// Pruebas de las podas y del Map con TTL (F-14):
//  - ia.pausados: se borran las pausas de más de 90 días (y se persisten),
//  - seguimiento.chats: se borran los chats sin actividad ni tareas en 180 días,
//  - cooldown: Map acotado (TTL 15 min, tope 5.000, poda al insertar).
//
// ia.js y seguimiento.js cargan su JSON al importarse, así que las fixtures se
// escriben ANTES del import dinámico (mismo patrón que bienvenida.test.mjs) y se
// restauran los archivos reales al terminar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { crearMapaTtl } from '../src/mapa-ttl.js';

const raiz = path.join(import.meta.dirname, '..');
const dataDir = path.join(raiz, 'data');
const iaFile = path.join(dataDir, 'ia.json');
const segFile = path.join(dataDir, 'seguimiento.json');

const AHORA = Date.now();
const MS_DIA = 24 * 60 * 60 * 1000;
const iso = ms => new Date(ms).toISOString();

const respaldoIa = fs.existsSync(iaFile) ? fs.readFileSync(iaFile, 'utf8') : null;
const respaldoSeg = fs.existsSync(segFile) ? fs.readFileSync(segFile, 'utf8') : null;

fs.mkdirSync(dataDir, { recursive: true });
// --- fixtures de ia.json: una pausa vieja, una reciente y una al borde (91 d) ---
fs.writeFileSync(iaFile, JSON.stringify({
  activa: true,
  autoRespuesta: true,
  maxPorConversacion: 0,
  prompt: '',
  actualizado: iso(AHORA - 200 * MS_DIA),
  pausados: {
    '51900000001': { desde: iso(AHORA - 100 * MS_DIA), motivo: 'viejo', nombre: 'Viejo' },
    '51900000002': { desde: iso(AHORA - 1 * MS_DIA), motivo: 'reciente', nombre: 'Reciente' },
    '51900000003': { desde: iso(AHORA - 91 * MS_DIA), motivo: 'justo pasado', nombre: 'Borde' }
  }
}, null, 2), 'utf8');

// --- fixtures de seguimiento.json: viejos, reciente y viejo con tarea reciente ---
fs.writeFileSync(segFile, JSON.stringify({
  chats: {
    '51900000011': { activo: true, nombre: 'Viejo sin tareas', desde: iso(AHORA - 250 * MS_DIA) },
    '51900000012': { activo: true, nombre: 'Reciente', desde: iso(AHORA - 5 * MS_DIA) },
    '51900000013': { activo: true, nombre: 'Viejo con tarea reciente', desde: iso(AHORA - 250 * MS_DIA) },
    '51900000014': { activo: false, nombre: 'Viejo con tarea vieja', desde: iso(AHORA - 300 * MS_DIA) }
  },
  tareas: [
    {
      id: 'S-00001', telefono: '51900000013', tipo: '3d', estado: 'enviado',
      creado: iso(AHORA - 10 * MS_DIA), programadoEn: iso(AHORA - 7 * MS_DIA), enviadoEn: iso(AHORA - 8 * MS_DIA)
    },
    {
      id: 'S-00002', telefono: '51900000014', tipo: '3d', estado: 'enviado',
      creado: iso(AHORA - 300 * MS_DIA), programadoEn: iso(AHORA - 290 * MS_DIA), enviadoEn: iso(AHORA - 290 * MS_DIA)
    }
  ]
}, null, 2), 'utf8');

const ia = await import('../src/ia.js');
const seg = await import('../src/seguimiento.js');

const leerJson = ruta => JSON.parse(fs.readFileSync(ruta, 'utf8'));
const existeTmp = ruta => fs.existsSync(ruta + '.tmp');

function restaurar(ruta, respaldo) {
  try {
    if (respaldo === null) fs.rmSync(ruta, { force: true });
    else fs.writeFileSync(ruta, respaldo, 'utf8');
    fs.rmSync(ruta + '.tmp', { force: true });
  } catch { /* best-effort */ }
}

test.after(() => {
  restaurar(iaFile, respaldoIa);
  restaurar(segFile, respaldoSeg);
});

/* ---------------- ia.pausados ---------------- */

test('ia: al cargar se podan los pausados de más de 90 días y se persiste', () => {
  const pausados = ia.estadoIA().pausados;
  assert.deepEqual(pausados.map(p => p.telefono), ['51900000002'], 'solo queda la pausa reciente');
  assert.equal(ia.estaPausado('51900000001'), false);
  assert.equal(ia.estaPausado('51900000002'), true);

  const disco = leerJson(iaFile);
  assert.deepEqual(Object.keys(disco.pausados), ['51900000002']);
  assert.equal(existeTmp(iaFile), false, 'persistencia atómica sin .tmp');
});

