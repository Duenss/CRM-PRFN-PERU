// Pruebas del autodiagnóstico de esquema (detecta el constraint de campañas).
import test from 'node:test';
import assert from 'node:assert/strict';
import { revisarCampanas, revisarFechaCampanas, revisarEsquema } from '../src/diagnostico.js';

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
  assert.ok(problemas.length >= 1);
  assert.ok(problemas.some(p => p.codigo === 'campanas_insert'));
});

test('sin sb no falla', async () => {
  assert.deepEqual(await revisarEsquema(null), []);
});

test('detecta fecha_programada como DATE (pierde la hora)', async () => {
  let borrada = false;
  const sb = {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'c1', fecha_programada: '2026-11-11' }, error: null }) }) }),
      delete: () => ({ eq: async () => { borrada = true; return { error: null }; } })
    })
  };
  const r = await revisarFechaCampanas(sb);
  assert.equal(r.ok, false);
  assert.equal(r.problema.codigo, 'campanas_fecha');
  assert.match(r.problema.solucion, /12_campanas_fecha_hora/);
  assert.equal(borrada, true);
});

test('con timestamptz no reporta problema', async () => {
  const sb = {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'c2', fecha_programada: '2026-11-11T20:00:00+00:00' }, error: null }) }) }),
      delete: () => ({ eq: async () => ({ error: null }) })
    })
  };
  assert.deepEqual(await revisarEsquema(sb).then(l => l.filter(p => p.codigo === 'campanas_fecha')), []);
});
