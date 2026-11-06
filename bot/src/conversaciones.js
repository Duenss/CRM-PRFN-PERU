import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'conversaciones.json');

const MAX_CHATS = 400;
const MAX_MENSAJES = 500;

/** @type {Record<string, {telefono:string,nombre:string,clienteId:string|null,noLeidos:number,ultimoTexto:string,ultimoEn:string,mensajes:Array<any>}>} */
let chats = cargar();

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

let guardando = null;
function guardar() {
  if (guardando) clearTimeout(guardando);
  guardando = setTimeout(() => {
    guardando = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(archivo, JSON.stringify(chats), 'utf8');
    } catch (e) {
      console.warn('[conversaciones] no se pudo guardar:', e.message);
    }
  }, 1200);
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
export function registrarCabecera({ telefono, nombre = '', nombreWa = '', nombreGuardado = '', pushname = '', verifiedName = '', esEmpresa = null, ultimoTexto = '', ultimoEn = null, noLeidos = 0, pin = false, real = true }) {
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
    chat.ultimoEn = ultimoEn;
    if (ultimoTexto) chat.ultimoTexto = String(ultimoTexto).slice(0, 300);
  } else if (!chat.ultimoEn && ultimoTexto) {
    chat.ultimoTexto = String(ultimoTexto).slice(0, 300);
  }
  // WhatsApp es la fuente de verdad para los no leídos: si el dueño respondió
  // desde el celular, el chat llega en 0 y el contador debe limpiarse.
  if (Number.isFinite(Number(noLeidos))) chat.noLeidos = Math.max(0, Number(noLeidos));
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
      wa: !!c.wa
    }));
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
    wa: !!c.wa,
    mensajes: c.mensajes.filter(m => String(m.texto || '').trim()).slice(-MAX_MENSAJES)
  };
}

export function marcarLeido(telefono) {
  const c = chats[limpiarTel(telefono)];
  if (!c) return null;
  c.noLeidos = 0;
  guardar();
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
