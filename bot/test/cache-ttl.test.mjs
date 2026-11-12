// Pruebas de la caché con TTL para `configuracion_tienda` (F-12):
// no vuelve a consultar dentro de los 5 min, reconsulta al vencer, la
// invalidación manual funciona y las consultas concurrentes comparten una sola.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCacheTtl, TTL_CONFIGURACION_MS } from '../src/cache-ttl.js';

/** Entorno con reloj falso y contador de consultas reales. */
function entorno({ ttlMs = TTL_CONFIGURACION_MS, valor = 'config' } = {}) {
  let t = 1_000_000;
  let consultas = 0;
  const cache = crearCacheTtl({ ttlMs, ahora: () => t });
  const cargar = async () => { consultas++; return { tienda: valor, consulta: consultas }; };
  return {
    cache,
    cargar,
    consultas: () => consultas,
    avanzar: ms => { t += ms; },
    t: () => t
  };
}

test('el TTL por defecto de la configuración es de 5 minutos', () => {
  assert.equal(TTL_CONFIGURACION_MS, 5 * 60 * 1000);
});

test('dentro de los 5 min NO vuelve a consultar', async () => {
  const e = entorno();
  const v1 = await e.cache.obtener(e.cargar);
  assert.equal(e.consultas(), 1);

  e.avanzar(TTL_CONFIGURACION_MS - 1); // 4 min 59,999 s
  const v2 = await e.cache.obtener(e.cargar);
  assert.equal(e.consultas(), 1, 'sigue usando la caché');
  assert.equal(v2, v1);
  assert.equal(e.cache.vigente(), true);
});

test('al vencer los 5 min vuelve a consultar', async () => {
  const e = entorno();
  const v1 = await e.cache.obtener(e.cargar);
  e.avanzar(TTL_CONFIGURACION_MS);
  const v2 = await e.cache.obtener(e.cargar);
  assert.equal(e.consultas(), 2, 'consultó de nuevo al vencer');
  assert.notDeepEqual(v2, v1);
});

test('invalidar() obliga a consultar de nuevo al instante', async () => {
  const e = entorno();
  await e.cache.obtener(e.cargar);
  assert.equal(e.consultas(), 1);

  e.cache.invalidar();
  assert.equal(e.cache.vigente(), false);
  await e.cache.obtener(e.cargar);
  assert.equal(e.consultas(), 2, 'la invalidación descartó el valor cacheado');
});

test('dos lecturas simultáneas comparten UNA sola consulta', async () => {
  const e = entorno();
  const [a, b] = await Promise.all([e.cache.obtener(e.cargar), e.cache.obtener(e.cargar)]);
  assert.equal(e.consultas(), 1);
  assert.equal(a, b);
});

test('invalidar durante una consulta en vuelo no cachea el resultado viejo', async () => {
  const e = entorno();
  let resolver;
  const lenta = () => new Promise(r => { resolver = r; });
  const pendiente = e.cache.obtener(lenta);
  e.cache.invalidar();       // el panel cambió la configuración mientras se leía
  resolver('valor-viejo');
  assert.equal(await pendiente, 'valor-viejo', 'la petición en curso recibe su valor');
  assert.equal(e.cache.vigente(), false, 'pero NO queda cacheado');

  const e2 = entorno();
  const valor = await e2.cache.obtener(async () => 'valor-nuevo');
  assert.equal(valor, 'valor-nuevo');
});

test('ultimo() conserva el último valor bueno para degradar sin romper', async () => {
  const e = entorno();
  await e.cache.obtener(e.cargar);          // primer valor: consulta 1
  e.avanzar(TTL_CONFIGURACION_MS + 1);      // vence
  assert.equal(e.cache.vigente(), false);
  assert.deepEqual(e.cache.ultimo(), { tienda: 'config', consulta: 1 });
  e.cache.invalidar();
  assert.equal(e.cache.ultimo(), undefined, 'invalidar sí borra el valor');
});

/* ---------------- cableado en supabase.js ---------------- */

const supabase = await import('../src/supabase.js');

test('supabase expone invalidarConfiguracion()', () => {
  assert.equal(typeof supabase.invalidarConfiguracion, 'function');
});

test('getConfiguracion() usa la caché y se invalida con invalidarConfiguracion()', async t => {
  const sb = supabase.sb;
  if (!sb) return t.skip('Sin SUPABASE_SERVICE_ROLE_KEY en este entorno');
  const originalFrom = sb.from;
  let consultas = 0;
  try {
    // Fake del encadenado de supabase-js: from().select().limit()
    sb.from = () => ({
      select: () => ({
        limit: () => {
          consultas++;
          return Promise.resolve({ data: [{ tienda: 'Fina', consulta: consultas }], error: null });
        }
      })
    });
    const v1 = await supabase.getConfiguracion();
    const v2 = await supabase.getConfiguracion();
    assert.deepEqual(v2, v1);
    assert.equal(consultas, 1, 'la segunda lectura no pegó a Supabase');

    supabase.invalidarConfiguracion();
    const v3 = await supabase.getConfiguracion();
    assert.equal(consultas, 2, 'tras invalidar, consultó otra vez');
    assert.equal(v3.consulta, 2);
  } finally {
    sb.from = originalFrom;
    supabase.invalidarConfiguracion();
  }
});
