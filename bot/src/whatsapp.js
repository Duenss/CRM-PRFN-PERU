import pkg from 'whatsapp-web.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { config, normalizar } from './config.js';
import { escribirAtomico } from './almacen.js';

const { Client, LocalAuth, MessageMedia } = pkg;

/**
 * Techo de tiempo para cualquier operación que cruza Puppeteer/WhatsApp Web.
 * `Promise.race` NO cancela la operación de Puppeteer (la deja en segundo
 * plano), pero desbloquea el pipeline: el job falla visible, la cola sigue y el
 * watchdog de queue.js evita que un cuelgue congele todo el bot.
 */
export function conTimeout(promesa, ms, etiqueta = 'operación de WhatsApp') {
  let timer = null;
  const reloj = new Promise((_, rechazar) => {
    timer = setTimeout(() => rechazar(new Error(`Timeout ${etiqueta} (${ms} ms)`)), ms);
    timer.unref?.();
  });
  return Promise.race([promesa, reloj]).finally(() => clearTimeout(timer));
}

/* ---------------- reconexión (backoff exponencial infinito) ---------------- */
// Solo para caídas de red/WhatsApp: 15 s → 30 s → 60 s → … hasta un tope de
// 5 min, con un ±20 % de ruido para no golpear siempre en el mismo instante.
// Los desvinculados por LOGOUT o los fallos de autenticación NO usan este
// bucle: se borra la sesión local y se genera un único QR (ver manejadores).
export const RECONEXION_BASE_MS = 15000;
export const RECONEXION_MAX_MS = 5 * 60 * 1000;

export function esperaReintentoMs(intento, { jitter = 0.2 } = {}) {
  const n = Math.max(1, Number(intento) || 1);
  let ms = Math.min(RECONEXION_MAX_MS, RECONEXION_BASE_MS * Math.pow(2, n - 1));
  if (jitter > 0) {
    const variacion = Math.round(ms * jitter * (Math.random() * 2 - 1));
    ms = Math.min(RECONEXION_MAX_MS, Math.max(RECONEXION_BASE_MS, ms + variacion));
  }
  return ms;
}

/** ¿El motivo del 'disconnected' es un desvinculado (LOGOUT) o una caída de red? */
export function clasificarDesconexion(motivo) {
  const m = String(motivo || '').toLowerCase();
  return /logout|logged\s?out|unpaired|desvincul/i.test(m) ? 'logout' : 'red';
}

/* ---------------- webVersionCache con fallback local ---------------- */
// whatsapp-web.js necesita el HTML de una versión concreta de WhatsApp Web.
// Antes se bajaba SIEMPRE de raw.githubusercontent (dependencia de un tercero
// en cada arranque). Ahora se guarda una copia local en bot/data y el remoto
// solo se consulta para refrescarla (cada 7 días o si falta): si no hay red,
// el bot arranca igual con la copia local.
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const WEB_VERSION_PIN = '2.3000.1053990023-alpha';
export const WEB_VERSION_URL = `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WEB_VERSION_PIN}.html`;
export const WEB_VERSION_CACHE = path.join(dataDir, 'web-version-cache.html');
export const WEB_VERSION_TTL_MS = 7 * 24 * 3600 * 1000;

function infoCacheWeb(ahoraMs = Date.now()) {
  try {
    const st = fs.statSync(WEB_VERSION_CACHE);
    if (st.isFile()) return { existe: true, edadMs: ahoraMs - st.mtimeMs, path: WEB_VERSION_CACHE };
  } catch { /* no existe */ }
  return { existe: false, edadMs: Infinity, path: WEB_VERSION_CACHE };
}

async function descargarVersionWeb() {
  try {
    const resp = await conTimeout(
      fetch(WEB_VERSION_URL, { signal: AbortSignal.timeout(10000) }),
      15000,
      'descargar versión web de WhatsApp'
    );
    if (!resp.ok) return null;
    const html = await conTimeout(resp.text(), 10000, 'leer versión web de WhatsApp');
    return html && html.includes('<html') ? html : null;
  } catch { return null; }
}

/** Resuelve la opción de webVersionCache: local (copia en disco) o remoto (último recurso). */
export async function resolverWebVersionCache(ahoraMs = Date.now()) {
  const cache = infoCacheWeb(ahoraMs);
  if (cache.existe && cache.edadMs < WEB_VERSION_TTL_MS) {
    return { type: 'local', path: cache.path };
  }
  const html = await descargarVersionWeb();
  if (html) {
    escribirAtomico(cache.path, html);
    return { type: 'local', path: cache.path };
  }
  if (cache.existe) {
    logFn(`Versión web de WhatsApp: sin red; se usa la copia local (${Math.round(cache.edadMs / 3600000)} h de antigüedad).`);
    return { type: 'local', path: cache.path };
  }
  logFn('Versión web de WhatsApp: sin copia local y sin red; se pedirá al repositorio remoto (último recurso).');
  return { type: 'remote', remotePath: WEB_VERSION_URL };
}

/** id -> { id, estado, conectado, qr, qrDataUrl, numero, error, client, reintentos } */
export const sesiones = new Map();

/** Avisa una sola vez en el log qué Chromium se va a usar. */
let chromiumLogeado = false;

/** Ids de mensajes que envió el propio bot (para no duplicarlos en 'message_create'). */
const enviadosPorBot = new Set();

/**
 * Mensajes salientes recién enviados por el bot, por texto. Cubre la carrera en
 * la que `message_create` llega ANTES de que `sendMessage` devuelva el id.
 */
const enviosRecientes = [];

function recordarEnvio(texto) {
  const t = String(texto || '').trim().slice(0, 1000);
  if (!t) return;
  enviosRecientes.push({ t, at: Date.now() });
  if (enviosRecientes.length > 120) enviosRecientes.shift();
}

function esEnvioPropioReciente(texto) {
  const t = String(texto || '').trim().slice(0, 1000);
  if (!t) return false;
  const i = enviosRecientes.findIndex(x => x.t === t && Date.now() - x.at < 90000);
  if (i < 0) return false;
  enviosRecientes.splice(i, 1);
  return true;
}

let logFn = console.log;

export function crearEstado(id) {
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
    reintentos: 0,
    msgKeyParche: false,
    // ---------------- estabilidad de conexión ----------------
    cerrada: false,           // logout manual: no se reconecta ni se revive
    sinAutoReintento: false,  // LOGOUT/auth_failure: un único QR, sin bucle
    reintentando: false,      // ya hay una reconexión programada o en curso
    reintentoTimer: null,
    fallosAuth: 0,
    ultimoMensajeEn: null,    // ISO del último mensaje RECIBIDO (salud/zombi)
    conectadoDesde: null,     // ISO del último 'ready'
    bloqueo: Promise.resolve(), // serializa crear/reiniciar/destruir por sesión
    timers: new Set(),        // timeouts/intervalos rastreados y cancelables
    vigilante: null,
    llamandoSync: false,
    autenticado: false,
    manejadores: null         // { onMensaje, onMensajePropio, onAck, log }
  };
}

/* ---------------- timers rastreados y lock por sesión ---------------- */
// Todos los timers de una sesión viven en s.timers: se cancelan en logout y
// reinicio para que una reconexión pendiente no "resucite" una sesión cerrada.
function sProgramar(s, fn, ms) {
  const t = setTimeout(() => { s.timers.delete(t); fn(); }, ms);
  s.timers.add(t);
  return t;
}

function sIntervalo(s, fn, ms) {
  const t = setInterval(fn, ms);
  s.timers.add(t);
  return t;
}

function cancelarTimersSesion(s) {
  for (const t of s.timers) { clearTimeout(t); clearInterval(t); }
  s.timers.clear();
  if (s.vigilante) { clearInterval(s.vigilante); s.vigilante = null; }
  if (s.reintentoTimer) { clearTimeout(s.reintentoTimer); s.reintentoTimer = null; }
  s.reintentando = false;
}

/** Serializa operaciones por sesión (crear/reiniciar/destruir): un solo Chrome a la vez. */
export function conBloqueoSesion(id, fn) {
  const s = sesiones.get(String(id));
  if (!s) return Promise.resolve().then(fn);
  const p = s.bloqueo.then(fn, fn);
  s.bloqueo = p.then(() => {}, () => {});
  return p;
}

/** Cierra el cliente actual con un tope de 10 s; si no cierra, mata el Chrome huérfano. */
async function destruirCliente(s) {
  const c = s.client;
  if (!c) return;
  s.client = null;
  try {
    await conTimeout(Promise.resolve(typeof c.destroy === 'function' ? c.destroy() : undefined), 10000, 'cerrar Chrome anterior');
  } catch (e) {
    try {
      const p = c.pupBrowser && typeof c.pupBrowser.process === 'function' ? c.pupBrowser.process() : null;
      if (p && typeof p.kill === 'function') p.kill('SIGKILL');
    } catch { /* proceso ya muerto */ }
    logFn(`[${s.id}] El Chrome anterior no cerró a tiempo; se forzó su cierre.`);
  }
}

