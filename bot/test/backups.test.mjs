// Pruebas de la lógica pura de backups (bot/src/backups.js): fechas de
// carpetas, retención, hashes de archivos y programación. Sin red ni Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUCKET, fechaCarpeta, carpetasViejas, hashesArchivos, sha256, msHastaHoraLocal } from '../src/backups.js';

test('el bucket por defecto es bot-backups', () => {
  assert.equal(BUCKET, 'bot-backups');
});

test('fechaCarpeta devuelve YYYY-MM-DD', () => {
  assert.match(fechaCarpeta(new Date('2026-11-12T08:05:00Z')), /^\d{4}-\d{2}-\d{2}$/);
});

test('sha256 es estable y distinto para contenidos distintos', () => {
  assert.equal(sha256('hola'), sha256('hola'));
  assert.notEqual(sha256('hola'), sha256('chau'));
});

test('carpetasViejas: borra solo las diarias más viejas del límite', () => {
  const hoy = '2026-11-12';
  const lista = ['2026-10-20', '2026-11-01', '2026-11-12', '2026-11-05', 'basura', '20261105'];
  const viejas = carpetasViejas(lista, hoy, 14);
  // límite: 2026-10-29 → solo 2026-10-20 queda fuera de la ventana de 14 días.
  assert.deepEqual(viejas, ['2026-10-20']);
});

test('carpetasViejas respeta días configurables', () => {
  assert.deepEqual(carpetasViejas(['2026-11-01', '2026-11-10'], '2026-11-12', 30), []);
  assert.deepEqual(carpetasViejas(['2026-11-01'], '2026-11-12', 5), ['2026-11-01']);
});

test('hashesArchivos: solo sube lo que cambió (por hash de contenido)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-hash-'));
  try {
    fs.writeFileSync(path.join(dir, 'catalogo.pdf'), 'pdf-v1');
    fs.writeFileSync(path.join(dir, 'video.mp4'), 'video');
    const h1 = hashesArchivos(dir);
    assert.deepEqual(Object.keys(h1).sort(), ['catalogo.pdf', 'video.mp4']);

    fs.writeFileSync(path.join(dir, 'catalogo.pdf'), 'pdf-v2');
    fs.writeFileSync(path.join(dir, 'foto.jpg'), 'foto');
    const h2 = hashesArchivos(dir);

    // El hash sigue al CONTENIDO: solo el PDF cambió su hash.
    assert.notEqual(h1['catalogo.pdf'], h2['catalogo.pdf']);
    assert.equal(h1['video.mp4'], h2['video.mp4'], 'el video no cambió');
    assert.ok(h2['foto.jpg'], 'archivo nuevo aparece');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('msHastaHoraLocal: un ciclo de 24 h en milisegundos positivos', () => {
  const a = new Date('2026-11-12T15:00:00Z'); // 10:00 en Lima
  const ms = msHastaHoraLocal(3, a);
  assert.ok(ms > 0 && ms <= 24 * 3600 * 1000);
  assert.ok(Number.isFinite(ms));
});
