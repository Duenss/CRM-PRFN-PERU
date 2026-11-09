// Pruebas del bus de eventos y del formato SSE (bot/src/eventos.js).
// Ejecutar: node --test bot/test/eventos.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { emitir, suscribir, suscriptores, desde, ultimoId, lineaSSE } from '../src/eventos.js';

test('suscribir recibe cada evento y deja de recibirlos al desuscribirse', () => {
  const recibidos = [];
  const quitar = suscribir(ev => recibidos.push(ev));
  assert.equal(suscriptores(), 1);

  const ev = emitir('mensaje', {
    telefono: '51999888777',
    mensaje: { texto: 'hola', direccion: 'entrante' },
    noLeidos: 1,
    ultimoTexto: 'hola',
    ultimoEn: '2026-11-08T18:00:00.000Z'
  });

  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].tipo, 'mensaje');
  assert.equal(recibidos[0].telefono, '51999888777');
  assert.equal(recibidos[0].noLeidos, 1);
  assert.equal(recibidos[0].id, ev.id);
  assert.ok(recibidos[0].en, 'todo evento lleva timestamp en ISO');

  quitar();
  assert.equal(suscriptores(), 0);
  emitir('ack', { telefono: '51999888777' });
  assert.equal(recibidos.length, 1, 'tras desuscribirse no debe recibir más');
});

test('un suscriptor roto no rompe a emitir() ni a los demás suscriptores', () => {
  const recibidos = [];
  const quitarMalo = suscribir(() => { throw new Error('SSE roto'); });
  const quitarBueno = suscribir(ev => recibidos.push(ev));
  const ev = emitir('pedido', { pedidoId: 'P-0001' });
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].id, ev.id);
  quitarMalo();
  quitarBueno();
});

test('lineaSSE usa el formato id/data con doble salto de línea', () => {
  const ev = { id: 42, tipo: 'mensaje', telefono: '51999888777', en: '2026-11-08T18:00:00.000Z' };
  const linea = lineaSSE(ev);
  assert.ok(linea.startsWith('id: 42\ndata: '), 'debe empezar con id: y data:');
  assert.ok(linea.endsWith('\n\n'), 'debe terminar con doble salto de línea');
  const data = linea.split('\n')[1].replace(/^data: /, '');
  const parseado = JSON.parse(data);
  assert.deepEqual(parseado, ev);
});

test('desde() filtra por id y ultimoId() avanza con cada evento', () => {
  const a = emitir('ia', { accion: 'config' });
  const b = emitir('ia', { accion: 'pausar' });
  assert.ok(b.id > a.id);
  assert.equal(ultimoId(), b.id);
  const posteriores = desde(a.id);
  assert.ok(posteriores.some(e => e.id === b.id));
  assert.ok(posteriores.every(e => e.id > a.id));
});
