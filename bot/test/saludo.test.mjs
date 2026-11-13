// Pruebas del saludo por hora (madrugada = "Buenos días", mediodía = "Buenas tardes").
import test from 'node:test';
import assert from 'node:assert/strict';
import { saludoPorHora } from '../src/saludo.js';

test('saludoPorHora: 00:00–11:59 siempre es Buenos días', () => {
  for (const h of [0, 1, 3, 4, 5, 6, 9, 11]) assert.equal(saludoPorHora(h), 'Buenos días', `h=${h}`);
});

test('saludoPorHora: 12:00–18:59 es Buenas tardes', () => {
  for (const h of [12, 13, 15, 18]) assert.equal(saludoPorHora(h), 'Buenas tardes', `h=${h}`);
});

test('saludoPorHora: 19:00–23:59 es Buenas noches', () => {
  for (const h of [19, 20, 22, 23]) assert.equal(saludoPorHora(h), 'Buenas noches', `h=${h}`);
});

test('saludoPorHora: hora inválida cae en Buenas noches (nunca rompe)', () => {
  assert.equal(saludoPorHora('x'), 'Buenas noches');
  assert.equal(saludoPorHora(null), 'Buenas noches');
});
