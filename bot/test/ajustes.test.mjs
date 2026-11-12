// Pruebas de los ajustes editables (límites e intervalos).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const raiz = path.join(import.meta.dirname, '..');
const archivo = path.join(raiz, 'data', 'ajustes.json');
const respaldo = fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8') : null;

fs.mkdirSync(path.dirname(archivo), { recursive: true });
if (fs.existsSync(archivo)) fs.rmSync(archivo, { force: true });

const ajustes = await import('../src/ajustes.js');

test.after(() => {
  try {
    if (respaldo === null) fs.rmSync(archivo, { force: true });
    else fs.writeFileSync(archivo, respaldo, 'utf8');
  } catch { /* best-effort */ }
});

test('valores por defecto coherentes', () => {
  const a = ajustes.estadoAjustes();
  assert.equal(a.maxPorDia, 0, 'sin límite diario por defecto');
  assert.equal(a.maxRespuestasPorChat, 0);
  assert.ok(a.intervaloMin >= 1);
  assert.ok(a.intervaloMax >= a.intervaloMin);
  assert.ok(a.intervaloEntreChats >= 0);
  assert.ok(a.intervaloMasivo >= 1);
});

test('bienvenida: catálogo, video y foto activados por defecto', () => {
  const a = ajustes.estadoAjustes();
  assert.equal(a.enviarCatalogo, true);
  assert.equal(a.enviarVideo, true);
  assert.equal(a.enviarFoto, true);
  assert.equal(a.preguntaMinutos, 2);
  assert.equal(a.bienvenidaDiasInactivo, 90);
});

test('bienvenida: preguntaMinutos se limita a 1-10 y los días de inactividad a 1-3650', () => {
  const a = ajustes.actualizarAjustes({ preguntaMinutos: 0, bienvenidaDiasInactivo: 99999, enviarFoto: false });
  assert.equal(a.preguntaMinutos, 1);
  assert.equal(a.bienvenidaDiasInactivo, 3650);
  assert.equal(a.enviarFoto, false);
  ajustes.actualizarAjustes({ enviarFoto: true });
});

test('normaliza números inválidos y negativos', () => {
  const a = ajustes.actualizarAjustes({
    maxPorDia: -5,
    maxRespuestasPorChat: 'abc',
    intervaloMin: -10,
    intervaloMax: 0,
    intervaloEntreChats: -3,
    intervaloMasivo: 0,
    horaInicio: 99,
    horaFin: 0
  });
  assert.equal(a.maxPorDia, 0);
  assert.equal(a.maxRespuestasPorChat, 0);
  assert.ok(a.intervaloMin >= 1);
  assert.ok(a.intervaloMax >= a.intervaloMin);
  assert.equal(a.intervaloEntreChats, 0);
  assert.ok(a.intervaloMasivo >= 1);
  assert.ok(a.horaInicio <= 23);
  assert.ok(a.horaFin >= 1);
});

test('respeta los valores configurados', () => {
  const a = ajustes.actualizarAjustes({
    maxPorDia: 120,
    maxRespuestasPorChat: 15,
    intervaloMin: 6,
    intervaloMax: 7,
    intervaloEntreChats: 30,
    intervaloMasivo: 3,
    horaInicio: 10,
    horaFin: 21
  });
  assert.equal(a.maxPorDia, 120);
  assert.equal(a.maxRespuestasPorChat, 15);
  assert.equal(a.intervaloMin, 6);
  assert.equal(a.intervaloMax, 7);
  assert.equal(a.intervaloEntreChats, 30);
  assert.equal(a.intervaloMasivo, 3);
  assert.equal(a.horaInicio, 10);
  assert.equal(a.horaFin, 21);
});

test('el masivo nunca baja de 1 segundo', () => {
  ajustes.actualizarAjustes({ intervaloMasivo: 0 });
  assert.ok(ajustes.esperaMasivaMs() >= 1000);
});

test('la espera de chat queda dentro del rango configurado', () => {
  ajustes.actualizarAjustes({ intervaloMin: 3, intervaloMax: 3 });
  assert.equal(ajustes.esperaChatMs(), 3000);
});

test('se persiste en data/ajustes.json', () => {
  ajustes.actualizarAjustes({ intervaloEntreChats: 12 });
  const guardado = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  assert.equal(guardado.intervaloEntreChats, 12);
});
