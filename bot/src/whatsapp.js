import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { config, normalizar } from './config.js';

const { Client, LocalAuth } = pkg;

/** id -> { id, estado, conectado, qr, qrDataUrl, numero, error, client, reintentos } */
export const sesiones = new Map();

/** Ids de mensajes que envió el propio bot (para no duplicarlos en 'message_create'). */
const enviadosPorBot = new Set();

let logFn = console.log;

function crearEstado(id) {
  return {
    id: String(id),
    etiqueta: `Número ${id}`,
    estado: 'iniciando',
    conectado: false,
    qr: null,
    qrDataUrl: null,
    numero: null,
    error: null,
    client: null,
    reintentos: 0
  };
}

export async function iniciarWhatsApp({ onMensaje, onMensajePropio, log, sesionIds = ['1'] }) {
  logFn = log || console.log;

  if (config.modoPrueba) {
    for (const id of sesionIds) {
      const s = crearEstado(id);
      s.estado = 'mock';
      sesiones.set(String(id), s);
    }
    logFn('MODO PRUEBA activo: no se conecta a WhatsApp ni se envían mensajes reales.');
    return;
  }

  let retraso = 0;
  for (const id of sesionIds) {
    const key = String(id);
    if (sesiones.has(key)) continue;
    sesiones.set(key, crearEstado(key));
    const espera = retraso;
    retraso += 12000;
    setTimeout(() => {
      crearSesion(key, { onMensaje, onMensajePropio, log }).catch(e => {
        const s = sesiones.get(key);
        if (s) { s.estado = 'desconectado'; s.error = e.message; }
        log(`No se pudo iniciar la sesión ${key}: ${e.message}`);
      });
    }, espera);
  }
}

async function crearSesion(id, { onMensaje, onMensajePropio, log }) {
  const s = sesiones.get(id);
  const opciones = {
    authStrategy: new LocalAuth({ clientId: `sesion-${id}`, dataPath: config.sessionPath }),
    webVersionCache: { type: 'none' },
    puppeteer: {
      headless: config.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  };
  if (config.chromePath) opciones.puppeteer.executablePath = config.chromePath;

  const client = new Client(opciones);
  s.client = client;
  s.estado = 'iniciando';
  s.onMensaje = onMensaje;

  client.on('qr', async qr => {
    s.estado = 'qr';
    s.autenticado = false;
    s.qr = qr;
    try { s.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 520, errorCorrectionLevel: 'M' }); } catch {}
    log(`[${id}] QR generado (${qr.length} chars, inicia "${qr.slice(0, 14)}…"). Escanéalo desde el panel del bot.`);
    // Si la sesión se cayó y hay que volver a escanear, reactiva el vigilante.
    vigilarConexion(id, client, s);
  });

  client.on('authenticated', () => {
    if (!s.autenticado) log(`[${id}] WhatsApp autenticado.`);
    s.autenticado = true;
    vigilarConexion(id, client, s);
  });

  client.on('ready', () => {
    s.estado = 'conectado';
    s.conectado = true;
    s.numero = client.info?.wid?.user || null;
    s.qr = null;
    s.qrDataUrl = null;
    s.error = null;
    s.reintentos = 0;
    s.autenticado = true;
    if (s.vigilante) { clearInterval(s.vigilante); s.vigilante = null; }
    log(`[${id}] WhatsApp conectado como +${s.numero || 'desconocido'}.`);
  });

  client.on('auth_failure', m => {
    s.estado = 'desconectado';
    s.conectado = false;
    s.error = String(m || 'Fallo de autenticación');
    log(`[${id}] Fallo de autenticación: ${s.error}`);
  });

  client.on('disconnected', motivo => {
    s.estado = 'desconectado';
    s.conectado = false;
    s.numero = null;
    s.error = `Desconectado: ${motivo}`;
    log(`[${id}] ${s.error}`);
    if (s.reintentos < 5) {
      s.reintentos++;
      log(`[${id}] Reintentando conexión en 15 segundos (intento ${s.reintentos}/5)…`);
      setTimeout(() => client.initialize().catch(e => log(`[${id}] Error al reconectar: ${e.message}`)), 15000);
    }
  });

  client.on('message', async msg => {
    try { await onMensaje(msg, id); }
    catch (e) { log(`[${id}] Error al procesar mensaje: ${e.message}`); }
  });

  // Mensajes creados por este número (los que envías tú desde el celular).
  // Los que manda el propio bot se descartan aquí para no duplicarlos.
  client.on('message_create', async msg => {
    try {
      const wid = msg?.id?._serialized;
      if (wid && enviadosPorBot.has(wid)) { enviadosPorBot.delete(wid); return; }
      if (onMensajePropio) await onMensajePropio(msg, id);
    } catch (e) { log(`[${id}] Error al procesar mensaje propio: ${e.message}`); }
  });

  // Arranca también un vigilante por si 'authenticated' nunca llega.
  vigilarConexion(id, client, s);

  await client.initialize();
}

