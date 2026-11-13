// Pruebas de los adjuntos de anuncios: legado + archivos propios saneados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarAdjuntos } from '../src/anuncios.js';

test('normalizarAdjuntos: conserva catálogo/video y acepta archivos propios', () => {
  const lista = normalizarAdjuntos([
    'catalogo',
    { archivo: 'abc123.png', nombre: 'foto.png', mimetype: 'image/png', tipo: 'imagen' },
    { archivo: 'def456.pdf', nombre: 'dama.pdf', mimetype: 'application/pdf' },
    'video'
  ]);
  assert.equal(lista.length, 4);
  assert.equal(lista[0], 'catalogo');
  assert.equal(lista[1].archivo, 'abc123.png');
  assert.equal(lista[1].tipo, 'imagen');
  assert.equal(lista[2].tipo, 'pdf');
  assert.equal(lista[3], 'video');
});

test('normalizarAdjuntos: rechaza rutas, tipos desconocidos y exceso', () => {
  const lista = normalizarAdjuntos([
    { archivo: '../malo.png', mimetype: 'image/png' },
    { archivo: 'ok.png', mimetype: 'text/html' },
    ...Array.from({ length: 10 }, (_, i) => ({ archivo: `a${i}.jpg`, mimetype: 'image/jpeg' }))
  ]);
  assert.equal(lista.length, 6);
  assert.ok(lista.every(x => typeof x === 'object' && /^[A-Za-z0-9._-]+$/.test(x.archivo)));
});
