// Pruebas de la lógica anti-bloqueo de validación (bot/src/validacion.js):
// un timeout/error de sesión NUNCA marca el número; dos fallos limpios en
// momentos distintos sí confirman "sin WhatsApp"; cuota diaria, pausa
// automática y ritmo 4-10 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESTADOS_WA,
  configValidacion,
  esperaValidacionMs,
  clasificarFallo,
  decidirEstado,
  aplicarResultado,
  planificarLote,
  pausaTrasErrores,
  etiquetasLista,
  sinEtiqueta,
  conEtiqueta
} from '../src/validacion.js';

const T0 = Date.parse('2026-11-12T12:00:00Z');

/* ---------------- timeouts y errores de sesión: nunca cuentan ---------------- */

test('un timeout NO registra fallo ni cambia el estado', () => {
  const prev = { estado: ESTADOS_WA.SIN_VERIFICAR, fallos: 0, primerFalloEn: null };
  const r = aplicarResultado(prev, { error: new Error('Timeout consultarNumeroWa (15000 ms)') });
  assert.equal(r.infra, true);
  assert.equal(r.estado, ESTADOS_WA.SIN_VERIFICAR);
  assert.equal(r.fallos, 0);
  assert.equal(r.primerFalloEn, null);
  assert.equal(r.confirmado, false);
});

test('error de sesión ("ningún WhatsApp conectado", página cerrada, protocolo) tampoco cuenta', () => {
  assert.equal(clasificarFallo(new Error('Ningún WhatsApp está conectado')), 'infra');
  assert.equal(clasificarFallo(new Error('página de WhatsApp cerrada')), 'infra');
  assert.equal(clasificarFallo(new Error('Protocol error')), 'infra');
  const prev = { estado: ESTADOS_WA.SIN_VERIFICAR, fallos: 1, primerFalloEn: T0 };
  const r = aplicarResultado(prev, { error: new Error('Ningún WhatsApp está conectado') });
  assert.equal(r.fallos, 1, 'el fallo previo se conserva pero no crece');
  assert.equal(r.confirmado, false);
  assert.equal(r.estado, ESTADOS_WA.SIN_VERIFICAR);
});

test('resultado no booleano se trata como infra (fail-safe, nunca confirma)', () => {
  const r = aplicarResultado({ estado: ESTADOS_WA.SIN_VERIFICAR, fallos: 0, primerFalloEn: null }, { existe: undefined });
  assert.equal(r.infra, true);
  assert.equal(r.estado, ESTADOS_WA.SIN_VERIFICAR);
  assert.equal(r.fallos, 0);
  assert.equal(r.confirmado, false);
});

/* ---------------- regla de los 2 fallos en momentos distintos ---------------- */

test('dos fallos limpios en momentos distintos confirman "sin WhatsApp"', () => {
  const umbral = 10 * 60 * 1000;
  const r1 = decidirEstado({ estado: ESTADOS_WA.SIN_VERIFICAR, fallos: 0, primerFalloEn: null, existe: false, ahoraMs: T0, umbralEntreFallosMs: umbral });
  assert.equal(r1.estado, ESTADOS_WA.SIN_VERIFICAR, 'el primer fallo solo deja pendiente');
  assert.equal(r1.fallos, 1);
  assert.equal(r1.confirmado, false);
  const r2 = decidirEstado({ estado: r1.estado, fallos: r1.fallos, primerFalloEn: r1.primerFalloEn, existe: false, ahoraMs: T0 + umbral, umbralEntreFallosMs: umbral });
  assert.equal(r2.estado, ESTADOS_WA.SIN_WHATSAPP, 'segundo fallo en otro momento confirma');
  assert.equal(r2.confirmado, true);
  assert.equal(r2.fallos, 2);
});

