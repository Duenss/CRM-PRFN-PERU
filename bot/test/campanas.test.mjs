// Pruebas de F-01: claim atómico, cierre de campaña y barrido de envíos colgados.
// Usan un Supabase FALSO (sin red ni credenciales); el contrato que se prueba es
// exactamente el que usa bot/src/server.js con supabase-js v2.
// Ejecutar: node --test bot/test/campanas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reclamarEnvioCon,
  marcarEnvioCon,
  cerrarCampanaSiCompleta,
  barrerEnviosColgados,
  verificarMigracionEnviosCon,
  esErrorDeMigracion,
  mensajeErrorMigracion,
  MS_ENVIO_COLGADO
} from '../src/campanas.js';

/**
 * Supabase falso: imita el encadenado de supabase-js v2 y registra cada
 * consulta para poder afirmar sobre los filtros que se aplicaron.
 * `manejador(estado)` devuelve { data, count, error }.
 */
function crearSbFalso(manejador) {
  const ops = [];
  function builder(tabla, op, payload = null, selectInicial = null) {
    const estado = { tabla, op, payload, filtros: [], select: selectInicial, limit: null };
    const b = {
      eq(col, val) { estado.filtros.push({ tipo: 'eq', col, val }); return b; },
      lt(col, val) { estado.filtros.push({ tipo: 'lt', col, val }); return b; },
      select(cols, opts) { estado.select = { cols, opts: opts || null }; return b; },
      limit(n) { estado.limit = n; return b; },
      then(onFulfilled, onRejected) {
        ops.push(estado);
        return Promise.resolve()
          .then(() => manejador(estado))
          .then(onFulfilled, onRejected);
      }
    };
    return b;
  }
  return {
    ops,
    from(tabla) {
      return {
        update(payload) { return builder(tabla, 'update', payload); },
        select(cols, opts) { return builder(tabla, 'select', null, { cols, opts: opts || null }); }
      };
    }
  };
}

test('reclamarEnvioCon: update atómico pendiente→enviando con filtros de id y estado', async () => {
  const sb = crearSbFalso(() => ({ data: [{ id: 7 }], error: null }));
  const fecha = new Date('2026-11-08T12:00:00.000Z');
  const ok = await reclamarEnvioCon(sb, 7, { fecha });

  assert.equal(ok, true);
  const op = sb.ops[0];
  assert.equal(op.tabla, 'envios');
  assert.equal(op.op, 'update');
  assert.equal(op.payload.estado, 'enviando');
  assert.equal(op.payload.fecha_envio, fecha.toISOString());
  // Clave del fail-safe: el claim también escribe wa_id/nota (si faltan las
  // columnas de la migración 07, el claim falla ANTES de enviar).
  assert.equal(op.payload.wa_id, null);
  assert.equal(op.payload.nota, null);
  assert.deepEqual(op.filtros, [
    { tipo: 'eq', col: 'id', val: 7 },
    { tipo: 'eq', col: 'estado', val: 'pendiente' }
  ]);
  assert.equal(op.select.cols, 'id', 'usa .select() para saber si reclamó la fila');
});

test('reclamarEnvioCon: false si ya no estaba pendiente (0 filas devueltas)', async () => {
  const sb = crearSbFalso(() => ({ data: [], error: null }));
  assert.equal(await reclamarEnvioCon(sb, 9), false);
});

test('reclamarEnvioCon: lanza si Supabase devuelve { error } (no se envía nada)', async () => {
  const sb = crearSbFalso(() => ({
    data: null,
    error: { code: '23514', message: 'new row violates check constraint "envios_estado_valido"' }
  }));
  await assert.rejects(
    () => reclamarEnvioCon(sb, 9),
    /check constraint/i
  );
});

test('marcarEnvioCon: filtra por id + estado enviando y devuelve el error sin lanzar', async () => {
  const sb = crearSbFalso(() => ({ data: null, error: { message: 'boom' } }));
  const r = await marcarEnvioCon(sb, 3, { estado: 'enviado', wa_id: 'ABC' });
  assert.equal(r.error.message, 'boom');
  const op = sb.ops[0];
  assert.equal(op.op, 'update');
  assert.equal(op.payload.estado, 'enviado');
  assert.equal(op.payload.wa_id, 'ABC');
  assert.deepEqual(op.filtros, [
    { tipo: 'eq', col: 'id', val: 3 },
    { tipo: 'eq', col: 'estado', val: 'enviando' }
  ]);
});

