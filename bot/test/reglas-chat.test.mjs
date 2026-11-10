// Reglas determinísticas del chat (no dependen de la IA para responder).
import test from 'node:test';
import assert from 'node:assert/strict';

const { redactarRespuesta } = await import('../src/ai.js');

test('consulta mayorista/revendedor: deriva con aviso educado', async () => {
  for (const mensaje of ['venden por mayor?', 'tienen kit emprendedor', 'precio de envases y esencias']) {
    const r = await redactarRespuesta({ mensaje, historial: [] });
    assert.equal(r.derivar, true, mensaje);
    assert.match(String(r.motivo), /mayorista|revendedor/i, mensaje);
    assert.match(String(r.aviso), /administrador/i, mensaje);
  }
});

test('promo de 3 perfumes: explica S/ 90 y deriva', async () => {
  const r = await redactarRespuesta({ mensaje: 'hay promo de 3 perfumes de 30 ml por 90?', historial: [] });
  assert.equal(r.derivar, true);
  assert.match(String(r.aviso), /S\/ 90/);
  assert.match(String(r.aviso), /administrador/i);
});

test('recomendación sin contexto: pregunta dama/caballero y notas', async () => {
  const r = await redactarRespuesta({ mensaje: 'me recomiendas algo?', historial: [] });
  assert.equal(r.responder, true);
  assert.match(String(r.texto), /dama/i);
  assert.match(String(r.texto), /caballero/i);
});

test('ocasión sin sexo: pregunta antes de recomendar', async () => {
  const r = await redactarRespuesta({ mensaje: 'un perfume para boda', historial: [] });
  assert.equal(r.responder, true);
  assert.match(String(r.texto), /dama/i);
});

test('ocasión + sexo + notas: sí recomienda', async () => {
  const r = await redactarRespuesta({ mensaje: 'un perfume para boda para caballero amaderado', historial: [] });
  assert.equal(r.responder, true);
  assert.ok(String(r.texto || '').length > 20);
});

test('medios de pago: lista las formas de pago, no perfumes', async () => {
  const r = await redactarRespuesta({ mensaje: 'cuáles son tus medios de pago?', historial: [] });
  assert.equal(r.responder, true);
  assert.match(String(r.texto), /Yape/);
  assert.match(String(r.texto), /Efectivo/);
});
