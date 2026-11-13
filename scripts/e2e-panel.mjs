#!/usr/bin/env node
/**
 * e2e-panel.mjs — Arnés E2E del panel REAL (index.html) de Perfumería Fina.
 *
 * Qué hace:
 *   1. Sirve el `index.html` real del repo en http://127.0.0.1:8099 (sin tocar la app).
 *   2. Levanta un BOT SIMULADO en http://127.0.0.1:3199 con todos los endpoints que
 *      consume el panel, incluido `GET /api/stream` (SSE) con el guion de eventos:
 *      hola, mensaje entrante, ack, campana y derivación.
 *   3. Abre Chromium con Puppeteer y siembra en localStorage:
 *        - bot_url = http://127.0.0.1:3199
 *        - sesión falsa de Supabase en `sb-pcesvmsewfpvmqmfmswn-auth-token`
 *   4. Intercepta https://pcesvmsewfpvmqmfmswn.supabase.co/** con fixtures
 *      (clientes, productos, plantillas, campanas, envios) y el refresh de auth.
 *      El script de supabase-js del CDN se sirve desde `bot/node_modules` (offline).
 *   5. Verifica con asserts:
 *        - 0 errores de consola JS y 0 pageerror.
 *        - login oculto / app visible y sesión de Supabase aceptada.
 *        - todas las pestañas abren sin excepciones.
 *        - SSE de mensaje se AGREGA al hilo sin remover nodos previos.
 *        - ack/campana/derivación no reemplazan el hilo.
 *        - el scroll del hilo se conserva si el usuario está arriba.
 *        - 20 s idle: 0 mutaciones en #in-list/#in-msgs, 0 requests a /api/eventos,
 *          ≤2 requests por endpoint y 0 reloads REST.
 *        - un fallo de red del bot no borra la lista ya pintada (y muestra aviso).
 *        - TOKEN_REFRESHED de Supabase no recarga la app (0 GET REST, 0 re-render).
 *   6. Guarda capturas en docs/auditoria/capturas/ y un JSON con el resultado.
 *
 * Uso:
 *   node scripts/e2e-panel.mjs                 # corrida completa
 *   node scripts/e2e-panel.mjs --self-test     # valida mock/SSE/fixtures sin navegador
 *   node scripts/e2e-panel.mjs --headed        # navegador visible (debug)
 *   node scripts/e2e-panel.mjs --idle-ms=5000  # acorta la ventana idle (dev)
 *
 * Requisitos: Node >= 20 (probado en v24.16.0), `bot/node_modules/puppeteer` con su
 * Chromium instalado. Si Chromium no puede arrancar (sandbox del agente), el script
 * lo detecta, explica la causa y sale con código 3.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/* ========================================================================
 * 0. Rutas y configuración
 * ====================================================================== */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PANEL_FILE = path.join(ROOT, 'index.html');
const SHOTS_DIR = path.join(ROOT, 'docs', 'auditoria', 'capturas');
const BOT_PKG_PATH = path.join(ROOT, 'bot', 'package.json');
const BOT_NODE_MODULES = path.join(ROOT, 'bot', 'node_modules');
const SUPABASE_JS_UMD = path.join(BOT_NODE_MODULES, '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');

const SUPABASE_ORIGIN = 'https://pcesvmsewfpvmqmfmswn.supabase.co';
const SUPABASE_AUTH_KEY = 'sb-pcesvmsewfpvmqmfmswn-auth-token';
const SUPABASE_CDN_RE = /cdn\.jsdelivr\.net\/.*supabase/i;
// PNG de 1×1 px para simular multimedia sin binarios externos.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Fecha LOCAL (YYYY-MM-DD): los filtros del panel y los pedidos usan el día
// local, no el UTC. Usar toISOString() aquí hacía fallar los E2E de fechas
// después de las 19:00 hora de Perú (UTC-5).
const fechaLocal = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const ARGS = parseArgs(process.argv.slice(2));
const PANEL_PORT = Number(process.env.E2E_PANEL_PORT || 8099);
const BOT_PORT = Number(process.env.E2E_BOT_PORT || 3199);
const IDLE_MS = clampInt(ARGS.idleMs ?? process.env.E2E_IDLE_MS ?? 20000, 3000, 120000);
const PANEL_BASE = `http://127.0.0.1:${PANEL_PORT}`;
const BOT_BASE = `http://127.0.0.1:${BOT_PORT}`;

/* ========================================================================
 * 1. Utilidades
 * ====================================================================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { selfTest: false, headed: false, help: false, idleMs: null, capturas: false };
  for (const a of argv) {
    if (a === '--self-test') out.selfTest = true;
    else if (a === '--headed') out.headed = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--capturas') out.capturas = true;
    else if (a.startsWith('--idle-ms=')) out.idleMs = Number(a.slice('--idle-ms='.length));
    else if (a === '--full') { /* compat: la corrida ya es completa */ }
    else console.warn(`[e2e] argumento ignorado: ${a}`);
  }
  return out;
}

function clampInt(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function readIndexInfo() {
  const buf = fs.readFileSync(PANEL_FILE);
  const st = fs.statSync(PANEL_FILE);
  return { bytes: buf.length, sha256: sha256(buf), mtime: st.mtime.toISOString(), buf };
}

function jsonResponse(status, obj, extraHeaders = {}) {
  // Nota: evitamos 204/304 en las respuestas que pasan por CDP (Fetch.fulfillRequest);
  // un 200 con cuerpo vacío o JSON es equivalente para el cliente y más robusto.
  return {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
    body: obj === undefined ? '' : JSON.stringify(obj),
  };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = err => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    setTimeout(resolve, 1500).unref?.();
  });
}

function png1x1() {
  // PNG 1x1 transparente (base64 fija, sin dependencias).
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
}

/* ========================================================================
 * 2. Sesión falsa de Supabase (formato validado contra supabase-js v2)
 * ====================================================================== */
function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }

function makeAuthUser() {
  const iso = new Date().toISOString();
  return {
    id: '00000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'qa.e2e@perfumeriafina.test',
    email_confirmed_at: iso,
    phone: '',
    confirmed_at: iso,
    last_sign_in_at: iso,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { nombre: 'QA E2E' },
    identities: [],
    created_at: iso,
    updated_at: iso,
    is_anonymous: false,
  };
}

function makeSession(user, { offsetSec = 3600, refreshToken = 'e2e-refresh-token' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const iat = now;
  const exp = now + offsetSec;
  const accessToken = [
    b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({ sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, exp, iat }),
    'e2e-firma-no-verificada',
  ].join('.');
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: offsetSec,
    expires_at: exp,
    refresh_token: refreshToken,
    user,
  };
}

/* ========================================================================
 * 3. Fixtures Supabase (lo que el panel pide al arrancar y al abrir pestañas)
 * ====================================================================== */
function makeFixtures() {
  const clientes = [
    { id: 'c1', nombre: 'María Fernanda Quispe', telefono: '51910418951', etiquetas: ['vip'], consentimiento: true, baja: false, activo: true, fecha_cumpleanos: '1995-04-12', ultima_compra: '2026-10-02', notas: 'Prefiere Yape', fecha_consentimiento: '2026-01-10' },
    { id: 'c2', nombre: 'Carlos Ramos', telefono: '51987654321', etiquetas: ['recompra'], consentimiento: true, baja: false, activo: true, fecha_cumpleanos: '1990-11-23', ultima_compra: '2026-09-18', notas: null, fecha_consentimiento: '2026-02-01' },
    { id: 'c3', nombre: 'Lucía Torres', telefono: '51955512345', etiquetas: [], consentimiento: false, baja: false, activo: true, fecha_cumpleanos: null, ultima_compra: null, notas: null, fecha_consentimiento: null },
    { id: 'c4', nombre: 'Ana Beltrán', telefono: '51944488877', etiquetas: ['baja'], consentimiento: false, baja: true, activo: true, fecha_cumpleanos: '1988-02-05', ultima_compra: '2026-05-30', notas: 'Pidió no recibir promos', fecha_baja: '2026-06-01' },
  ];
  const productos = [
    { id: 'p1', codigo: 'PF-001', nombre: 'Árabe Blanco', casa_inspirada: 'Creed Aventus', precio_50ml: 45, precio_100ml: 70, activo: true, imagen_ruta: 'productos/arabe-blanco.jpg', familia: 'amaderado' },
    { id: 'p2', codigo: 'PF-002', nombre: 'Noche de Damasco', casa_inspirada: 'Dior Sauvage', precio_50ml: 50, precio_100ml: 80, activo: true, imagen_ruta: 'productos/noche-damasco.jpg', familia: 'cítrico' },
    { id: 'p3', codigo: 'PF-003', nombre: 'Rosa Imperial', casa_inspirada: 'Chanel N°5', precio_50ml: 55, precio_100ml: 90, activo: true, imagen_ruta: 'productos/rosa-imperial.jpg', familia: 'floral' },
    { id: 'p4', codigo: 'PF-004', nombre: 'Descontinuado', casa_inspirada: 'X', precio_50ml: 10, precio_100ml: 15, activo: false, imagen_ruta: '', familia: 'otro' },
  ];
  const plantillas = [
    { id: 't1', nombre: 'Promo general', texto: 'Hola {nombre}, tenemos una promoción especial para ti.', creado_en: '2026-01-01T10:00:00Z' },
    { id: 't2', nombre: 'Recompra', texto: 'Hola {nombre}, ya pasó un tiempo desde tu última compra.', creado_en: '2026-02-01T10:00:00Z' },
  ];
  const campanas = [
    { id: 'k1', titulo: 'Promo Día de la Madre', estado: 'programada', fecha_programada: '2026-11-20T15:00:00Z', mensaje_final: 'Promo especial', creado_en: '2026-10-01T10:00:00Z' },
    { id: 'k2', titulo: 'Recompra Octubre', estado: 'enviada', fecha_programada: '2026-10-01T15:00:00Z', mensaje_final: 'Vuelve por tu perfume', creado_en: '2026-09-25T10:00:00Z' },
  ];
  return { clientes, productos, plantillas, campanas, envios: [] };
}

/* ========================================================================
 * 4. Bot simulado (HTTP + SSE)
 * ====================================================================== */