test('cerrarCampanaSiCompleta: con 0 pendientes marca la campaña como enviada', async () => {
  const sb = crearSbFalso(estado => {
    if (estado.tabla === 'envios' && estado.op === 'select') return { count: 0, error: null };
    if (estado.tabla === 'campanas' && estado.op === 'update') return { error: null };
    throw new Error('consulta inesperada: ' + JSON.stringify(estado));
  });
  const r = await cerrarCampanaSiCompleta(sb, 'c-1');
  assert.deepEqual(r, { cerrada: true, pendientes: 0 });

  const countOp = sb.ops[0];
  assert.equal(countOp.op, 'select');
  assert.equal(countOp.select.opts.count, 'exact');
  assert.equal(countOp.select.opts.head, true);
  assert.deepEqual(countOp.filtros, [
    { tipo: 'eq', col: 'campana_id', val: 'c-1' },
    { tipo: 'eq', col: 'estado', val: 'pendiente' }
  ]);
  const updateOp = sb.ops[1];
  assert.equal(updateOp.tabla, 'campanas');
  assert.equal(updateOp.payload.estado, 'enviada');
  assert.deepEqual(updateOp.filtros, [{ tipo: 'eq', col: 'id', val: 'c-1' }]);
});

test('cerrarCampanaSiCompleta: con pendientes NO cierra (queda programada)', async () => {
  const sb = crearSbFalso(() => ({ count: 4, error: null }));
  const r = await cerrarCampanaSiCompleta(sb, 'c-2');
  assert.deepEqual(r, { cerrada: false, pendientes: 4 });
  assert.equal(sb.ops.length, 1, 'no debe actualizar la campaña si quedan pendientes');
});

test('cerrarCampanaSiCompleta: lanza si falla el count (para que el llamador loguee)', async () => {
  const sb = crearSbFalso(() => ({ count: null, error: { message: 'timeout' } }));
  await assert.rejects(() => cerrarCampanaSiCompleta(sb, 'c-3'), /timeout/);
});

test('barrerEnviosColgados: enviando con más de 10 min → error con nota', async () => {
  const ahora = Date.parse('2026-11-08T12:00:00.000Z');
  const sb = crearSbFalso(() => ({ error: null }));
  const r = await barrerEnviosColgados(sb, { ahora });

  const limiteEsperado = new Date(ahora - MS_ENVIO_COLGADO).toISOString();
  assert.equal(r.limite, limiteEsperado);
  const op = sb.ops[0];
  assert.equal(op.op, 'update');
  assert.equal(op.payload.estado, 'error');
  assert.equal(op.payload.nota, 'proceso interrumpido');
  assert.deepEqual(op.filtros, [
    { tipo: 'eq', col: 'estado', val: 'enviando' },
    { tipo: 'lt', col: 'fecha_envio', val: limiteEsperado }
  ]);
});

test('verificarMigracionEnviosCon: detecta columnas faltantes de la migración 07', async () => {
  const bueno = crearSbFalso(() => ({ data: null, error: null }));
  assert.deepEqual(await verificarMigracionEnviosCon(bueno), { ok: true, error: null });

  const malo = crearSbFalso(() => ({
    data: null,
    error: { code: 'PGRST204', message: "Could not find the 'wa_id' column of 'envios' in the schema cache" }
  }));
  const r = await verificarMigracionEnviosCon(malo);
  assert.equal(r.ok, false);
  assert.equal(esErrorDeMigracion(r.error), true);
});

test('esErrorDeMigracion distingue errores de migración de fallos normales', () => {
  assert.equal(esErrorDeMigracion({ code: 'PGRST204', message: 'x' }), true);
  assert.equal(esErrorDeMigracion({ code: '42703', message: 'column "wa_id" does not exist' }), true);
  assert.equal(esErrorDeMigracion({ message: 'new row violates check constraint "envios_estado_valido"' }), true);
  assert.equal(esErrorDeMigracion(new Error('fetch failed')), false);
  assert.equal(esErrorDeMigracion({ message: 'Timeout contar campañas (8000 ms)' }), false);
});

test('mensajeErrorMigracion nombra el archivo sql/07 para que el operador sepa qué hacer', () => {
  const texto = mensajeErrorMigracion({ message: 'column "wa_id" does not exist' });
  assert.match(texto, /sql\/07_envios_claim\.sql/);
  assert.match(texto, /No se envía nada/);
  assert.match(texto, /column "wa_id" does not exist/);
});
