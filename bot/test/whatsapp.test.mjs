// Pruebas de estabilidad de conexión (bot/src/whatsapp.js):
// teléfono canónico, backoff, clasificación de desconexiones, zombi y lock
// crearSesion/reiniciarSesion (un solo Chrome por sesión).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sesiones,
  crearEstado,
  crearSesion,
  reiniciarSesion,
  cerrarSesion,
  telefonoCanonico,
  recordarDestinoWa,
  recordarDestinoDirecto,
  destinoCacheado,
  recordarTelefonoDeLid,
  esperaReintentoMs,
  clasificarDesconexion,
  esZombi,
  estadoSalud,
  consultarNumeroWa,
  verificarNumeroWa,
  _fabricaClientParaPruebas
} from '../src/whatsapp.js';

/* ---------------- teléfono canónico ---------------- */

test('telefonoCanonico: @c.us y @s.whatsapp.net normalizan al mismo teléfono', () => {
  assert.equal(telefonoCanonico('51987654321@c.us'), '51987654321');
  assert.equal(telefonoCanonico('51987654321@s.whatsapp.net'), '51987654321');
  assert.equal(telefonoCanonico('987654321@s.whatsapp.net'), '51987654321', '9 dígitos peruano → +51');
  assert.equal(telefonoCanonico('0051987654321@c.us'), '51987654321', '00 + país');
  assert.equal(telefonoCanonico('51987654321'), '51987654321', 'sin sufijo');
});

test('telefonoCanonico: ids inválidos devuelven vacío', () => {
  assert.equal(telefonoCanonico(''), '');
  assert.equal(telefonoCanonico('1234@c.us'), '', 'muy corto');
  assert.equal(telefonoCanonico('hola@c.us'), '');
});

test('mismo cliente con dos ids (@c.us y @s.whatsapp.net) NO duplica chat', () => {
  const chats = new Map();
  for (const wid of ['51987654321@c.us', '51987654321@s.whatsapp.net', '0051987654321@s.whatsapp.net']) {
    const clave = telefonoCanonico(wid);
    if (!chats.has(clave)) chats.set(clave, []);
    chats.get(clave).push(wid);
  }
  assert.equal(chats.size, 1, 'una sola clave para el mismo cliente');
  assert.equal(chats.get('51987654321').length, 3);
});

test('telefonoCanonico: @lid sin resolver queda como clave propia (no se fusiona con nada)', () => {
  assert.equal(telefonoCanonico('123456789012@lid'), 'lid:123456789012');
  assert.equal(telefonoCanonico('987654321098@lid'), 'lid:987654321098');
});

test('dos @lid SIN resolver NO se fusionan entre sí', () => {
  const chats = new Map();
  for (const wid of ['123456789012@lid', '987654321098@lid']) {
    const clave = telefonoCanonico(wid);
    if (!chats.has(clave)) chats.set(clave, []);
    chats.get(clave).push(wid);
  }
  assert.equal(chats.size, 2, 'cada @lid sin resolver es un chat propio');
  assert.ok(chats.has('lid:123456789012') && chats.has('lid:987654321098'));
});

test('telefonoCanonico: @lid SOLO se fusiona si el mapa lo resuelve con certeza', () => {
  const mapa = new Map([['123456789012', '51987654321']]);
  assert.equal(telefonoCanonico('123456789012@lid', { mapa }), '51987654321');
  assert.equal(telefonoCanonico('999999999999@lid', { mapa }), 'lid:999999999999', 'sin resolver → clave propia');
});

test('recordarDestinoWa y recordarTelefonoDeLid alimentan el mapa lid→teléfono', () => {
  recordarDestinoWa('51911111111', '111111111111@lid');
  assert.equal(telefonoCanonico('111111111111@lid'), '51911111111');
  recordarTelefonoDeLid('222222222222@lid', '51922222222');
  assert.equal(telefonoCanonico('222222222222@lid'), '51922222222');
});

test('recordarDestinoDirecto: responde sin getNumberId a chats ya conocidos', () => {
  recordarDestinoDirecto('51933333333', '51933333333@c.us');
  assert.equal(destinoCacheado('51933333333'), '51933333333@c.us');
  // Un LID no se cachea como destino directo (va por destinosLid).
  recordarDestinoDirecto('51944444444', '123456789012@lid');
  assert.equal(destinoCacheado('51944444444'), '');
});