/**
 * Algunas versiones de WhatsApp Web no disparan el evento que whatsapp-web.js
 * espera para emitir 'ready'. El socket queda CONNECTED y la sesión vinculada,
 * pero el bot se queda en estado 'qr'. Este vigilante comprueba la página y,
 * si ya hay sesión vinculada, fuerza el evento interno de la librería.
 */
function vigilarConexion(id, client, s) {
  if (s.vigilante) return;
  const tick = async () => {
    if (s.estado === 'conectado' || s.estado === 'desconectado' || config.modoPrueba) {
      clearInterval(s.vigilante);
      s.vigilante = null;
      return;
    }
    if (s.llamandoSync) return;
    if (!client.pupPage) return;
    let info;
    try {
      info = await client.pupPage.evaluate(() => {
        try {
          const prefs = window.require('WAWebUserPrefsMeUser');
          const me = prefs.getMaybeMePnUser() || prefs.getMaybeMeLidUser();
          return {
            vinculado: !!me,
            socket: window.require('WAWebSocketModel').Socket.state,
            funcion: typeof window.onAppStateHasSyncedEvent === 'function'
          };
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
      });
    } catch {
      return; // página navegando o cerrada; reintenta en el siguiente ciclo
    }
    if (!info || !info.vinculado || info.socket !== 'CONNECTED' || !info.funcion) return;
    s.llamandoSync = true;
    try {
      await client.pupPage.evaluate(async () => { await window.onAppStateHasSyncedEvent(); });
    } catch (e) {
      logFn(`[${id}] Reintento de conexión: ${(e && e.message) || e}`);
    } finally {
      s.llamandoSync = false;
    }
  };
  s.vigilante = setInterval(tick, 8000);
  setTimeout(tick, 3000);
}

function sesionParaEnviar(sesionId) {
  if (sesionId) {
    const s = sesiones.get(String(sesionId));
    if (s && s.estado === 'conectado') return s;
    return null;
  }
  return [...sesiones.values()].find(s => s.estado === 'conectado') || null;
}

export async function enviar(telefono, texto, sesionId = null) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (config.modoPrueba) {
    logFn(`[PRUEBA${sesionId ? ' ' + sesionId : ''}] Mensaje para +${limpio}: ${String(texto).slice(0, 160)}${String(texto).length > 160 ? '…' : ''}`);
    return { simulado: true };
  }

  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error(sesionId ? `La sesión ${sesionId} no está conectada` : 'Ningún WhatsApp está conectado');

  const id = await s.client.getNumberId(limpio);
  if (!id) throw new Error(`El número +${limpio} no tiene WhatsApp`);
  const enviado = await s.client.sendMessage(id._serialized, texto);
  const waId = (enviado && enviado.id && enviado.id._serialized) || '';
  if (waId) {
    enviadosPorBot.add(waId);
    if (enviadosPorBot.size > 500) enviadosPorBot.delete(enviadosPorBot.values().next().value);
  }
  return { ok: true, sesion: s.id, waId };
}

