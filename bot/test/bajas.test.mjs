// Pruebas de la lista local de bajas (números que pidieron no recibir promos).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const raiz = path.join(import.meta.dirname, '..');
const archivo = path.join(raiz, 'data', 'bajas.json');
const respaldo = fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8') : null;
if (fs.existsSync(archivo)) fs.rmSync(archivo, { force: true });

const bajas = await import('../src/bajas.js');

test.after(() => {
  try {
    if (respaldo === null) fs.rmSync(archivo, { force: true });
    else fs.writeFileSync(archivo, respaldo, 'utf8');
  } catch { /* best-effort */ }
});

test('marcar y consultar baja', () => {
  assert.equal(bajas.esBaja('51900000996'), false);
  bajas.marcarBajaLocal('+51 900 000 996');
  assert.equal(bajas.esBaja('51900000996'), true);
  assert.equal(bajas.esBaja('51 900-000-996'), true);
  assert.ok(bajas.listaBajas().includes('51900000996'));
});

test('quitar baja', () => {
  bajas.marcarBajaLocal('51900000996');
  assert.equal(bajas.quitarBaja('51900000996'), true);
  assert.equal(bajas.esBaja('51900000996'), false);
});

test('no guarda números vacíos', () => {
  assert.equal(bajas.marcarBajaLocal(''), false);
  assert.equal(bajas.esBaja(''), false);
});

test('persiste en data/bajas.json', () => {
  bajas.marcarBajaLocal('51911112222');
  const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  assert.ok(j.includes('51911112222'));
  bajas.quitarBaja('51911112222');
});