function createBotMock() {
  const fixtures = makeFixtures();
  const user = makeAuthUser();

  const state = {
    requests: [],            // {ts, method, path, query}
    sseClients: new Set(),
    sseWaiters: [],
    offline: null,           // 'conversaciones' | null (fallo de red simulado)
    eventos: [],
    evSeq: 0,
    ia: { activa: true, autoRespuesta: true, maxPorConversacion: 0, prompt: '', pausados: [] },
    mediaEnviados: 0,
    logs: ['[e2e] bot simulado iniciado', '[e2e] WhatsApp conectado (mock)'],
  };

  /* ---- conversaciones fixture ---- */
  const nowMs = Date.now();
  const isoAgo = mins => new Date(nowMs - mins * 60000).toISOString();
  // Fechas "recientes" que SIEMPRE caen en el día local actual (evita que el
  // test de rangos falle si la corrida empieza justo después de medianoche).
  const inicioHoyMs = (() => { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const isoHoy = mins => new Date(Math.max(nowMs - mins * 60000, inicioHoyMs + 60000)).toISOString();
  // Reloj FIJO para los eventos SSE: si usáramos "ahora" en cada emisión, el texto
  // HH:MM de la lista cambiaría al cruzar el minuto durante la ventana de idle y el
  // panel repintaría (falso positivo). Con timestamp fijo el HTML es estable.
  const clockISO = new Date(nowMs).toISOString();

  function seedMessages() {
    const msgs = [];
    for (let i = 0; i < 30; i++) {
      const saliente = i % 3 === 2;
      msgs.push({
        id: `m-e2e-${i}`,
        waId: saliente ? `wamid.OUT.E2E.${i}` : `wamid.IN.E2E.${i}`,
        direccion: saliente ? 'saliente' : 'entrante',
        texto: saliente ? `Respuesta del bot #${i}` : `Mensaje del cliente #${i}: consulta sobre perfumes`,
        origen: saliente ? 'bot' : 'cliente',
        estado: 'ok',
        en: isoAgo(120 - i * 3),
        ...(saliente ? { ack: 3 } : {}),
      });
    }
    // Mensajes de multimedia para probar la visualización en el hilo:
    // 1) imagen nueva con miniatura, 2) video antiguo con solo marcador.
    msgs.push({
      id: 'm-e2e-media', waId: 'wamid.IN.E2E.MEDIA', direccion: 'entrante',
      texto: '[imagen]', origen: 'cliente', estado: 'ok', en: isoAgo(1.5),
      media: { tipo: 'imagen', tipoWa: 'image', mimetype: 'image/png', bytes: 68, thumb: 'data:image/png;base64,' + PNG_1PX },
    });
    msgs.push({
      id: 'm-e2e-video-legacy', waId: 'wamid.IN.E2E.VIDEO', direccion: 'entrante',
      texto: '[video]', origen: 'cliente', estado: 'ok', en: isoAgo(1),
    });
    return msgs;
  }

  const chats = [
    {
      telefono: '51910418951',
      nombre: 'María Fernanda Quispe',
      nombreWa: 'María Fernanda',
      nombreGuardado: 'María Fernanda Quispe',
      esEmpresa: false,
      tipo: 'persona',
      clienteId: 'c1',
      noLeidos: 2,
      ultimoTexto: 'Mensaje del cliente #29: consulta sobre perfumes',
      ultimoEn: isoHoy(2),
      pin: false,
      wa: true,
      mensajes: seedMessages(),
      seguimiento: { activo: false, items: [] },
      etiquetas: [{ tipo: 'ok', texto: 'vip' }],
    },
    {
      telefono: '51987654321',
      nombre: 'Carlos Ramos',
      nombreWa: 'Carlos',
      nombreGuardado: 'Carlos Ramos',
      esEmpresa: true,
      tipo: 'empresa',
      clienteId: 'c2',
      noLeidos: 0,
      ultimoTexto: 'Gracias, lo reviso',
      ultimoEn: isoHoy(60),
      pin: false,
      wa: true,
      mensajes: [
        { id: 'c-1', waId: 'wamid.C.1', direccion: 'entrante', texto: '¿Tienen envío a Arequipa?', origen: 'cliente', estado: 'ok', en: isoAgo(75) },
        { id: 'c-2', waId: 'wamid.C.2', direccion: 'saliente', texto: 'Sí, llegamos a todo el Perú. Gracias, lo reviso', origen: 'bot', estado: 'ok', en: isoAgo(60), ack: 3 },
      ],
      seguimiento: { activo: true, items: [] },
      etiquetas: [],
    },
    {
      telefono: '51955512345',
      nombre: 'Lucía Torres',
      nombreWa: 'Lucía',
      nombreGuardado: 'Lucía Torres',
      esEmpresa: false,
      tipo: 'persona',
      clienteId: 'c3',
      noLeidos: 1,
      ultimoTexto: '¿Cuánto cuesta el de 100 ml?',
      ultimoEn: isoHoy(20),
      pin: false,
      wa: true,
      mensajes: [
        { id: 'l-1', waId: 'wamid.L.1', direccion: 'entrante', texto: '¿Cuánto cuesta el de 100 ml?', origen: 'cliente', estado: 'ok', en: isoAgo(20) },
      ],
      seguimiento: { activo: false, items: [] },
      etiquetas: [],
    },
    {
      // Chat antiguo: permite probar el filtro por rango de fechas.
      telefono: '51966677788',
      nombre: 'Cliente Antiguo',
      nombreWa: 'Cliente Antiguo',
      nombreGuardado: 'Cliente Antiguo',
      esEmpresa: false,
      tipo: 'persona',
      clienteId: null,
      noLeidos: 0,
      ultimoTexto: 'Gracias por la info',
      ultimoEn: isoAgo(40 * 24 * 60),
      pin: false,
      wa: true,
      mensajes: [
        { id: 'a-1', waId: 'wamid.A.1', direccion: 'entrante', texto: '¿Tienen algo parecido a Sauvage?', origen: 'cliente', estado: 'ok', en: isoAgo(40 * 24 * 60 + 5) },
        { id: 'a-2', waId: 'wamid.A.2', direccion: 'saliente', texto: 'Gracias por la info', origen: 'bot', estado: 'ok', en: isoAgo(40 * 24 * 60), ack: 3 },
      ],
      seguimiento: { activo: false, items: [] },
      etiquetas: [],
    },
  ];

  const findChat = tel => chats.find(c => c.telefono === String(tel));

  function resumen() {
    const hoy = fechaLocal();
    return {
      chats: chats.length,
      noLeidos: chats.reduce((n, c) => n + (c.noLeidos || 0), 0),
      mensajesHoy: chats.reduce((n, c) => n + c.mensajes.filter(m => String(m.en).startsWith(hoy)).length, 0),
    };
  }

  /**
   * Listado de conversaciones con el MISMO criterio que el bot real
   * (`conversaciones.listar()`): pin primero y luego `ultimoEn` descendente.
   * Estado único: los eventos SSE mutan los mismos objetos que sirve el REST,
   * así el HTML que pinta el panel es idéntico entre SSE y polling (sin parpadeo).
   */
  function listarChats(limite = 40) {
    return [...chats]
      .sort((a, b) => (Number(!!b.pin) - Number(!!a.pin)) || (Date.parse(b.ultimoEn) - Date.parse(a.ultimoEn)))
      .slice(0, limite)
      .map(c => ({
        telefono: c.telefono,
        nombre: c.nombre,
        nombreWa: c.nombreWa,
        nombreGuardado: c.nombreGuardado,
        esEmpresa: c.esEmpresa,
        tipo: c.tipo,
        clienteId: c.clienteId,
        noLeidos: c.noLeidos,
        ultimoTexto: c.ultimoTexto,
        ultimoEn: c.ultimoEn,
        ultimaDireccion: (c.mensajes[c.mensajes.length - 1] || {}).direccion || '',
        total: c.mensajes.length,
        pin: c.pin,
        wa: c.wa,
        pausado: state.ia.pausados.some(x => x.telefono === c.telefono),
        seguimiento: c.seguimiento.activo,
        etiquetas: c.etiquetas,
      }));
  }

  const iaEstado = () => ({
    activa: !!state.ia.activa,
    autoRespuesta: !!state.ia.autoRespuesta,
    maxPorConversacion: Number(state.ia.maxPorConversacion) || 0,
    prompt: String(state.ia.prompt || ''),
    pausados: state.ia.pausados,
    actualizado: new Date().toISOString(),
  });

  const dias = n => {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      out.push({ fecha: d.toISOString().slice(0, 10), entrantes: (i * 3) % 7, salientes: (i * 2) % 5 });
    }
    return out;
  };

  /* ---- SSE ---- */
  function emit(obj) {
    const event = { id: ++state.evSeq, en: new Date().toISOString(), ...obj };
    state.eventos.push(event);
    if (state.eventos.length > 200) state.eventos.shift();
    const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of state.sseClients) {
      try { res.write(frame); } catch { /* cliente cerrado */ }
    }
    return event;
  }

  function emitHola() { return emit({ tipo: 'hola', mensaje: 'conexión SSE establecida' }); }

  function emitMensaje(tel, texto, extra = {}) {
    const chat = findChat(tel) || chats[0];
    const msg = {
      waId: `wamid.E2E.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`,
      id: `e2e-${Date.now()}`,
      direccion: 'entrante',
      texto,
      origen: 'cliente',
      estado: 'ok',
      en: clockISO,
      ...extra,
    };
    chat.mensajes.push(msg);
    chat.ultimoTexto = texto;
    chat.ultimoEn = msg.en;
    chat.noLeidos = (chat.noLeidos || 0) + 1;
    return emit({ tipo: 'mensaje', telefono: chat.telefono, nombre: chat.nombre, noLeidos: chat.noLeidos, mensaje: msg });
  }

  function emitAck(tel) {
    const chat = findChat(tel) || chats[0];
    const out = [...chat.mensajes].reverse().find(m => m.direccion === 'saliente' && m.waId);
    if (!out) return null;
    out.ack = 3;
    return emit({ tipo: 'ack', telefono: chat.telefono, waId: out.waId, ack: 3 });
  }

  function emitLeido(tel) {
    const chat = findChat(tel) || chats[0];
    chat.noLeidos = 0;
    return emit({ tipo: 'leido', telefono: chat.telefono });
  }

  function emitCampana() {
    return emit({ tipo: 'campana', campanaId: 'k1', estado: 'enviando', enviados: 5, total: 20 });
  }

  function emitDerivacion(tel) {
    const chat = findChat(tel) || chats[0];
    return emit({
      tipo: 'derivacion',
      telefono: chat.telefono,
      nombre: chat.nombre,
      motivo: 'Consulta compleja (mock)',
      mensaje: 'Quiere coordinar pago manual',
    });
  }

  function emitPedido(tel) {
    const chat = findChat(tel) || chats[0];
    return emit({ tipo: 'pedido', telefono: chat.telefono, nombre: chat.nombre, pedidoId: 'ped-e2e-1', detalle: '2× Árabe Blanco 100 ml' });
  }

  async function emitGuion(tel) {
    emitHola();
    await sleep(150);
    emitMensaje(tel, 'Hola, ¿tienen el perfume Árabe?');
    await sleep(300);
    emitAck(tel);
    await sleep(300);
    emitCampana();
    await sleep(300);
    emitDerivacion(tel);
  }

  /* ---- HTTP ---- */
  function json(res, status, obj, extra = {}) {
    res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
  }

  function failIfOffline(req, res, p) {
    if (state.offline === 'conversaciones' && p.startsWith('/api/conversaciones')) {
      // Fallo de red real: cortamos el socket (fetch -> TypeError, sin respuesta HTTP).
      try { req.socket.destroy(); } catch { /* noop */ }
      return true;
    }
    return false;
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, BOT_BASE);
    const p = u.pathname;
    const method = req.method || 'GET';
    state.requests.push({
      ts: Date.now(),
      method,
      path: p,
      query: Object.fromEntries(u.searchParams),
      token: req.headers['x-bot-token'] || '',
    });

    if (method === 'OPTIONS') {
      if (failIfOffline(req, res, p)) return;
      res.writeHead(204, CORS_HEADERS); res.end(); return;
    }

    if (failIfOffline(req, res, p)) return;

    /* SSE */
    if (p === '/api/stream') {
      res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(': conectado\n\n');
      state.sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
      req.on('close', () => { clearInterval(ping); state.sseClients.delete(res); });
      const waiters = state.sseWaiters.splice(0);
      for (const w of waiters) w();
      return;
    }

    /* estado / QR */
    if (p === '/api/estado') {
      json(res, 200, {
        sesiones: [{ id: 'e2e', etiqueta: 'QA E2E', conectado: true, numero: '51910418951', estado: 'ready' }],
        conectado: true,
        cola: 0,
        programadas: 1,
        enviadosHoy: 7,
        maxPorDia: 80,
        autoRespuesta: true,
        modoPrueba: true,
        dentroHorario: true,
        horario: { inicio: '08:00', fin: '21:00', lunesASabado: false },
        delay: { min: 2, max: 6 },
        ia: iaEstado(),
        chats: resumen(),
        version: '1.0.0-e2e',
      });
      return;
    }
    if (p === '/api/qr') {
      if (u.searchParams.get('sesion') === 'sin-qr') return json(res, 404, { error: 'No hay QR disponible' });
      const png = png1x1();
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(png.length) });
      res.end(png);
      return;
    }
    if (p === '/api/campanas') return json(res, 200, { campanas: fixtures.campanas });
    if (p === '/api/clientes') return json(res, 200, { clientes: fixtures.clientes });
    if (p === '/api/logs') return json(res, 200, { logs: state.logs.slice(-120) });
    if (p === '/api/eventos') {
      const desde = Number(u.searchParams.get('desde')) || 0;
      return json(res, 200, { eventos: state.eventos.filter(e => e.id > desde), ultimo: state.evSeq });
    }

    /* IA */
    if (p === '/api/ia') return json(res, 200, iaEstado());
    if (p === '/api/ia/pausar') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let j = {}; try { j = JSON.parse(body || '{}'); } catch { /* noop */ }
        const tel = String(j.telefono || '').replace(/\D/g, '');
        if (j.pausado === false) state.ia.pausados = state.ia.pausados.filter(x => x.telefono !== tel);
        else state.ia.pausados.push({ telefono: tel, nombre: j.nombre || '', motivo: j.motivo || '', desde: new Date().toISOString() });
        json(res, 200, iaEstado());
      });
      return;
    }

    /* pedidos */
    if (p === '/api/pedidos') {
      const hoyISO = fechaLocal(new Date(nowMs));
      return json(res, 200, {
        pedidos: [
          {
            id: 'P-0001', telefono: '51987654321', nombre: 'Carlos Ramos', estado: 'por_entregar',
            entrega: 'estacion', estacion: 'Estación Central', fechaEntrega: hoyISO,
            items: [{ cantidad: 1, nombre: 'Noche de Damasco', ml: 100, precio: 70 }],
            total: 70, saldo: 70, metodo: 'efectivo', actualizado: new Date(nowMs - 3600e3).toISOString(),
          },
          {
            id: 'P-0002', telefono: '51955512345', nombre: 'Lucía Torres', estado: 'comprobante_recibido',
            creadoEn: new Date(nowMs).toISOString(),
            entrega: 'delivery', fechaEntrega: '',
            items: [{ cantidad: 1, nombre: 'Árabe Blanco', ml: 50, precio: 45 }],
            total: 45, saldo: 0, metodo: 'yape', actualizado: new Date(nowMs - 2 * 3600e3).toISOString(),
          },
        ],
        resumen: { abiertos: 2, ventasEntregadas: 0 },
        estados: ['borrador', 'esperando_pago', 'comprobante_recibido', 'por_entregar', 'entregado', 'cancelado'],
        metodos: ['yape', 'plin', 'transferencia', 'efectivo', 'otro'],
      });
    }
    if (/^\/api\/pedidos\/[^/]+$/.test(p)) return json(res, 200, { ok: true, pedido: { id: p.split('/').pop() } });

    /* pagos */
    if (p === '/api/pagos') return json(res, 200, { plantillas: [] });

    /* archivos configurables (PDF, video y foto subidos desde Ajustes) */
    if (p === '/api/archivos') {
      return json(res, 200, { ok: true, archivos: { pdf: { personalizado: false, nombre: '', bytes: 0 }, video: { personalizado: false, nombre: '', bytes: 0 }, foto: { personalizado: false, nombre: '', bytes: 0 } } });
    }

    /* ajustes de límites y tiempos */
    if (p === '/api/ajustes') {
      if (method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let j = {}; try { j = JSON.parse(body || '{}'); } catch { /* noop */ }
          state.ajustesPanel = { ...(state.ajustesPanel || {}), ...j };
          json(res, 200, { ok: true, ajustes: state.ajustesPanel });
        });
        return;
      }
      return json(res, 200, {
        ajustes: {
          maxPorDia: 0, maxRespuestasPorChat: 0,
          intervaloMin: 25, intervaloMax: 40,
          intervaloEntreChats: 5, intervaloMasivo: 30,
          horaInicio: 9, horaFin: 20,
          metaVentasMes: 0, promociones: [], respuestasRapidas: [],
          actualizado: new Date().toISOString(),
          ...(state.ajustesPanel || {})
        }
      });
    }

    /* anuncios */
    if (p === '/api/anuncios') {
      return json(res, 200, {
        anuncios: [],
        resumen: { total: 0, porEstado: { borrador: 0, enviando: 0, enviado: 0, cancelado: 0 }, mensajesEnviados: 0 },
        filtros: ['todos', 'etiquetas', 'telefonos'],
        estados: ['borrador', 'enviando', 'enviado', 'cancelado'],
      });
    }
    if (p === '/api/anuncios/preview') return json(res, 200, { total: 3, sinConsentimiento: 1, ejemplos: [] });
    if (/^\/api\/anuncios\/[^/]+\/enviar$/.test(p)) return json(res, 200, { ok: true, cola: 1 });
    if (/^\/api\/anuncios\/[^/]+$/.test(p)) return json(res, 200, { ok: true, anuncio: { id: p.split('/').pop(), estado: 'borrador' } });

    /* seguimiento */
    if (/^\/api\/seguimiento(\/[^/]+)?$/.test(p)) return json(res, 200, { activo: false, items: [] });

    /* analíticas / estadísticas */
    if (p === '/api/analiticas') {
      return json(res, 200, {
        ok: true,
        chats: resumen(),
        analizados: 123,
        dias: dias(14),
        masConsultados: [{ nombre: 'Árabe Blanco', menciones: 8, chats: 4 }, { nombre: 'Rosa Imperial', menciones: 5, chats: 3 }],
        masPedidos: [{ nombre: 'Árabe Blanco', cantidad: 3 }],
        porMetodo: { yape: 2, efectivo: 1 },
        porEstado: { entregado: 2, esperando_pago: 1 },
        totalPedidos: 3,
        pedidosActivos: 1,
        ventas: 160,
        entregados: 2,
        ticketPromedio: 53.33,
      });
    }
    if (p === '/api/estadisticas') {
      return json(res, 200, { dias: dias(7), totalEntrantes: 21, totalSalientes: 14, chats: resumen(), ia: iaEstado(), enviadosHoy: 7, maxPorDia: 80, programadas: null });
    }

    /* sincronizar / prueba */
    if (p === '/api/sincronizar') {
      return json(res, 200, { ok: true, chats: 3, chatsTotal: 3, contactosNuevos: 0, contactosExistentes: 3, contactos: 3 });
    }
    if (p === '/api/prueba') return json(res, 200, { ok: true });

    /* conversaciones */
    if (p === '/api/conversaciones') {
      const limite = Math.min(100, Math.max(1, Number(u.searchParams.get('limite')) || 40));
      return json(res, 200, {
        conversaciones: listarChats(limite),
        resumen: resumen(),
        ia: { activa: state.ia.activa, autoRespuesta: state.ia.autoRespuesta, pausadas: state.ia.pausados },
      });
    }

    /* multimedia de chats: descarga bajo demanda simulada */
    if (method === 'POST' && /^\/api\/conversaciones\/[^/]+\/enviar-media$/.test(p)) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        state.mediaEnviados++;
        json(res, 200, { ok: true, tipo: 'imagen' });
      });
      return;
    }
    if (method === 'POST' && /^\/api\/conversaciones\/[^/]+\/media$/.test(p)) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let j = {}; try { j = JSON.parse(body || '{}'); } catch { /* noop */ }
        const waId = String(j.waId || '');
        const esVideo = /VIDEO/i.test(waId);
        json(res, 200, esVideo
          ? { ok: true, archivo: 'b'.repeat(32) + '.mp4', mimetype: 'video/mp4', tipo: 'video', nombre: '' }
          : { ok: true, archivo: 'a'.repeat(32) + '.png', mimetype: 'image/png', tipo: 'imagen', nombre: 'foto.png' });
      });
      return;
    }
    if (method === 'GET' && /^\/api\/media\/chats\/[a-f0-9]{32}\.(png|mp4)$/.test(p)) {
      const esMp4 = p.endsWith('.mp4');
      const buf = esMp4 ? Buffer.from('0000000000000000', 'hex') : Buffer.from(PNG_1PX, 'base64');
      res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': esMp4 ? 'video/mp4' : 'image/png',
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
      });
      res.end(buf);
      return;
    }

    const convMatch = p.match(/^\/api\/conversaciones\/([^/]+)(?:\/(importar|leido|enviar))?$/);
    if (convMatch) {
      const tel = convMatch[1];
      const accion = convMatch[2];
      const chat = findChat(tel);
      if (accion === 'importar') return json(res, 200, { ok: true, leidos: chat ? chat.mensajes.length : 0, nuevos: 0 });
      if (accion === 'leido') { if (chat) chat.noLeidos = 0; return json(res, 200, { ok: true }); }
      if (accion === 'enviar') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let j = {}; try { j = JSON.parse(body || '{}'); } catch { /* noop */ }
          const texto = String(j.texto || '').trim();
          if (chat && texto) {
            chat.mensajes.push({ id: `enviado-${Date.now()}`, waId: '', direccion: 'saliente', texto, origen: 'panel', estado: 'ok', en: new Date().toISOString(), ack: 0 });
            chat.ultimoTexto = texto; chat.ultimoEn = new Date().toISOString();
          }
          json(res, 200, { ok: true });
        });
        return;
      }
      if (!chat) return json(res, 404, { error: 'Conversación no encontrada' });
      return json(res, 200, {
        telefono: chat.telefono,
        nombre: chat.nombre,
        nombreWa: chat.nombreWa,
        nombreGuardado: chat.nombreGuardado,
        esEmpresa: chat.esEmpresa,
        tipo: chat.tipo,
        clienteId: chat.clienteId,
        noLeidos: chat.noLeidos,
        ultimoTexto: chat.ultimoTexto,
        ultimoEn: chat.ultimoEn,
        pin: chat.pin,
        wa: chat.wa,
        pausado: state.ia.pausados.some(x => x.telefono === chat.telefono),
        seguimiento: chat.seguimiento,
        pedidos: [],
        etiquetas: chat.etiquetas,
        mensajes: chat.mensajes.slice(-200),
      });
    }

    json(res, 404, { error: 'Endpoint no simulado: ' + method + ' ' + p });
  });

  return {
    state,
    server,
    chats,
    fixtures,
    user,
    emit,
    emitHola,
    emitMensaje,
    emitAck,
    emitLeido,
    emitCampana,
    emitDerivacion,
    emitPedido,
    emitGuion,
    setOffline(kind) { state.offline = kind || null; },
    get offline() { return state.offline; },
    get requests() { return state.requests; },
    apiRequests({ since = 0, includeOptions = false } = {}) {
      return state.requests.filter(r => r.ts >= since && (includeOptions || r.method !== 'OPTIONS') && r.path.startsWith('/api/'));
    },
    waitForSSEClient(timeoutMs = 8000) {
      if (state.sseClients.size) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('El panel no abrió ' + BOT_BASE + '/api/stream en ' + timeoutMs + ' ms')), timeoutMs);
        state.sseWaiters.push(() => { clearTimeout(t); resolve(); });
      });
    },
    get sseClients() { return state.sseClients; },
    async start(port) { this.port = await listen(server, port); return this.port; },
    async stop() {
      for (const res of state.sseClients) { try { res.end(); } catch { /* noop */ } }
      state.sseClients.clear();
      await closeServer(server);
    },
  };
}