/** Teléfono de un chat o contacto individual (solo dígitos), o '' si es grupo/sin número. */
function telDe(item) {
  if (!item || item.isGroup) return '';
  const candidato = (item.id?.server === 'c.us' ? item.id?.user : '')
    || item.contact?.number || item.number || '';
  const tel = normalizar(candidato);
  return /^\d{8,15}$/.test(tel) ? tel : '';
}

/** Dado el id de un chat (@lid o @c.us), devuelve el teléfono real (solo dígitos) o ''. */
export async function resolverTelefonoWa(widSerializado, sesionId = null) {
  const wid = String(widSerializado || '');
  if (!wid) return '';
  const [user, server] = wid.split('@');
  if (server === 'c.us') return normalizar(user);
  const s = sesionParaEnviar(sesionId) || [...sesiones.values()].find(x => x.client && x.client.pupPage);
  if (!s) return '';
  try {
    const real = await s.client.pupPage.evaluate(async (wid) => {
      const W = window;
      try {
        const apiContact = W.require('WAWebApiContact');
        const widFactory = W.require('WAWebWidFactory');
        const w = widFactory.createWid(wid);
        const phone = apiContact.getPhoneNumber(w);
        if (phone && phone._serialized) return String(phone._serialized).split('@')[0];
      } catch (e) {}
      try {
        if (W.WWebJS && W.WWebJS.enforceLidAndPnRetrieval) {
          const r = await W.WWebJS.enforceLidAndPnRetrieval(wid);
          if (r && r.phone && r.phone._serialized) return String(r.phone._serialized).split('@')[0];
        }
      } catch (e) {}
      return '';
    }, wid);
    return real ? normalizar(real) : '';
  } catch (e) {
    return '';
  }
}

/** Todos los chats del WhatsApp vinculado (no solo los que vio el bot). */
export async function listarChatsWa(sesionId = null) {
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error('Ningún WhatsApp está conectado');

  let crudos;
  try {
    // Vía normal: el wrapper de whatsapp-web.js.
    const chats = await s.client.getChats();
    crudos = chats.map(c => ({
      tel: c.id?.server === 'c.us' ? c.id?.user : (c.contact?.number || ''),
      esGrupo: !!c.isGroup,
      nombre: c.name || c.contact?.name || c.contact?.pushname || '',
      ultimoTexto: c.lastMessage?.body || '',
      ts: c.timestamp || 0,
      noLeidos: c.unreadCount || 0
    }));
  } catch {
    // Respaldo: `client.getChats()` falla en algunas versiones de WhatsApp Web
    // cuando un solo chat no se puede serializar. Leemos la colección directo,
    // toleramos chats problemáticos y resolvemos el número real de cada chat
    // (los chats nuevos usan identificadores @lid y no traen el teléfono).
    crudos = await s.client.pupPage.evaluate(async () => {
      const out = [];
      const W = window;
      let apiContact, widFactory;
      try { apiContact = W.require('WAWebApiContact'); } catch (e) {}
      try { widFactory = W.require('WAWebWidFactory'); } catch (e) {}
      try {
        const col = W.require('WAWebCollections');
        const arr = (col.Chat && col.Chat.getModelsArray && col.Chat.getModelsArray()) || [];
        for (const c of arr) {
          try {
            const server = c.id && c.id.server;
            const esGrupo = server === 'g.us' || !!c.groupMetadata;
            let nombre = '';
            try { nombre = c.formattedTitle || c.name || (c.contact && (c.contact.name || c.contact.pushname)) || ''; } catch (e) {}
            let ultimoTexto = '';
            try { ultimoTexto = (c.lastMessage && c.lastMessage.body) || ''; } catch (e) {}
            let ts = 0;
            try { ts = c.timestamp || (c.lastMessage && c.lastMessage.t) || 0; } catch (e) {}
            let noLeidos = 0;
            try { noLeidos = c.unreadCount || 0; } catch (e) {}

            let tel = '';
            if (!esGrupo) {
              // 1) El contacto suele traer el número real aunque el chat use @lid.
              try {
                const pn = c.contact && c.contact.phoneNumber;
                if (pn && pn._serialized) tel = String(pn._serialized).split('@')[0];
              } catch (e) {}
              // 2) Chat @c.us clásico.
              if (!tel && server === 'c.us' && c.id && c.id.user) tel = String(c.id.user);
              // 3) Resolver el @lid a teléfono.
              if (!tel && server === 'lid' && widFactory && apiContact) {
                try {
                  const wid = widFactory.createWid((c.id && c.id._serialized) || '');
                  let phone = apiContact.getPhoneNumber(wid);
                  if (!phone && W.WWebJS && W.WWebJS.enforceLidAndPnRetrieval) {
                    const r = await W.WWebJS.enforceLidAndPnRetrieval((c.id && c.id._serialized) || '');
                    phone = r && r.phone;
                  }
                  if (phone && phone._serialized) tel = String(phone._serialized).split('@')[0];
                } catch (e) {}
              }
            }

            out.push({
              tel,
              esGrupo,
              nombre: String(nombre || ''),
              ultimoTexto: String(ultimoTexto || ''),
              ts,
              noLeidos
            });
          } catch (e) {}
        }
      } catch (e) {}
      return out;
    });
  }

  const propio = normalizar(s.numero);
  return crudos
    .map(c => ({
      telefono: telDe({ isGroup: c.esGrupo, number: c.tel }),
      esGrupo: !!c.esGrupo,
      nombre: String(c.nombre || '').trim(),
      ultimoTexto: String(c.ultimoTexto || '').slice(0, 300),
      ultimoEn: c.ts ? new Date(c.ts * 1000).toISOString() : null,
      noLeidos: c.noLeidos || 0
    }))
    .filter(c => !c.esGrupo ? (c.telefono && c.telefono !== propio) : true);
}

