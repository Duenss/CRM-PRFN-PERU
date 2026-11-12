// Pruebas de la cola con prioridades (bot/src/queue.js):
// atender a un cliente que acaba de escribir (ALTA) va antes que cualquier
// validación o sincronización (BAJA), con pausa mientras haya actividad.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cola, PRIORIDAD, MS_WATCHDOG } from '../src/queue.js';

const dormir = ms => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, ms = 3000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (fn()) return true;
    await dormir(5);
  }
  return fn();
}

test('PRIORIDAD: ALTA < NORMAL < BAJA (menor = más urgente)', () => {
  assert.ok(PRIORIDAD.ALTA < PRIORIDAD.NORMAL);
  assert.ok(PRIORIDAD.NORMAL < PRIORIDAD.BAJA);
});

test('prioridad: ALTA antes que NORMAL antes que BAJA, sin importar el orden de llegada', async () => {
  const orden = [];
  let liberar;
  const cola = new Cola(() => {});
  // Mantén el worker ocupado con un trabajo ya en curso (un trabajo corriendo
  // no se interrumpe: la prioridad ordena los que están EN COLA).
  cola.add('bloqueo', async () => {
    await new Promise(r => { liberar = r; });
    orden.push('bloqueo');
  });
  assert.ok(await esperarHasta(() => typeof liberar === 'function'), 'el worker quedó ocupado');
  cola.add('baja', async () => { orden.push('baja'); }, { prioridad: 'baja' });
  cola.add('normal', async () => { orden.push('normal'); }, { prioridad: 'normal' });
  cola.add('alta', async () => { orden.push('alta'); }, { prioridad: 'alta' });
  liberar();
  assert.ok(await esperarHasta(() => orden.length === 4), 'los 4 trabajos debieron ejecutarse');
  assert.deepEqual(orden, ['bloqueo', 'alta', 'normal', 'baja']);
});

test('FIFO estable dentro de la misma prioridad', async () => {
  const orden = [];
  const cola = new Cola(() => {});
  cola.add('x', async () => { orden.push('x'); });
  cola.add('y', async () => { orden.push('y'); });
  cola.add('z', async () => { orden.push('z'); });
  assert.ok(await esperarHasta(() => orden.length === 3));
  assert.deepEqual(orden, ['x', 'y', 'z']);
});

test('un BAJA espera mientras pausaBaja() sea verdadero y un ALTA entrante pasa primero', async () => {
  const orden = [];
  let pausa = true;
  const cola = new Cola(() => {}, { pausaBaja: () => pausa, esperaPausaMs: 10 });
  cola.add('baja-1', async () => { orden.push('baja-1'); }, { prioridad: 'baja' });
  await dormir(40); // el worker queda esperando por la pausa
  assert.deepEqual(orden, [], 'el trabajo baja no arranca mientras haya actividad');
  cola.add('alta-1', async () => { orden.push('alta-1'); }, { prioridad: 'alta' });
  assert.ok(await esperarHasta(() => orden.length === 1), 'el ALTA debió ejecutarse primero');
  assert.deepEqual(orden, ['alta-1'], 'atender al cliente va antes que la validación pausada');
  pausa = false;
  assert.ok(await esperarHasta(() => orden.length === 2), 'el BAJA debió reanudarse al terminar la actividad');
  assert.deepEqual(orden, ['alta-1', 'baja-1']);
});

test('add() sin opciones mantiene prioridad normal (retrocompatible)', async () => {
  const orden = [];
  const cola = new Cola(() => {});
  cola.add('a', async () => { orden.push('a'); });
  assert.ok(await esperarHasta(() => orden.length === 1));
  assert.deepEqual(orden, ['a']);
});

test('add() rechaza ids duplicados (en cola o en curso)', () => {
  const cola = new Cola(() => {});
  assert.equal(cola.add('dup', async () => {}), true);
  assert.equal(cola.add('dup', async () => {}), false);
});

test('el watchdog usa el tiempo propio del trabajo (tiempoMaxMs)', async () => {
  const log = [];
  const cola = new Cola(m => log.push(m));
  let liberada = false;
  cola.add('largo', () => new Promise(r => { setTimeout(() => { liberada = true; r(); }, 120); }), { tiempoMaxMs: 30 });
  assert.ok(await esperarHasta(() => liberada && log.length === 1), 'el job terminó en segundo plano y quedó el aviso del watchdog');
  assert.match(log[0], /Timeout trabajo largo/);
});

test('MS_WATCHDOG sigue siendo el límite por defecto (120 s)', () => {
  assert.equal(MS_WATCHDOG, 120000);
});