/* ========================================================================
 * 5. Servidor del panel (index.html real)
 * ====================================================================== */
function createPanelServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, PANEL_BASE);
    if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    // Archivos locales del panel (vendor, imágenes, etc.)
    const rutaLocal = path.join(ROOT, decodeURIComponent(u.pathname));
    if (u.pathname !== '/' && u.pathname !== '/index.html' && fs.existsSync(rutaLocal) && fs.statSync(rutaLocal).isFile() && rutaLocal.startsWith(ROOT)) {
      const ext = path.extname(rutaLocal).toLowerCase();
      const tipos = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      const buf = fs.readFileSync(rutaLocal);
      res.writeHead(200, { 'Content-Type': tipos[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': String(buf.length) });
      res.end(buf);
      return;
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      let buf;
      try { buf = fs.readFileSync(PANEL_FILE); } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No se pudo leer index.html: ' + e.message); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(buf.length) });
      res.end(buf);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Solo se sirve el panel real (/) desde este arnés.');
  });
  return {
    server,
    async start(port) { this.port = await listen(server, port); return this.port; },
    stop: () => closeServer(server),
  };
}

/* ========================================================================
 * 6. Supabase interceptado (responder puro, testeable sin navegador)
 * ====================================================================== */
function createSupabaseResponder() {
  const fixtures = makeFixtures();
  const user = makeAuthUser();
  const state = {
    restRequests: [],   // {ts, table, method}
    authRequests: [],   // {ts, path}
    refreshToken: 'e2e-refresh-token',
    session: makeSession(user),
  };

  function respond(url, method) {
    const u = new URL(url);
    const p = u.pathname;
    const cors = { ...CORS_HEADERS };

    if (method === 'OPTIONS') return { status: 200, headers: { ...cors }, body: '' };

    if (p === '/auth/v1/token' || p === '/auth/v1/token/') {
      state.authRequests.push({ ts: Date.now(), path: p, grant: u.searchParams.get('grant_type') });
      if (u.searchParams.get('grant_type') === 'refresh_token') {
        state.session = makeSession(user, { offsetSec: 3600, refreshToken: 'e2e-refresh-token-2' });
        return jsonResponse(200, {
          access_token: state.session.access_token,
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: state.session.refresh_token,
          user,
        });
      }
      return jsonResponse(400, { error: 'invalid_grant', error_description: 'e2e: solo se simula refresh_token' });
    }
    if (p === '/auth/v1/user') {
      state.authRequests.push({ ts: Date.now(), path: p });
      return jsonResponse(200, user);
    }
    if (p === '/auth/v1/logout') {
      state.authRequests.push({ ts: Date.now(), path: p });
      return { status: 200, headers: { ...cors }, body: '' };
    }

    if (p.startsWith('/rest/v1/')) {
      const parts = p.split('/');           // ['', 'rest', 'v1', tabla, ...]
      const table = parts[3] || '';
      state.restRequests.push({ ts: Date.now(), table, method });
      if (!(table in fixtures)) {
        return jsonResponse(404, { code: '42P01', message: `relation "public.${table}" does not exist` });
      }
      if (method === 'GET' || method === 'HEAD') {
        const data = fixtures[table];
        const n = Array.isArray(data) ? data.length : 1;
        return jsonResponse(200, data, { 'Content-Range': `0-${Math.max(0, n - 1)}/${n}` });
      }
      if (method === 'POST') {
        // insert/upsert: devolvemos el body eco como fila (el panel no lo valida).
        return { status: 201, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }, body: '[]' };
      }
      if (method === 'PATCH' || method === 'DELETE') {
        return { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }, body: '[]' };
      }
    }

    return jsonResponse(404, { message: 'e2e mock: ruta Supabase no simulada ' + method + ' ' + p });
  }

  return {
    state,
    fixtures,
    user,
    respond,
    restGets(since = 0) { return state.restRequests.filter(r => r.ts >= since && (r.method === 'GET' || r.method === 'HEAD')); },
    resetCounters() { state.restRequests.length = 0; state.authRequests.length = 0; },
  };
}

/* ========================================================================
 * 7. Resolución de dependencias del navegador
 * ====================================================================== */
function botRequire() {
  if (!fs.existsSync(BOT_PKG_PATH)) throw new Error(`No existe ${BOT_PKG_PATH}`);
  return createRequire(BOT_PKG_PATH);
}

function loadPuppeteer() {
  try {
    const req = botRequire();
    const puppeteer = req('puppeteer');
    const pkg = JSON.parse(fs.readFileSync(path.join(BOT_NODE_MODULES, 'puppeteer', 'package.json'), 'utf8'));
    return { puppeteer, version: pkg.version };
  } catch (e) {
    const err = new Error(
      `No se pudo cargar Puppeteer desde bot/node_modules: ${e.message}\n` +
      `Instálalo con:  cd "${path.join(ROOT, 'bot')}" && npm install\n` +
      `y el navegador con:  npx puppeteer browsers install chrome`
    );
    err.code = 'E2E_ENV_PUPPETEER';
    throw err;
  }
}

async function launchBrowser(puppeteer, { headed = false } = {}) {
  const exe = (() => { try { return puppeteer.executablePath(); } catch { return '(no resuelto)'; } })();
  const opts = {
    headless: !headed, // Puppeteer >= 22 usa "new headless" por defecto
    executablePath: fs.existsSync(exe) ? exe : undefined,
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 180000,
    timeout: 45000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-ipc-flooding-protection',
      '--mute-audio',
    ],
  };
  try {
    const browser = await puppeteer.launch(opts);
    return { browser, exe };
  } catch (e) {
    const err = new Error(
      `Chromium no pudo iniciarse.\n` +
      `  error: ${e.message}\n` +
      `  chrome: ${exe}\n\n` +
      diagnoseBrowserFailure(e)
    );
    err.code = 'E2E_ENV_BROWSER';
    throw err;
  }
}

function diagnoseBrowserFailure(e) {
  const msg = String(e && e.message || '');
  const win = process.platform === 'win32';
  const lines = ['Diagnóstico:'];
  if (/EPERM|EACCES|spawn/i.test(msg)) {
    lines.push('  - El proceso no puede crear los pipes de stdio con los que Puppeteer habla con Chromium.');
  }
  if (/Failed to launch the browser process|Code: 4|code:/i.test(msg)) {
    lines.push('  - Chromium arrancó pero murió al inicializar su IPC.');
    lines.push('  - Síntoma típico en sandbox: "FATAL:mojo\\\\public\\\\cpp\\\\platform\\\\platform_channel.cc Check failed: Acceso denegado (0x5)".');
  }
  if (win) {
    lines.push('');
    lines.push('Cómo resolverlo:');
    lines.push('  1. Ejecuta este arnés desde una TERMINAL NORMAL del usuario (fuera de agentes/sandbox):');
    lines.push(`       cd "${ROOT}"`);
    lines.push('       node scripts/e2e-panel.mjs');
    lines.push('  2. Si el problema fuese tu antivirus/EDR, añade una exclusión para chrome.exe y node.exe.');
    lines.push('  3. Para depurar a la vista:  node scripts/e2e-panel.mjs --headed');
  } else {
    lines.push('');
    lines.push('Prueba: `node scripts/e2e-panel.mjs` con un usuario con permisos para lanzar navegadores,');
    lines.push('o `npx puppeteer browsers install chrome` si faltan los binarios.');
  }
  lines.push('');
  lines.push('Nota: el resto del arnés (mock del bot, SSE y fixtures de Supabase) sí se puede validar sin navegador:');
  lines.push('       node scripts/e2e-panel.mjs --self-test');
  return lines.join('\n');
}

function loadSupabaseScript() {
  if (fs.existsSync(SUPABASE_JS_UMD)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(BOT_NODE_MODULES, '@supabase', 'supabase-js', 'package.json'), 'utf8'));
    return { source: 'bot/node_modules (offline)', version: pkg.version, code: fs.readFileSync(SUPABASE_JS_UMD, 'utf8') };
  }
  throw new Error(
    `No se encontró el build UMD de supabase-js en:\n  ${SUPABASE_JS_UMD}\n` +
    `Ejecuta: cd "${path.join(ROOT, 'bot')}" && npm install`
  );
}

/* ========================================================================
 * 8. Instrumentación inyectada en la página
 * ====================================================================== */
