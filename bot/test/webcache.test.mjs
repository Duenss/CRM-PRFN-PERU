// Pruebas del caché local de la versión de WhatsApp Web.
//
// Regresión importante: whatsapp-web.js (LocalWebCache) trata `path` como
// DIRECTORIO y escribe `<path>/<version>.html`. Antes se le pasaba un ARCHIVO,
// lo que producía "EEXIST: mkdir ... web-version-cache.html" en bucle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  resolverWebVersionCache,
  migrarCacheWebAntiguo,
  WEB_VERSION_PIN,
  WEB_VERSION_FILE,
  WEB_VERSION_CACHE_DIR,
  WEB_VERSION_URL,
  WEB_VERSION_TTL_MS
} from '../src/whatsapp.js';

const RAIZ = path.join(import.meta.dirname, '..');
const requiere = createRequire(import.meta.url);
// Clase REAL de la librería (no un mock): valida el contrato path/version.
const LocalWebCache = requiere(path.join(RAIZ, 'node_modules', 'whatsapp-web.js', 'src', 'webCache', 'LocalWebCache.js'));

const HTML = '<!doctype html><html><head><title>WhatsApp</title></head><body>ok</body></html>';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webcache-'));
}

test('el nombre esperado es <pin>.html dentro de un DIRECTORIO', () => {
  assert.equal(path.basename(WEB_VERSION_FILE), `${WEB_VERSION_PIN}.html`);
  assert.equal(path.dirname(WEB_VERSION_FILE), WEB_VERSION_CACHE_DIR);
});

test('resolver devuelve un DIRECTORIO y LocalWebCache persist/resolve funcionan con él', async () => {
  const dir = tempDir();
  try {
    const r = await resolverWebVersionCache(Date.now(), { dir, descargar: async () => HTML, log: () => {} });
    assert.equal(r.type, 'local');
    assert.equal(r.path, dir);
    assert.equal(fs.statSync(dir).isDirectory(), true, 'el path debe ser un directorio, no un archivo');
    assert.equal(fs.existsSync(path.join(dir, `${WEB_VERSION_PIN}.html`)), true, 'el HTML debe estar dentro con el nombre de la versión');

    // La clase real de la librería: persist() no lanza (antes hacía mkdirSync
    // sobre un archivo y lanzaba EEXIST) y resolve() devuelve el HTML.
    const cache = new LocalWebCache({ path: r.path });
    await cache.persist(HTML, WEB_VERSION_PIN);
    assert.equal(await cache.resolve(WEB_VERSION_PIN), HTML);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('con caché fresco no se vuelve a descargar', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, `${WEB_VERSION_PIN}.html`), HTML);
    let descargas = 0;
    const r = await resolverWebVersionCache(Date.now(), {
      dir,
      descargar: async () => { descargas++; return '<html>nuevo</html>'; },
      log: () => {}
    });
    assert.equal(r.type, 'local');
    assert.equal(descargas, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('caché de más de 7 días: se intenta refrescar; si falla la red se usa la copia local', async () => {
  const dir = tempDir();
  try {
    const archivo = path.join(dir, `${WEB_VERSION_PIN}.html`);
    fs.writeFileSync(archivo, HTML);
    const viejo = (Date.now() - WEB_VERSION_TTL_MS - 3600000) / 1000;
    fs.utimesSync(archivo, viejo, viejo);

    const r1 = await resolverWebVersionCache(Date.now(), { dir, descargar: async () => '<html>refrescado</html>', log: () => {} });
    assert.equal(r1.type, 'local');
    assert.match(fs.readFileSync(archivo, 'utf8'), /refrescado/);

    const r2 = await resolverWebVersionCache(Date.now(), { dir, descargar: async () => null, log: () => {} });
    assert.equal(r2.type, 'local', 'sin red, se usa la copia local aunque sea vieja');
    assert.equal(r2.path, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sin caché y sin red: fallback remoto', async () => {
  const dir = tempDir();
  try {
    const r = await resolverWebVersionCache(Date.now(), { dir, descargar: async () => null, log: () => {} });
    assert.deepEqual(r, { type: 'remote', remotePath: WEB_VERSION_URL });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('si no se puede guardar el caché, NO lanza y cae al remoto', async () => {
  const dir = tempDir();
  try {
    // El "directorio" es en realidad un archivo: mkdirSync fallará.
    const ocupado = path.join(dir, 'ocupado');
    fs.writeFileSync(ocupado, 'x');
    const r = await resolverWebVersionCache(Date.now(), { dir: ocupado, descargar: async () => HTML, log: () => {} });
    assert.deepEqual(r, { type: 'remote', remotePath: WEB_VERSION_URL });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migración: borra el archivo viejo web-version-cache.html sin lanzar', () => {
  const dir = tempDir();
  try {
    const viejo = path.join(dir, 'web-version-cache.html');
    fs.writeFileSync(viejo, 'html antiguo');
    const logs = [];
    assert.equal(migrarCacheWebAntiguo({ archivoViejo: viejo, log: m => logs.push(m) }), true);
    assert.equal(fs.existsSync(viejo), false);
    assert.ok(logs.some(l => /archivo antiguo/.test(l)));
    // Segunda llamada: no existe → no lanza y devuelve false.
    assert.equal(migrarCacheWebAntiguo({ archivoViejo: viejo, log: () => {} }), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
