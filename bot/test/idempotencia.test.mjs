// Pruebas de la idempotencia del envío manual (F-16):
//  - el módulo puro respeta TTL de 15 s y el tope de entradas,
//  - el endpoint real registra el handler de Express y no reenvía dos veces
//    el mismo mensaje cuando llega la misma `idempotencyKey`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearIdempotencia, TTL_IDEMPOTENCIA_MS } from '../src/idempotencia.js';
import { registrarConversaciones } from '../src/routes/conversaciones.js';

/* ---------------- módulo puro ---------------- */

test('recordar/obtener: la misma clave devuelve el valor guardado', () => {
  const idem = crearIdempotencia();
  const valor = { status: 200, cuerpo: { ok: true } };
  idem.recordar('k1', valor, 1_000_000);
  assert.equal(idem.obtener('k1', 1_000_000), valor);
  assert.equal(idem.obtener('otra', 1_000_000), null);
});

test('TTL: dentro de 15 s se recuerda; al vencer se olvida', () => {
  const idem = crearIdempotencia();
  const t0 = 5_000_000;
  idem.recordar('k1', 'respuesta', t0);
  assert.equal(idem.obtener('k1', t0 + TTL_IDEMPOTENCIA_MS - 1), 'respuesta');
  assert.equal(idem.obtener('k1', t0 + TTL_IDEMPOTENCIA_MS), null, 'a los 15 s ya no cuenta');
  assert.equal(idem.tamano(), 0, 'la poda eliminó la clave vencida');
});

test('poda: las claves vencidas se borran y las vigentes se conservan', () => {
  const idem = crearIdempotencia();
  const t0 = 2_000_000;
  idem.recordar('vieja', 1, t0);
  idem.recordar('nueva', 2, t0 + 10_000);
  idem.podar(t0 + 16_000);
  assert.equal(idem.tamano(), 1);
  assert.equal(idem.obtener('nueva', t0 + 16_000), 2);
  assert.equal(idem.obtener('vieja', t0 + 16_000), null);
});

test('tope: nunca guarda más entradas que `max` (poda al insertar)', () => {
  const idem = crearIdempotencia({ max: 3 });
  for (let i = 1; i <= 5; i++) idem.recordar('k' + i, i, 1_000_000);
  assert.equal(idem.tamano(), 3);
  assert.equal(idem.obtener('k1', 1_000_000), null, 'la más vieja se descartó');
  assert.equal(idem.obtener('k5', 1_000_000), 5);
});

test('olvidar elimina la clave (reintento permitido tras un fallo)', () => {
  const idem = crearIdempotencia();
  idem.recordar('k1', 'x', 1000);
  assert.equal(idem.olvidar('k1'), true);
  assert.equal(idem.obtener('k1', 1000), null);
});

/* ---------------- endpoint de envío manual ---------------- */
// App/Express falsa: guarda el handler POST para invocarlo directamente, sin
// abrir un puerto ni tocar WhatsApp/Supabase.
function crearEntorno() {
  const rutas = {};
  const app = {
    get() {},
    post(ruta, ...args) { rutas[ruta] = args[args.length - 1]; }
  };
  const enviados = [];
  const registrados = [];
  const ctx = {
    auth: (_req, _res, next) => next(),
    normalizar: t => String(t || '').replace(/\D/g, ''),
    listar: () => [], buscar: () => ({ items: [], total: 0 }), obtener: () => null,
    marcarLeido: () => {}, obtenerChat: () => null,
    estadoIA: () => ({ pausados: [] }),
    seguimiento: { estaActivo: () => false, listar: () => ({}) },
    pedidos: { etiquetasChat: () => [] },
    resumenChats: () => ({}),
    getClientes: async () => [],
    getCliente: async () => null,
    config: { modoPrueba: true },
    sesionDisponible: () => true,
    enviar: async (tel, texto) => { enviados.push({ tel, texto }); return { waId: 'wa-' + enviados.length }; },
    logMensaje: async fila => { registrados.push(fila); },
    registrar: () => {},
    log: () => {}
  };
  registrarConversaciones(app, ctx);
  return { handler: rutas['/api/conversaciones/:telefono/enviar'], enviados, registrados };
}

