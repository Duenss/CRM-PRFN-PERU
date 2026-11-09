// Pruebas de las reglas puras de pago (bot/src/politicas.js).
// Ejecutar: node --test bot/test/politicas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  esPagoDigital,
  esEfectivo,
  decidirEstadoPedidoIA,
  debeDerivarPago,
  corregirEstadoPedidoIA,
  textoAvisoPagoDigital,
  normalizarMetodoPago
} from '../src/politicas.js';

test('esPagoDigital reconoce Yape, Plin y transferencia (con variantes)', () => {
  for (const m of ['yape', 'Yape', 'YAPE', 'plin', 'Plin', 'transferencia', 'transferencia BCP', 'transferencia bancaria']) {
    assert.equal(esPagoDigital(m), true, `debería ser digital: ${m}`);
  }
});

test('esPagoDigital NO considera efectivo ni métodos vacíos/desconocidos', () => {
  for (const m of ['efectivo', 'Efectivo', 'contra entrega', 'pago al entregar', '', 'otro', null, undefined]) {
    assert.equal(esPagoDigital(m), false, `no debería ser digital: ${m}`);
  }
});

test('esEfectivo solo acepta efectivo y sus sinónimos', () => {
  assert.equal(esEfectivo('efectivo'), true);
  assert.equal(esEfectivo('CONTRA ENTREGA'), true);
  assert.equal(esEfectivo('al entregar'), true);
  assert.equal(esEfectivo('yape'), false);
  assert.equal(esEfectivo(''), false);
});

test('normalizarMetodoPago canoniza las variantes que devuelve la IA', () => {
  assert.equal(normalizarMetodoPago('Yape '), 'yape');
  assert.equal(normalizarMetodoPago('PLIN'), 'plin');
  assert.equal(normalizarMetodoPago('transferencia Banco BCP'), 'transferencia');
  assert.equal(normalizarMetodoPago('pago contra entrega'), 'efectivo');
  assert.equal(normalizarMetodoPago('cripto'), '');
});

test('decidirEstadoPedidoIA: solo efectivo cierra la venta (por_entregar)', () => {
  assert.equal(decidirEstadoPedidoIA({ metodo: 'efectivo' }), 'por_entregar');
  assert.equal(decidirEstadoPedidoIA({ metodo: 'contra entrega' }), 'por_entregar');
});

test('decidirEstadoPedidoIA: Yape/Plin/transferencia quedan esperando_pago', () => {
  for (const metodo of ['yape', 'plin', 'transferencia']) {
    assert.equal(decidirEstadoPedidoIA({ metodo }), 'esperando_pago');
    assert.equal(decidirEstadoPedidoIA({ metodo, tieneComprobante: true }), 'comprobante_recibido');
  }
});

test('decidirEstadoPedidoIA nunca devuelve entregado', () => {
  for (const metodo of ['yape', 'plin', 'transferencia', 'efectivo', '']) {
    for (const tieneComprobante of [false, true]) {
      const estado = decidirEstadoPedidoIA({ metodo, tieneComprobante });
      assert.notEqual(estado, 'entregado');
      assert.ok(['borrador', 'esperando_pago', 'comprobante_recibido', 'por_entregar'].includes(estado));
    }
  }
});

test('decidirEstadoPedidoIA sin método deja borrador (y comprobante si ya llegó)', () => {
  assert.equal(decidirEstadoPedidoIA({ metodo: '' }), 'borrador');
  assert.equal(decidirEstadoPedidoIA({ metodo: '', tieneComprobante: true }), 'comprobante_recibido');
});

test('debeDerivarPago solo para pagos digitales', () => {
  assert.equal(debeDerivarPago('yape'), true);
  assert.equal(debeDerivarPago('transferencia'), true);
  assert.equal(debeDerivarPago('efectivo'), false);
  assert.equal(debeDerivarPago(''), false);
});

test('corregirEstadoPedidoIA corrige "por_entregar" con método digital', () => {
  const r = corregirEstadoPedidoIA({ metodo: 'yape', estadoSugerido: 'por_entregar' });
  assert.equal(r.corregido, true);
  assert.equal(r.estado, 'esperando_pago');
  assert.match(r.motivo, /pago digital/i);
});

test('corregirEstadoPedidoIA corrige "entregado" con cualquier método', () => {
  for (const metodo of ['yape', 'efectivo', '']) {
    const r = corregirEstadoPedidoIA({ metodo, estadoSugerido: 'entregado' });
    assert.equal(r.corregido, true, `método ${metodo}`);
    assert.notEqual(r.estado, 'entregado');
  }
});

test('corregirEstadoPedidoIA deja pasar lo que sí puede hacer el bot', () => {
  const efectivo = corregirEstadoPedidoIA({ metodo: 'efectivo', estadoSugerido: 'por_entregar' });
  assert.equal(efectivo.corregido, false);
  assert.equal(efectivo.estado, 'por_entregar');
  const digital = corregirEstadoPedidoIA({ metodo: 'plin', estadoSugerido: 'esperando_pago' });
  assert.equal(digital.corregido, false);
  assert.equal(digital.estado, 'esperando_pago');
});

test('textoAvisoPagoDigital avisa que el bot NO confirma el pago', () => {
  const texto = textoAvisoPagoDigital({
    nombre: 'Ana',
    pedido: { id: 'P-0007', metodo: 'yape', total: 56 }
  });
  assert.match(texto, /Ana/);
  assert.match(texto, /P-0007/);
  assert.match(texto, /yape/);
  assert.match(texto, /S\/ 56/);
  assert.match(texto, /NO confirma el pago/i);
  assert.match(texto, /esperando_pago/);
});

test('textoAvisoPagoDigital también acepta el id como texto', () => {
  const texto = textoAvisoPagoDigital({ nombre: 'Luis', pedido: 'P-0010' });
  assert.match(texto, /Luis/);
  assert.match(texto, /P-0010/);
});
