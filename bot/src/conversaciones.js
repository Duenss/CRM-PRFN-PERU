import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitir } from './eventos.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'conversaciones.json');
// Copia de seguridad: se refresca cada 5 minutos con el último archivo bueno,
// para poder recuperar la bandeja si el JSON principal queda corrupto (corte de
// luz, disco lleno, proceso matado a mitad de escritura).
const archivoBak = archivo + '.bak';
const INTERVALO_BAK = 5 * 60 * 1000;
let ultimoBak = 0;

const MAX_CHATS = 60000;
const MAX_MENSAJES = 500;

/** Lee un JSON de conversaciones; devuelve null si no existe o está corrupto. */
function leerJsonConversaciones(ruta) {
  const j = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  return j;
}

function cargar() {
  try {
    const j = leerJsonConversaciones(archivo);
    if (j) return j;
  } catch (e) {
    console.warn('[conversaciones] JSON corrupto, se intenta recuperar desde .bak:', e.message);
  }
  try {
    const j = leerJsonConversaciones(archivoBak);
    if (j) {
      console.warn('[conversaciones] bandeja recuperada desde conversaciones.json.bak');
      return j;
    }
  } catch {}
  return {};
}

/** @type {Record<string, {telefono:string,nombre:string,clienteId:string|null,noLeidos:number,ultimoTexto:string,ultimoEn:string,mensajes:Array<any>}>} */
let chats = cargar();

/**
 * Escritura atómica: se escribe un .tmp y se renombra encima del archivo real.
 * `rename` es atómico en el mismo volumen (NTFS/ext4), así que un corte deja el
 * archivo anterior intacto en vez de uno truncado.
 */