function crearRes() {
  const res = { codigo: 200, cuerpo: null };
  res.status = c => { res.codigo = c; return res; };
  res.json = b => { res.cuerpo = b; return res; };
  return res;
}

async function pedir(handler, body) {
  const res = crearRes();
  await handler({ params: { telefono: '51912345678' }, body }, res);
  return res;
}
const claveUnica = prefijo => `${prefijo}-${Math.random().toString(36).slice(2)}`;

test('endpoint: dos llamadas con la misma clave solo envían una vez', async () => {
  const { handler, enviados, registrados } = crearEntorno();
  const clave = claveUnica('doble-clic');
  const r1 = await pedir(handler, { texto: 'Hola', idempotencyKey: clave });
  const r2 = await pedir(handler, { texto: 'Hola', idempotencyKey: clave });

  assert.equal(enviados.length, 1, 'el mensaje se envió una sola vez');
  assert.equal(registrados.filter(f => f.direccion === 'saliente').length, 1, 'una sola fila en mensajes');
  assert.equal(r1.cuerpo.ok, true);
  assert.equal(r1.cuerpo.duplicado, undefined);
  assert.equal(r2.cuerpo.ok, true);
  assert.equal(r2.cuerpo.duplicado, true, 'la segunda respuesta avisa que fue duplicada');
  assert.equal(r2.codigo, 200);
});

test('endpoint: claves distintas envían dos mensajes', async () => {
  const { handler, enviados } = crearEntorno();
  await pedir(handler, { texto: 'Uno', idempotencyKey: claveUnica('a') });
  await pedir(handler, { texto: 'Dos', idempotencyKey: claveUnica('b') });
  assert.equal(enviados.length, 2);
});

test('endpoint: una clave vencida (más de 15 s) permite reenviar', async () => {
  const { handler, enviados } = crearEntorno();
  const clave = claveUnica('vencida');
  // Simula que la primera petición fue hace 16 s: la clave ya debe estar vencida.
  const { idempotenciaEnvios } = await import('../src/idempotencia.js');
  idempotenciaEnvios.recordar(clave, { status: 200, cuerpo: { ok: true } }, Date.now() - 16_000);

  const res = await pedir(handler, { texto: 'Hola', idempotencyKey: clave });
  assert.equal(enviados.length, 1, 'la clave vencida no bloquea el envío');
  assert.equal(res.cuerpo.duplicado, undefined);
});

test('endpoint: sin idempotencyKey se comporta como antes (siempre envía)', async () => {
  const { handler, enviados } = crearEntorno();
  await pedir(handler, { texto: 'Hola' });
  await pedir(handler, { texto: 'Hola' });
  assert.equal(enviados.length, 2);
});

test('endpoint: un envío fallido no se cachea (el reintento con la misma clave sí envía)', async () => {
  const rutas = {};
  const app = { get() {}, post(ruta, ...args) { rutas[ruta] = args[args.length - 1]; } };
  let fallar = true;
  const enviados = [];
  registrarConversaciones(app, {
    auth: (_q, _s, next) => next(),
    normalizar: t => String(t || '').replace(/\D/g, ''),
    obtener: () => null,
    estadoIA: () => ({ pausados: [] }),
    seguimiento: {}, pedidos: {}, resumenChats: () => ({}),
    getClientes: async () => [], getCliente: async () => null,
    config: { modoPrueba: true }, sesionDisponible: () => true,
    enviar: async () => {
      if (fallar) throw new Error('sin conexión');
      enviados.push(1);
      return { waId: 'w' };
    },
    logMensaje: async () => {}, registrar: () => {}, log: () => {}
  });
  const handler = rutas['/api/conversaciones/:telefono/enviar'];
  const clave = claveUnica('fallo');

  const r1 = await pedir(handler, { texto: 'Hola', idempotencyKey: clave });
  assert.equal(r1.codigo, 500);
  fallar = false;
  const r2 = await pedir(handler, { texto: 'Hola', idempotencyKey: clave });
  assert.equal(r2.codigo, 200);
  assert.equal(r2.cuerpo.duplicado, undefined, 'el reintento se ejecutó de verdad');
  assert.equal(enviados.length, 1);
});