/** Todos los contactos guardados/iniciados en el WhatsApp vinculado. */
export async function listarContactosWa(sesionId = null) {
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error('Ningún WhatsApp está conectado');
  const contactos = await s.client.getContacts();
  const propio = normalizar(s.numero);
  const porTel = new Map();
  for (const c of contactos) {
    if (c.isGroup || c.id?.server !== 'c.us') continue;
    const tel = telDe(c);
    if (!tel || tel === propio) continue;
    const nombre = String(c.name || c.pushname || c.shortName || '').trim();
    const previo = porTel.get(tel);
    if (!previo || (!previo.nombre && nombre)) porTel.set(tel, { telefono: tel, nombre });
  }
  return [...porTel.values()];
}

/** Historial reciente de un chat, leído directo de WhatsApp. */
export async function historialWa(telefono, limite = 50, sesionId = null) {
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error('Ningún WhatsApp está conectado');
  const limpio = String(telefono || '').replace(/\D/g, '');
  const numId = await s.client.getNumberId(limpio);
  if (!numId) throw new Error(`El número +${limpio} no tiene WhatsApp`);
  const chatId = numId._serialized;
  // Se lee directo de la página y sin serializar: `getChatById`/`fetchMessages`
  // de whatsapp-web.js fallan ("r") al serializar chats en la versión actual.
  const msgs = await s.client.pupPage.evaluate(async ({ chatId, limite }) => {
    const W = window;
    const filtro = m => !m.isNotification;
    let chat = null;
    try { chat = await W.WWebJS.getChat(chatId, { getAsModel: false }); } catch (e) { chat = null; }
    if (!chat) return null;
    let lista = (chat.msgs && chat.msgs.getModelsArray && chat.msgs.getModelsArray()) || [];
    lista = lista.filter(filtro);
    const tope = Math.min(100, Math.max(1, limite));
    let vueltas = 0;
    while (lista.length < tope && vueltas < 8) {
      vueltas++;
      try {
        const cargados = await W.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
        if (!cargados || !cargados.length) break;
        lista = [...cargados.filter(filtro), ...lista];
      } catch (e) { break; }
    }
    lista.sort((a, b) => (a.t || 0) - (b.t || 0));
    if (lista.length > tope) lista = lista.slice(lista.length - tope);
    const vistos = new Set();
    return lista
      .map(m => {
        let texto = String((m.body || m.caption || '')).trim();
        if (!texto) {
          const t = String(m.type || '');
          texto = ({
            image: '[imagen]', video: '[video]', audio: '[audio]', ptt: '[nota de voz]',
            document: '[documento]', sticker: '[sticker]', location: '[ubicación]',
            vcard: '[contacto]', multi_vcard: '[contactos]'
          })[t] || (m.hasMedia ? '[archivo]' : '');
        }
        const idObj = m.id || {};
        const waId = idObj._serialized || idObj.id || (m.key && m.key.id) || '';
        if (!texto && !waId) return null;
        if (waId) { if (vistos.has(waId)) return null; vistos.add(waId); }
        return {
          waId,
          direccion: m.id && m.id.fromMe ? 'saliente' : 'entrante',
          texto: texto.slice(0, 4000),
          en: m.t ? new Date(m.t * 1000).toISOString() : new Date().toISOString()
        };
      })
      .filter(Boolean);
  }, { chatId, limite });
  return msgs || [];
}