const INIT_SCRIPT = ({ storageKey, sessionJson, botUrl }) => {
  // 1) Sembrar localStorage ANTES de que corran los scripts del panel.
  try {
    localStorage.setItem(storageKey, sessionJson);
    localStorage.setItem('bot_url', botUrl);
    localStorage.removeItem('bot_token');
    localStorage.setItem('ui_sound', '0'); // sin AudioContext en el test
    localStorage.setItem('avisos', '0');
  } catch (e) {
    window.__E2E_STORAGE_ERROR = String(e && e.message || e);
  }

  const NS = { sse: { urls: [], opened: 0, messages: 0, errors: 0 }, obs: {}, buf: {} };
  window.__E2E = NS;

  // 2) Instrumentar EventSource (URL, open y nº de mensajes SSE recibidos).
  try {
    const NativeES = window.EventSource;
    if (NativeES) {
      window.EventSource = class extends NativeES {
        constructor(url, o) {
          super(url, o);
          try { NS.sse.urls.push(String(url)); } catch { /* noop */ }
          this.addEventListener('open', () => { NS.sse.opened++; });
          this.addEventListener('message', () => { NS.sse.messages++; });
          this.addEventListener('error', () => { NS.sse.errors++; });
        }
      };
    }
  } catch (e) { NS.sse.instrumentError = String(e && e.message || e); }

  // 2b) Instrumentar SSE por fetch (el panel ya no usa EventSource: manda el JWT
  // en la cabecera Authorization y lee el stream con ReadableStream).
  try {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const esStream = url.includes('/api/stream');
      if (esStream) { try { NS.sse.urls.push(String(url)); NS.sse.opened++; } catch { /* noop */ } }
      const respuesta = await nativeFetch(input, init);
      if (!esStream || !respuesta.body) return respuesta;
      try {
        const lector = respuesta.body.getReader();
        const stream = new ReadableStream({
          async pull(ctrl) {
            const { done, value } = await lector.read();
            if (done) { ctrl.close(); return; }
            NS.sse.messages++;
            ctrl.enqueue(value);
          }
        });
        return new Response(stream, { status: respuesta.status, headers: respuesta.headers });
      } catch (e) {
        NS.sse.instrumentError = String(e && e.message || e);
        return respuesta;
      }
    };
  } catch (e) { NS.sse.instrumentFetchError = String(e && e.message || e); }

  // 3) Observadores de mutaciones por contenedor (#in-list, #in-msgs).
  const countIn = (node, itemSel) => {
    try {
      if (!node || node.nodeType !== 1) return 0;
      if (itemSel && node.matches(itemSel)) return 1;
      return itemSel ? node.querySelectorAll(itemSel).length : 1;
    } catch { return 0; }
  };
  NS.attach = function (key, containerSel, itemSel) {
    const c = document.querySelector(containerSel);
    if (!c) return false;
    if (NS.obs[key]) { try { NS.obs[key].disconnect(); } catch { /* noop */ } }
    NS.buf[key] = { added: 0, removed: 0, addedTexts: [], removedTexts: [], last: 0 };
    const obs = new MutationObserver(list => {
      const b = NS.buf[key];
      if (!b) return;
      b.last = Date.now();
      for (const m of list) {
        for (const n of m.addedNodes) {
          const k = countIn(n, itemSel);
          if (k) { b.added += k; if (b.addedTexts.length < 20) b.addedTexts.push(String(n.textContent || '').trim().slice(0, 140)); }
        }
        for (const n of m.removedNodes) {
          const k = countIn(n, itemSel);
          if (k) { b.removed += k; if (b.removedTexts.length < 20) b.removedTexts.push(String(n.textContent || '').trim().slice(0, 140)); }
        }
      }
    });
    obs.observe(c, { childList: true, subtree: true });
    NS.obs[key] = obs;
    return true;
  };
  NS.reset = function (key) { NS.buf[key] = { added: 0, removed: 0, addedTexts: [], removedTexts: [], last: 0 }; };
  NS.muts = function (key) {
    const b = NS.buf[key] || { added: 0, removed: 0, addedTexts: [], removedTexts: [] };
    return { added: b.added, removed: b.removed, addedTexts: b.addedTexts.slice(0, 5), removedTexts: b.removedTexts.slice(0, 5) };
  };
  NS.tag = function (containerSel, itemSel, attr) {
    let i = 0;
    document.querySelectorAll(containerSel + ' ' + itemSel).forEach(n => n.setAttribute(attr || 'data-e2e-keep', String(++i)));
    return i;
  };
  NS.kept = function (attr, total) {
    let n = 0;
    document.querySelectorAll('[' + (attr || 'data-e2e-keep') + ']').forEach(() => n++);
    return n;
  };
  // Acepta (contenedor, item) o un selector combinado ya listo (para evitar
  // el clásico "selector + undefined" que devolvía 0 en silencio).
  NS.count = function (containerSel, itemSel) {
    return document.querySelectorAll(itemSel ? containerSel + ' ' + itemSel : containerSel).length;
  };
  NS.texts = function (containerSel, itemSel) {
    return [...document.querySelectorAll(itemSel ? containerSel + ' ' + itemSel : containerSel)].map(n => String(n.textContent || '').trim());
  };
  NS.state = function () {
    const msgs = document.querySelector('#in-msgs');
    return {
      loginHidden: !!document.querySelector('#login')?.hidden,
      appHidden: !!document.querySelector('#app')?.hidden,
      listItems: document.querySelectorAll('#in-list .in-item').length,
      msgs: document.querySelectorAll('#in-msgs .msg').length,
      msgScrollTop: msgs ? msgs.scrollTop : null,
      msgScrollHeight: msgs ? msgs.scrollHeight : null,
      msgClientHeight: msgs ? msgs.clientHeight : null,
      inSub: document.querySelector('#in-sub')?.textContent || '',
      alertBadge: document.querySelector('#alert-badge')?.textContent || '',
      alertBadgeHidden: !!document.querySelector('#alert-badge')?.hidden,
    };
  };
  NS.markApp = function () {
    const app = document.querySelector('#app');
    if (app) app.setAttribute('data-e2e-app', '1');
    return { timeOrigin: performance.timeOrigin, marked: !!app };
  };
  NS.appInfo = function () {
    return {
      timeOrigin: performance.timeOrigin,
      appMarked: !!document.querySelector('#app[data-e2e-app="1"]'),
      inListKept: document.querySelectorAll('#in-list .in-item[data-e2e-keep]').length,
      msgsKept: document.querySelectorAll('#in-msgs .msg[data-e2e-keep]').length,
    };
  };
};

/* ========================================================================
 * 9. Runner de casos
 * ====================================================================== */
function createRunner() {
  const results = [];
  const log = (status, id, name, detail) => {
    const icon = status === 'PASS' ? '✔' : status === 'FAIL' ? '�’' : '…';
    console.log(`${icon} ${status.padEnd(4)} ${id}  ${name}${detail ? `\n        → ${detail}` : ''}`);
  };
  const runner = {
    results,
    onResult: null,
    async case(id, name, fn) {
      try {
        const detail = await fn();
        results.push({ id, name, status: 'PASS', detail: detail || '' });
        log('PASS', id, name, detail);
      } catch (e) {
        const detail = e && e.message ? e.message : String(e);
        results.push({ id, name, status: 'FAIL', detail });
        log('FAIL', id, name, detail);
      }
      // Artefacto incremental: si la corrida se interrumpe, queda evidencia parcial.
      if (typeof runner.onResult === 'function') {
        try { runner.onResult(results); } catch { /* noop */ }
      }
    },
    skip(id, name, reason) {
      results.push({ id, name, status: 'SKIP', detail: reason });
      log('SKIP', id, name, reason);
    },
  };
  return runner;
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ========================================================================
 * 10. Modo self-test (sin navegador): valida mock, SSE y fixtures
 * ====================================================================== */
async function runSelfTest() {
  console.log('\n=== E2E PANEL · SELF-TEST (sin navegador) ===');
  console.log(`Node ${process.version} · ${process.platform}/${process.arch}`);

  const index = readIndexInfo();
  console.log(`Panel: ${PANEL_FILE}`);
  console.log(`       sha256=${index.sha256.slice(0, 16)}… bytes=${index.bytes} mtime=${index.mtime}`);

  const runner = createRunner();
  const bot = createBotMock();
  const panel = createPanelServer();
  const supabase = createSupabaseResponder();
  let botPort = 0;
  let panelPort = 0;

  try {
    botPort = await bot.start(0);
    panelPort = await panel.start(0);
    console.log(`Mock bot: ${BOT_BASE} → puerto real ${botPort}`);
    console.log(`Panel:    ${PANEL_BASE} → puerto real ${panelPort}`);

    await runner.case('ST-01', 'index.html real se sirve por HTTP', async () => {
      const res = await fetch(`http://127.0.0.1:${panelPort}/`);
      const html = await res.text();
      assert(res.status === 200, `HTTP ${res.status}`);
      assert(html.includes('id="app"'), 'no contiene id="app"');
      assert(html.includes(SUPABASE_AUTH_KEY) || html.includes('SUPABASE_URL'), 'no parece el panel real');
      return `HTTP 200 · ${html.length} bytes`;
    });

    await runner.case('ST-02', 'GET /api/estado tiene la forma que usa el panel', async () => {
      const j = await (await fetch(`http://127.0.0.1:${botPort}/api/estado`)).json();
      assert(Array.isArray(j.sesiones) && j.sesiones.length > 0, 'falta sesiones[]');
      assert(j.sesiones[0].conectado === true, 'sesión no conectada');
      assert(j.sesiones[0].numero === '51910418951', 'falta numero');
      assert(typeof j.cola === 'number' && typeof j.maxPorDia === 'number', 'faltan contadores');
      assert(j.ia && typeof j.ia.activa === 'boolean', 'falta ia');
      return `sesiones=${j.sesiones.length} · modoPrueba=${j.modoPrueba}`;
    });

    await runner.case('ST-03', 'GET /api/conversaciones y detalle (30 mensajes de scroll, orden por ultimoEn)', async () => {
      const lista = await (await fetch(`http://127.0.0.1:${botPort}/api/conversaciones?limite=80`)).json();
      assert(Array.isArray(lista.conversaciones) && lista.conversaciones.length >= 3, 'faltan conversaciones');
      assert(lista.resumen && typeof lista.resumen.chats === 'number', 'falta resumen');
      assert(Array.isArray(lista.ia?.pausadas), 'falta ia.pausadas');
      const tiempos = lista.conversaciones.map(c => Date.parse(c.ultimoEn));
      for (let i = 1; i < tiempos.length; i++) assert(tiempos[i - 1] >= tiempos[i], 'las conversaciones no vienen ordenadas por ultimoEn desc (rompe el no-parpadeo)');
      const tel = lista.conversaciones[0].telefono;
      const det = await (await fetch(`http://127.0.0.1:${botPort}/api/conversaciones/${tel}`)).json();
      assert(det.telefono === tel, 'detalle de otra conversación');
      assert(Array.isArray(det.mensajes) && det.mensajes.length === 30, `mensajes=${det.mensajes?.length} (se esperaban 30)`);
      assert(det.mensajes.some(m => m.direccion === 'saliente' && m.waId), 'sin salientes con waId (para el ack)');
      return `${lista.conversaciones.length} chats ordenados · hilo=${det.mensajes.length} mensajes`;
    });

    await runner.case('ST-03b', 'SSE y REST comparten estado (clave para idle sin parpadeo)', async () => {
      const antes = await (await fetch(`http://127.0.0.1:${botPort}/api/conversaciones`)).json();
      const tel = antes.conversaciones[0].telefono;
      const ev = bot.emitMensaje(tel, 'mensaje stateful e2e');
      const despues = await (await fetch(`http://127.0.0.1:${botPort}/api/conversaciones`)).json();
      const chat = despues.conversaciones.find(c => c.telefono === tel);
      assert(chat, 'la conversación desapareció del listado');
      assert(chat.ultimoTexto === ev.mensaje.texto, 'REST no refleja el ultimoTexto que llegó por SSE');
      assert(chat.ultimoEn === ev.mensaje.en, 'REST no refleja el ultimoEn que llegó por SSE');
      assert(chat.noLeidos === ev.noLeidos, `REST no refleja noLeidos (${chat.noLeidos} vs ${ev.noLeidos})`);
      assert(despues.conversaciones[0].telefono === tel, 'el chat con mensaje nuevo no quedó primero (orden por ultimoEn)');
      const det = await (await fetch(`http://127.0.0.1:${botPort}/api/conversaciones/${tel}`)).json();
      assert(det.mensajes.some(m => m.waId === ev.mensaje.waId), 'el detalle no incluye el mensaje emitido por SSE');
      const leido = await fetch(`http://127.0.0.1:${botPort}/api/conversaciones/${tel}/leido`, { method: 'POST' });
      assert(leido.status === 200, 'POST /leido no respondió 200');
      const trasLeido = await (await fetch(`http://127.0.0.1:${botPort}/api/conversaciones`)).json();
      assert(trasLeido.conversaciones.find(c => c.telefono === tel).noLeidos === 0, 'POST /leido no puso noLeidos en 0');
      return `REST sincronizado con SSE · ultimoTexto/noLeidos/orden/detalle OK`;
    });

    await runner.case('ST-04', 'resto de endpoints del bot responden con la forma esperada', async () => {
      const must = [
        ['/api/pedidos', j => Array.isArray(j.pedidos) && j.resumen],
        ['/api/pagos', j => Array.isArray(j.plantillas)],
        ['/api/ia', j => typeof j.activa === 'boolean'],
        ['/api/logs', j => Array.isArray(j.logs)],
        ['/api/analiticas', j => Array.isArray(j.dias) && Array.isArray(j.masConsultados)],
        ['/api/estadisticas', j => Array.isArray(j.dias) && typeof j.totalEntrantes === 'number'],
        ['/api/eventos?desde=0', j => Array.isArray(j.eventos) && typeof j.ultimo === 'number'],
        ['/api/campanas', j => Array.isArray(j.campanas)],
        ['/api/clientes', j => Array.isArray(j.clientes)],
      ];
      for (const [p, check] of must) {
        const j = await (await fetch(`http://127.0.0.1:${botPort}${p}`)).json();
        assert(check(j), `${p} no cumple la forma esperada`);
      }
      const qr = await fetch(`http://127.0.0.1:${botPort}/api/qr`);
      const buf = Buffer.from(await qr.arrayBuffer());
      assert(qr.headers.get('content-type')?.includes('image/png'), '/api/qr no es PNG');
      assert(buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG', '/api/qr no tiene firma PNG');
      return `${must.length} endpoints OK · QR ${buf.length} bytes PNG`;
    });

    await runner.case('ST-05', 'SSE /api/stream: retry, hola, mensaje, ack, campana, derivación', async () => {
      const client = await openSse(botPort);
      await sleep(200);
      assert(/retry:\s*3000/.test(client.rawHeadersWritten || ''), 'no se vio "retry: 3000"');
      assert(bot.sseClients.size === 1, `clientes SSE conectados=${bot.sseClients.size}`);
      const guion = bot.emitGuion('51910418951');
      const frames = await client.waitFor(5, 6000);
      await guion;
      const tipos = frames.map(f => f.data?.tipo);
      for (const t of ['hola', 'mensaje', 'ack', 'campana', 'derivacion']) {
        assert(tipos.includes(t), `no llegó el evento SSE "${t}" (recibidos: ${tipos.join(', ')})`);
      }
      const msg = frames.find(f => f.data?.tipo === 'mensaje').data;
      assert(msg.telefono === '51910418951', 'mensaje sin telefono');
      assert(msg.mensaje && typeof msg.mensaje.texto === 'string', 'mensaje sin payload.mensaje.texto');
      assert(msg.mensaje.direccion === 'entrante', 'mensaje no es entrante');
      const ack = frames.find(f => f.data?.tipo === 'ack').data;
      assert(typeof ack.waId === 'string' && ack.ack === 3, 'ack sin waId/ack');
      assert(frames.every(f => f.id >= 0), 'frames sin id:');
      client.close();
      return `frames=${frames.length} · tipos=${tipos.join(',')}`;
    });

    await runner.case('ST-06', 'Supabase interceptado: fixtures, 404 controlado y refresh de auth', async () => {
      const clientes = supabase.respond(`${SUPABASE_ORIGIN}/rest/v1/clientes?select=*`, 'GET');
      assert(clientes.status === 200, 'GET clientes != 200');
      assert(Array.isArray(JSON.parse(clientes.body)) && JSON.parse(clientes.body).length === 4, 'clientes != 4');
      for (const tabla of ['productos', 'plantillas', 'campanas', 'envios']) {
        const r = supabase.respond(`${SUPABASE_ORIGIN}/rest/v1/${tabla}?select=*`, 'GET');
        assert(r.status === 200 && Array.isArray(JSON.parse(r.body)), `${tabla} no devuelve array`);
      }
      const nf = supabase.respond(`${SUPABASE_ORIGIN}/rest/v1/no_existe?select=*`, 'GET');
      assert(nf.status === 404, 'tabla desconocida no devuelve 404');
      const refresh = supabase.respond(`${SUPABASE_ORIGIN}/auth/v1/token?grant_type=refresh_token`, 'POST');
      const rs = JSON.parse(refresh.body);
      assert(refresh.status === 200 && rs.access_token && rs.refresh_token && rs.user, 'refresh_token no devuelve sesión');
      assert(rs.expires_in === 3600, 'refresh sin expires_in');
      return 'clientes/productos/plantillas/campanas/envios + 404 + refresh OK';
    });

    await runner.case('ST-07', 'la sesión falsa de Supabase es aceptada por supabase-js real', async () => {
      let supabaseJs;
      try { supabaseJs = botRequire()('@supabase/supabase-js'); } catch { return 'SKIP: @supabase/supabase-js no disponible en bot/node_modules'; }
      const session = makeSession(supabase.user);
      const mem = (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } }; })();
      mem.setItem(SUPABASE_AUTH_KEY, JSON.stringify(session));
      const sb = supabaseJs.createClient(SUPABASE_ORIGIN, 'sb_publishable_e2e', {
        auth: { storage: mem, storageKey: SUPABASE_AUTH_KEY, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false },
      });
      const { data, error } = await sb.auth.getSession();
      assert(!error, 'getSession devolvió error: ' + error?.message);
      assert(data.session && data.session.user.email === 'qa.e2e@perfumeriafina.test', 'getSession no recuperó la sesión sembrada');
      assert(data.session.expires_at === session.expires_at, 'expires_at no coincide');
      return `storageKey=${SUPABASE_AUTH_KEY} · sesión aceptada (exp ${session.expires_at})`;
    });

    await runner.case('ST-08', 'supabase-js UMD local disponible para servir en lugar del CDN', async () => {
      const s = loadSupabaseScript();
      assert(s.code.length > 100000, 'UMD demasiado pequeño');
      assert(/supabase/i.test(s.code), 'el UMD no menciona supabase');
      return `${s.source} · v${s.version} · ${Math.round(s.code.length / 1024)} KB`;
    });
  } finally {
    await bot.stop();
    await panel.stop();
    ensureDir(SHOTS_DIR);
    const out = {
      kind: 'self-test',
      ts: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      index: { path: PANEL_FILE, bytes: index.bytes, sha256: index.sha256, mtime: index.mtime },
      cases: runner.results,
      totals: totals(runner.results),
    };
    fs.writeFileSync(path.join(SHOTS_DIR, 'e2e-selftest.json'), JSON.stringify(out, null, 2));
    printSummary(runner.results);
    process.exitCode = runner.results.some(r => r.status === 'FAIL') ? 1 : 0;
  }
}