/** Borra la sesión local guardada (LocalAuth): obliga a escanear un QR nuevo. */
function borrarSesionLocal(id) {
  const carpeta = path.join(config.sessionPath, `session-${id}`);
  try {
    fs.rmSync(carpeta, { recursive: true, force: true });
  } catch (e) {
    logFn(`[${id}] No se pudo borrar la sesión local (${e.message}); se reintentará al crear el cliente.`);
  }
}

/** Gancho SOLO para pruebas: permite inyectar una fábrica de clientes falsos. */
let fabricaClient = null;
export function _fabricaClientParaPruebas(fn) {
  if (typeof fn === 'function') fabricaClient = fn;
  return fabricaClient;
}

export async function iniciarWhatsApp({ onMensaje, onMensajePropio, onAck, log, sesionIds = ['1'] }) {
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
    const s = crearEstado(key);
    sesiones.set(key, s);
    const espera = retraso;
    retraso += 12000;
    sProgramar(s, () => {
      crearSesion(key, { onMensaje, onMensajePropio, onAck, log }).catch(e => {
        const st = sesiones.get(key);
        if (st) { st.estado = 'desconectado'; st.error = e.message; }
        log(`No se pudo iniciar la sesión ${key}: ${e.message}`);
      });
    }, espera);
  }
}

/**
 * WhatsApp Web cambió `MsgKey`: la propiedad `_serialized` ya no existe y ahora
 * la clave se obtiene con `toString()`. La librería whatsapp-web.js la usa para
 * cerrar el envío de multimedia y falla con
 * "Data passed to getter must include an id property".
 * Este parche restaura `_serialized` en el prototipo de `WAWebMsgKey`.
 */
async function parcharMsgKey(client, s) {
  if (!client?.pupPage) return false;
  try {
    const ok = await client.pupPage.evaluate(() => {
      try {
        const WK = window.require('WAWebMsgKey');
        if (WK && WK.prototype && !Object.getOwnPropertyDescriptor(WK.prototype, '_serialized')) {
          Object.defineProperty(WK.prototype, '_serialized', {
            configurable: true,
            get() { return this.toString(); }
          });
        }
        // El modelo de media actual trae campos internos (`__x_*`, `parent`,
        // `collection`) que, al mezclarse en el mensaje, rompen
        // addAndSendMsgToChat. Se devuelve solo el JSON limpio.
        const WW = window.WWebJS;
        if (WW && typeof WW.processMediaData === 'function' && !WW.__mediaLimpia) {
          const original = WW.processMediaData.bind(WW);
          WW.processMediaData = async function (mediaInfo, opciones) {
            const modelo = await original(mediaInfo, opciones);
            let json = {};
            try { json = modelo && typeof modelo.toJSON === 'function' ? modelo.toJSON() : (modelo || {}); } catch (e) { json = {}; }
            const limpio = { ...json };
            Object.defineProperty(limpio, 'toJSON', {
              value: () => ({ ...json }),
              enumerable: false,
              configurable: true
            });
            return limpio;
          };
          WW.__mediaLimpia = true;
        }
        return true;
      } catch (e) {
        return 'error: ' + ((e && e.message) || e);
      }
    });
    if (ok === true) {
      if (!s.msgKeyParche) logFn(`[${s.id}] Compatibilidad de multimedia aplicada (MsgKey).`);
      s.msgKeyParche = true;
      return true;
    }
    logFn(`[${s.id}] No se pudo aplicar el parche de MsgKey: ${ok}`);
    return false;
  } catch (e) {
    logFn(`[${s.id}] No se pudo aplicar el parche de MsgKey: ${e.message}`);
    return false;
  }
}

function esArchivo(p) {  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Encuentra un Chromium usable. Orden:
 *   1) CHROME_PATH (variables de entorno del servidor)
 *   2) PUPPETEER_EXECUTABLE_PATH
 *   3) Chromium del sistema (Debian/Ubuntu/Alpine/snap)
 *   4) Chromium incluido en la imagen (Playwright / caché de Puppeteer)
 * Si no encuentra ninguno devuelve '' y Puppeteer usa su propia resolución.
 * Esto hace que el bot arranque igual en Docker, en VPS o en Pterodactyl.
 */
export function buscarChromium() {
  const directos = [
    config.chromePath,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium'
  ];
  for (const c of directos) if (esArchivo(c)) return c;

  const raices = [
    '/ms-playwright',
    path.join(process.env.HOME || '/root', '.cache', 'puppeteer'),
    '/home/container/.cache/puppeteer'
  ];
  const relativos = [
    'chrome-linux/chrome',
    'chrome-linux64/chrome',
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-win64/chrome.exe',
    'chrome-win32/chrome.exe'
  ];
  for (const raiz of raices) {
    try {
      if (!fs.existsSync(raiz)) continue;
      for (const dir of fs.readdirSync(raiz)) {
        for (const rel of relativos) {
          const cand = path.join(raiz, dir, rel);
          if (esArchivo(cand)) return cand;
        }
      }
    } catch {
      /* carpeta ilegible: se prueba la siguiente */
    }
  }
  return '';
}

/**
 * Crea la sesión bajo el lock de la sesión: crearSesion y reiniciarSesion
 * nunca corren en paralelo (un solo Chrome por sesión).
 * `conReintentos:false` = no programar reconexión si initialize falla
 * (se usa tras LOGOUT/auth_failure: un único QR, sin bucle).
 */
export function crearSesion(id, manejadores = {}, opciones = {}) {
  return conBloqueoSesion(id, () => crearSesionSinLock(id, manejadores, opciones));
}