test('grupos tienen clave propia', () => {
  assert.equal(telefonoCanonico('123456789012@g.us'), 'grupo:123456789012');
});

/* ---------------- backoff y clasificación de desconexiones ---------------- */

test('esperaReintentoMs: exponencial 15 s → tope 5 min, infinito acotado', () => {
  assert.equal(esperaReintentoMs(1, { jitter: 0 }), 15000);
  assert.equal(esperaReintentoMs(2, { jitter: 0 }), 30000);
  assert.equal(esperaReintentoMs(3, { jitter: 0 }), 60000);
  assert.equal(esperaReintentoMs(4, { jitter: 0 }), 120000);
  assert.equal(esperaReintentoMs(5, { jitter: 0 }), 240000);
  assert.equal(esperaReintentoMs(6, { jitter: 0 }), 300000, 'tope 5 min');
  assert.equal(esperaReintentoMs(1000, { jitter: 0 }), 300000, 'infinito pero acotado');
});

test('esperaReintentoMs: el jitter se mantiene dentro del ±20 % y nunca baja de 15 s', () => {
  for (let i = 0; i < 30; i++) {
    const ms = esperaReintentoMs(3, { jitter: 0.2 });
    assert.ok(ms >= 48000 && ms <= 72000, `fuera de rango: ${ms}`);
    assert.ok(ms >= 15000);
  }
});

test('clasificarDesconexion: LOGOUT/desvinculado vs caída de red', () => {
  assert.equal(clasificarDesconexion('LOGOUT'), 'logout');
  assert.equal(clasificarDesconexion('Logged out'), 'logout');
  assert.equal(clasificarDesconexion('UNPAIRED'), 'logout');
  assert.equal(clasificarDesconexion('desvinculado'), 'logout');
  assert.equal(clasificarDesconexion('NAVIGATION'), 'red');
  assert.equal(clasificarDesconexion('SESSION_CLOSED'), 'red');
  assert.equal(clasificarDesconexion('CONNECTED_TO_OTHER_DEVICE'), 'red');
  assert.equal(clasificarDesconexion(''), 'red');
});

/* ---------------- sesión zombi ---------------- */

const hace = ms => new Date(Date.now() - ms).toISOString();

test('esZombi: conectado hace rato sin mensajes recientes', () => {
  assert.equal(esZombi({ estado: 'conectado', conectadoDesde: hace(12 * 60000), ultimoMensajeEn: hace(60000) }, Date.now(), 600000), false, 'mensaje hace 1 min');
  assert.equal(esZombi({ estado: 'conectado', conectadoDesde: hace(12 * 60000), ultimoMensajeEn: hace(11 * 60000) }, Date.now(), 600000), true, 'mensaje hace 11 min');
  assert.equal(esZombi({ estado: 'conectado', conectadoDesde: hace(12 * 60000), ultimoMensajeEn: null }, Date.now(), 600000), true, 'nunca recibió mensajes');
});

test('esZombi: conectado hace poco o desconectado nunca es zombi', () => {
  assert.equal(esZombi({ estado: 'conectado', conectadoDesde: hace(3 * 60000), ultimoMensajeEn: null }, Date.now(), 600000), false, 'recién conectado');
  assert.equal(esZombi({ estado: 'desconectado', conectadoDesde: hace(12 * 60000), ultimoMensajeEn: null }, Date.now(), 600000), false);
  assert.equal(esZombi(null), false);
});

test('estadoSalud: expone sesiones, último mensaje y la bandera zombi global', () => {
  const id = 'salud-test';
  sesiones.set(id, {
    ...crearEstado(id),
    estado: 'conectado',
    conectado: true,
    numero: '51999999999',
    conectadoDesde: hace(12 * 60000),
    ultimoMensajeEn: hace(11 * 60000)
  });
  try {
    const salud = estadoSalud(Date.now());
    assert.equal(salud.zombi, true);
    const s = salud.sesiones.find(x => x.id === id);
    assert.ok(s);
    assert.equal(s.estado, 'conectado');
    assert.equal(s.numero, '51999999999');
    assert.ok(s.segundosSinMensaje >= 660 && s.segundosSinMensaje <= 666, `~11 min: ${s.segundosSinMensaje}`);
    assert.equal(s.zombi, true);
  } finally {
    sesiones.delete(id);
  }
});

/* ---------------- lock: crearSesion vs reiniciarSesion (un solo Chrome) ---------------- */