function openSse(port, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const frames = [];
    let raw = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream?token=e2e-token', headers: { Accept: 'text/event-stream' } }, res => {
      res.setEncoding('utf8');
      let pending = '';
      res.on('data', chunk => {
        raw += chunk;
        pending += chunk;
        let idx;
        while ((idx = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, idx);
          pending = pending.slice(idx + 2);
          const frame = { raw: block, id: null, data: null };
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) frame.id = Number(line.slice(3).trim());
            else if (line.startsWith('data:')) {
              try { frame.data = JSON.parse(line.slice(5).trim()); } catch { frame.data = line.slice(5).trim(); }
            }
          }
          if (frame.data !== null && frame.id !== null && !frames.some(f => f.id === frame.id)) frames.push(frame);
        }
      });
      const client = {
        res, frames,
        get rawHeadersWritten() { return raw; },
        waitFor(n, ms = timeoutMs) {
          return new Promise((resolveWait, rejectWait) => {
            const t0 = Date.now();
            const tick = () => {
              if (frames.length >= n) return resolveWait(frames.slice(0, n));
              if (Date.now() - t0 > ms) return rejectWait(new Error(`SSE: solo ${frames.length}/${n} frames en ${ms} ms`));
              setTimeout(tick, 50);
            };
            tick();
          });
        },
        close() { try { req.destroy(); } catch { /* noop */ } },
      };
      resolve(client);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => reject(new Error('timeout conectando a SSE')));
  });
}

/* ========================================================================
 * 11. Corrida E2E completa con navegador
 * ====================================================================== */