async function crearSesionSinLock(id, { onMensaje, onMensajePropio, onAck, log }, opciones = {}) {
  const s = sesiones.get(id);
  if (!s) return;
  if (s.cerrada) return;
  s.manejadores = { onMensaje, onMensajePropio, onAck, log: log || logFn };
  s.onMensaje = onMensaje;
  s.onMensajePropio = onMensajePropio;
  s.onAck = onAck;

  // Un solo Chrome por sesión: el cliente anterior se cierra antes de crear otro.
  await destruirCliente(s);
  if (s.cerrada) return;

  const cacheWeb = await resolverWebVersionCache();
  const opcionesWa = {
    authStrategy: new LocalAuth({ clientId: `sesion-${id}`, dataPath: config.sessionPath }),
    webVersionCache: cacheWeb,
    puppeteer: {
      headless: config.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  };
  const chromium = buscarChromium();
  if (chromium) opcionesWa.puppeteer.executablePath = chromium;
  if (!chromiumLogeado) {
    chromiumLogeado = true;
    logFn(`Chromium: ${chromium || 'el que resuelva Puppeteer por defecto'}`);
  }

  const client = fabricaClient ? fabricaClient(opcionesWa) : new Client(opcionesWa);
  s.client = client;
  s.estado = 'iniciando';
  s.msgKeyParche = false;

  client.on('qr', async qr => {
    if (s.cerrada || s.client !== client) return; // evento de un cliente viejo
    s.estado = 'qr';
    s.autenticado = false;
    s.qr = qr;
    try { s.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 520, errorCorrectionLevel: 'M' }); } catch {}
    log(`[${id}] QR generado (${qr.length} chars, inicia "${qr.slice(0, 14)}…"). Escanéalo desde el panel del bot.`);
    // Si la sesión se cayó y hay que volver a escanear, reactiva el vigilante.
    vigilarConexion(id, client, s);
  });

  client.on('authenticated', () => {
    if (s.cerrada || s.client !== client) return;
    if (!s.autenticado) log(`[${id}] WhatsApp autenticado.`);
    s.autenticado = true;
    vigilarConexion(id, client, s);
  });

  client.on('ready', () => {
    if (s.cerrada || s.client !== client) return;
    cancelarTimersSesion(s);
    s.estado = 'conectado';
    s.conectado = true;
    s.numero = client.info?.wid?.user || null;
    s.qr = null;
    s.qrDataUrl = null;
    s.error = null;
    s.reintentos = 0;
    s.fallosAuth = 0;
    s.sinAutoReintento = false;
    s.autenticado = true;
    s.conectadoDesde = new Date().toISOString();
    log(`[${id}] WhatsApp conectado como +${s.numero || 'desconocido'}.`);
    // WhatsApp Web nuevo: restaura MsgKey._serialized para poder enviar fotos.
    parcharMsgKey(client, s);
  });

  // Fallo de autenticación: la sesión local ya no sirve. Se borra y se genera
  // UN único QR nuevo, sin bucle de reintentos (si vuelve a fallar, se repite
  // una sola vez más y luego queda esperando el escaneo manual/reinicio).
  client.on('auth_failure', m => {
    if (s.cerrada || s.client !== client) return;
    s.fallosAuth = (s.fallosAuth || 0) + 1;
    s.estado = 'desconectado';
    s.conectado = false;
    s.error = String(m || 'Fallo de autenticación');
    log(`[${id}] Fallo de autenticación (${s.fallosAuth}): ${s.error}`);
    cancelarTimersSesion(s);
    s.sinAutoReintento = true;
    log(`[${id}] Se borra la sesión local y se genera un único QR nuevo (sin reintentos automáticos).`);
    borrarSesionLocal(id);
    destruirCliente(s).then(() => {
      if (s.cerrada) return;
      crearSesion(id, s.manejadores || {}, { conReintentos: false }).catch(e => {
        const st = sesiones.get(String(id));
        if (st) { st.estado = 'desconectado'; st.error = e.message; }
        logFn(`[${id}] No se pudo generar el QR nuevo: ${e.message}`);
      });
    });
  });

  client.on('disconnected', motivo => {
    if (s.cerrada || s.client !== client) return; // cerrado a propósito o cliente viejo
    const razon = String(motivo || '');
    s.estado = 'desconectado';
    s.conectado = false;
    s.numero = null;
    s.error = `Desconectado: ${razon}`;
    log(`[${id}] ${s.error}`);
    cancelarTimersSesion(s);
    if (s.sinAutoReintento) {
      log(`[${id}] Sin reintentos automáticos (QR pendiente de escanear).`);
      return;
    }
    if (clasificarDesconexion(razon) === 'logout') {
      // Desvinculado desde el celular (LOGOUT): borrar sesión local, un único QR.
      log(`[${id}] WhatsApp desvinculado (LOGOUT): se borra la sesión local y se genera un único QR nuevo.`);
      s.reintentos = 0;
      s.sinAutoReintento = true;
      borrarSesionLocal(id);
      destruirCliente(s).then(() => {
        if (s.cerrada) return;
        crearSesion(id, s.manejadores || {}, { conReintentos: false }).catch(e => {
          const st = sesiones.get(String(id));
          if (st) { st.estado = 'desconectado'; st.error = e.message; }
          logFn(`[${id}] No se pudo generar el QR nuevo: ${e.message}`);
        });
      });
      return;
    }
    // Caída de red/WhatsApp: backoff exponencial infinito (15 s → 5 min).
    programarReconexion(id, razon);
  });

  client.on('message', async msg => {
    if (s.cerrada || s.client !== client) return;
    s.ultimoMensajeEn = new Date().toISOString();
    try { await onMensaje(msg, id); }
    catch (e) { log(`[${id}] Error al procesar mensaje: ${e.message}`); }
  });

  // Mensajes creados por este número (los que envías tú desde el celular).
  // Los que manda el propio bot se descartan aquí para no duplicarlos.
  client.on('message_create', async msg => {
    if (s.cerrada || s.client !== client) return;
    try {
      // Descarta lo que acaba de enviar el propio bot (evita marcarlo como
      // mensaje del dueño y duplicarlo). Se comprueba por id y, como respaldo,
      // por texto, porque 'message_create' a veces llega antes que el id.
      const wid = idMensaje(msg);
      if (wid && enviadosPorBot.has(wid)) { enviadosPorBot.delete(wid); return; }
      if (esEnvioPropioReciente(msg.body)) return;
      if (onMensajePropio) await onMensajePropio(msg, id);
    } catch (e) { log(`[${id}] Error al procesar mensaje propio: ${e.message}`); }
  });

  // Estado de entrega/lectura (palomitas) de los mensajes salientes:
  // 0 pendiente · 1 enviado ✓ · 2 entregado ✓✓ · 3 leído ✓✓ azul.
  client.on('message_ack', async (msg, ack) => {
    if (s.cerrada || s.client !== client) return;
    try { if (onAck) await onAck(msg, ack, id); }
    catch (e) { log(`[${id}] Error al leer el estado del mensaje: ${e.message}`); }
  });

  // Arranca también un vigilante por si 'authenticated' nunca llega.
  vigilarConexion(id, client, s);

  try {
    await client.initialize();
  } catch (e) {
    if (s.cerrada) return;
    log(`[${id}] No se pudo iniciar la sesión: ${e.message}`);
    if (opciones.conReintentos === false) {
      s.estado = 'desconectado';
      s.error = e.message;
      return;
    }
    programarReconexion(id, `inicio fallido: ${e.message}`);
  }
}

/**
 * Caída de red/WhatsApp: programa la reconexión con backoff exponencial
 * infinito (15 s → 5 min). Se cancela con logout/reinicio (timers rastreados).
 */
function programarReconexion(id, motivo) {
  const s = sesiones.get(String(id));
  if (!s || s.cerrada || s.sinAutoReintento || s.reintentando) return;
  if (s.reintentoTimer) { clearTimeout(s.reintentoTimer); s.reintentoTimer = null; }
  s.reintentos = (s.reintentos || 0) + 1;
  const espera = esperaReintentoMs(s.reintentos);
  logFn(`[${id}] Reintentando conexión en ${Math.round(espera / 1000)} s (intento ${s.reintentos}, motivo: ${String(motivo || '').slice(0, 80)})…`);
  s.reintentando = true;
  s.reintentoTimer = sProgramar(s, () => {
    s.reintentoTimer = null;
    s.reintentando = false;
    reconectar(id).catch(e => logFn(`[${id}] Error al reconectar: ${e.message}`));
  }, espera);
}

async function reconectar(id) {
  const s = sesiones.get(String(id));
  if (!s || s.cerrada || s.sinAutoReintento) return;
  await conBloqueoSesion(id, async () => {
    const st = sesiones.get(String(id));
    if (!st || st.cerrada || st.sinAutoReintento) return;
    await crearSesionSinLock(id, st.manejadores || { onMensaje: st.onMensaje, onMensajePropio: st.onMensajePropio, onAck: st.onAck, log: logFn });
  });
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
  s.vigilante = sIntervalo(s, tick, 8000);
  sProgramar(s, tick, 3000);
}

function sesionParaEnviar(sesionId) {
  if (sesionId) {
    const s = sesiones.get(String(sesionId));
    if (s && s.estado === 'conectado') return s;
    return null;
  }
  return [...sesiones.values()].find(s => s.estado === 'conectado') || null;
}

/* ---------------- teléfono canónico (un cliente, un teléfono) ---------------- */
// WhatsApp identifica el mismo cliente con varios ids: 519…@c.us,
// 519…@s.whatsapp.net o un @lid opaco. telefonoCanonico los normaliza a UN
// teléfono único para que la Bandeja no duplique chats.
// Regla: un @lid SOLO se fusiona con un teléfono si el mapa lid→teléfono lo
// resolvió con certeza (al recibir/enviar mensajes o al resolverlo en la
// página); si no, queda como clave propia (`lid:…`) y nunca se confunde con
// otro número.

// Destinos @lid ya conocidos (el teléfono real puede no estar disponible):
// se envía directo al id del chat para no fallar con "no tiene WhatsApp".
const destinosLid = new Map();
// Mapa inverso lid→teléfono, poblado SOLO cuando la resolución es segura.
const lidATelefono = new Map();

export function recordarDestinoWa(telefono, wid) {
  const tel = String(telefono || '').replace(/\D/g, '');
  const id = String(wid || '');
  if (tel && /@lid$/.test(id)) {
    destinosLid.set(tel, id);
    const user = id.split('@')[0];
    if (user) lidATelefono.set(String(user), tel);
  }
}

/** Registra un lid→teléfono resuelto con certeza (desde la página de WhatsApp). */
export function recordarTelefonoDeLid(widSerializado, telefono) {
  const tel = String(telefono || '').replace(/\D/g, '');
  const [user, server] = String(widSerializado || '').split('@');
  if (server === 'lid' && user && /^\d{8,15}$/.test(tel)) lidATelefono.set(String(user), tel);
}

export function telefonoCanonico(waId, { mapa } = {}) {
  const s = String(waId || '').trim();
  if (!s) return '';
  const [user, server] = s.split('@');
  if (!server) {
    const t = normalizar(user);
    return /^\d{8,15}$/.test(t) ? t : '';
  }
  if (server === 'c.us' || server === 's.whatsapp.net') {
    const t = normalizar(user);
    return /^\d{8,15}$/.test(t) ? t : '';
  }
  if (server === 'lid') {
    const m = (mapa instanceof Map ? mapa : lidATelefono).get(String(user));
    if (m) {
      const t = normalizar(m);
      if (/^\d{8,15}$/.test(t)) return t;
    }
    return `lid:${user}`;
  }
  if (server === 'g.us') return `grupo:${user}`;
  return '';
}