test('ia: podarPausadosDe (puro) borra viejos y conserva recientes/sin fecha', () => {
  const r = ia.podarPausadosDe({
    viejo: { desde: iso(AHORA - 91 * MS_DIA) },
    reciente: { desde: iso(AHORA - 89 * MS_DIA) },
    sinFecha: { motivo: 'dato legado' }
  }, AHORA);
  assert.equal(r.borrados, 1);
  assert.deepEqual(Object.keys(r.pausados).sort(), ['reciente', 'sinFecha']);
});

test('ia: podarPausados no reescribe si no hay nada que borrar', () => {
  assert.deepEqual(ia.podarPausados(AHORA), { borrados: 0 });
  assert.deepEqual(Object.keys(leerJson(iaFile).pausados), ['51900000002']);
});

/* ---------------- seguimiento.chats ---------------- */

test('seguimiento: poda los chats viejos y conserva los recientes / con tareas', () => {
  const r = seg.podarChats(AHORA);
  assert.equal(r.borrados, 2, 'se borraron los dos chats sin actividad reciente');

  // Chat viejo sin tareas: fuera. Reciente: queda. Viejo con tarea reciente: queda.
  assert.equal(seg.estaActivo('51900000011'), false);
  assert.equal(seg.estaActivo('51900000012'), true);
  assert.equal(seg.estaActivo('51900000013'), true);
  assert.equal(seg.estaActivo('51900000014'), false);

  const disco = leerJson(segFile);
  assert.deepEqual(Object.keys(disco.chats).sort(), ['51900000012', '51900000013']);
  assert.equal(existeTmp(segFile), false, 'persistencia atómica sin .tmp');
  assert.equal(disco.tareas.length, 2, 'la poda de chats no toca las tareas');
});

test('seguimiento: podarChatsDe (puro) elige bien la fecha de referencia', () => {
  const r = seg.podarChatsDe({
    viejo: { activo: true, desde: iso(AHORA - 200 * MS_DIA) },
    reciente: { activo: true, desde: iso(AHORA - 1 * MS_DIA) },
    sinFecha: { activo: true },
    conActualizadoReciente: { activo: true, desde: iso(AHORA - 400 * MS_DIA), actualizado: iso(AHORA - 2 * MS_DIA) }
  }, [], AHORA);
  assert.equal(r.borrados, 2);
  assert.deepEqual(Object.keys(r.chats).sort(), ['conActualizadoReciente', 'reciente']);
});

test('seguimiento: el periodo de poda es configurable', () => {
  const chats = { hace40dias: { activo: true, desde: iso(AHORA - 40 * MS_DIA) } };
  assert.equal(seg.podarChatsDe(chats, [], AHORA, 180).borrados, 0);
  assert.equal(seg.podarChatsDe(chats, [], AHORA, 30).borrados, 1);
});

test('seguimiento: una segunda poda no borra nada más', () => {
  assert.deepEqual(seg.podarChats(AHORA), { borrados: 0 });
});

/* ---------------- cooldown: Map con TTL y tope (F-14) ---------------- */

test('mapa-ttl: TTL de 15 min; la entrada vencida ya no se lee', () => {
  let t = 1_000_000;
  const mapa = crearMapaTtl({ ttlMs: 15 * 60 * 1000, max: 5000, ahora: () => t });
  mapa.set('chat', 'ultima-respuesta');
  assert.equal(mapa.get('chat'), 'ultima-respuesta');

  t += 15 * 60 * 1000 - 1;
  assert.equal(mapa.get('chat'), 'ultima-respuesta', 'todavía dentro del TTL');
  t += 1; // venció exactamente
  assert.equal(mapa.get('chat'), undefined);
  assert.equal(mapa.tamano(), 0, 'la poda eliminó la entrada vencida');
});

test('mapa-ttl: tope de 5.000 (o configurable) respetado al insertar', () => {
  const mapa = crearMapaTtl({ ttlMs: 60 * 60 * 1000, max: 3, ahora: () => 0 });
  for (let i = 1; i <= 5; i++) mapa.set('chat-' + i, i);
  assert.equal(mapa.tamano(), 3, 'nunca guarda más que el tope');
  assert.equal(mapa.get('chat-1'), undefined, 'descartó primero la más antigua');
  assert.equal(mapa.get('chat-5'), 5);
});

test('mapa-ttl: la poda también limpiar vencidas al insertar', () => {
  let t = 0;
  const mapa = crearMapaTtl({ ttlMs: 1000, max: 100, ahora: () => t });
  mapa.set('vieja', 1);
  t = 1500;
  mapa.set('nueva', 2); // el propio set poda la vencida
  assert.equal(mapa.tamano(), 1);
  assert.equal(mapa.get('vieja'), undefined);
  assert.equal(mapa.get('nueva'), 2);
});

test('mapa-ttl: delete, has y limpiar se comportan como un Map', () => {
  const mapa = crearMapaTtl({ ahora: () => 0 });
  mapa.set('a', 1);
  assert.equal(mapa.has('a'), true);
  assert.equal(mapa.delete('a'), true);
  assert.equal(mapa.has('a'), false);
  mapa.set('b', 2);
  mapa.limpiar();
  assert.equal(mapa.tamano(), 0);
});
