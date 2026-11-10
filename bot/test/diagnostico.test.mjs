// Pruebas del autodiagnóstico de esquema (detecta el constraint de campañas).
import test from 'node:test';
import assert from 'node:assert/strict';
import { revisarCampanas, revisarEsquema } from '../src/diagnostico.js';

test('detecta el constraint viejo de campañas', async () => {
  const sb = {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({ data: null, error: { code: '23514', message: 'violates check constraint "campanas_estado_check"' } })
        })
      })
    })
  };
  const r = await revisarCampanas(sb);
  assert.equal(r.ok, false);
  assert.equal(r.problema.codigo, 'campanas_estado');
  assert.match(r.problema.solucion, /11_arreglar_estado_campanas/);
});

test('con esquema correcto no reporta nada y limpia la fila de prueba', async () => {
  let borrada = false;
  const sb = {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'x1' }, error: null }) }) }),
      delete: () => ({ eq: async () => { borrada = true; return { error: null }; } })
    })
  };
  assert.deepEqual(await revisarEsquema(sb), []);
  assert.equal(borrada, true);
});

test('otros errores se reportan sin tumbar el bot', async () => {
  const sb = {
    from: () => ({
      insert: () => ({
        select: () => ({ single: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }) })
      })
    })
  };
  const problemas = await revisarEsquema(sb);
  assert.equal(problemas.length, 1);
  assert.equal(problemas[0].codigo, 'campanas_insert');
});

test('sin sb no falla', async () => {
  assert.deepEqual(await revisarEsquema(null), []);
});