function destinoConocido(limpio) {
  const w = destinosLid.get(String(limpio || ''));
  return w ? { _serialized: w } : null;
}

/**
 * Resuelve el destino de un envío:
 *  1) waId explícito (@lid o @c.us)
 *  2) LID recordado al recibir un mensaje
 *  3) getNumberId normal
 *  4) si el número no resuelve y parece LID, se envía directo a <numero>@lid
 */
async function idDestino(s, limpio, opciones = {}) {
  if (opciones && opciones.waId && /@(lid|c\.us)$/.test(String(opciones.waId))) {
    return { _serialized: String(opciones.waId) };
  }
  const conocido = destinoConocido(limpio);
  if (conocido) return conocido;
  try {
    const id = await conTimeout(s.client.getNumberId(limpio), 20000, 'getNumberId');
    if (id) return id;
  } catch (e) { /* se intenta por LID */ }
  if (/^\d{12,16}$/.test(String(limpio))) return { _serialized: `${limpio}@lid` };
  return null;
}

export async function enviar(telefono, texto, sesionId = null, opciones = {}) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (config.modoPrueba) {
    logFn(`[PRUEBA${sesionId ? ' ' + sesionId : ''}] Mensaje para +${limpio}: ${String(texto).slice(0, 160)}${String(texto).length > 160 ? '…' : ''}`);
    return { simulado: true };
  }

  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error(sesionId ? `La sesión ${sesionId} no está conectada` : 'Ningún WhatsApp está conectado');

  const id = await idDestino(s, limpio, opciones);
  if (!id) throw new Error(`El número +${limpio} no tiene WhatsApp`);
  recordarEnvio(texto);
  const opcionesWa = {};
  if (opciones && opciones.linkPreview && /https?:\/\//i.test(String(texto || ''))) opcionesWa.linkPreview = true;
  const enviado = await conTimeout(s.client.sendMessage(id._serialized, texto, opcionesWa), 60000, 'sendMessage');
  const waId = idMensaje(enviado);
  if (waId) {
    enviadosPorBot.add(waId);
    if (enviadosPorBot.size > 800) enviadosPorBot.delete(enviadosPorBot.values().next().value);
  }
  return { ok: true, sesion: s.id, waId };
}

/**
 * Envía una imagen por WhatsApp (foto de producto o plantilla de pago).
 * `media` acepta { url }, { archivo } o { base64, mimetype }.
 */
export async function enviarImagen(telefono, media = {}, caption = '', sesionId = null) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (!media || (!media.url && !media.archivo && !media.base64)) {
    throw new Error('No hay imagen para enviar.');
  }
  if (config.modoPrueba) {
    logFn(`[PRUEBA${sesionId ? ' ' + sesionId : ''}] Imagen para +${limpio}: ${String(caption || '').slice(0, 120)}`);
    return { simulado: true };
  }
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error(sesionId ? `La sesión ${sesionId} no está conectada` : 'Ningún WhatsApp está conectado');

  // Asegura la compatibilidad con el WhatsApp Web actual antes de enviar media.
  await conTimeout(parcharMsgKey(s.client, s), 25000, 'compatibilidad multimedia');

  const id = await idDestino(s, limpio);
  if (!id) throw new Error(`El número +${limpio} no tiene WhatsApp`);

  let mm;
  if (media.base64) {
    mm = new MessageMedia(media.mimetype || 'image/jpeg', media.base64, media.filename || 'imagen');
  } else if (media.archivo) {
    mm = MessageMedia.fromFilePath(media.archivo);
  } else {
    mm = await conTimeout(MessageMedia.fromUrl(media.url, { unsafeMime: true }), 30000, 'descargar imagen');
  }
  recordarEnvio(caption);
  const enviado = await conTimeout(
    s.client.sendMessage(id._serialized, mm, caption ? { caption: String(caption).slice(0, 1000) } : {}),
    90000,
    'sendMessage (imagen)'
  );
  const waId = idMensaje(enviado);
  if (waId) {
    enviadosPorBot.add(waId);
    if (enviadosPorBot.size > 800) enviadosPorBot.delete(enviadosPorBot.values().next().value);
  }
  return { ok: true, sesion: s.id, waId };
}

/**
 * Envía un video REPRODUCIBLE (con miniatura y botón de play), no como
 * documento. Usa solo { caption } para que WhatsApp lo trate como video.
 */
export async function enviarVideo(telefono, archivo, caption = '', sesionId = null) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (!archivo || !fs.existsSync(archivo)) throw new Error('No se encontró el video para enviar.');
  if (config.modoPrueba) {
    logFn(`[PRUEBA${sesionId ? ' ' + sesionId : ''}] Video para +${limpio}: ${String(caption || '').slice(0, 120)}`);
    return { simulado: true, tipo: 'video' };
  }
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error(sesionId ? `La sesión ${sesionId} no está conectada` : 'Ningún WhatsApp está conectado');
  await conTimeout(parcharMsgKey(s.client, s), 25000, 'compatibilidad multimedia');
  const id = await idDestino(s, limpio);
  if (!id) throw new Error(`El número +${limpio} no tiene WhatsApp`);
  const mm = MessageMedia.fromFilePath(archivo);
  recordarEnvio(caption);
  const enviado = await conTimeout(
    s.client.sendMessage(id._serialized, mm, { caption: String(caption || '').slice(0, 1000) }),
    120000,
    'sendMessage (video)'
  );
  const waId = idMensaje(enviado);
  if (waId) {
    enviadosPorBot.add(waId);
    if (enviadosPorBot.size > 800) enviadosPorBot.delete(enviadosPorBot.values().next().value);
  }
  return { ok: true, sesion: s.id, waId, tipo: String((enviado && enviado.type) || 'video') };
}

/** Envía un video/archivo local como documento de WhatsApp. */
export async function enviarArchivo(telefono, archivo, mimetype = 'video/mp4', nombre = 'archivo.mp4', caption = '', sesionId = null) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (!archivo || !fs.existsSync(archivo)) throw new Error('No se encontró el archivo para enviar.');
  if (config.modoPrueba) {
    logFn(`[PRUEBA${sesionId ? ' ' + sesionId : ''}] Archivo para +${limpio}: ${nombre}`);
    return { simulado: true };
  }
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error(sesionId ? `La sesión ${sesionId} no está conectada` : 'Ningún WhatsApp está conectado');
  await conTimeout(parcharMsgKey(s.client, s), 25000, 'compatibilidad multimedia');
  const id = await idDestino(s, limpio);
  if (!id) throw new Error(`El número +${limpio} no tiene WhatsApp`);
  const mm = MessageMedia.fromFilePath(archivo);
  recordarEnvio(caption);
  const enviado = await conTimeout(
    s.client.sendMessage(id._serialized, mm, { caption: String(caption || '').slice(0, 1000), sendMediaAsDocument: true }),
    120000,
    'sendMessage (archivo)'
  );
  const waId = idMensaje(enviado);
  if (waId) {
    enviadosPorBot.add(waId);
    if (enviadosPorBot.size > 800) enviadosPorBot.delete(enviadosPorBot.values().next().value);
  }
  return { ok: true, sesion: s.id, waId };
}
function telDe(item) {
  if (!item || item.isGroup) return '';
  const candidato = (item.id?.server === 'c.us' ? item.id?.user : '')
    || item.contact?.number || item.number || '';
  const tel = normalizar(candidato);
  return /^\d{8,15}$/.test(tel) ? tel : '';
}

/** Id crudo (clave) de un mensaje, consistente entre historial y eventos en vivo. */
export function idMensaje(msg) {
  if (!msg) return '';
  const id = msg.id;
  // Algunos envíos devuelven `id` como texto plano (no como MessageId).
  if (typeof id === 'string') return id;
  if (id && (id.id || id._serialized)) return id.id || id._serialized;
  const d = msg._data && msg._data.id;
  if (typeof d === 'string') return d;
  return (d && (d.id || d._serialized)) || '';
}

/** Dado el id de un chat (@lid o @c.us), devuelve el teléfono real (solo dígitos) o ''. */
// ---------- Lecturas de WhatsApp Web seguras ----------
// Una sola lectura a la vez (Chromium no admite bien dos evaluaciones en
// paralelo), esperando a que la página esté lista y reintentando si WhatsApp
// Web se recarga (error "Target closed").
let colaPagina = Promise.resolve();
function enColaPagina(fn) {
  const p = colaPagina.then(fn, fn);
  colaPagina = p.then(() => {}, () => {});
  return p;
}

