import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { config } from './config.js';

const { Client, LocalAuth } = pkg;

/** id -> { id, estado, conectado, qr, qrDataUrl, numero, error, client, reintentos } */
export const sesiones = new Map();

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

export async function iniciarWhatsApp({ onMensaje, log, sesionIds = ['1'] }) {
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
      crearSesion(key, { onMensaje, log }).catch(e => {
        const s = sesiones.get(key);
        if (s) { s.estado = 'desconectado'; s.error = e.message; }
        log(`No se pudo iniciar la sesión ${key}: ${e.message}`);
      });
    }, espera);
  }
}

async function crearSesion(id, { onMensaje, log }) {
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
  await s.client.sendMessage(id._serialized, texto);
  return { ok: true, sesion: s.id };
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