async function runE2E() {
  const index = readIndexInfo();
  ensureDir(SHOTS_DIR);

  console.log('\n============================================================');
  console.log('  E2E PANEL · Perfumería Fina');
  console.log('============================================================');
  console.log(`Panel:     ${PANEL_FILE}`);
  console.log(`           sha256=${index.sha256.slice(0, 16)}… bytes=${index.bytes} mtime=${index.mtime}`);
  console.log(`Node:      ${process.version} · ${process.platform}/${process.arch}`);
  console.log(`Panel URL: ${PANEL_BASE}`);
  console.log(`Bot mock:  ${BOT_BASE}`);
  console.log(`Idle:      ${IDLE_MS} ms`);
  console.log('');

  let bot, panel, browser, page;
  const runner = createRunner();
  runner.onResult = results => {
    try {
      ensureDir(SHOTS_DIR);
      fs.writeFileSync(path.join(SHOTS_DIR, 'e2e-parcial.json'), JSON.stringify({
        kind: 'e2e-parcial',
        ts: new Date().toISOString(),
        index: { path: PANEL_FILE, bytes: index.bytes, sha256: index.sha256, mtime: index.mtime },
        totals: totals(results),
        cases: results,
      }, null, 2));
    } catch { /* noop */ }
  };
  const consoleErrors = [];
  const consoleWarnings = [];
  const netErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  let offlineWindow = null;
  let supabaseScript = null;

  const startedAt = new Date().toISOString();

  try {
    // 1) Dependencias y servidores
    const { puppeteer, version: puppeteerVersion } = loadPuppeteer();
    supabaseScript = loadSupabaseScript();
    console.log(`Puppeteer: ${puppeteerVersion} · ${supabaseScript.source} v${supabaseScript.version}`);

    bot = createBotMock();
    panel = createPanelServer();
    const realBotPort = await bot.start(BOT_PORT);
    const realPanelPort = await panel.start(PANEL_PORT);
    const panelUrl = `http://127.0.0.1:${realPanelPort}/`;
    const botUrl = `http://127.0.0.1:${realBotPort}`;
    if (realBotPort !== BOT_PORT || realPanelPort !== PANEL_PORT) console.warn(`[e2e] puertos reales: panel=${realPanelPort} bot=${realBotPort}`);

    // 2) Navegador
    const launch = await launchBrowser(puppeteer, { headed: ARGS.headed });
    browser = launch.browser;
    console.log(`Chromium:  ${launch.exe}`);
    console.log(`           ${await browser.version()}\n`);

    // 3) Interceptación Supabase + CDN + imágenes externas
    const supabase = createSupabaseResponder();
    createSupabaseResponderReference.restGets = (since = 0) => supabase.restGets(since);
    const session = makeSession(supabase.user);
    const PNG_1X1 = png1x1();

    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', m => {
      const text = m.text();
      const type = m.type();
      const url = (m.location() && m.location().url) || '';
      const entry = { ts: Date.now(), type, text, url };
      if (type === 'error') {
        if (/^Failed to load resource/i.test(text)) netErrors.push(entry);
        else consoleErrors.push(entry);
      } else if (type === 'warning') consoleWarnings.push(entry);
    });
    page.on('pageerror', e => pageErrors.push({ ts: Date.now(), message: e.message, stack: (e.stack || '').slice(0, 1200) }));
    page.on('requestfailed', req => {
      requestFailures.push({ ts: Date.now(), url: req.url(), method: req.method(), error: req.failure()?.errorText || '' });
    });

    await page.setRequestInterception(true);
    page.on('request', async req => {
      const url = req.url();
      try {
        if (url.startsWith(SUPABASE_ORIGIN)) {
          const r = supabase.respond(url, req.method());
          await req.respond({ status: r.status, headers: r.headers, body: r.body });
          return;
        }
        if (SUPABASE_CDN_RE.test(url)) {
          await req.respond({
            status: 200,
            headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
            body: supabaseScript.code,
          });
          return;
        }
        // Imágenes del catálogo (perfumeriafinaperu.com): sin red, se sirve un PNG 1×1
        // para no ensuciar la corrida con ERR_BLOCKED_BY_ORB de recursos externos.
        if (/^https?:\/\/(?:[a-z0-9-]+\.)*perfumeriafinaperu\.com\//i.test(url)) {
          await req.respond({
            status: 200,
            headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
            body: PNG_1X1,
          });
          return;
        }
        await req.continue();
      } catch (e) {
        // Si la request ya no existe (navegación/carrera), no rompemos el run.
        try { await req.continue(); } catch { /* noop */ }
      }
    });

    // 4) Sembrar localStorage antes de ejecutar el panel
    await page.evaluateOnNewDocument(INIT_SCRIPT, {
      storageKey: SUPABASE_AUTH_KEY,
      sessionJson: JSON.stringify(session),
      botUrl,
    });

    // 5) Cargar el panel real
    await page.goto(panelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitFor(async () => {
      const st = await page.evaluate(() => {
        const login = document.querySelector('#login');
        const app = document.querySelector('#app');
        return { loginHidden: !!login?.hidden, appHidden: !!app?.hidden };
      });
      return st.loginHidden && !st.appHidden;
    }, 20000, 'el panel no mostró la app (login oculto / #app visible)');

    // Esperar a que el render inicial (Supabase fixtures) esté listo.
    await waitFor(async () => {
      const t = await page.evaluate(() => document.querySelector('#c-count')?.textContent || '');
      return /4 de 4/.test(t);
    }, 10000, 'load() no pintó los 4 clientes de los fixtures de Supabase');

    // ===================== CASOS =====================

    await runner.case('E2E-01', 'Arranque limpio: login oculto, app visible, sesión Supabase aceptada', async () => {
      const st = await page.evaluate(() => ({
        loginHidden: !!document.querySelector('#login')?.hidden,
        appHidden: !!document.querySelector('#app')?.hidden,
        storageError: window.__E2E_STORAGE_ERROR || null,
      }));
      assert(st.loginHidden === true, '#login sigue visible');
      assert(st.appHidden === false, '#app sigue oculto');
      assert(!st.storageError, 'localStorage falló: ' + st.storageError);
      const auth = await page.evaluate(async () => {
        try {
          const { data, error } = await sb.auth.getSession();
          return { ok: !!data?.session, email: data?.session?.user?.email || null, error: error?.message || null };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      });
      assert(auth.ok, `sb.auth.getSession() no recuperó la sesión sembrada: ${auth.error || 'sin sesión'}`);
      const cCount = await page.evaluate(() => document.querySelector('#c-count')?.textContent || '');
      assert(/4 de 4/.test(cCount), `clientes no cargados desde fixtures: "${cCount}"`);
      await page.screenshot({ path: path.join(SHOTS_DIR, '01-inicio.png') });
      return `sesión=${auth.email} · ${cCount.trim()} · captura 01-inicio.png`;
    });

    await runner.case('E2E-02', 'Todas las pestañas abren sin excepciones', async () => {
      const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabs button')].map(b => b.dataset.tab).filter(Boolean));
      assert(tabs.length >= 8, `se esperaban >=8 pestañas, hay ${tabs.length}`);
      const beforeErrors = consoleErrors.length + pageErrors.length;
      const abiertas = [];
      for (const t of tabs) {
        const errMark = consoleErrors.length + pageErrors.length;
        await page.click(`#tabs button[data-tab="${t}"]`);
        await sleep(280);
        const st = await page.evaluate(n => {
          const el = document.querySelector('#t-' + n);
          return { exists: !!el, hidden: !!el?.hidden, id: el?.id || null };
        }, t);
        assert(st.exists, `no existe #t-${t}`);
        assert(st.hidden === false, `la pestaña "${t}" no quedó visible`);
        assert(consoleErrors.length + pageErrors.length === errMark, `error JS al abrir la pestaña "${t}"`);
        abiertas.push(t);
      }
      // Volver a Inicio para la captura de portada.
      await page.click('#tabs button[data-tab="inicio"]');
      await sleep(350);
      await page.screenshot({ path: path.join(SHOTS_DIR, '01-inicio.png') });
      assert(consoleErrors.length + pageErrors.length === beforeErrors, 'errores JS durante el recorrido de pestañas');
      return `${abiertas.length} pestañas: ${abiertas.join(', ')}`;
    });

    await runner.case('E2E-03', 'Bandeja: lista pintada y chat abierto', async () => {
      await page.click('#tabs button[data-tab="bandeja"]');
      await waitFor(async () => {
        const n = await page.evaluate(() => document.querySelectorAll('#in-list .in-item').length);
        return n >= 3;
      }, 10000, 'la bandeja no pintó los 3 chats del mock');
      await page.click('#in-list .in-item');
      await waitFor(async () => {
        const st = await page.evaluate(() => ({
          visible: !!document.querySelector('#in-thread') && !document.querySelector('#in-thread').hidden,
          msgs: document.querySelectorAll('#in-msgs .msg').length,
        }));
        return st.visible && st.msgs >= 20;
      }, 10000, 'el hilo no se abrió con mensajes');
      await page.screenshot({ path: path.join(SHOTS_DIR, '02-bandeja.png') });
      const st = await page.evaluate(() => window.__E2E.state());
      return `${st.listItems} chats · hilo ${st.msgs} mensajes · captura 02-bandeja.png`;
    });

    await runner.case('E2E-04', 'SSE conectado: el panel abre /api/stream y recibe eventos', async () => {
      const hasUrl = await waitFor(async () => {
        const urls = await page.evaluate(() => (window.__E2E?.sse?.urls || []));
        return urls.length > 0;
      }, 10000, 'no se observó `new EventSource(...)` en el panel');
      await bot.waitForSSEClient(10000);
      const info = await page.evaluate(() => ({ ...window.__E2E.sse }));
      assert(info.urls.length > 0, 'EventSource sin URL');
      assert(bot.sseClients.size >= 1, 'el mock bot no tiene clientes SSE conectados');
      const req = bot.apiRequests().filter(r => r.path === '/api/stream');
      return `url=${info.urls[0]} · clientes=${bot.sseClients.size} · peticiones stream=${req.length}`;
    });

    // Localizar helpers en la página
    const tel = await page.evaluate(() => {
      const it = document.querySelector('#in-list .in-item');
      return it ? it.getAttribute('data-tel') : null;
    });
    assert(tel, 'no se pudo obtener el teléfono del chat abierto');

    await runner.case('E2E-05', 'Evento SSE "mensaje" se AGREGA al hilo sin remover nodos previos', async () => {
      const setup = await page.evaluate(() => {
        window.__E2E.attach('msgs', '#in-msgs', '.msg');
        window.__E2E.reset('msgs');
        const tagged = window.__E2E.tag('#in-msgs', '.msg', 'data-e2e-keep');
        window.__E2E.reset('msgs');
        return { tagged, state: window.__E2E.state() };
      });
      assert(setup.tagged >= 20, `se esperaban >=20 mensajes pintados, hay ${setup.tagged}`);
      const texto = 'Hola, ¿tienen el perfume Árabe? (evento SSE e2e)';
      bot.emitMensaje(tel, texto);
      await sleep(1200);
      const res = await page.evaluate(t => {
        const muts = window.__E2E.muts('msgs');
        const st = window.__E2E.state();
        const kept = window.__E2E.kept('data-e2e-keep');
        return { muts, st, kept, textFound: document.querySelector('#in-msgs')?.textContent?.includes(t) || false };
      }, texto);
      assert(res.muts.removed === 0, `el evento removió ${res.muts.removed} nodo(s) del hilo: ${JSON.stringify(res.muts.removedTexts)}`);
      assert(res.muts.added >= 1, 'el mensaje SSE no agregó ningún nodo al hilo');
      assert(res.kept === setup.tagged, `se perdieron nodos previos: ${res.kept}/${setup.tagged} conservados`);
      assert(res.textFound, 'el texto del mensaje SSE no aparece en #in-msgs');
      assert(res.st.msgs === setup.tagged + 1, `mensajes esperados ${setup.tagged + 1}, hay ${res.st.msgs} (¿reemplazo del hilo?)`);
      await page.screenshot({ path: path.join(SHOTS_DIR, '03-bandeja-sse.png') });
      return `+${res.muts.added} nodo(s), -${res.muts.removed}, ${res.kept}/${setup.tagged} previos conservados`;
    });

    await runner.case('E2E-06', 'Eventos ack/campana/derivación no reemplazan el hilo', async () => {
      await page.evaluate(() => {
        window.__E2E.attach('msgs', '#in-msgs', '.msg');
        window.__E2E.tag('#in-msgs', '.msg', 'data-e2e-keep2');
        window.__E2E.reset('msgs');
      });
      const before = await page.evaluate(() => window.__E2E.count('#in-msgs', '.msg'));
      bot.emitAck(tel);
      await sleep(700);
      const ackMuts = await page.evaluate(() => window.__E2E.muts('msgs'));
      assert(ackMuts.removed === 0, `ack removió ${ackMuts.removed} nodos`);
      bot.emitCampana();
      await sleep(450);
      bot.emitDerivacion(tel);
      await sleep(700);
      const res = await page.evaluate(() => ({
        muts: window.__E2E.muts('msgs'),
        st: window.__E2E.state(),
        kept: window.__E2E.count('#in-msgs', '.msg[data-e2e-keep2]'),
        count: window.__E2E.count('#in-msgs', '.msg'),
      }));
      assert(res.muts.removed === 0, `campana/derivación removieron ${res.muts.removed} nodos del hilo`);
      assert(res.kept === before, `se perdieron mensajes: ${res.kept}/${before}`);
      assert(res.count >= before, `el hilo quedó con menos mensajes (${res.count} < ${before})`);
      const badge = await page.evaluate(() => ({
        hidden: !!document.querySelector('#alert-badge')?.hidden,
        text: document.querySelector('#alert-badge')?.textContent || '',
      }));
      return `sin removals · alert-badge ${badge.hidden ? 'oculto' : '"' + badge.text + '"'}`;
    });

    await runner.case('E2E-07', 'Scroll del hilo se conserva si el usuario está arriba', async () => {
      const before = await page.evaluate(() => {
        const c = document.querySelector('#in-msgs');
        c.scrollTop = 0;
        window.__E2E.attach('msgs', '#in-msgs', '.msg');
        window.__E2E.tag('#in-msgs', '.msg', 'data-e2e-keep3');
        window.__E2E.reset('msgs');
        return { top: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, msgs: window.__E2E.count('#in-msgs', '.msg') };
      });
      assert(before.scrollHeight > before.clientHeight + 20, `el hilo no es scrollable (${before.scrollHeight}/${before.clientHeight}); no se puede validar scroll`);
      bot.emitMensaje(tel, 'Mensaje SSE para el test de scroll');
      await sleep(1200);
      const after = await page.evaluate(() => {
        const c = document.querySelector('#in-msgs');
        return {
          top: c.scrollTop,
          muts: window.__E2E.muts('msgs'),
          kept: window.__E2E.count('#in-msgs', '.msg[data-e2e-keep3]'),
        };
      });
      assert(Math.abs(after.top - before.top) <= 2, `el scroll saltó de ${before.top} a ${after.top} estando el usuario arriba`);
      assert(after.muts.removed === 0, `el scroll test removió ${after.muts.removed} nodos`);
      assert(after.kept === before.msgs, `se perdieron mensajes: ${after.kept}/${before.msgs}`);
      return `scrollTop ${before.top} → ${after.top} · ${before.msgs} mensajes conservados`;
    });

    await runner.case('E2E-08', `Idle ${Math.round(IDLE_MS / 1000)} s: sin mutaciones, sin polling de eventos ni recargas`, async () => {
      // Ventana limpia: dejar que se asienten RAF/promises del evento SSE anterior.
      await sleep(500);
      await page.evaluate(() => {
        window.__E2E.attach('list', '#in-list', '.in-item');
        window.__E2E.attach('msgs', '#in-msgs', '.msg');
        window.__E2E.reset('list');
        window.__E2E.reset('msgs');
      });
      const reqMark = Date.now();
      const restMark = Date.now();
      const restBase = createSupabaseResponderReference.restGets(restMark).length;
      await sleep(IDLE_MS);
      const mutsList = await page.evaluate(() => window.__E2E.muts('list'));
      const mutsMsgs = await page.evaluate(() => window.__E2E.muts('msgs'));
      const reqs = bot.apiRequests({ since: reqMark });
      const eventsReqs = reqs.filter(r => r.path === '/api/eventos').length;
      const byEndpoint = {};
      for (const r of reqs) byEndpoint[r.path] = (byEndpoint[r.path] || 0) + 1;
      const tooMany = Object.entries(byEndpoint).filter(([, n]) => n > 2);
      const restDelta = createSupabaseResponderReference.restGets(restMark).length - restBase;

      assert(mutsMsgs.added === 0 && mutsMsgs.removed === 0,
        `#in-msgs mutó en idle: +${mutsMsgs.added}/-${mutsMsgs.removed} (${JSON.stringify(mutsMsgs.addedTexts.concat(mutsMsgs.removedTexts)).slice(0, 300)})`);
      assert(mutsList.added === 0 && mutsList.removed === 0,
        `#in-list mutó en idle: +${mutsList.added}/-${mutsList.removed}`);
      assert(eventsReqs === 0, `el panel siguió llamando /api/eventos con SSE abierto: ${eventsReqs} vez(es)`);
      assert(tooMany.length === 0, `doble polling / requests de más: ${tooMany.map(([p, n]) => p + '×' + n).join(', ')}`);
      assert(restDelta === 0, `hubo ${restDelta} GET REST durante el idle (recarga de app)`);
      return `0 mutaciones · 0 eventos · ${reqs.length} req (${Object.entries(byEndpoint).map(([p, n]) => p.replace('/api/', '') + '×' + n).join(', ') || 'ninguna'}) · 0 REST`;
    });

    await runner.case('E2E-09', 'Fallo de red del bot NO borra la lista ya pintada', async () => {
      const before = await page.evaluate(() => {
        window.__E2E.attach('list', '#in-list', '.in-item');
        window.__E2E.reset('list');
        window.__E2E.tag('#in-list', '.in-item', 'data-e2e-keep9');
        return {
          items: window.__E2E.count('#in-list', '.in-item'),
          texts: window.__E2E.texts('#in-list', '.in-item'),
          sub: document.querySelector('#in-sub')?.textContent || '',
        };
      });
      assert(before.items >= 3, `la bandeja debía estar pintada (items=${before.items})`);
      offlineWindow = { start: Date.now(), end: null };
      bot.setOffline('conversaciones');
      const marks = consoleErrors.length + pageErrors.length;
      const hasRefreshBtn = await page.evaluate(() => !!document.querySelector('#in-refresh'));
      if (hasRefreshBtn) await page.click('#in-refresh');       // cargarBandeja() con el bot "caído"
      else await page.evaluate(() => cargarBandeja());
      await sleep(1500);
      const after = await page.evaluate(() => ({
        items: window.__E2E.count('#in-list', '.in-item'),
        kept: window.__E2E.count('#in-list', '.in-item[data-e2e-keep9]'),
        texts: window.__E2E.texts('#in-list', '.in-item'),
        sub: document.querySelector('#in-sub')?.textContent || '',
        listText: document.querySelector('#in-list')?.textContent || '',
        muts: window.__E2E.muts('list'),
      }));
      bot.setOffline(null);
      offlineWindow.end = Date.now();
      assert(after.items === before.items, `la lista cambió de ${before.items} a ${after.items} items por el fallo de red`);
      assert(after.kept === before.items, `se perdieron items ya pintados: ${after.kept}/${before.items}`);
      assert(JSON.stringify(after.texts) === JSON.stringify(before.texts), 'los items ya pintados cambiaron de contenido');
      assert(!/No se pudo cargar/i.test(after.listText), 'la lista se reemplazó por el mensaje de error');
      assert(consoleErrors.length + pageErrors.length === marks, 'el fallo del bot generó un error JS no controlado');
      const stale = /sin conexi[oó]n|⚠|bot apagado/i.test(after.sub);
      assert(stale, `no se mostró el aviso de "sin conexión" en #in-sub (texto: "${after.sub}")`);
      // Recuperación: al volver el bot, refrescar debe mantener la lista.
      await page.click('#in-refresh');
      await sleep(1200);
      const recovered = await page.evaluate(() => window.__E2E.count('#in-list', '.in-item'));
      assert(recovered === before.items, `tras recuperar la red la lista quedó con ${recovered} items`);
      // Asentar la recuperación (puede haber un poll de bandeja en vuelo): si no se
      // espera, el repintado tardío se atribuye falsamente al caso siguiente (E2E-10).
      await settleMutations(page, 'list', 600, 5000);
      return `${before.items} items intactos · aviso "${after.sub.trim().slice(0, 60)}" · recuperada y asentada`;
    });

    await runner.case('E2E-10', 'TOKEN_REFRESHED de Supabase NO recarga la app ni repite GET REST', async () => {
      // La recuperación de E2E-09 y los polls de vista son asíncronos: primero se
      // asienta el DOM para que un repintado tardío no se confunda con el auth event.
      await sleep(400);
      await settleMutations(page, 'list', 600, 5000);
      const before = await page.evaluate(() => {
        window.__E2E.attach('list', '#in-list', '.in-item');
        window.__E2E.reset('list');
        window.__E2E.tag('#in-list', '.in-item', 'data-e2e-keep10');
        const mark = window.__E2E.markApp();
        window.__E2E.authEvents = [];
        sb.auth.onAuthStateChange(ev => window.__E2E.authEvents.push({ ev, at: Date.now() }));
        return { ...mark, items: window.__E2E.count('#in-list', '.in-item') };
      });
      // Segundo settle DESPUÉS de etiquetar: garantiza que el observer parte limpio.
      await sleep(400);
      let pre = await page.evaluate(() => ({
        kept: window.__E2E.count('#in-list', '.in-item[data-e2e-keep10]'),
        muts: window.__E2E.muts('list'),
      }));
      if (pre.kept !== before.items) {
        // Repintado tardío del caso anterior: se espera, se re-etiqueta y se reintenta
        // una vez. Si aun así se pierde, el error señala el origen (E2E-09), no el auth.
        await settleMutations(page, 'list', 600, 5000);
        before.items = await page.evaluate(() => {
          window.__E2E.tag('#in-list', '.in-item', 'data-e2e-keep10');
          return window.__E2E.count('#in-list', '.in-item');
        });
        await sleep(400);
        pre = await page.evaluate(() => ({
          kept: window.__E2E.count('#in-list', '.in-item[data-e2e-keep10]'),
          muts: window.__E2E.muts('list'),
        }));
      }
      assert(pre.kept === before.items, `un repintado pendiente del caso anterior (E2E-09) perdió las etiquetas antes del refresh: ${pre.kept}/${before.items}`);
      await page.evaluate(() => window.__E2E.reset('list'));
      const restMark = Date.now();
      const restBase = createSupabaseResponderReference.restGets(restMark).length;
      const refreshResult = await page.evaluate(async () => {
        try {
          const timeout = new Promise(res => setTimeout(() => res({ ok: false, timeout: true, error: 'timeout de 8 s esperando refreshSession()' }), 8000));
          const refresh = sb.auth.refreshSession()
            .then(({ data, error }) => ({ ok: !!data?.session, error: error?.message || null }))
            .catch(e => ({ ok: false, error: String(e && e.message || e) }));
          return await Promise.race([refresh, timeout]);
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      });
      await sleep(1200); // comprobación "inmediata" tras el refresh (no esperar el poll de 15 s)
      const after = await page.evaluate(() => ({
        info: window.__E2E.appInfo(),
        items: window.__E2E.count('#in-list', '.in-item'),
        kept: window.__E2E.count('#in-list', '.in-item[data-e2e-keep10]'),
        muts: window.__E2E.muts('list'),
        authEvents: window.__E2E.authEvents || [],
      }));
      const restDelta = createSupabaseResponderReference.restGets(restMark).length - restBase;
      const refreshed = after.authEvents.some(e => e.ev === 'TOKEN_REFRESHED');
      const signedIn = after.authEvents.some(e => e.ev === 'SIGNED_IN');
      assert(after.authEvents.length > 0 || refreshResult.ok, `no se pudo simular el refresh de auth: ${refreshResult.error || 'sin evento'}`);
      assert(refreshed || signedIn, `no se emitió TOKEN_REFRESHED/SIGNED_IN (eventos: ${after.authEvents.map(e => e.ev).join(', ') || 'ninguno'})`);
      assert(after.info.timeOrigin === before.timeOrigin, 'la página se recargó (timeOrigin cambió)');
      assert(after.info.appMarked === true, 'la app se reconstruyó (marca #app perdida)');
      assert(after.items === before.items && after.kept === before.items, `la lista se re-renderizó por el auth event: ${after.kept}/${before.items} conservados`);
      assert(after.muts.removed === 0, `el auth event removió ${after.muts.removed} items de la lista`);
      assert(restDelta === 0, `TOKEN_REFRESHED disparó ${restDelta} GET REST (load() completo)`);
      return `${after.authEvents.map(e => e.ev).join(', ')} · 0 GET REST · ${after.items} items intactos`;
    });

    /* ---------- Filtros de Bandeja y Pedidos (Parte 5) ---------- */
    const hoyFiltro = fechaLocal();
    const mananaFiltro = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return fechaLocal(d); })();
    const contarItemsBandeja = () => page.evaluate(() => document.querySelectorAll('#in-list .in-item').length);
    const contarFilasPedidos = () => page.evaluate(() => document.querySelectorAll('#pe-list .lrow').length);
    const setValor = (sel, valor) => page.evaluate((s, v) => {
      const el = document.querySelector(s);
      if (!el) throw new Error('no existe ' + s);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, sel, valor);
    const limpiarFiltrosBandeja = async () => {
      const panelVisible = await page.evaluate(() => !document.querySelector('#in-filtros-panel')?.hidden);
      if (!panelVisible) await page.click('#in-toggle-filtros');
      await page.click('#in-flimpiar');
      await sleep(400);
      // Si había una carga en vuelo, el panel puede no repintar: refrescar una vez.
      if ((await contarItemsBandeja()) < 4) await page.click('#in-refresh');
      await waitFor(async () => (await contarItemsBandeja()) >= 4, 10000, 'la bandeja no volvió a 4 chats tras limpiar filtros');
    };

    await runner.case('E2E-12', 'Filtro Bandeja "No leídos": solo chats con mensajes sin leer', async () => {
      await page.click('#tabs button[data-tab="bandeja"]');
      await waitFor(async () => (await contarItemsBandeja()) >= 4, 8000, 'la bandeja no pintó los 4 chats del mock');
      await limpiarFiltrosBandeja();
      await page.click('#in-filtros button[data-inf="noLeidos"]');
      await waitFor(async () => (await contarItemsBandeja()) === 2, 8000, 'el filtro "No leídos" no dejó 2 chats');
      const tels = await page.evaluate(() => [...document.querySelectorAll('#in-list .in-item')].map(x => x.dataset.tel));
      assert(tels.includes('51910418951') && tels.includes('51955512345'), `chats inesperados en "No leídos": ${tels.join(',')}`);
      await limpiarFiltrosBandeja();
      return `2 chats no leídos (${tels.join(', ')}) · limpiado`;
    });

    await runner.case('E2E-13', 'Filtro Bandeja "Sin responder": último mensaje del cliente', async () => {
      await limpiarFiltrosBandeja();
      await page.click('#in-filtros button[data-inf="sinResponder"]');
      await waitFor(async () => {
        const n = await contarItemsBandeja();
        return n >= 1 && n <= 2;
      }, 8000, 'el filtro "Sin responder" no dejó los chats con último mensaje entrante');
      const tels = await page.evaluate(() => [...document.querySelectorAll('#in-list .in-item')].map(x => x.dataset.tel));
      assert(tels.includes('51955512345'), `"Sin responder" no incluyó a Lucía (último mensaje entrante): ${tels.join(',')}`);
      assert(!tels.includes('51987654321') && !tels.includes('51966677788'), `"Sin responder" incluyó chats ya respondidos: ${tels.join(',')}`);
      await limpiarFiltrosBandeja();
      return `${tels.length} chat(s) sin responder: ${tels.join(', ')}`;
    });

    await runner.case('E2E-14', 'Filtro Bandeja "Con pedido": chats con pedido registrado', async () => {
      // Garantiza que el panel ya cargó los pedidos del bot antes de filtrar.
      await page.click('#tabs button[data-tab="pedidos"]');
      await waitFor(async () => (await page.evaluate(() => (typeof pedidosCache !== 'undefined' ? pedidosCache.length : 0))) >= 2, 10000, 'el panel no cargó los pedidos del mock');
      await page.click('#tabs button[data-tab="bandeja"]');
      await limpiarFiltrosBandeja();
      await page.click('#in-filtros button[data-inf="conPedido"]');
      await waitFor(async () => (await contarItemsBandeja()) === 2, 8000, 'el filtro "Con pedido" no dejó 2 chats');
      const tels = await page.evaluate(() => [...document.querySelectorAll('#in-list .in-item')].map(x => x.dataset.tel));
      assert(tels.includes('51987654321') && tels.includes('51955512345'), `chats inesperados en "Con pedido": ${tels.join(',')}`);
      await limpiarFiltrosBandeja();
      return `2 chats con pedido (${tels.join(', ')})`;
    });

    await runner.case('E2E-15', 'Filtro Bandeja por etiqueta: solo los chats con esa etiqueta', async () => {
      await limpiarFiltrosBandeja();
      const opciones = await page.evaluate(() => [...document.querySelectorAll('#in-e option')].map(o => o.value));
      assert(opciones.includes('vip'), `el selector de etiquetas no tiene "vip": ${opciones.join(',')}`);
      await setValor('#in-e', 'vip');
      await waitFor(async () => (await contarItemsBandeja()) === 1, 8000, 'el filtro por etiqueta no dejó 1 chat');
      const tel = await page.evaluate(() => document.querySelector('#in-list .in-item')?.dataset.tel);
      assert(tel === '51910418951', `etiqueta "vip" mostró ${tel} (se esperaba 51910418951)`);
      await limpiarFiltrosBandeja();
      return `etiqueta vip → 1 chat (${tel})`;
    });

    await runner.case('E2E-16', 'Filtro Bandeja por rango de fechas: hoy incluye recientes y excluye el antiguo', async () => {
      await limpiarFiltrosBandeja();
      await setValor('#in-fd', hoyFiltro);
      await setValor('#in-fh', hoyFiltro);
      await waitFor(async () => (await contarItemsBandeja()) === 3, 8000, `el rango de hoy no dejó 3 chats (chat antiguo debería quedar fuera)`);
      await setValor('#in-fd', mananaFiltro);
      await waitFor(async () => (await contarItemsBandeja()) === 0, 8000, 'un rango futuro no dejó la lista vacía');
      const vacio = await page.evaluate(() => /Sin chats con este filtro/i.test(document.querySelector('#in-list')?.textContent || ''));
      assert(vacio, 'no se mostró el estado vacío de la bandeja');
      await limpiarFiltrosBandeja();
      return `hoy → 3 chats · futuro → 0 con estado vacío`;
    });

    await runner.case('E2E-17', 'Filtro Pedidos por estado: solo los pedidos de ese estado', async () => {
      await page.click('#tabs button[data-tab="pedidos"]');
      await waitFor(async () => (await contarFilasPedidos()) === 2, 10000, 'la lista de pedidos no pintó los 2 pedidos del mock');
      await page.select('#pe-f-estado', 'por_entregar');
      await waitFor(async () => (await contarFilasPedidos()) === 1, 8000, 'el filtro por estado no dejó 1 pedido');
      const txt = await page.evaluate(() => document.querySelector('#pe-list .lrow')?.textContent || '');
      assert(/P-0001/.test(txt), `el pedido filtrado no es P-0001: ${txt.slice(0, 80)}`);
      await page.select('#pe-f-estado', '');
      await waitFor(async () => (await contarFilasPedidos()) === 2, 8000, 'no se restauraron los 2 pedidos');
      return `estado por_entregar → 1 pedido (P-0001)`;
    });

    await runner.case('E2E-18', 'Filtro Pedidos por entrega: recojo en estación vs delivery', async () => {
      await page.select('#pe-f-entrega', 'estacion');
      await waitFor(async () => (await contarFilasPedidos()) === 1, 8000, 'el filtro por entrega no dejó 1 pedido');
      const txt = await page.evaluate(() => document.querySelector('#pe-list .lrow')?.textContent || '');
      assert(/P-0001/.test(txt) && /Recojo/i.test(txt), `el filtro "estación" no mostró el recojo: ${txt.slice(0, 100)}`);
      await page.select('#pe-f-entrega', 'delivery');
      await waitFor(async () => (await contarFilasPedidos()) === 1, 8000, 'el filtro delivery no dejó 1 pedido');
      const txt2 = await page.evaluate(() => document.querySelector('#pe-list .lrow')?.textContent || '');
      assert(/P-0002/.test(txt2), `el filtro delivery no mostró P-0002: ${txt2.slice(0, 100)}`);
      await page.select('#pe-f-entrega', '');
      await waitFor(async () => (await contarFilasPedidos()) === 2, 8000, 'no se restauraron los 2 pedidos');
      return `estación → P-0001 · delivery → P-0002`;
    });

    await runner.case('E2E-19', 'Filtro Pedidos por rango de fechas: hoy incluye, futuro vacía', async () => {
      await page.click('#pe-flimpiar');
      await waitFor(async () => (await contarFilasPedidos()) === 2, 8000, 'no se restauraron los 2 pedidos tras limpiar');
      await setValor('#pe-f-desde', hoyFiltro);
      await setValor('#pe-f-hasta', hoyFiltro);
      await waitFor(async () => (await contarFilasPedidos()) === 2, 8000, 'el rango de hoy no dejó los 2 pedidos');
      await setValor('#pe-f-desde', mananaFiltro);
      await waitFor(async () => (await contarFilasPedidos()) === 0, 8000, 'un rango futuro no dejó la lista de pedidos vacía');
      const vacio = await page.evaluate(() => /Aún no hay pedidos/i.test(document.querySelector('#pe-list')?.textContent || ''));
      assert(vacio, 'no se mostró el estado vacío de pedidos');
      await page.click('#pe-flimpiar');
      await waitFor(async () => (await contarFilasPedidos()) === 2, 8000, 'no se restauraron los 2 pedidos tras limpiar');
      return `hoy → 2 pedidos · futuro → 0 con estado vacío`;
    });

    await runner.case('E2E-20', 'Búsqueda persistente: se guarda y se restaura al recargar la vista', async () => {
      await page.click('#tabs button[data-tab="bandeja"]');
      await limpiarFiltrosBandeja();
      await page.type('#in-q', 'Lucía');
      await waitFor(async () => (await contarItemsBandeja()) === 1, 8000, 'la búsqueda "Lucía" no dejó 1 chat');
      const guardado = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('pf_bandeja_filtros_v1') || '{}'); } catch { return {}; }
      });
      assert(guardado.q === 'Lucía', `la búsqueda no se guardó en localStorage: ${JSON.stringify(guardado)}`);
      const restaurado = await page.evaluate(() => {
        const input = document.querySelector('#in-q');
        input.value = '';
        restaurarFiltrosBandeja();
        return input.value;
      });
      assert(restaurado === 'Lucía', `la búsqueda no se restauró: "${restaurado}"`);
      await limpiarFiltrosBandeja();
      const trasLimpiar = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('pf_bandeja_filtros_v1') || '{}'); } catch { return {}; }
      });
      assert(!trasLimpiar.q, `la búsqueda no se limpió del localStorage: ${JSON.stringify(trasLimpiar)}`);
      return `"Lucía" guardada, restaurada y limpiada · ${await contarItemsBandeja()} chats`;
    });

    /* ---------- Capturas de diseño (Parte 7): 360 / 768 / 1280 px ---------- */
    if (ARGS.capturas) {
      const CAPTURAS_DIR = path.join(ROOT, 'docs', 'capturas');
      ensureDir(CAPTURAS_DIR);
      const pantallas = [
        ['inicio', 'kpis-inicio'],
        ['bandeja', 'bandeja'],
        ['pedidos', 'pedidos'],
        ['campanas', 'campanas'],
        ['bot', 'ajustes'],
        ['bienvenida', 'bienvenida'],
      ];
      const anchos = [360, 768, 1280];
      for (const [tab, nombre] of pantallas) {
        await page.click(`#tabs button[data-tab="${tab}"]`);
        await sleep(650);
        if (tab === 'bandeja') {
          const it = await page.$('#in-list .in-item');
          if (it) { await it.click(); await sleep(500); }
        }
        for (const ancho of anchos) {
          await page.setViewport({ width: ancho, height: ancho < 500 ? 900 : 1000, deviceScaleFactor: 1 });
          await sleep(420);
          await page.screenshot({ path: path.join(CAPTURAS_DIR, `${nombre}-${ancho}.png`) });
        }
        console.log(`  capturas ${nombre}: 360/768/1280`);
      }
      await page.setViewport({ width: 1280, height: 1000 });
      await page.click('#themeToggle');
      await page.click('#tabs button[data-tab="campanas"]');
      await sleep(500);
      await page.screenshot({ path: path.join(CAPTURAS_DIR, 'campanas-oscuro-1280.png') });
      await page.click('#themeToggle');
      await page.click('#tabs button[data-tab="inicio"]');
      await page.click('#tabs button[data-tab="bandeja"]');
      await sleep(350);
      await page.click('.in-tools summary');
      await sleep(250);
      await page.screenshot({ path: path.join(CAPTURAS_DIR, 'bandeja-menu-1280.png') });
      await page.click('.in-tools summary');
      await sleep(400);
    }

    await runner.case('E2E-21', 'Multimedia: la imagen se muestra automáticamente (sin botón)', async () => {
      await page.click('#tabs button[data-tab="bandeja"]');
      await waitFor(async () => (await page.evaluate(() => document.querySelectorAll('#in-list .in-item').length)) >= 4, 8000, 'la bandeja no pintó los chats');
      const it = await page.$('#in-list .in-item');
      await it.click();
      await waitFor(async () => (await page.evaluate(() => document.querySelectorAll('#in-msgs .msg-media').length)) >= 2, 10000, 'no aparecieron las multimedia en el hilo');
      // Sin clics: el observer debe descargar y pintar la imagen sola.
      await waitFor(async () => (await page.evaluate(() => !!document.querySelector('.msg-media[data-media-wa="wamid.IN.E2E.MEDIA"] img.msg-img'))), 12000, 'la imagen no se visualizó automáticamente');
      const ok = await page.evaluate(() => {
        const img = document.querySelector('.msg-media[data-media-wa="wamid.IN.E2E.MEDIA"] img.msg-img');
        const boton = document.querySelector('.msg-media[data-media-wa="wamid.IN.E2E.MEDIA"] .msg-media-btn');
        return { blob: !!(img && String(img.src).startsWith('blob:')), boton: !!boton };
      });
      assert(ok.blob, 'la imagen no se mostró como blob autenticado');
      assert(!ok.boton, 'no debe requerir botón de "Ver imagen"');
      return 'imagen visible automáticamente';
    });

    await runner.case('E2E-22', 'Multimedia antigua: el video se carga y reproduce solo (sin botón)', async () => {
      await waitFor(async () => (await page.evaluate(() => !!document.querySelector('.msg-media[data-media-wa="wamid.IN.E2E.VIDEO"] video.msg-video'))), 15000, 'el video no se visualizó automáticamente');
      const ok = await page.evaluate(() => {
        const v = document.querySelector('.msg-media[data-media-wa="wamid.IN.E2E.VIDEO"] video.msg-video');
        const boton = document.querySelector('.msg-media[data-media-wa="wamid.IN.E2E.VIDEO"] .msg-media-btn');
        return { controls: !!(v && v.controls), blob: !!(v && String(v.src).startsWith('blob:')), boton: !!boton };
      });
      assert(ok.controls && ok.blob, 'el video no quedó listo para reproducir');
      assert(!ok.boton, 'no debe requerir botón de "Ver video"');
      return 'video visible/reproducible automáticamente';
    });

    await runner.case('E2E-23', 'Modo oscuro del panel: cambia sin romper el chat y mantiene contraste', async () => {
      await page.click('#themeToggle');
      await new Promise(r => setTimeout(r, 350));
      const estado = await page.evaluate(() => {
        const tema = document.documentElement.dataset.theme;
        const out = document.querySelector('.msg.out');
        const cs = out ? getComputedStyle(out) : null;
        return { tema, color: cs?.color || '', fondo: cs?.backgroundColor || '' };
      });
      assert(estado.tema === 'dark', 'no cambió a modo oscuro');
      assert(estado.color && estado.color !== estado.fondo, 'texto del mensaje saliente sin contraste');
      await page.screenshot({ path: path.join(SHOTS_DIR, '04-oscuro.png') });
      await page.click('#themeToggle');
      await new Promise(r => setTimeout(r, 250));
      assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'no volvió al modo claro');
      return `oscuro ${estado.color} sobre ${estado.fondo} · captura 04-oscuro.png`;
    });

    await runner.case('E2E-24', 'Módulos nuevos: promoción, meta y programación por rango', async () => {
      await page.click('#tabs button[data-tab="promociones"]');
      await sleep(350);
      assert(await page.$('#promo-new'), 'la pestaña Promociones no abrió');
      await page.click('#promo-new');
      await page.type('#promo-titulo', 'Promo E2E');
      await page.type('#promo-texto', '2x50 ml por S/ 99');
      await page.click('#promo-save');
      await sleep(500);
      assert(/Promo E2E/.test(await page.$eval('#promo-list', el => el.textContent)), 'la promoción no se guardó');
      await page.click('#tabs button[data-tab="analiticas"]');
      await sleep(350);
      assert(await page.$('#an-meta'), 'falta la meta de ventas en Métricas');
      await page.click('#tabs button[data-tab="campanas"]');
      await sleep(300);
      await page.click('#k-program');
      await sleep(300);
      const dlgAbierto = await page.evaluate(() => !!document.querySelector('#dlgProgramar')?.open);
      assert(dlgAbierto, 'no abrió el modal de programación');
      await page.click('#pg-cancel');
      await page.click('#tabs button[data-tab="bandeja"]');
      await sleep(300);
      await page.click('#in-quick-config');
      await sleep(250);
      assert(await page.evaluate(() => !!document.querySelector('#dlgQuick')?.open), 'no abrió la configuración de respuestas');
      await page.click('#q-cancel');
      return 'promoción guardada · meta visible · modal de rango y respuestas OK';
    });

    await runner.case('E2E-25', 'Bandeja: adjuntar imagen y enviarla por el endpoint real del panel', async () => {
      await page.click('#tabs button[data-tab="bandeja"]');
      await sleep(350);
      const item = await page.$('#in-list .in-item');
      assert(item, 'no hay chats para probar el adjunto');
      await item.click();
      await sleep(350);
      const tmp = path.join(os.tmpdir(), 'e2e-adjunto.png');
      fs.writeFileSync(tmp, Buffer.from(PNG_1PX, 'base64'));
      const input = await page.$('#in-file');
      assert(input, 'falta el input de adjuntos');
      await input.uploadFile(tmp);
      await sleep(300);
      const chips = await page.$$eval('#in-attach-preview .in-attach-chip', xs => xs.length);
      assert(chips === 1, 'el adjunto no apareció en la vista previa');
      const antes = bot.state.mediaEnviados;
      await page.click('#in-send');
      await waitFor(() => bot.state.mediaEnviados > antes, 8000, 'el panel no llamó al endpoint de adjuntos');
      fs.rmSync(tmp, { force: true });
      return 'imagen adjuntada y enviada por /enviar-media';
    });

    await runner.case('E2E-11', 'Cero errores de consola JS y cero pageerror en toda la corrida', async () => {
      // El assert real es "0 errores de consola JS y 0 pageerror". Los avisos de red
      // que el propio arnés provoca (fallo simulado de E2E-09) o que vienen de recursos
      // externos sin red (imágenes del catálogo) se clasifican como esperados.
      const isExpectedNetError = e => {
        const hay = String(e.text || '') + ' ' + String(e.url || '');
        if (/perfumeriafinaperu\.com|ERR_BLOCKED_BY_ORB|net::ERR_ABORTED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i.test(hay)) return true;
        if (offlineWindow) {
          const start = offlineWindow.start - 1500;
          const end = (offlineWindow.end || Date.now()) + 5000; // margen: Chrome avisa async
          if (e.ts >= start && e.ts <= end && /ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|Failed to load resource|Failed to fetch|net::ERR/i.test(hay)) return true;
        }
        return false;
      };
      const isExpectedRequestFailure = r => {
        const hay = String(r.url || '') + ' ' + String(r.error || '');
        if (/perfumeriafinaperu\.com|ERR_BLOCKED_BY_ORB|net::ERR_ABORTED/i.test(hay)) return true;
        if (offlineWindow) {
          const start = offlineWindow.start - 1500;
          const end = (offlineWindow.end || Date.now()) + 5000;
          if (r.ts >= start && r.ts <= end && /api\/conversaciones|ERR_EMPTY_RESPONSE|ERR_CONNECTION/i.test(hay)) return true;
        }
        return false;
      };
      const unexpectedNet = netErrors.filter(e => !isExpectedNetError(e));
      const unexpectedFailures = requestFailures.filter(r => !isExpectedRequestFailure(r));
      assert(pageErrors.length === 0, `${pageErrors.length} pageerror: ${pageErrors.slice(0, 2).map(e => e.message).join(' | ')}`);
      assert(consoleErrors.length === 0, `${consoleErrors.length} console.error JS: ${consoleErrors.slice(0, 2).map(e => e.text).join(' | ')}`);
      assert(unexpectedNet.length === 0, `${unexpectedNet.length} error de red inesperado: ${unexpectedNet.slice(0, 2).map(e => e.text).join(' | ')}`);
      assert(unexpectedFailures.length === 0, `${unexpectedFailures.length} request fallida inesperada: ${unexpectedFailures.slice(0, 2).map(r => r.url + ' ' + r.error).join(' | ')}`);
      return `0 console.error JS · 0 pageerror · ${netErrors.length} aviso(s) de red esperados (fallo simulado/imágenes offline)`;
    });

    // ===================== FIN =====================
    const durationMs = Date.now() - Date.parse(startedAt);
    await writeRunArtifacts({ index, runner, startedAt, durationMs, puppeteerVersion, launch, supabase, bot, netErrors, consoleErrors, pageErrors, requestFailures, idleMs: IDLE_MS, supabaseScript });
    printSummary(runner.results);
    const failed = runner.results.filter(r => r.status === 'FAIL').length;
    console.log(`\nCapturas y artefactos: ${SHOTS_DIR}`);
    console.log(`Duración: ${(durationMs / 1000).toFixed(1)} s`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    if (e && e.code === 'E2E_ENV_BROWSER') {
      console.error('\n============================================================');
      console.error('  ENTORNO: CHROMIUM NO PUDO ARRANCAR');
      console.error('============================================================');
      console.error(e.message);
      console.error('\nNo se ejecutaron los casos E2E (no hay resultados PASS/FAIL de UI).');
      process.exitCode = 3;
    } else if (e && (e.code === 'E2E_ENV_PUPPETEER')) {
      console.error('\n[ENTORNO] ' + e.message);
      process.exitCode = 3;
    } else {
      console.error('\n[E2E] Error inesperado:', e && e.stack || e);
      process.exitCode = 2;
    }
    // Guardar artefactos parciales si ya había panel/servidores levantados.
    try {
      await writeRunArtifacts({
        index, runner, startedAt, durationMs: Date.now() - Date.parse(startedAt),
        puppeteerVersion: '(no disponible)', launch: { exe: '(no disponible)' }, supabase: null,
        bot, netErrors, consoleErrors, pageErrors, requestFailures, idleMs: IDLE_MS,
        supabaseScript, error: String(e && e.message || e),
      });
    } catch { /* noop */ }
  } finally {
    try { if (browser) await browser.close(); } catch { /* noop */ }
    try { if (bot) await bot.stop(); } catch { /* noop */ }
    try { if (panel) await panel.stop(); } catch { /* noop */ }
  }
}