export async function cerrarSesion(sesionId) {
  const ids = sesionId ? [String(sesionId)] : [...sesiones.keys()];
  for (const id of ids) {
    const s = sesiones.get(id);
    if (!s) continue;
    try { await s.client?.logout(); } catch {}
    try { await s.client?.destroy(); } catch {}
    if (s.vigilante) { clearInterval(s.vigilante); s.vigilante = null; }
    s.client = null;
    s.estado = 'desconectado';
    s.conectado = false;
    s.numero = null;
    s.qr = null;
    s.qrDataUrl = null;
    logFn(`[${id}] Sesión de WhatsApp cerrada.`);
  }
}

/**
 * Destruye el cliente actual y lo vuelve a crear.
 * Si no hay credenciales guardadas, genera un QR nuevo para vincular.
 */
export async function reiniciarSesion(sesionId = null) {
  const ids = sesionId ? [String(sesionId)] : [...sesiones.keys()];
  const reiniciadas = [];
  for (const id of ids) {
    const s = sesiones.get(id);
    if (!s) continue;
    if (s.vigilante) { clearInterval(s.vigilante); s.vigilante = null; }
    try { await s.client?.destroy(); } catch {}
    s.client = null;
    s.estado = 'iniciando';
    s.conectado = false;
    s.numero = null;
    s.qr = null;
    s.qrDataUrl = null;
    s.error = null;
    s.llamandoSync = false;
    s.autenticado = false;
    s.reintentos = 0;
    logFn(`[${id}] Reiniciando sesión de WhatsApp...`);
    crearSesion(id, { onMensaje: s.onMensaje, log: logFn }).catch(e => {
      const st = sesiones.get(id);
      if (st) { st.estado = 'desconectado'; st.error = e.message; }
      logFn(`No se pudo reiniciar la sesión ${id}: ${e.message}`);
    });
    reiniciadas.push(id);
  }
  return reiniciadas;
}

export function estadoWa() {
  return [...sesiones.values()].map(s => ({
    id: s.id,
    etiqueta: s.etiqueta,
    estado: s.estado,
    conectado: s.conectado,
    numero: s.numero,
    error: s.error,
    qr: s.estado === 'qr' ? s.qrDataUrl : null
  }));
}

export function hayConexion() {
  return config.modoPrueba || [...sesiones.values()].some(s => s.estado === 'conectado');
}

export function sesionDisponible(id) {
  if (config.modoPrueba) return true;
  if (id) {
    const s = sesiones.get(String(id));
    return !!s && s.estado === 'conectado';
  }
  return hayConexion();
}