/** Espera a que WhatsApp Web termine de cargar (readyState + lista de chats). */
async function esperarPagina(s, esperaMax = 25000) {
  const fin = Date.now() + esperaMax;
  while (Date.now() < fin) {
    const page = s && s.client && s.client.pupPage;
    if (page && (!page.isClosed || !page.isClosed())) {
      try {
        const ok = await page.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#pane-side'));
        if (ok) return true;
      } catch { /* recargando */ }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/** Evalúa en la página con cola, timeout y reintentos ante "Target closed". */
async function evalPagina(s, fn, arg, timeout = 30000, etiqueta = 'WhatsApp Web', intentos = 3) {
  let ultimo = null;
  for (let i = 1; i <= intentos; i++) {
    try {
      return await enColaPagina(async () => {
        const page = s && s.client && s.client.pupPage;
        if (!page || (page.isClosed && page.isClosed())) throw new Error('página de WhatsApp cerrada');
        return await conTimeout(page.evaluate(fn, arg), timeout, etiqueta);
      });
    } catch (e) {
      ultimo = e;
      const msg = String((e && e.message) || e);
      if (i < intentos && /target closed|session closed|detached|protocol error|página de whatsapp cerrada/i.test(msg)) {
        await new Promise(r => setTimeout(r, 1200 * i));
        continue;
      }
      throw e;
    }
  }
  throw ultimo || new Error('No se pudo leer WhatsApp Web');
}

export async function resolverTelefonoWa(widSerializado, sesionId = null) {
  const wid = String(widSerializado || '');
  if (!wid) return '';
  const [user, server] = wid.split('@');
  if (server === 'c.us') return normalizar(user);
  const s = sesionParaEnviar(sesionId) || [...sesiones.values()].find(x => x.client && x.client.pupPage);
  if (!s) return '';
  try {
    const real = await evalPagina(s, async (wid) => {
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
    }, wid, 15000, 'resolver teléfono');
    const tel = real ? normalizar(real) : '';
    if (tel) recordarTelefonoDeLid(wid, tel); // lid→teléfono resuelto con certeza
    return tel;
  } catch (e) {
    return '';
  }
}

/** ¿El texto es solo un número de teléfono (con +, espacios, guiones)? */
const pareceTelefonoWa = s => /^[+\d\s().-]+$/.test(String(s || '').trim());

/**
 * Nombre que conviene mostrar para un chat de WhatsApp:
 * - Empresa: su nombre verificado (aunque el título sea el teléfono).
 * - Persona: el título del chat (pushname, p. ej. "@Jvampi"), salvo que sea solo un teléfono.
 */
function nombreMostradoWa({ titulo = '', pushname = '', verifiedName = '', nombreGuardado = '', esEmpresa = false }) {
  const t = String(titulo || '').trim();
  const p = String(pushname || '').trim();
  const v = String(verifiedName || '').trim();
  const g = String(nombreGuardado || '').trim();
  if (esEmpresa && v) return v;
  if (t && !pareceTelefonoWa(t)) return t;
  if (p && !pareceTelefonoWa(p)) return p;
  return v || g || t || p || '';
}

/** Da forma final a los chats crudos (wrapper o lectura directa de página). */
function formatearChatsWa(crudos, propioNumero) {
  return (Array.isArray(crudos) ? crudos : [])
    .map(c => {
      // Si lo último es solo una reacción (sin mensaje real), no le damos fecha:
      // así cae al fondo y no desplaza a las conversaciones reales.
      const t = c.real === false ? 0 : (c.tsReal || c.ts);
      const nombreWa = nombreMostradoWa({
        titulo: c.nombre || '',
        pushname: c.pushname || '',
        verifiedName: c.verifiedName || '',
        nombreGuardado: c.nombreGuardado || '',
        esEmpresa: !!c.esEmpresa
      });
      const idSerial = String(c.id || '');
      const telGrupo = c.esGrupo ? idSerial.split('@')[0].replace(/\D/g, '') : '';
      return {
        telefono: c.esGrupo ? telGrupo : telDe({ isGroup: false, number: c.tel }),
        waiver: '',
        grupo: !!c.esGrupo,
        waId: idSerial,
        nombre: nombreWa,
        nombreWa,
        nombreGuardado: String(c.nombreGuardado || '').trim(),
        pushname: String(c.pushname || '').trim(),
        verifiedName: String(c.verifiedName || '').trim(),
        esEmpresa: !!c.esEmpresa,
        tipo: c.esEmpresa ? 'empresa' : 'persona',
        ultimoTexto: String(c.ultimoTexto || '').slice(0, 300),
        ultimoEn: t ? new Date(t * 1000).toISOString() : null,
        noLeidos: c.noLeidos || 0,
        pin: !!c.pin,
        archived: c.archived === true,
        tieneMensajes: c.tieneMensajes !== false,
        real: c.real !== false,
        tsReal: c.tsReal || 0
      };
    })
    .filter(c => !!c.telefono);
}

/** Todos los chats del WhatsApp vinculado (no solo los que vio el bot). */
export async function listarChatsWa(sesionId = null) {
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error('Ningún WhatsApp está conectado');

  await esperarPagina(s);

  // WhatsApp Web carga la lista de chats por partes. Se baja la lista para
  // que cargue todo el historial conocido (así aparecen todos los chats, no
  // solo los primeros que ya estaban en memoria).
  try {
    await evalPagina(s, async () => {
      const pane = document.querySelector('#pane-side');
      if (!pane) return;
      const W = window;
      const total = () => {
        try { return W.require('WAWebCollections').Chat.getModelsArray().length; } catch (e) { return 0; }
      };
      let anterior = -1;
      let estable = 0;
      for (let i = 0; i < 120; i++) {
        try { pane.scrollTop = pane.scrollHeight; } catch (e) { break; }
        await new Promise(r => setTimeout(r, 400));
        const n = total();
        if (n === anterior) estable++; else { anterior = n; estable = 0; }
        if (estable >= 4) break;       // dejó de crecer: ya está toda la lista
      }
    }, undefined, 120000, 'cargar lista de chats');
  } catch { /* si no se puede, se sigue con lo cargado */ }

  let crudos;
  try {
    // Vía normal: el wrapper de whatsapp-web.js.
    const chats = await conTimeout(s.client.getChats(), 180000, 'getChats');
    crudos = chats.map(c => {
      const esEmpresa = !!(c.contact?.isBusiness || c.contact?.isEnterprise || c.contact?.businessProfile);
      const nombreGuardado = c.contact?.name || '';
      const pushname = c.contact?.pushname || '';
      const verifiedName = c.contact?.verifiedName || c.contact?.businessProfile?.name || '';
      const nombreWa = nombreMostradoWa({ titulo: c.formattedTitle || c.name || '', pushname, verifiedName, nombreGuardado, esEmpresa });
      const ultimo = c.lastMessage || null;
      let ultimoTexto = String((ultimo && (ultimo.body || ultimo.caption)) || '').trim();
      if (!ultimoTexto && ultimo) {
        const mapaUltimo = { image: '[imagen]', video: '[video]', audio: '[audio]', ptt: '[nota de voz]',
          document: '[documento]', sticker: '[sticker]', location: '[ubicación]', vcard: '[contacto]',
          multi_vcard: '[contactos]', poll_creation: '[encuesta]', event_creation: '[evento]' };
        ultimoTexto = mapaUltimo[String(ultimo.type || '')] || (ultimo.hasMedia ? '[archivo]' : '');
      }
      const tieneMensajes = !!(ultimo || c.unreadCount || (c.msgs && c.msgs.length));
      return {
        tel: c.id?.server === 'c.us' ? c.id?.user : (c.contact?.number || c.contact?.phoneNumber?._serialized?.split('@')[0] || ''),
        lid: c.id?.server === 'lid' ? String(c.id?.user || '') : '',
        id: String(c.id?._serialized || ''),
        esGrupo: !!c.isGroup,
        nombre: nombreWa,
        nombreWa,
        nombreGuardado,
        pushname,
        verifiedName,
        esEmpresa,
        ultimoTexto,
        tieneMensajes,
        ts: c.timestamp || ultimo?.timestamp || ultimo?.t || 0,
        tsReal: 0,
        guardado: c.contact?.isMyContact === true || c.isMyContact === true,
        pin: !!(c.pinned === true || c.isPinned === true),
        archived: c.archived === true || c.isArchived === true || c.archive === true,
        real: true,
        noLeidos: c.unreadCount || 0
      };
    });
  } catch {
    // Respaldo: `client.getChats()` falla en algunas versiones de WhatsApp Web
    // cuando un solo chat no se puede serializar. Leemos la colección directo,
    // toleramos chats problemáticos y resolvemos el número real de cada chat
    // (los chats nuevos usan identificadores @lid y no traen el teléfono).
    crudos = await evalPagina(s, async () => {
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
            let nombreGuardado = '';
            let pushname = '';
            let verifiedName = '';
            let esEmpresa = false;
            try {
              nombre = c.formattedTitle || c.name || (c.contact && (c.contact.pushname || c.contact.name)) || '';
              nombreGuardado = (c.contact && (c.contact.name || c.contact.shortName)) || '';
              pushname = (c.contact && c.contact.pushname) || '';
              verifiedName = (c.contact && (c.contact.verifiedName || (c.contact.businessProfile && c.contact.businessProfile.name))) || '';
              esEmpresa = !!(c.contact && (c.contact.isBusiness || c.contact.isEnterprise || c.contact.businessProfile));
            } catch (e) {}
            let ultimoTexto = '';
            let ts = 0;
            let tsReal = 0;
            let real = true;
            try {
              const esReaccion = m => String((m && m.type) || '') === 'reaction' || !!(m && m.isNotification);
              const cuerpo = m => {
                if (!m) return '';
                const tipo = String(m.type || '');
                const cap = String(m.caption || '').trim();
                if (cap) return cap;
                if (!tipo || tipo === 'chat' || tipo === 'text') return String(m.body || '').trim();
                return '';
              };
              const tieneContenido = m => !!cuerpo(m) || !!(m && m.hasMedia);
              const buscarReal = arr => {
                for (let i = arr.length - 1; i >= 0; i--) {
                  const m = arr[i];
                  if (!m || esReaccion(m)) continue;
                  if (tieneContenido(m)) return m;
                }
                return null;
              };
              let lista = (c.msgs && c.msgs.getModelsArray && c.msgs.getModelsArray()) || [];
              let ultimoReal = buscarReal(lista);
              // Si lo cargado son solo reacciones, busca más atrás para confirmar
              // si el chat tiene algún mensaje real (evita ocultar chats válidos).
              if (!ultimoReal && lista.length > 0) {
                let vueltas = 0;
                while (vueltas < 4) {
                  vueltas++;
                  let cargados = null;
                  try { cargados = await W.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat: c }); } catch (e) { cargados = null; break; }
                  if (!cargados || !cargados.length) break;
                  lista = [...cargados.filter(m => m && !m.isNotification), ...lista];
                  ultimoReal = buscarReal(lista);
                  if (ultimoReal) break;
                }
              }
              if (ultimoReal) {
                tsReal = ultimoReal.t || 0;
                ultimoTexto = cuerpo(ultimoReal) || (ultimoReal.hasMedia ? '[archivo]' : '');
              }
              ts = c.t || c.timestamp || (c.lastMessage && (c.lastMessage.t || c.lastMessage.timestamp)) || tsReal || 0;
              if (!ultimoTexto && c.lastMessage && !esReaccion(c.lastMessage)) ultimoTexto = cuerpo(c.lastMessage);
              // Sin mensaje real (solo reacciones) => no es una conversación real.
              real = !!ultimoReal || lista.length === 0;
            } catch (e) {}
            let pin = false;
            let archived = false;
            try {
              pin = !!(c.pin || c.pinned || c.isPinned);
              archived = !!(c.archive || c.archived || c.isArchived);
            } catch (e) {}
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
                  if (phone && phone._serialized) {
                    tel = String(phone._serialized).split('@')[0];
                    if (c.id && c.id.user) recordarTelefonoDeLid(`${c.id.user}@lid`, tel);
                  }
                } catch (e) {}
              }
            }

            out.push({
              id: String((c.id && c.id._serialized) || ''),
              tel,
              lid: server === 'lid' ? String((c.id && c.id.user) || '') : '',
              esGrupo,
              nombre: String(nombre || ''),
              nombreWa: String(nombre || ''),
              nombreGuardado: String(nombreGuardado || ''),
              pushname: String(pushname || ''),
              verifiedName: String(verifiedName || ''),
              esEmpresa,
              ultimoTexto: String(ultimoTexto || ''),
              ts,
              tsReal,
              pin,
              archived,
              real,
              tieneMensajes: !!(ultimoReal || (lista && lista.length && ultimoTexto)),
              noLeidos
            });
          } catch (e) {}
        }
      } catch (e) {}
      return out;
    }, undefined, 180000, 'getChats (respaldo)');
  }

  // WhatsApp Web no trae el último mensaje de todos los chats hasta abrirlos.
  // Para los que vienen vacíos se lee el último mensaje real desde la página
  // (cargando anteriores si hace falta). Así se descartan los chats sin
  // conversación y se muestra el texto real de los demás.
  try {
    const vacios = crudos.filter(c => !String(c.ultimoTexto || '').trim() && c.id).map(c => c.id);
    if (vacios.length) {
      const enriquecidos = await evalPagina(s, async (ids) => {
        const W = window;
        const out = {};
        let ChatCol = null;
        try { ChatCol = W.require('WAWebCollections').Chat; } catch (e) { ChatCol = null; }
        if (!ChatCol || !ChatCol.get) return out;
        const mapa = {
          image: '[imagen]', video: '[video]', audio: '[audio]', ptt: '[nota de voz]',
          document: '[documento]', sticker: '[sticker]', location: '[ubicación]', vcard: '[contacto]'
        };
        for (const id of ids) {
          try {
            const chat = ChatCol.get(id);
            if (!chat) continue;
            let msgs = (chat.msgs && chat.msgs.getModelsArray && chat.msgs.getModelsArray()) || [];
            const real = () => {
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (!m || String(m.type || '') === 'reaction' || m.isNotification) continue;
                if (m.body || m.caption || m.hasMedia) return m;
              }
              return null;
            };
            let m = real();
            let vueltas = 0;
            while (!m && vueltas < 3) {
              vueltas++;
              try {
                const cargados = await W.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
                if (!cargados || !cargados.length) break;
                msgs = [...cargados.filter(x => x && !x.isNotification), ...msgs];
                m = real();
              } catch (e) { break; }
            }
            if (!m) continue;
            const texto = String(m.caption || m.body || '').trim() || mapa[String(m.type || '')] || (m.hasMedia ? '[archivo]' : '');
            if (texto) out[id] = texto.slice(0, 300);
          } catch (e) { /* chat problemático */ }
        }
        return out;
      }, vacios, 90000, 'enriquecer chats');
      let puestos = 0;
      for (const c of crudos) {
        if (c.id && enriquecidos && enriquecidos[c.id] && !String(c.ultimoTexto || '').trim()) {
          c.ultimoTexto = enriquecidos[c.id];
          puestos++;
        }
      }
      if (puestos) console.log('[chats] último mensaje recuperado en', puestos, 'chats');
    }
  } catch (e) { /* si falla, se sigue con lo que haya */ }

  // Chats con identificador @lid (número oculto en el chat): se resuelve el
  // teléfono real para que la Bandeja los pueda importar.
  const sinTel = crudos.filter(c => !c.esGrupo && !c.tel && c.lid);
  if (sinTel.length) {
    await Promise.all(sinTel.map(async c => {
      try {
        const tel = await resolverTelefonoWa(`${c.lid}@lid`, sesionId);
        if (tel) c.tel = tel;
      } catch { /* se queda sin número y se omite */ }
    }));
  }

  const propio = normalizar(s.numero);
  return formatearChatsWa(crudos, propio);
}