/* Referencia al responder de Supabase para medir GET REST en los casos.
 * (Se asigna en runE2E antes de ejecutar casos.) */
const createSupabaseResponderReference = {
  restGets: () => [],
};

function totals(results) {
  return {
    total: results.length,
    pass: results.filter(r => r.status === 'PASS').length,
    fail: results.filter(r => r.status === 'FAIL').length,
    skip: results.filter(r => r.status === 'SKIP').length,
  };
}

function printSummary(results) {
  const t = totals(results);
  console.log('\n============================================================');
  console.log(`  RESULTADO: ${t.pass} PASS · ${t.fail} FAIL · ${t.skip} SKIP  (total ${t.total})`);
  console.log('============================================================');
  for (const r of results) {
    console.log(`  ${r.status.padEnd(4)} ${r.id}  ${r.name}`);
    if (r.detail) console.log(`         ${r.detail}`);
  }
}

async function writeRunArtifacts({ index, runner, startedAt, durationMs, puppeteerVersion, launch, supabase, bot, netErrors, consoleErrors, pageErrors, requestFailures, idleMs, supabaseScript, error }) {
  ensureDir(SHOTS_DIR);
  const reqSummary = {};
  if (bot) {
    const reqs = bot.apiRequests();
    for (const r of reqs) reqSummary[r.path] = (reqSummary[r.path] || 0) + 1;
  }
  const out = {
    kind: 'e2e',
    ts: new Date().toISOString(),
    startedAt,
    durationMs,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      puppeteer: puppeteerVersion,
      chrome: launch && launch.exe,
      panelUrl: PANEL_BASE,
      botUrl: BOT_BASE,
      idleMs,
    },
    index: { path: PANEL_FILE, bytes: index.bytes, sha256: index.sha256, mtime: index.mtime },
    supabaseScript: supabaseScript ? { source: supabaseScript.source, version: supabaseScript.version } : null,
    cases: runner.results,
    totals: totals(runner.results),
    errors: {
      consoleErrors,
      pageErrors,
      netErrors,
      requestFailures,
      fatal: error || null,
    },
    requests: {
      botByPath: reqSummary,
      total: Object.values(reqSummary).reduce((n, x) => n + x, 0),
    },
    supabase: supabase ? {
      restRequests: supabase.state.restRequests.length,
      authRequests: supabase.state.authRequests.length,
    } : null,
  };
  fs.writeFileSync(path.join(SHOTS_DIR, 'e2e-resultado.json'), JSON.stringify(out, null, 2));
}

