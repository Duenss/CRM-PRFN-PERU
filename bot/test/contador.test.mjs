// Pruebas del contador diario persistido (bot/src/contador.js, F-15):
//  - reiniciar el proceso conserva el conteo del día,
//  - cambiar de fecha (hora de Lima) lo reinicia,
//  - la escritura es atómica (no queda .tmp) y tolera un JSON corrupto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearContador } from '../src/contador.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contador-test-'));
const MS_DIA = 24 * 60 * 60 * 1000;

/** Archivo nuevo por prueba (evita que una prueba contamine a otra). */
let n = 0;
const archivo = () => path.join(dir, `contador-${++n}.json`);
const fechaHoy = ms => new Date(ms).toISOString().slice(0, 10);
const leer = ruta => JSON.parse(fs.readFileSync(ruta, 'utf8'));

test('persiste el conteo y lo retoma al reiniciar el proceso', () => {
  const ruta = archivo();
  const reloj = Date.parse('2026-11-12T15:00:00.000Z');
  const uno = crearContador({ archivo: ruta, fechaHoy, ahora: () => reloj });

  assert.deepEqual(uno.valor(), { fecha: '2026-11-12', n: 0 });
  uno.contar();
  uno.contar();
  assert.equal(uno.valor().n, 2);
  assert.deepEqual(leer(ruta), { fecha: '2026-11-12', n: 2 });
  assert.equal(fs.existsSync(ruta + '.tmp'), false, 'la escritura atómica no deja temporal');

  // "Reinicio del bot": una instancia nueva sobre el mismo archivo.
  const dos = crearContador({ archivo: ruta, fechaHoy, ahora: () => reloj });
  assert.equal(dos.valor().n, 2, 'el conteo del día sobrevive al reinicio');
});

test('al cambiar la fecha de Lima se reinicia a 0 y se persiste el día nuevo', () => {
  const ruta = archivo();
  let reloj = Date.parse('2026-11-12T23:30:00.000Z');
  const contador = crearContador({ archivo: ruta, fechaHoy, ahora: () => reloj });
  contador.contar();
  contador.contar();
  contador.contar();
  assert.equal(contador.valor().n, 3);

  reloj += MS_DIA; // 2026-11-13
  assert.deepEqual(contador.valor(), { fecha: '2026-11-13', n: 0 }, 'día nuevo → conteo en 0');
  assert.deepEqual(leer(ruta), { fecha: '2026-11-13', n: 0 }, 'el reinicio también se persiste');

  contador.contar();
  assert.deepEqual(contador.valor(), { fecha: '2026-11-13', n: 1 });
  assert.deepEqual(leer(ruta), { fecha: '2026-11-13', n: 1 });
});

test('al arrancar con un archivo de otro día, el contador empieza en 0', () => {
  const ruta = archivo();
  fs.writeFileSync(ruta, JSON.stringify({ fecha: '2026-11-10', n: 50 }), 'utf8');
  const contador = crearContador({
    archivo: ruta,
    fechaHoy,
    ahora: () => Date.parse('2026-11-12T10:00:00.000Z')
  });
  assert.deepEqual(contador.valor(), { fecha: '2026-11-12', n: 0 });
  assert.equal(leer(ruta).fecha, '2026-11-12');
  assert.equal(fs.existsSync(ruta + '.tmp'), false);
});

test('limiteAlcanzado respeta el tope diario (y 0 = sin límite)', () => {
  const ruta = archivo();
  const reloj = Date.parse('2026-11-12T15:00:00.000Z');
  const contador = crearContador({ archivo: ruta, fechaHoy, ahora: () => reloj });

  assert.equal(contador.limiteAlcanzado(0), false, 'sin límite configurado');
  assert.equal(contador.limiteAlcanzado(3), false);
  contador.contar();
  contador.contar();
  assert.equal(contador.limiteAlcanzado(3), false);
  contador.contar();
  assert.equal(contador.limiteAlcanzado(3), true);
  assert.equal(contador.limiteAlcanzado(5), false);
});

test('un JSON corrupto no rompe el arranque: se empieza de cero y se reescribe', () => {
  const ruta = archivo();
  fs.writeFileSync(ruta, '{esto no es json', 'utf8');
  const reloj = Date.parse('2026-11-12T15:00:00.000Z');
  const contador = crearContador({ archivo: ruta, fechaHoy, ahora: () => reloj });
  assert.equal(contador.valor().n, 0);
  contador.contar();
  assert.deepEqual(leer(ruta), { fecha: '2026-11-12', n: 1 });
  assert.equal(fs.existsSync(ruta + '.tmp'), false);
});

test('avisa cuando no puede escribir el archivo (destino inválido)', () => {
  // El destino es un DIRECTORIO: escribirAtomico falla y el contador no rompe.
  const ruta = path.join(dir, 'destino-dir');
  fs.mkdirSync(ruta, { recursive: true });
  const avisos = [];
  const reloj = Date.parse('2026-11-12T15:00:00.000Z');
  const contador = crearContador({ archivo: ruta, fechaHoy, ahora: () => reloj, avisar: m => avisos.push(m) });
  assert.equal(contador.contar(), 1, 'el conteo en memoria sigue funcionando');
  assert.ok(avisos.length >= 1, 'avisó que no pudo persistir');
  assert.ok(avisos.every(m => /contador/i.test(m)));
});

test.after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
