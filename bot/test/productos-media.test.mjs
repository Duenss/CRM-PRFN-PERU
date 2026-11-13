// Pruebas de resolución de fotos locales de producto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imagenLocalProducto, PRODUCTOS_MEDIA_DIR } from '../src/productos-media.js';

test('imagenLocalProducto: encuentra jpg y prefiere jpg sobre webp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-media-'));
  try {
    fs.writeFileSync(path.join(dir, 'asad.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'khamrah.webp'), 'x');
    assert.equal(imagenLocalProducto('asad', { dir }), path.join(dir, 'asad.jpg'));
    assert.equal(imagenLocalProducto('khamrah', { dir }), path.join(dir, 'khamrah.webp'));
    assert.equal(imagenLocalProducto('no-existe', { dir }), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('imagenLocalProducto: sanea ids (sin traversal ni mayúsculas)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-media-'));
  try {
    fs.writeFileSync(path.join(dir, 'asad.jpg'), 'x');
    assert.equal(imagenLocalProducto('ASAD', { dir }), path.join(dir, 'asad.jpg'));
    assert.equal(imagenLocalProducto('../asad', { dir }), '');
    assert.equal(imagenLocalProducto('../../etc/passwd', { dir }), '');
    assert.equal(imagenLocalProducto('', { dir }), '');
    assert.equal(imagenLocalProducto(null, { dir }), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('las 202 fotos del catálogo están empaquetadas en bot/media/products', () => {
  const catalogo = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'catalogo', 'productos.json'), 'utf8'));
  const faltan = catalogo.map(p => p.id).filter(id => !imagenLocalProducto(id));
  assert.deepEqual(faltan, [], `faltan fotos locales: ${faltan.slice(0, 10).join(', ')}`);
  assert.equal(catalogo.length, 202);
  assert.ok(fs.existsSync(path.join(PRODUCTOS_MEDIA_DIR, 'manifest.json')), 'falta el manifest de fotos');
});