/**
 * Listado INCREMENTAL de chats: solo los que tienen actividad posterior a
 * `desdeMs` (timestamp del chat o de su último mensaje). Lee directo de la
 * página SIN bajar la lista completa ni serializar con `getChats()`: es la
 * lectura barata que usa la sincronización periódica anti-bloqueo (15-30 min).
 * Si la lectura ligera falla, cae al listado completo (más pesado, pero seguro).
 */
export async function listarChatsActivosWa(desdeMs = 0, sesionId = null) {
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error('Ningún WhatsApp está conectado');
  const corte = Math.max(0, Number(desdeMs) || 0);
  if (!corte) return listarChatsWa(sesionId); // sin corte: lista completa
  await esperarPagina(s);
  try {
    const crudos = await evalPagina(s, async ({ desdeTs }) => {
      const out = [];
      const W = window;
      let widFactory;
      try { widFactory = W.require('WAWebWidFactory'); } catch (e) {}
      let col;
      try { col = W.require('WAWebCollections'); } catch (e) { return out; }
      const arr = (col.Chat && col.Chat.getModelsArray && col.Chat.getModelsArray()) || [];
      for (const c of arr) {
        try {
          const t = (c.t || 0) || (c.lastMessage && (c.lastMessage.t || 0)) || 0;
          if (!(t >= desdeTs)) continue; // solo actividad nueva
          const server = c.id && c.id.server;
          const esGrupo = server === 'g.us' || !!c.groupMetadata;
          let nombre = '';
          let nombreGuardado = '';
          let pushname = '';
          let verifiedName = '';
          let esEmpresa = false;
          try {
            nombre = c.formattedTitle || c.name || (c.contact && (c.contact.pushname || c.contact.name)) || '';
            nombreGuardado = (c.contact && (c.contact.name || c.contact.shortName)) || '';
            pushname = (c.contact && c.contact.pushname) || '';
            verifiedName = (c.contact && (c.contact.verifiedName || (c.contact.businessProfile && c.contact.businessProfile.name))) || '';
            esEmpresa = !!(c.contact && (c.contact.isBusiness || c.contact.isEnterprise || c.contact.businessProfile));
          } catch (e) {}
          let ultimoTexto = '';
          try {
            const lm = c.lastMessage;
            if (lm) {
              ultimoTexto = String(lm.caption || '').trim();
              if (!ultimoTexto && (!lm.type || lm.type === 'chat' || lm.type === 'text')) ultimoTexto = String(lm.body || '').trim();
            }
          } catch (e) {}
          let tel = '';
          if (!esGrupo) {
            try {
              const pn = c.contact && c.contact.phoneNumber;
              if (pn && pn._serialized) tel = String(pn._serialized).split('@')[0];
            } catch (e) {}
            if (!tel && server === 'c.us' && c.id && c.id.user) tel = String(c.id.user);
            if (!tel && server === 'lid' && widFactory) {
              try {
                const wid = widFactory.createWid((c.id && c.id._serialized) || '');
                let phone = null;
                try { phone = W.require('WAWebApiContact').getPhoneNumber(wid); } catch (e) {}
                if (!phone && W.WWebJS && W.WWebJS.enforceLidAndPnRetrieval) {
                  const r = await W.WWebJS.enforceLidAndPnRetrieval((c.id && c.id._serialized) || '');
                  phone = r && r.phone;
                }
                if (phone && phone._serialized) tel = String(phone._serialized).split('@')[0];
              } catch (e) {}
            }
          }
          out.push({
            id: String((c.id && c.id._serialized) || ''),
            tel,
            lid: server === 'lid' ? String((c.id && c.id.user) || '') : '',
            esGrupo,
            nombre: String(nombre || ''),
            nombreWa: String(nombre || ''),
            nombreGuardado: String(nombreGuardado || ''),
            pushname: String(pushname || ''),
            verifiedName: String(verifiedName || ''),
            esEmpresa,
            ultimoTexto: String(ultimoTexto || ''),
            ts: t,
            tsReal: t,
            real: true,
            tieneMensajes: true,
            pin: !!(c.pin || c.pinned || c.isPinned),
            archived: !!(c.archive || c.archived || c.isArchived),
            noLeidos: c.unreadCount || 0
          });
        } catch (e) { /* chat problemático: se omite */ }
      }
      return out;
    }, { desdeTs: corte / 1000 }, 90000, 'listar chats activos');

    // Los @lid resueltos a teléfono se recuerdan en el mapa lid→teléfono
    // (en contexto Node, no dentro de la página).
    for (const c of crudos) {
      if (c.tel && c.lid) recordarTelefonoDeLid(`${c.lid}@lid`, c.tel);
    }
    const propio = normalizar(s.numero);
    return formatearChatsWa(crudos, propio);
  } catch {
    // Respaldo: si la lectura ligera falla, se cae al listado completo.
    return listarChatsWa(sesionId);
  }
}