function escribirAtomico(datos) {
  const tmp = archivo + '.tmp';
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // Antes de pisar el archivo bueno, cada 5 min se guarda una copia .bak.
    if (Date.now() - ultimoBak >= INTERVALO_BAK) {
      try { fs.copyFileSync(archivo, archivoBak); ultimoBak = Date.now(); } catch {}
    }
    fs.writeFileSync(tmp, JSON.stringify(datos), 'utf8');
    fs.renameSync(tmp, archivo);
    return true;
  } catch (e) {
    console.warn('[conversaciones] no se pudo guardar:', e.message);
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

// Debounce que NO descarta turnos: si llega otro cambio mientras el timer está
// pendiente, se agrupa y se escribe una sola vez, sin perder la última foto.
let guardando = null;
let pendiente = false;
function guardar() {
  pendiente = true;
  if (guardando) return;
  guardando = setTimeout(() => {
    guardando = null;
    if (!pendiente) return;
    pendiente = false;
    escribirAtomico(chats);
  }, 1200);
}

/**
 * Vacía YA los cambios pendientes a disco (apagado ordenado, SIGINT/SIGTERM y
 * pruebas). Devuelve true si había algo que escribir.
 */
export function flush() {
  if (guardando) {
    clearTimeout(guardando);
    guardando = null;
  }
  if (!pendiente) return false;
  pendiente = false;
  return escribirAtomico(chats);
}

/** Avisa de un cambio de conversación a los suscriptores SSE (panel en vivo). */
function emitirCambio(tipo, telefono, chat, mensaje = null) {
  try {
    emitir(tipo, {
      telefono,
      // Nombre visible del chat: si el panel aún no lo tiene en su lista (primer
      // contacto), sin esto mostraría "+519…" hasta el siguiente refresco.
      nombre: chat?.nombre || '',
      nombreWa: chat?.nombreWa || '',
      mensaje: mensaje ? { ...mensaje } : null,
      noLeidos: chat?.noLeidos || 0,
      ultimoTexto: chat?.ultimoTexto || '',
      ultimoEn: chat?.ultimoEn || ''
    });
  } catch {}
}

const limpiarTel = t => String(t || '').replace(/\D/g, '');
const ahora = () => new Date().toISOString();
/** Milisegundos de una fecha ISO; 0 si no se puede interpretar (ordenan al final). */
const tiempo = c => {
  const t = Date.parse(c && c.ultimoEn);
  return Number.isFinite(t) ? t : 0;
};

export function registrar({ telefono, texto, direccion = 'entrante', nombre = '', clienteId = null, origen = '', estado = 'ok', waId = '', en = null, ack = null }) {
  const tel = limpiarTel(telefono);
  if (!tel) return null;
  // Nunca guardamos mensajes sin contenido (reacciones, avisos de sistema, etc.):
  // contaminaban la fecha y el orden de la bandeja.
  if (!String(texto || '').trim()) return null;
  const chat = chats[tel] || {
    telefono: tel,
    nombre: nombre || `+${tel}`,
    clienteId: clienteId || null,
    noLeidos: 0,
    ultimoTexto: '',
    ultimoEn: ahora(),
    mensajes: []
  };
  if (nombre) chat.nombre = String(nombre).slice(0, 120);
  if (clienteId) chat.clienteId = clienteId;
  // Dedupe por identificador de WhatsApp (evita duplicar al reimportar historial).
  if (waId && chat.mensajes.some(m => m.waId === waId)) return null;
  // Conciliación: si el envío no trajo waId y `message_create` lo aporta después,
  // reutilizamos ese mensaje reciente en vez de crear un duplicado.
  if (waId && direccion === 'saliente') {
    const tNuevo = Date.parse(en || ahora()) || 0;
    const previo = [...chat.mensajes].reverse().find(m =>
      m.direccion === 'saliente' &&
      !m.waId &&
      String(m.texto || '') === String(texto || '').slice(0, 4000) &&
      Math.abs((Date.parse(m.en) || 0) - tNuevo) <= 120000
    );
    if (previo) {
      previo.waId = waId;
      previo.id = waId;
      if (Number.isFinite(Number(ack))) previo.ack = Number(ack);
      chat.ultimoTexto = previo.texto;
      chat.ultimoEn = previo.en;
      chats[tel] = chat;
      guardar();
      return previo;
    }
  }
  // Conciliación inversa: el envío puede registrarse DESPUÉS de que
  // `message_create` ya guardó el mismo mensaje con su waId real. En ese caso
  // no creamos una segunda copia sin id.
  if (!waId && direccion === 'saliente') {
    const tNuevo = Date.parse(en || ahora()) || 0;
    const existente = [...chat.mensajes].reverse().find(m =>
      m.direccion === 'saliente' &&
      m.waId &&
      String(m.texto || '') === String(texto || '').slice(0, 4000) &&
      Math.abs((Date.parse(m.en) || 0) - tNuevo) <= 120000
    );
    if (existente) {
      chat.ultimoTexto = existente.texto;
      chat.ultimoEn = existente.en;
      if (direccion === 'saliente') chat.noLeidos = 0;
      chats[tel] = chat;
      guardar();
      return existente;
    }
  }

  const mensaje = {
    id: waId || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    waId: waId || '',
    direccion,
    texto: String(texto || '').slice(0, 4000),
    origen: origen || (direccion === 'entrante' ? 'cliente' : 'bot'),
    estado,
    en: en || ahora(),
    // Estado de entrega/lectura de WhatsApp (solo mensajes salientes):
    // 0 pendiente, 1 enviado, 2 entregado, 3 leído. Lo actualiza manejarAck().
    ...(direccion === 'saliente' ? { ack: Number.isFinite(Number(ack)) ? Number(ack) : 0 } : {})
  };
  chat.mensajes.push(mensaje);
  if (chat.mensajes.length > MAX_MENSAJES) chat.mensajes = chat.mensajes.slice(-MAX_MENSAJES);
  chat.ultimoTexto = mensaje.texto;
  chat.ultimoEn = mensaje.en;
  if (direccion === 'entrante') chat.noLeidos = (chat.noLeidos || 0) + 1;
  // Si responde el bot, la IA o el dueño (aunque sea desde su celular), el chat
  // ya está atendido: se limpia el contador de no leídos.
  else chat.noLeidos = 0;

  chats[tel] = chat;
  recortar();
  guardar();
  // Aviso en vivo al panel (SSE): mensaje nuevo con el estado del chat.
  emitirCambio('mensaje', tel, chat, mensaje);
  return mensaje;
}

/**
 * Actualiza el estado de entrega/lectura (ack) de un mensaje saliente ya guardado.
 * ack: 0 pendiente, 1 enviado, 2 entregado, 3 leído. Devuelve true si cambió.
 */
export function actualizarAck(telefono, waId, ack) {
  const tel = limpiarTel(telefono);
  const n = Number(ack);
  if (!tel || !waId || !Number.isFinite(n)) return false;
  const chat = chats[tel];
  if (!chat || !Array.isArray(chat.mensajes)) return false;
  const m = chat.mensajes.find(x => x.waId === waId || x.id === waId);
  if (!m || m.ack === n) return false;
  m.ack = n;
  guardar();
  emitirCambio('ack', tel, chat, m);
  return true;
}

function recortar() {
  const claves = Object.keys(chats);
  if (claves.length <= MAX_CHATS) return;
  claves
    .sort((a, b) => tiempo(chats[a]) - tiempo(chats[b]))
    .slice(0, claves.length - MAX_CHATS)
    .forEach(k => delete chats[k]);
}

/** Crea/actualiza un chat solo con su cabecera (sincronización desde WhatsApp). */
export function registrarCabecera({ telefono, nombre = '', nombreWa = '', nombreGuardado = '', pushname = '', verifiedName = '', esEmpresa = null, ultimoTexto = '', ultimoEn = null, noLeidos = 0, pin = false, real = true, grupo = false, archivado = null, propio = false, waId = '' }) {
  const tel = limpiarTel(telefono);
  if (!tel) return null;
  const chat = chats[tel] || {
    telefono: tel,
    nombre: nombre || `+${tel}`,
    clienteId: null,
    noLeidos: 0,
    ultimoTexto: '',
    ultimoEn: ultimoEn || '',
    mensajes: []
  };
  chat.grupo = grupo === true;
  if (archivado === true || archivado === false) chat.archivado = archivado;
  if (propio === true) chat.propio = true;
  if (waId) chat.waId = String(waId).slice(0, 90);
  if (nombre && (!chat.nombre || chat.nombre === `+${tel}`)) chat.nombre = String(nombre).slice(0, 120);
  // Nombre real que muestra WhatsApp y tipo de contacto (persona o empresa).
  const waName = String(nombreWa || nombre || '').trim();
  if (waName) chat.nombreWa = waName.slice(0, 120);
  if (nombreGuardado) chat.nombreGuardado = String(nombreGuardado).slice(0, 120);
  if (pushname) chat.pushname = String(pushname).slice(0, 120);
  if (verifiedName) chat.verifiedName = String(verifiedName).slice(0, 120);
  if (esEmpresa === true || esEmpresa === false) {
    chat.esEmpresa = esEmpresa;
    chat.tipo = esEmpresa ? 'empresa' : 'persona';
  }
  // La cabecera viene del listado real de WhatsApp: si trae fecha, es la buena.
  if (real === false) {
    // Lo último es solo una reacción/aviso (sin mensaje real): usamos la fecha
    // del último mensaje real guardado (o sin fecha si nunca hubo conversación),
    // para que no suba por encima de conversaciones reales.
    const ult = chat.mensajes && chat.mensajes[chat.mensajes.length - 1];
    chat.ultimoEn = ult ? ult.en : '';
    chat.ultimoTexto = ult ? ult.texto : '';
  } else if (ultimoEn) {
    // No pisar un mensaje local más nuevo con una cabecera vieja de WhatsApp.
    const nuevo = Date.parse(ultimoEn);
    const actual = Date.parse(chat.ultimoEn);
    if (!Number.isFinite(actual) || (Number.isFinite(nuevo) && nuevo >= actual)) {
      chat.ultimoEn = ultimoEn;
      if (ultimoTexto) chat.ultimoTexto = String(ultimoTexto).slice(0, 300);
    }
  } else if (!chat.ultimoEn && ultimoTexto) {
    chat.ultimoTexto = String(ultimoTexto).slice(0, 300);
  }
  // WhatsApp puede devolver un contador VIEJO (p. ej. si el dueño respondió
  // desde su celular y aún así llega "2"). Solo aceptamos que el contador BAJE;
  // los mensajes nuevos en vivo ya lo suben por su propio evento.
  if (Number.isFinite(Number(noLeidos))) {
    const externo = Math.max(0, Number(noLeidos));
    chat.noLeidos = (chat.mensajes && chat.mensajes.length)
      ? Math.min(chat.noLeidos || 0, externo)
      : externo;
  }
  chat.pin = !!pin;
  chat.wa = true;
  chats[tel] = chat;
  recortar();
  guardar();
  return chat;
}

/** Importa mensajes históricos de WhatsApp sin duplicar (dedupe por waId). */
export function importarMensajes(telefono, mensajes = []) {
  const tel = limpiarTel(telefono);
  if (!tel || !Array.isArray(mensajes) || !mensajes.length) return 0;
  const chat = chats[tel] || {
    telefono: tel,
    nombre: `+${tel}`,
    clienteId: null,
    noLeidos: 0,
    ultimoTexto: '',
    ultimoEn: ahora(),
    mensajes: []
  };
  const clave = m => m.waId || `${m.en || ''}|${m.direccion || ''}|${String(m.texto || '').slice(0, 120)}`;
  // Índice por waId para poder refrescar el ack de mensajes ya guardados
  // (los históricos anteriores a las palomitas no tenían `ack`).
  const porWa = new Map();
  for (const m of chat.mensajes) if (m.waId) porWa.set(m.waId, m);
  const vistos = new Set(chat.mensajes.map(clave));
  let nuevos = 0;
  let actualizados = 0;
  for (const m of mensajes) {
    if (!String(m.texto || '').trim()) continue;
    const k = clave({ ...m, texto: String(m.texto || '') });
    if (vistos.has(k)) {
      const previo = m.waId && porWa.get(m.waId);
      if (previo && previo.direccion === 'saliente') {
        const entrante = Number.isFinite(Number(m.ack)) ? Number(m.ack) : 0;
        const actual = Number.isFinite(Number(previo.ack)) ? Number(previo.ack) : -1;
        if (entrante > actual) { previo.ack = entrante; actualizados++; }
      }
      continue;
    }
    const item = {
      id: m.waId || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      waId: m.waId || '',
      direccion: m.direccion === 'saliente' ? 'saliente' : 'entrante',
      texto: String(m.texto || '').slice(0, 4000),
      origen: m.direccion === 'saliente' ? 'bot' : 'cliente',
      estado: 'ok',
      en: m.en || ahora(),
      ...(m.direccion === 'saliente' ? { ack: Number.isFinite(Number(m.ack)) ? Number(m.ack) : 0 } : {})
    };
    vistos.add(k);
    chat.mensajes.push(item);
    if (m.waId) porWa.set(m.waId, item);
    nuevos++;
  }
  if (!nuevos && !actualizados) return 0;
  chat.mensajes.sort((a, b) => String(a.en).localeCompare(String(b.en)));
  if (chat.mensajes.length > MAX_MENSAJES) chat.mensajes = chat.mensajes.slice(-MAX_MENSAJES);
  const ult = chat.mensajes[chat.mensajes.length - 1];
  if (ult) { chat.ultimoTexto = ult.texto; chat.ultimoEn = ult.en; }
  chat.wa = true;
  chats[tel] = chat;
  recortar();
  guardar();
  return nuevos;
}

/** ¿Ya está registrado este mensaje (por su id de WhatsApp)? */
export function yaExisteWa(telefono, waId) {
  const c = chats[limpiarTel(telefono)];
  if (!c || !waId) return false;
  return c.mensajes.some(m => m.waId === waId);
}

/** Borra todos los chats de la Bandeja (memoria + disco). */
/** Fija o desfija un chat en la Bandeja (como WhatsApp Web). */
export function fijar(telefono, valor = true) {
  const tel = limpiarTel(telefono);
  const chat = chats[tel];
  if (!chat) return null;
  chat.fijado = valor === true;
  guardar();
  return chat.fijado;
}

/** Archiva o desarchiva un chat. */
export function archivar(telefono, valor = true) {
  const tel = limpiarTel(telefono);
  const chat = chats[tel];
  if (!chat) return null;
  chat.archivado = valor === true;
  guardar();
  return chat.archivado;
}

/** Borra un chat concreto de la Bandeja. */
export function eliminar(telefono) {
  const tel = limpiarTel(telefono);
  if (!tel || !chats[tel]) return false;
  delete chats[tel];
  guardar();
  return true;
}

export function vaciar() {
  chats = {};
  guardar();
  return true;
}

function esNombreAgregado(nombre) {
  const t = String(nombre || '').trim();
  if (!t) return false;
  if (t.startsWith('@')) return false;                 // LID / solo pushname con @ = no agregado
  return !/^\+?[\d\s\-()]+$/.test(t);             // un nombre real, no un número
}

export function listar(limite = 40) {
  return Object.values(chats)
    .sort((a, b) => (Number(!!b.pin) - Number(!!a.pin)) || (tiempo(b) - tiempo(a)))
    .slice(0, limite)
    .map(c => ({
      telefono: c.telefono,
      nombre: c.nombre,
      nombreWa: c.nombreWa || '',
      nombreGuardado: c.nombreGuardado || '',
      esEmpresa: c.esEmpresa === true,
      tipo: c.tipo || '',
      clienteId: c.clienteId,
      noLeidos: c.noLeidos || 0,
      ultimoTexto: c.ultimoTexto,
      ultimoEn: c.ultimoEn,
      total: c.mensajes.length,
      pin: !!c.pin,
      fijado: !!(c.fijado || c.pin),
      grupo: c.grupo === true,
      archivado: c.archivado === true,
      propio: c.propio === true,
      sinWhatsApp: c.sinWhatsApp === true,
      sinChat: c.sinChat === true,
      waId: c.waId || '',
      wa: !!c.wa
    }));
}

/** Búsqueda y paginación para la Bandeja (soporta miles de chats). */
export function buscar({ limite = 80, offset = 0, q = '', filtro = 'todos' } = {}) {
  const texto = String(q || '').toLowerCase().trim();
  const serializar = c => ({
    telefono: c.telefono,
    nombre: c.nombre,
    nombreWa: c.nombreWa || '',
    nombreGuardado: c.nombreGuardado || '',
    esEmpresa: c.esEmpresa === true,
    tipo: c.tipo || '',
    clienteId: c.clienteId,
    noLeidos: c.noLeidos || 0,
    ultimoTexto: c.ultimoTexto,
    ultimoEn: c.ultimoEn,
    total: c.mensajes.length,
    pin: !!c.pin,
    fijado: !!(c.fijado || c.pin),
    grupo: c.grupo === true,
    archivado: c.archivado === true,
    propio: c.propio === true,
    sinWhatsApp: c.sinWhatsApp === true,
    sinChat: c.sinChat === true,
    waId: c.waId || '',
    wa: !!c.wa
  });
  let arr = Object.values(chats).filter(c => {
    // "sinWhatsApp": modo revisión de la Bandeja — muestra SOLO los ocultos
    // para poder restaurarlos desde el panel. En cualquier otro filtro los
    // "sin WhatsApp" quedan ocultos.
    if (filtro === 'sinWhatsApp') return c.sinWhatsApp === true;
    if (c.sinWhatsApp === true) return false;
    if (filtro === 'noLeidos' && !((c.noLeidos || 0) > 0)) return false;
    if (filtro === 'fijados' && !(c.fijado || c.pin)) return false;
    if (filtro === 'personas' && (c.grupo || c.tipo !== 'persona')) return false;
    if (filtro === 'empresas' && c.tipo !== 'empresa') return false;
    // "Agregado" = el número está guardado en la agenda del WhatsApp.
    // Los números que no existen en WhatsApp no se muestran en la Bandeja.
    if (filtro === 'agregados' && !esNombreAgregado(c.nombre)) return false;
    if (filtro === 'noAgregados' && esNombreAgregado(c.nombre)) return false;
    if (texto) {
      const blob = [c.nombre, c.nombreWa, c.nombreGuardado, c.telefono, c.ultimoTexto].join(' ').toLowerCase();
      if (!blob.includes(texto)) return false;
    }
    return true;
  });
  arr.sort((a, b) => (Number(!!b.pin) - Number(!!a.pin)) || (tiempo(b) - tiempo(a)));
  const total = arr.length;
  const desde = Math.max(0, Number(offset) || 0);
  const items = arr.slice(desde, desde + limite).map(serializar);
  return { items, total, hasMore: desde + items.length < total };
}

/** Marca qué chats tienen su número guardado en la agenda (contactos). */
export function marcarAgregados(telefonos = []) {
  const set = new Set((Array.isArray(telefonos) ? telefonos : []).map(t => limpiarTel(t)));
  for (const tel of Object.keys(chats)) chats[tel].agregado = set.has(tel);
  guardar();
}

/** Aplica la agenda de contactos: marca agregados y completa nombres faltantes. */
export function aplicarContactos(contactos = []) {
  const mapa = new Map();
  for (const c of Array.isArray(contactos) ? contactos : []) {
    const tel = limpiarTel(c.telefono);
    if (tel) mapa.set(tel, c);
  }
  for (const tel of Object.keys(chats)) {
    const c = mapa.get(tel);
    if (!c) continue;
    const ch = chats[tel];
    const nom = String(c.nombreGuardado || c.nombre || '').trim();
    // El nombre se aplica aunque el contacto no esté "guardado": sirve para
    // que los chats viejos dejen de mostrarse como +51XXXXXXXXX.
    if (nom && !/^\+?[\d\s\-()]+$/.test(nom)) {
      if (!ch.nombre || /^\+?[\d\s\-()]+$/.test(String(ch.nombre))) {
        ch.nombre = nom;
        ch.nombreWa = nom;
      }
      if (!ch.nombreGuardado) ch.nombreGuardado = nom;
    }
    if (c.guardado === true) ch.agregado = true;
    else if (ch.agregado !== true) ch.agregado = false;
  }
  guardar();
}

/** Completa nombres de chats numéricos usando la base de clientes del CRM. */
export function aplicarNombresClientes(clientes = []) {
  const mapa = new Map();
  for (const cl of Array.isArray(clientes) ? clientes : []) {
    const tel = limpiarTel(cl.telefono);
    const nom = String(cl.nombre || '').trim();
    if (!tel || !nom) continue;
    if (/^\+?[\d\s\-()]+$/.test(nom)) continue;
    mapa.set(tel, nom);
  }
  for (const tel of Object.keys(chats)) {
    const nom = mapa.get(tel);
    if (!nom) continue;
    const ch = chats[tel];
    if (!ch.nombre || /^\+?[\d\s\-()]+$/.test(String(ch.nombre))) {
      ch.nombre = nom;
      ch.nombreWa = nom;
    }
  }
  guardar();
}

/** Marca si el número del chat existe o no en WhatsApp (validación). */
export function marcarSinWhatsApp(telefono, valor = true) {
  const tel = limpiarTel(telefono);
  const ch = chats[tel];
  if (!ch) return;
  ch.sinWhatsApp = valor === true;
  guardar();
}

export function marcarSinChat(telefono, valor = true) {
  const tel = limpiarTel(telefono);
  const ch = chats[tel];
  if (!ch) return;
  ch.sinChat = valor === true;
  guardar();
}

/** Teléfonos de chats marcados como sin WhatsApp (para etiquetar clientes). */
export function chatsSinWhatsApp() {
  return Object.values(chats).filter(c => c.sinWhatsApp === true).map(c => c.telefono);
}

export function obtener(telefono) {
  const c = chats[limpiarTel(telefono)];
  if (!c) return null;
  return {
    telefono: c.telefono,
    nombre: c.nombre,
    nombreWa: c.nombreWa || '',
    nombreGuardado: c.nombreGuardado || '',
    esEmpresa: c.esEmpresa === true,
    tipo: c.tipo || '',
    clienteId: c.clienteId,
    noLeidos: c.noLeidos || 0,
    ultimoTexto: c.ultimoTexto,
    ultimoEn: c.ultimoEn,
    pin: !!c.pin,
    fijado: !!(c.fijado || c.pin),
    grupo: c.grupo === true,
    archivado: c.archivado === true,
    propio: c.propio === true,
    sinWhatsApp: c.sinWhatsApp === true,
    sinChat: c.sinChat === true,
    waId: c.waId || '',
    wa: !!c.wa,
    mensajes: c.mensajes.filter(m => String(m.texto || '').trim()).slice(-MAX_MENSAJES)
  };
}

export function marcarLeido(telefono) {
  const c = chats[limpiarTel(telefono)];
  if (!c) return null;
  c.noLeidos = 0;
  guardar();
  emitirCambio('leido', c.telefono, c);
  return { ok: true };
}

export function porDia(dias = 7) {
  const out = [];
  const hoy = new Date();
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoy);
    d.setDate(d.getDate() - i);
    const fecha = d.toISOString().slice(0, 10);
    out.push({ fecha, entrantes: 0, salientes: 0 });
  }
  const mapa = new Map(out.map(x => [x.fecha, x]));
  for (const c of Object.values(chats)) {
    for (const m of c.mensajes) {
      const fecha = String(m.en).slice(0, 10);
      const fila = mapa.get(fecha);
      if (!fila) continue;
      if (m.direccion === 'entrante') fila.entrantes++;
      else fila.salientes++;
    }
  }
  return out;
}