test('dos fallos seguidos (sin distancia de tiempo) NO confirman', () => {
  const umbral = 10 * 60 * 1000;
  const r1 = decidirEstado({ estado: ESTADOS_WA.SIN_VERIFICAR, fallos: 0, primerFalloEn: null, existe: false, ahoraMs: T0, umbralEntreFallosMs: umbral });
  const r2 = decidirEstado({ estado: r1.estado, fallos: r1.fallos, primerFalloEn: r1.primerFalloEn, existe: false, ahoraMs: T0 + 30000, umbralEntreFallosMs: umbral });
  assert.equal(r2.estado, ESTADOS_WA.SIN_VERIFICAR, 'dos fallos en el mismo momento no confirman');
  assert.equal(r2.fallos, 2);
  assert.equal(r2.confirmado, false);
  // El tercer fallo, ya fuera del umbral desde el primero, sí confirma.
  const r3 = decidirEstado({ estado: r2.estado, fallos: r2.fallos, primerFalloEn: r2.primerFalloEn, existe: false, ahoraMs: T0 + umbral + 1, umbralEntreFallosMs: umbral });
  assert.equal(r3.estado, ESTADOS_WA.SIN_WHATSAPP);
  assert.equal(r3.confirmado, true);
});

test('un éxito limpio verifica y resetea los fallos acumulados', () => {
  const r = decidirEstado({ estado: ESTADOS_WA.SIN_VERIFICAR, fallos: 2, primerFalloEn: T0, existe: true, ahoraMs: T0 + 999999, umbralEntreFallosMs: 10 * 60 * 1000 });
  assert.equal(r.estado, ESTADOS_WA.VERIFICADO);
  assert.equal(r.fallos, 0);
  assert.equal(r.primerFalloEn, null);
  assert.equal(r.verificado, true);
});

/* ---------------- cuota diaria, pausa y ritmo ---------------- */

test('la cuota diaria recorta el lote (lotes pequeños por día)', () => {
  const lista = Array.from({ length: 3500 }, (_, i) => ({ id: i }));
  assert.equal(planificarLote(lista, { hechosHoy: 0, porDia: 300 }).length, 300);
  assert.equal(planificarLote(lista, { hechosHoy: 280, porDia: 300 }).length, 20);
  assert.equal(planificarLote(lista, { hechosHoy: 300, porDia: 300 }).length, 0);
});

test('pausa automática tras N errores de infraestructura seguidos', () => {
  assert.equal(pausaTrasErrores(2, 3), false);
  assert.equal(pausaTrasErrores(3, 3), true);
  assert.equal(pausaTrasErrores(5, 3), true);
});

test('ritmo aleatorio entre 4 y 10 s por número', () => {
  const cfg = { minMs: 4000, maxMs: 10000 };
  assert.equal(esperaValidacionMs(cfg, () => 0), 4000);
  assert.equal(esperaValidacionMs(cfg, () => 0.5), 7000);
  assert.equal(esperaValidacionMs(cfg, () => 1), 10000);
});

test('configValidacion usa los defaults anti-bloqueo (4-10 s, 300/día, umbral 10 min)', () => {
  const cfg = configValidacion({});
  assert.ok(cfg.minMs >= 4000 && cfg.minMs <= 10000);
  assert.ok(cfg.maxMs >= cfg.minMs && cfg.maxMs <= 10000);
  assert.equal(cfg.porDia, 300);
  assert.equal(cfg.erroresPausa, 3);
  assert.ok(cfg.umbralEntreFallosMs >= 10 * 60 * 1000);
  assert.ok(cfg.pausaMs >= 60000);
});

/* ---------------- etiquetas ---------------- */

test('sinEtiqueta/conEtiqueta funcionan con array y con csv', () => {
  assert.deepEqual(sinEtiqueta(['vip', 'sin-wsp']), ['vip']);
  assert.deepEqual(sinEtiqueta('vip,sin-wsp'), ['vip']);
  assert.deepEqual(sinEtiqueta(null), []);
  assert.deepEqual(conEtiqueta(['vip']), ['vip', 'sin-wsp']);
  assert.deepEqual(conEtiqueta(['vip', 'sin-wsp']), ['vip', 'sin-wsp']);
  assert.deepEqual(etiquetasLista(' a , b '), ['a', 'b']);
  assert.deepEqual(etiquetasLista(null), []);
});