/** Todos los contactos guardados/iniciados en el WhatsApp vinculado. */
export async function listarContactosWa(sesionId = null) {
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error('Ningún WhatsApp está conectado');
  const contactos = await conTimeout(s.client.getContacts(), 300000, 'getContacts');
  const propio = normalizar(s.numero);
  const porTel = new Map();
  for (const c of contactos) {
    if (c.isGroup || c.id?.server !== 'c.us') continue;
    const tel = telDe(c);
    if (!tel || tel === propio) continue;
    const nombre = String(c.name || c.pushname || c.shortName || '').trim();
    const guardado = c.isMyContact === true;
    const previo = porTel.get(tel);
    if (!previo || (!previo.nombre && nombre)) {
      porTel.set(tel, { telefono: tel, nombre, guardado, nombreGuardado: String(c.name || '').trim() });
    } else if (guardado && !previo.guardado) {
      porTel.set(tel, { ...previo, guardado, nombreGuardado: String(c.name || '').trim() });
    }
  }
  return [...porTel.values()];
}

/** Historial reciente de un chat, leído directo de WhatsApp. */
/**
 * Consulta tri-estado de un número (anti-bloqueo):
 *  - `{ existe: true }`  → getNumberId devolvió un id limpio.
 *  - `{ existe: false }` → getNumberId resolvió null LIMPIAMENTE (no existe).
 *  - LANZA en timeout, sesión caída o red: el llamador debe tratarlo como
 *    error de infraestructura y NUNCA como "sin WhatsApp".
 */
export async function consultarNumeroWa(telefono, sesionId = null) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (!limpio) throw new Error('Número inválido para consultar');
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error('Ningún WhatsApp está conectado');
  const id = await conTimeout(s.client.getNumberId(limpio), 15000, 'consultarNumeroWa');
  return { existe: !!id };
}

/**
 * Valida si un número (de cualquier país) existe en WhatsApp (booleano).
 * Mantiene la semántica histórica (false ante cualquier error) para los
 * llamadores que solo necesitan sí/no; la validación anti-bloqueo usa
 * `consultarNumeroWa` para distinguir "no existe" de "error".
 */
export async function verificarNumeroWa(telefono, sesionId = null) {
  try {
    return (await consultarNumeroWa(telefono, sesionId)).existe;
  } catch {
    return false;
  }
}

export async function historialWa(telefono, limite = 50, sesionId = null) {
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error('Ningún WhatsApp está conectado');
  const limpio = String(telefono || '').replace(/\D/g, '');
  await esperarPagina(s);
  let numId = null;
  try {
    numId = await conTimeout(s.client.getNumberId(limpio), 20000, 'getNumberId');
  } catch (e) {
    // Timeout/sesión/red: NUNCA equivale a "no tiene WhatsApp". El llamador
    // debe distinguirlo por código y no marcar el número como inexistente.
    const err = new Error('No se pudo consultar el número en WhatsApp (error de sesión o red)');
    err.codigo = 'ERROR_WA';
    throw err;
  }
  // getNumberId resolvió limpio a null: el número no está registrado.
  if (!numId) {
    const err = new Error(`El número +${limpio} no tiene WhatsApp`);
    err.codigo = 'SIN_WA';
    throw err;
  }
  const chatId = numId._serialized;
  if (!chatId) {
    const err = new Error(`El número +${limpio} no tiene WhatsApp`);
    err.codigo = 'SIN_WA';
    throw err;
  }
  // Se lee directo de la página y sin serializar: `getChatById`/`fetchMessages`
  // de whatsapp-web.js fallan ("r") al serializar chats en la versión actual.
  const msgs = await evalPagina(s, async ({ chatId, limite }) => {
    const W = window;
    const filtro = m => !m.isNotification;
    let chat = null;
    try { chat = await W.WWebJS.getChat(chatId, { getAsModel: false }); } catch (e) { chat = null; }
    if (!chat) return null;
    let lista = (chat.msgs && chat.msgs.getModelsArray && chat.msgs.getModelsArray()) || [];
    lista = lista.filter(filtro);
    const tope = Math.min(160, Math.max(1, limite));
    let vueltas = 0;
    while (lista.length < tope && vueltas < 14) {
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
        const tipo = String(m.type || '');
        let texto = String(m.caption || '').trim();
        if (!texto && (!tipo || tipo === 'chat' || tipo === 'text')) texto = String(m.body || '').trim();
        if (!texto) {
          texto = ({
            image: '[imagen]', video: '[video]', audio: '[audio]', ptt: '[nota de voz]',
            document: `[documento]${m.filename ? ' ' + m.filename : ''}`, sticker: '[sticker]',
            location: '[ubicación]', vcard: '[contacto]', multi_vcard: '[contactos]'
          })[tipo] || (m.hasMedia ? '[archivo]' : '');
        }
        const idObj = m.id || {};
        const waId = idObj.id || idObj._serialized || (m.key && m.key.id) || '';
        if (!texto) return null;
        if (waId) { if (vistos.has(waId)) return null; vistos.add(waId); }
        const saliente = !!(m.id && m.id.fromMe);
        return {
          waId,
          direccion: saliente ? 'saliente' : 'entrante',
          texto: texto.slice(0, 4000),
          en: m.t ? new Date(m.t * 1000).toISOString() : new Date().toISOString(),
          ...(saliente ? { ack: Number.isFinite(Number(m.ack)) ? Number(m.ack) : 0 } : {})
        };
      })
      .filter(Boolean);
  }, { chatId, limite }, 90000, 'historialWa');
  if (msgs === null) {
    const err = new Error('Este número no tiene conversación en WhatsApp');
    err.codigo = 'SIN_CHAT';
    throw err;
  }
  return msgs || [];
}