export function respuestasIA(telefono, horas = 24) {
  const c = chats[limpiarTel(telefono)];
  if (!c) return 0;
  const desde = Date.now() - horas * 3600 * 1000;
  return c.mensajes.filter(m => m.origen === 'ia' && new Date(m.en).getTime() >= desde).length;
}

export function totalNoLeidos() {
  return Object.values(chats).reduce((n, c) => n + (c.noLeidos || 0), 0);
}

/** Mensajes entrantes de todos los chats (para analíticas de consultas). */
export function mensajesEntrantes(limite = 20000) {
  const out = [];
  for (const c of Object.values(chats)) {
    for (const m of c.mensajes) {
      if (m.direccion === 'entrante' && String(m.texto || '').trim()) {
        out.push({ telefono: c.telefono, texto: String(m.texto), en: m.en });
      }
    }
  }
  out.sort((a, b) => String(a.en).localeCompare(String(b.en)));
  return out.slice(-Math.max(1, limite));
}

export function resumen() {
  const lista = Object.values(chats);
  const hoy = ahora().slice(0, 10);
  return {
    chats: lista.length,
    noLeidos: totalNoLeidos(),
    mensajesHoy: lista.reduce((n, c) => n + c.mensajes.filter(m => String(m.en).startsWith(hoy)).length, 0)
  };
}