function waitFor(fn, timeoutMs, message) {
  return (async () => {
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) { lastErr = e; }
      await sleep(120);
    }
    throw new Error(`Timeout (${timeoutMs} ms): ${message}${lastErr ? ' · ' + lastErr.message : ''}`);
  })();
}

/**
 * Espera a que el MutationObserver de un contenedor deje de registrar cambios
 * durante `quietMs` (para separar repintados asíncronos entre casos).
 */
async function settleMutations(page, key, quietMs = 600, timeoutMs = 5000) {
  const t0 = Date.now();
  let prev = null;
  let lastChange = t0;
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(k => window.__E2E.muts(k), key);
    const sig = JSON.stringify(last);
    if (sig !== prev) { prev = sig; lastChange = Date.now(); }
    if (Date.now() - lastChange >= quietMs) return last;
    await sleep(120);
  }
  throw new Error(`el DOM observado (${key}) no quedó estable en ${timeoutMs} ms (últimas mutaciones: ${JSON.stringify(last)})`);
}

/* ========================================================================
 * 12. Entry point
 * ====================================================================== */
async function main() {
  if (ARGS.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    return;
  }
  if (ARGS.selfTest) return runSelfTest();
  return runE2E();
}

main().catch(e => {
  console.error('\n[E2E] Fallo fatal:', e && e.stack || e);
  process.exitCode = e && e.code === 'E2E_ENV_BROWSER' ? 3 : 2;
});
