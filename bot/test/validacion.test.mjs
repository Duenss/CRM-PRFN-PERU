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
  conEtiqueta,
  enVentanaHoraria,
  msHastaApertura,
  proximaPausaLarga,
  esperaPausaLargaMs
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

test('tope 0 = SIN límite diario: no recorta la lista', () => {
  const lista = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
  assert.equal(planificarLote(lista, { hechosHoy: 0, porDia: 0 }).length, 2500);
  assert.equal(planificarLote(lista, { hechosHoy: 9999, porDia: 0 }).length, 2500);
  const cfg = configValidacion({ VALIDACION_POR_DIA: '0' });
  assert.equal(cfg.porDia, 0);
  const porDefecto = configValidacion({});
  assert.equal(porDefecto.porDia, 0, 'validación diaria sin tope por defecto');
});

test('VALIDACION_POR_DIA>0 sí limita; negativos se acotan a 0', () => {
  assert.equal(configValidacion({ VALIDACION_POR_DIA: '150' }).porDia, 150);
  assert.equal(configValidacion({ VALIDACION_POR_DIA: '-20' }).porDia, 0);
  assert.equal(configValidacion({ VALIDACION_POR_DIA: 'no-numero' }).porDia, 0);
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

test('configValidacion usa los defaults anti-bloqueo (4-10 s, sin tope, ventana 9-22, pausa larga 80-120)', () => {
  const cfg = configValidacion({});
  assert.ok(cfg.minMs >= 4000 && cfg.minMs <= 10000);
  assert.ok(cfg.maxMs >= cfg.minMs && cfg.maxMs <= 10000);
  assert.equal(cfg.porDia, 0, '0 = sin tope diario por defecto');
  assert.equal(cfg.erroresPausa, 3);
  assert.ok(cfg.umbralEntreFallosMs >= 10 * 60 * 1000);
  assert.ok(cfg.pausaMs >= 60000);
  assert.equal(cfg.horaInicio, 9);
  assert.equal(cfg.horaFin, 22);
  assert.equal(cfg.loteMin, 80);
  assert.equal(cfg.loteMax, 120);
  assert.equal(cfg.pausaLargaMinMs, 3 * 60 * 1000);
  assert.equal(cfg.pausaLargaMaxMs, 6 * 60 * 1000);
});

test('configValidacion lee la ventana horaria y los lotes de pausa larga del entorno', () => {
  const cfg = configValidacion({
    VALIDACION_HORA_INICIO: '8',
    VALIDACION_HORA_FIN: '20',
    VALIDACION_LOTE_MIN: '50',
    VALIDACION_LOTE_MAX: '60',
    VALIDACION_PAUSA_LARGA_MIN_MS: '120000',
    VALIDACION_PAUSA_LARGA_MAX_MS: '180000'
  });
  assert.equal(cfg.horaInicio, 8);
  assert.equal(cfg.horaFin, 20);
  assert.equal(cfg.loteMin, 50);
  assert.equal(cfg.loteMax, 60);
  assert.equal(cfg.pausaLargaMinMs, 120000);
  assert.equal(cfg.pausaLargaMaxMs, 180000);
});

/* ---------------- ventana horaria de Lima ---------------- */

const partes = (h, min = 0, y = 2026, m = 11, d = 12) => ({ y, m, d, h, min });
const cfgVentana = { horaInicio: 9, horaFin: 22 };

test('ventana horaria: dentro entre 9:00 y 21:59, fuera a las 8:59 y 22:00', () => {
  assert.equal(enVentanaHoraria(cfgVentana, partes(8, 59)), false);
  assert.equal(enVentanaHoraria(cfgVentana, partes(9, 0)), true);
  assert.equal(enVentanaHoraria(cfgVentana, partes(12, 0)), true);
  assert.equal(enVentanaHoraria(cfgVentana, partes(21, 59)), true);
  assert.equal(enVentanaHoraria(cfgVentana, partes(22, 0)), false);
  assert.equal(enVentanaHoraria(cfgVentana, partes(23, 30)), false);
  // Ventana circular (cruza medianoche).
  assert.equal(enVentanaHoraria({ horaInicio: 22, horaFin: 6 }, partes(23, 0)), true);
  assert.equal(enVentanaHoraria({ horaInicio: 22, horaFin: 6 }, partes(5, 0)), true);
  assert.equal(enVentanaHoraria({ horaInicio: 22, horaFin: 6 }, partes(12, 0)), false);
});

test('msHastaApertura: 0 dentro de la ventana; abre a las 9:00 de Lima si está cerrada', () => {
  // 08:00 Lima = 13:00 UTC; la apertura es a las 14:00 UTC (1 h).
  const ahora = Date.parse('2026-11-12T13:00:00Z');
  assert.equal(msHastaApertura(cfgVentana, partes(8, 0), ahora), 60 * 60 * 1000);
  // 10:00 Lima ya está abierta: 0.
  assert.equal(msHastaApertura(cfgVentana, partes(10, 0), Date.parse('2026-11-12T15:00:00Z')), 0);
  // 23:00 Lima (04:00 UTC del día siguiente): abre mañana 9:00 Lima = 14:00 UTC → 10 h.
  const ahoraNoche = Date.parse('2026-11-13T04:00:00Z');
  assert.equal(msHastaApertura(cfgVentana, partes(23, 0), ahoraNoche), 10 * 60 * 60 * 1000);
});

/* ---------------- pausa larga anti-bloqueo ---------------- */

test('pausa larga: se dispara cada 80-120 números consultados', () => {
  const cfg = { loteMin: 80, loteMax: 120 };
  assert.equal(proximaPausaLarga(cfg, () => 0), 80);
  assert.equal(proximaPausaLarga(cfg, () => 0.5), 100);
  assert.equal(proximaPausaLarga(cfg, () => 1), 120);
  const valor = proximaPausaLarga(cfg, () => 0.37);
  assert.ok(valor >= 80 && valor <= 120);
});

test('pausa larga: duración aleatoria de 3 a 6 min', () => {
  const cfg = { pausaLargaMinMs: 180000, pausaLargaMaxMs: 360000 };
  assert.equal(esperaPausaLargaMs(cfg, () => 0), 180000);
  assert.equal(esperaPausaLargaMs(cfg, () => 0.5), 270000);
  assert.equal(esperaPausaLargaMs(cfg, () => 1), 360000);
  const valor = esperaPausaLargaMs(cfg, () => 0.8);
  assert.ok(valor >= 180000 && valor <= 360000);
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
