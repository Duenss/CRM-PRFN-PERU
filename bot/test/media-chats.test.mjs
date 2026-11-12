// Pruebas de la multimedia de chats: metadatos, miniaturas, archivos seguros
// y poda de disco. Sin red ni WhatsApp (solo fs temporal).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  datosMediaEntrante, tipoDeMarcador, esMarcadorMedia, extensionMedia,
  nombreArchivoMedia, archivoMediaSeguro, rutaMediaSegura, guardarMediaChat,
  podarMediaChats
} from '../src/media-chats.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* ---------------- metadatos de una multimedia recibida ---------------- */

test('datosMediaEntrante: null para texto y completo para imagen con miniatura', () => {
  assert.equal(datosMediaEntrante({ type: 'chat', hasMedia: false, _data: {} }), null);
  assert.equal(datosMediaEntrante(null), null);
  const meta = datosMediaEntrante({
    type: 'image', hasMedia: true, mimetype: 'image/jpeg',
    _data: { thumbnail: 'abc123', size: 2048, width: 1080, height: 1350, filename: '' }
  });
  assert.equal(meta.tipo, 'imagen');
  assert.equal(meta.tipoWa, 'image');
  assert.equal(meta.mimetype, 'image/jpeg');
  assert.equal(meta.bytes, 2048);
  assert.equal(meta.ancho, 1080);
  assert.match(meta.thumb, /^data:image\/jpeg;base64,abc123$/);
});

test('datosMediaEntrante: ptt→audio, documento con nombre, gif marcado y miniaturas enormes descartadas', () => {
  const audio = datosMediaEntrante({ type: 'ptt', hasMedia: true, _data: { duration: 7 } });
  assert.equal(audio.tipo, 'audio');
  assert.equal(audio.duracion, 7);
  const doc = datosMediaEntrante({ type: 'document', hasMedia: true, mimetype: 'application/pdf', _data: { filename: 'factura.pdf', size: 9000 } });
  assert.equal(doc.tipo, 'documento');
  assert.equal(doc.nombre, 'factura.pdf');
  const gif = datosMediaEntrante({ type: 'video', hasMedia: true, _data: { isGif: true } });
  assert.equal(gif.gif, true);
  const grande = datosMediaEntrante({ type: 'image', hasMedia: true, _data: { thumbnail: 'x'.repeat(70000) } });
  assert.equal(grande.thumb, '', 'una miniatura gigante no se guarda en el JSON');
});

/* ---------------- marcadores de mensajes antiguos ---------------- */

test('tipoDeMarcador/esMarcadorMedia: reconoce los textos de compatibilidad', () => {
  assert.equal(tipoDeMarcador('[imagen]'), 'imagen');
  assert.equal(tipoDeMarcador('[video]'), 'video');
  assert.equal(tipoDeMarcador('[nota de voz]'), 'audio');
  assert.equal(tipoDeMarcador('[documento factura.pdf]'), 'documento');
  assert.equal(tipoDeMarcador('[sticker]'), 'sticker');
  assert.equal(tipoDeMarcador('hola'), '');
  assert.equal(esMarcadorMedia('[video]'), true);
  assert.equal(esMarcadorMedia('hola'), false);
});

/* ---------------- nombres y rutas seguras ---------------- */

test('extensionMedia/nombreArchivoMedia: extensión correcta y nombre aleatorio seguro', () => {
  assert.equal(extensionMedia('image/jpeg'), 'jpg');
  assert.equal(extensionMedia('video/mp4'), 'mp4');
  assert.equal(extensionMedia('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(extensionMedia('application/pdf'), 'pdf');
  assert.equal(extensionMedia('', 'imagen'), 'jpg');
  const nombre = nombreArchivoMedia('image/png', 'imagen');
  assert.match(nombre, /^[a-f0-9]{32}\.png$/);
  assert.equal(archivoMediaSeguro(nombre), true);
});

test('archivoMediaSeguro/rutaMediaSegura: rechazan traversal y nombres raros', () => {
  assert.equal(archivoMediaSeguro('../../etc/passwd'), false);
  assert.equal(archivoMediaSeguro('foto.jpg'), false, 'debe ser hash generado por el bot');
  assert.equal(rutaMediaSegura('/tmp/chats', '../../etc/passwd'), '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-chats-'));
  try {
    assert.equal(rutaMediaSegura(dir, 'a'.repeat(32) + '.jpg'), path.join(dir, 'a'.repeat(32) + '.jpg'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- guardado y poda ---------------- */

test('guardarMediaChat: escribe el archivo con nombre aleatorio y bytes correctos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-chats-'));
  try {
    const r = guardarMediaChat(dir, { base64: PNG_1PX, mimetype: 'image/png', tipo: 'imagen' });
    assert.match(r.archivo, /^[a-f0-9]{32}\.png$/);
    assert.equal(r.bytes > 0, true);
    assert.equal(fs.existsSync(path.join(dir, r.archivo)), true);
    assert.equal(fs.readdirSync(dir).some(n => n.endsWith('.tmp')), false, 'escritura atómica');
    assert.throws(() => guardarMediaChat(dir, { base64: '', mimetype: 'image/png' }), /vacío/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('podarMediaChats: borra por antigüedad y respeta el tope de bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-poda-'));
  try {
    const ahora = Date.now();
    const crear = (nombre, bytes, edadDias) => {
      const p = path.join(dir, nombre);
      fs.writeFileSync(p, Buffer.alloc(bytes, 1));
      const t = (ahora - edadDias * 24 * 3600 * 1000) / 1000;
      fs.utimesSync(p, t, t);
    };
    crear('a'.repeat(32) + '.jpg', 100, 100); // viejo
    crear('b'.repeat(32) + '.jpg', 100, 10);  // reciente
    crear('c'.repeat(32) + '.jpg', 100, 5);   // reciente
    let r = podarMediaChats({ dir, maxBytes: 1024 * 1024, maxDias: 90, ahoraMs: ahora });
    assert.equal(r.borrados, 1, 'borra el de 100 días');
    assert.equal(fs.existsSync(path.join(dir, 'b'.repeat(32) + '.jpg')), true);
    // Tope de bytes pequeño: borra los más antiguos que queden.
    r = podarMediaChats({ dir, maxBytes: 150, maxDias: 90, ahoraMs: ahora });
    assert.equal(r.borrados, 1);
    assert.equal(fs.readdirSync(dir).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