test('crearSesion y reiniciarSesion simultáneos NO generan dos Chromes', async () => {
  // Evita la descarga remota de la versión web durante la prueba.
  const cacheWeb = path.join(import.meta.dirname, '..', 'data', 'web-version-cache.html');
  const respaldo = fs.existsSync(cacheWeb) ? fs.readFileSync(cacheWeb, 'utf8') : null;
  fs.mkdirSync(path.dirname(cacheWeb), { recursive: true });
  fs.writeFileSync(cacheWeb, '<html>dummy para pruebas</html>', 'utf8');

  let creaciones = 0;
  let destrucciones = 0;
  let activos = 0;
  let maxActivos = 0;
  _fabricaClientParaPruebas(() => {
    creaciones++;
    activos++;
    maxActivos = Math.max(maxActivos, activos);
    return {
      on() {},
      info: { wid: { user: '51999999999' } },
      pupPage: null,
      pupBrowser: null,
      initialize: () => new Promise(res => setTimeout(res, 25)),
      destroy: async () => { destrucciones++; activos = Math.max(0, activos - 1); },
      logout: async () => {}
    };
  });

  const id = 'test-lock';
  sesiones.set(id, crearEstado(id));
  const man = { onMensaje: async () => {}, onMensajePropio: async () => {}, onAck: async () => {}, log: () => {} };
  try {
    const p1 = crearSesion(id, man);
    const p2 = reiniciarSesion(id);
    await Promise.all([p1, p2]);
    await new Promise(r => setTimeout(r, 50)); // deja terminar initialize/destroy
    assert.equal(creaciones, 2, 'una creación por operación (serializadas)');
    assert.ok(destrucciones >= 1, 'el cliente anterior se destruyó antes de crear el nuevo');
    assert.equal(maxActivos, 1, 'nunca hubo dos Chromes vivos a la vez');
  } finally {
    _fabricaClientParaPruebas(null);
    await cerrarSesion(id); // también verifica que logout limpia timers y cliente
    sesiones.delete(id);
    if (respaldo === null) fs.rmSync(cacheWeb, { force: true });
    else fs.writeFileSync(cacheWeb, respaldo, 'utf8');
  }
});

test('cerrarSesion deja la sesión sin timers ni cliente', async () => {
  const id = 'test-cierre';
  sesiones.set(id, crearEstado(id));
  sesiones.get(id).client = { destroy: async () => {}, logout: async () => {} };
  await cerrarSesion(id);
  const s = sesiones.get(id);
  assert.equal(s.client, null);
  assert.equal(s.estado, 'desconectado');
  assert.equal(s.cerrada, true);
  assert.equal(s.timers.size, 0);
  sesiones.delete(id);
});

/* ---------------- consulta tri-estado anti-bloqueo ---------------- */

test('consultarNumeroWa: getNumberId null LIMPIO → {existe:false}', async () => {
  const id = 'consulta-numero';
  const s = crearEstado(id);
  s.estado = 'conectado';
  s.conectado = true;
  s.numero = '51999999999';
  s.client = { getNumberId: async () => null };
  sesiones.set(id, s);
  try {
    assert.deepEqual(await consultarNumeroWa('51987654321', id), { existe: false });
  } finally {
    sesiones.delete(id);
  }
});

test('consultarNumeroWa: un error de getNumberId LANZA (infra, nunca "sin WhatsApp")', async () => {
  const id = 'consulta-numero-error';
  const s = crearEstado(id);
  s.estado = 'conectado';
  s.conectado = true;
  s.client = { getNumberId: async () => { throw new Error('boom de red'); } };
  sesiones.set(id, s);
  try {
    await assert.rejects(consultarNumeroWa('51987654321', id), /boom de red/);
  } finally {
    sesiones.delete(id);
  }
});

test('consultarNumeroWa sin sesión conectada lanza (infra, no "sin WhatsApp")', async () => {
  await assert.rejects(consultarNumeroWa('51987654321', 'sesion-inexistente'), /Ningún WhatsApp está conectado/);
});

test('verificarNumeroWa conserva el booleano histórico: false ante error', async () => {
  const id = 'verificar-numero';
  const s = crearEstado(id);
  s.estado = 'conectado';
  s.conectado = true;
  s.client = { getNumberId: async () => { throw new Error('red'); } };
  sesiones.set(id, s);
  try {
    assert.equal(await verificarNumeroWa('51987654321', id), false);
  } finally {
    sesiones.delete(id);
  }
});