export async function cerrarSesion(sesionId) {
  const ids = sesionId ? [String(sesionId)] : [...sesiones.keys()];
  for (const id of ids) {
    const s = sesiones.get(id);
    if (!s) continue;
    // Marca ANTES de cerrar: el 'disconnected' que dispara logout/destroy no
    // debe programar reconexiones ni regenerar QRs.
    s.cerrada = true;
    cancelarTimersSesion(s);
    try { await conTimeout(Promise.resolve(s.client?.logout()), 10000, 'logout de WhatsApp'); } catch {}
    await destruirCliente(s);
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
 * Corre bajo el lock de la sesión: nunca dos Chromes en paralelo.
 */
export async function reiniciarSesion(sesionId = null) {
  const ids = sesionId ? [String(sesionId)] : [...sesiones.keys()];
  const reiniciadas = [];
  for (const id of ids) {
    const s = sesiones.get(id);
    if (!s) continue;
    // Reactiva la sesión (por si se cerró o quedó en "sin reintentos").
    s.cerrada = false;
    s.sinAutoReintento = false;
    s.fallosAuth = 0;
    s.reintentos = 0;
    cancelarTimersSesion(s);
    s.estado = 'iniciando';
    s.conectado = false;
    s.numero = null;
    s.qr = null;
    s.qrDataUrl = null;
    s.error = null;
    s.llamandoSync = false;
    s.autenticado = false;
    logFn(`[${id}] Reiniciando sesión de WhatsApp...`);
    // Fire-and-forget bajo el lock: la ruta responde enseguida y el QR llega
    // por SSE/estado cuando el cliente nuevo lo genere.
    conBloqueoSesion(id, () => crearSesionSinLock(id, s.manejadores || { onMensaje: s.onMensaje, onMensajePropio: s.onMensajePropio, onAck: s.onAck, log: logFn }))
      .catch(e => {
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

/* ---------------- salud de sesión (detección de sesión zombi) ---------------- */
// Una sesión "zombi" está en estado 'conectado' pero no recibe mensajes hace
// más del umbral (por defecto 10 min, configurable con SALUD_ZOMBI_SEGUNDOS):
// el socket puede estar muerto sin que 'disconnected' haya llegado. NO se
// reinicia nada automáticamente: solo se avisa (health + problemas del panel).
export function umbralZombiMs() {
  return Math.max(60, Number(process.env.SALUD_ZOMBI_SEGUNDOS) || 600) * 1000;
}

export function esZombi(s, ahoraMs = Date.now(), umbralMs = umbralZombiMs()) {
  if (!s || s.estado !== 'conectado') return false;
  const desde = Date.parse(s.conectadoDesde || '');
  if (!Number.isFinite(desde) || ahoraMs - desde <= umbralMs) return false; // conectado hace poco
  const ultimo = Date.parse(s.ultimoMensajeEn || '');
  if (!Number.isFinite(ultimo)) return true; // nunca recibió mensajes desde que conectó
  return ahoraMs - ultimo > umbralMs;
}

export function estadoSalud(ahoraMs = Date.now()) {
  const umbralMs = umbralZombiMs();
  const lista = [...sesiones.values()].map(s => {
    const conectado = s.estado === 'conectado';
    let segundosSinMensaje = null;
    const ultimo = Date.parse(s.ultimoMensajeEn || '');
    if (Number.isFinite(ultimo)) segundosSinMensaje = Math.max(0, Math.round((ahoraMs - ultimo) / 1000));
    return {
      id: s.id,
      estado: s.estado,
      conectado,
      numero: conectado ? s.numero : null,
      ultimoMensajeEn: s.ultimoMensajeEn || null,
      segundosSinMensaje,
      zombi: esZombi(s, ahoraMs, umbralMs)
    };
  });
  return {
    zombi: lista.some(x => x.zombi),
    sesiones: lista,
    umbralSegundos: Math.round(umbralMs / 1000)
  };
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

/**
 * Descarga la multimedia de un mensaje (audio, imagen, etc.) directamente de la
 * página. `msg.downloadMedia()` de whatsapp-web.js falla aquí ("r") porque usa el
 * id serializado, que en esta versión de WhatsApp Web viene vacío para los envíos
 * en vivo; por eso leemos los datos de descarga del propio mensaje.
 */
export async function descargarMediaWa(msg, sesionId = null) {
  const s = sesionParaEnviar(sesionId);
  if (!s) throw new Error('Ningún WhatsApp está conectado');
  const d = (msg && msg._data) || {};
  const idRaw = (d.id && d.id.id) || (msg && msg.id && msg.id.id) || '';
  const remote = (d.id && d.id.remote) || (msg && msg.id && msg.id.remote) || '';
  const fromMe = (d.id && typeof d.id.fromMe === 'boolean') ? d.id.fromMe : !!(msg && msg.fromMe);
  const id = (d.id && d.id._serialized) || (msg && msg.id && msg.id._serialized) ||
    (remote ? `${fromMe ? 'true' : 'false'}_${remote}_${idRaw}` : '');
  const chatId = remote || (msg && msg.from) || '';
  const ts = d.t || (msg && msg.timestamp) || 0;
  const datos = {
    directPath: d.directPath || '',
    encFilehash: d.encFilehash || '',
    filehash: d.filehash || '',
    mediaKey: d.mediaKey || '',
    mediaKeyTimestamp: d.mediaKeyTimestamp || 0,
    type: d.type || '',
    mimetype: d.mimetype || ''
  };
  return await evalPagina(s, async ({ id: msgId, chatId, idRaw, ts, datos }) => {
    const W = window;
    try {
      const col = W.require('WAWebCollections');
      let m = null;
      try { if (msgId) m = col.Msg.get(msgId); } catch (e) {}
      if (!m && msgId) {
        try {
          const r = await col.Msg.getMessagesById([msgId]);
          m = (r && r.messages && r.messages[0]) || null;
        } catch (e) {}
      }
      // Respaldo: buscar el mensaje dentro del chat (por id crudo o por hora).
      if (!m && chatId) {
        try {
          const chat = await W.WWebJS.getChat(chatId, { getAsModel: false });
          const lista = (chat && chat.msgs && chat.msgs.getModelsArray && chat.msgs.getModelsArray()) || [];
          for (let i = lista.length - 1; i >= 0; i--) {
            const cand = lista[i];
            if (!cand || !cand.directPath) continue;
            if ((idRaw && cand.id && cand.id.id === idRaw) || (ts && Math.abs((cand.t || 0) - ts) <= 2)) { m = cand; break; }
          }
        } catch (e) {}
      }
      if (m) {
        try {
          const etapa = m.mediaData && m.mediaData.mediaStage;
          if (etapa && etapa !== 'RESOLVED' && etapa !== 'REUPLOADING') {
            await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
          }
        } catch (e) {}
        datos.directPath = m.directPath || datos.directPath;
        datos.encFilehash = m.encFilehash || datos.encFilehash;
        datos.filehash = m.filehash || datos.filehash;
        datos.mediaKey = m.mediaKey || datos.mediaKey;
        datos.mediaKeyTimestamp = m.mediaKeyTimestamp || datos.mediaKeyTimestamp;
        datos.type = m.type || datos.type;
        datos.mimetype = m.mimetype || datos.mimetype;
      }
      if (!datos.directPath || !datos.mediaKey) {
        return { error: 'sin datos de descarga', tipo: datos.type, hallado: !!m };
      }
      const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
      const decrypted = await W.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
        directPath: datos.directPath,
        encFilehash: datos.encFilehash,
        filehash: datos.filehash,
        mediaKey: datos.mediaKey,
        mediaKeyTimestamp: datos.mediaKeyTimestamp,
        type: datos.type,
        mimetype: datos.mimetype,
        signal: new AbortController().signal,
        downloadQpl: mockQpl
      });
      const data = await W.WWebJS.arrayBufferToBase64Async(decrypted);
      return { data, mimetype: datos.mimetype };
    } catch (e) {
      return { error: (e && (e.message || String(e))) || 'error al descargar', tipo: datos.type, hallado: false };
    }
  }, { id, chatId, idRaw, ts, datos }, 60000, 'descargar multimedia');
}
