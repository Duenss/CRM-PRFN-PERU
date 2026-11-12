// Pruebas de la escritura atómica compartida (bot/src/almacen.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escribirAtomico } from '../src/almacen.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almacen-test-'));

test('escribe el archivo sin dejar .tmp y devuelve true', () => {
  const destino = path.join(dir, 'a.json');
  const ok = escribirAtomico(destino, '{"a":1}');
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(destino, 'utf8'), '{"a":1}');
  assert.equal(fs.existsSync(destino + '.tmp'), false, 'no queda temporal');
});

test('sobrescribe un archivo existente', () => {
  const destino = path.join(dir, 'b.json');
  escribirAtomico(destino, 'v1');
  const ok = escribirAtomico(destino, 'v2');
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(destino, 'utf8'), 'v2');
});

test('crea la carpeta si no existe', () => {
  const destino = path.join(dir, 'sub', 'carpeta', 'c.json');
  const ok = escribirAtomico(destino, 'x');
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(destino, 'utf8'), 'x');
});

test('si el rename falla, devuelve false, limpia el .tmp y no daña el destino', () => {
  // El destino es un DIRECTORIO: el rename del temporal falla siempre.
  const destino = path.join(dir, 'target-dir');
  fs.mkdirSync(destino, { recursive: true });
  const ok = escribirAtomico(destino, 'nuevo contenido');
  assert.equal(ok, false);
  assert.ok(fs.statSync(destino).isDirectory(), 'el destino sigue intacto');
  assert.equal(fs.existsSync(destino + '.tmp'), false, 'el temporal se limpió');
});

test('acepta contenido binario (comprobantes)', () => {
  const destino = path.join(dir, 'foto.jpg');
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const ok = escribirAtomico(destino, buf);
  assert.equal(ok, true);
  assert.deepEqual(fs.readFileSync(destino), buf);
});

test.after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
