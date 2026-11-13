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

test('promo: tabla oficial y promoción 2 x 50 ml por S/ 99 (sin derivar)', async () => {
  const r = await redactarRespuesta({ mensaje: 'hay promo de 3 perfumes de 30 ml por 90?', historial: [] });
  assert.equal(r.responder, true);
  assert.equal(r.promo, true);
  assert.match(String(r.texto), /S\/ 90/);
  assert.match(String(r.texto), /2 × 50 ml por S\/ 99/i);
});

test('envíos: responde ubicación, Olva/Shalom y Tarapoto sin inventar', async () => {
  const r = await redactarRespuesta({ mensaje: 'haces envíos a Tarapoto?', historial: [] });
  assert.equal(r.responder, true);
  assert.match(String(r.texto), /Villa María del Triunfo/i);
  assert.match(String(r.texto), /Olva/i);
  assert.match(String(r.texto), /Shalom/i);
  assert.match(String(r.texto), /Tarapoto/i);
});

test('dos preguntas (promo + envío): responde en 2 bloques seguidos sin esperar', async () => {
  const r = await redactarRespuesta({ mensaje: 'En promoción, haces envíos a Tarapoto', historial: [] });
  assert.equal(r.responder, true);
  assert.equal(Array.isArray(r.bloques), true);
  assert.equal(r.bloques.length, 2);
  assert.equal(r.bloques[0].imagenPromo, true, 'el primer bloque lleva la imagen de promoción');
  assert.match(String(r.bloques[1].texto), /Shalom|Olva/);
});

test('dos recomendaciones (dama + varón): un bloque por género y cierre de promo', async () => {
  const r = await redactarRespuesta({ mensaje: 'recomiéndame de dama y de varón', historial: [] });
  assert.equal(r.responder, true);
  assert.equal(Array.isArray(r.bloques), true);
  assert.ok(r.bloques.length >= 2);
  const todo = r.bloques.map(b => String(b.texto)).join(' ');
  assert.match(todo, /Para él|Para ella/i);
  assert.match(todo, /promo/i);
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
