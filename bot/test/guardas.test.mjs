// Pruebas de las reglas puras de endpoints de campañas/sincronización (F-11/F-17):
//  - 409 cuando ya hay revisión o sincronización en curso,
//  - campaña con emisor no configurado → 'error' visible,
//  - sesión válida pero desconectada → reprogramar (no error).
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardaRevision, guardaSincronizacion, decidirEmisorCampana } from '../src/guardas.js';

/* ---------------- /api/revisar (F-17) ---------------- */

test('guardaRevision: libre → null; en curso → 409 con error', () => {
  assert.equal(guardaRevision(false), null);
  const bloqueo = guardaRevision(true);
  assert.equal(bloqueo.status, 409);
  assert.match(bloqueo.cuerpo.error, /revisi[oó]n en curso/i);
});

/* ---------------- /api/sincronizar (F-11) ---------------- */

test('guardaSincronizacion: libre → null; en curso → 409 con el mensaje pedido', () => {
  assert.equal(guardaSincronizacion(false), null);
  const bloqueo = guardaSincronizacion(true);
  assert.equal(bloqueo.status, 409);
  assert.deepEqual(bloqueo.cuerpo, { error: 'sincronización en curso' });
});

/* ---------------- emisor de campaña (F-17) ---------------- */

test('emisor que no está en SESIONES → estado error visible', () => {
  const r = decidirEmisorCampana({ emisor: '2', sesionesConfiguradas: ['1'], conectada: false });
  assert.equal(r.accion, 'error');
  assert.match(r.motivo, /"2"/);
  assert.match(r.motivo, /no está configurada/);
  assert.match(r.motivo, /SESIONES=1/);
});

test('emisor no configurado se marca error aunque haya otra sesión conectada', () => {
  const r = decidirEmisorCampana({ emisor: '3', sesionesConfiguradas: ['1', '2'], conectada: true });
  assert.equal(r.accion, 'error');
});

test('emisor configurado y conectado → enviar', () => {
  const r = decidirEmisorCampana({ emisor: '2', sesionesConfiguradas: ['1', '2'], conectada: true });
  assert.equal(r.accion, 'enviar');
  assert.equal(r.motivo, '');
});

test('emisor configurado pero desconectado → reprogramar (fallo temporal, no error)', () => {
  const r = decidirEmisorCampana({ emisor: '1', sesionesConfiguradas: ['1', '2'], conectada: false });
  assert.equal(r.accion, 'reprogramar');
  assert.match(r.motivo, /no está conectada/);
});

test('campaña sin emisor fijo: decide por la conexión general', () => {
  assert.equal(decidirEmisorCampana({ emisor: null, sesionesConfiguradas: ['1'], conectada: true }).accion, 'enviar');
  assert.equal(decidirEmisorCampana({ emisor: '', sesionesConfiguradas: ['1'], conectada: false }).accion, 'reprogramar');
});

test('SESIONES como texto ("1,2") se entiende igual que el arreglo', () => {
  assert.equal(decidirEmisorCampana({ emisor: '2', sesionesConfiguradas: '1, 2', conectada: true }).accion, 'enviar');
  assert.equal(decidirEmisorCampana({ emisor: '3', sesionesConfiguradas: '1, 2', conectada: true }).accion, 'error');
});

test('sin lista de SESIONES no se puede validar: no se inventa un error', () => {
  const r = decidirEmisorCampana({ emisor: '9', sesionesConfiguradas: [], conectada: false });
  assert.equal(r.accion, 'reprogramar');
});
