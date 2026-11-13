// Pruebas de identidad LID y fusión de chats duplicados (sin red ni disco).
import test from 'node:test';
import assert from 'node:assert/strict';
import { telefonoDeDestino, esLidDeDigitos, claveTemporalLid } from '../src/identidad.js';
import {
  fusionarChats, elegirDestino, detectarDuplicados, aplicarFusiones,
  nombrePareceTelefono, claveEsTelefonoPeru
} from '../src/fusion.js';

/* ---------------- identidad: un LID nunca es un teléfono ---------------- */

test('telefonoDeDestino: @c.us / @s.whatsapp.net devuelven el teléfono canónico', () => {
  assert.equal(telefonoDeDestino('51995227235@c.us', { canonico: '51995227235' }), '51995227235');
  assert.equal(telefonoDeDestino('987654321@s.whatsapp.net', { canonico: '51987654321' }), '51987654321');
});

test('telefonoDeDestino: @lid resuelto usa el teléfono real', () => {
  const r = telefonoDeDestino('123456789012345@lid', { canonico: 'lid:123456789012345', resuelto: '51995227235' });
  assert.equal(r, '51995227235');
});

test('telefonoDeDestino: @lid sin resolver NO se convierte en teléfono', () => {
  assert.equal(telefonoDeDestino('123456789012345@lid', { canonico: 'lid:123456789012345' }), '');
  // Si la "resolución" devuelve el propio userid del LID, se rechaza.
  assert.equal(telefonoDeDestino('123456789012345@lid', { canonico: 'lid:123456789012345', resuelto: '123456789012345' }), '');
  assert.equal(esLidDeDigitos('123456789012345@lid', '123456789012345'), true);
  assert.equal(esLidDeDigitos('51995227235@c.us', '51995227235'), false);
});

test('claveTemporalLid: permite atender un LID no resoluble sin guardarlo como teléfono real', () => {
  assert.equal(claveTemporalLid('123456789012345@lid'), '123456789012345');
  assert.equal(claveTemporalLid('1234567890123456@lid'), '1234567890123456');
  assert.equal(claveTemporalLid('51995227235@c.us'), '');
  assert.equal(claveTemporalLid('abc@lid'), '');
});

/* ---------------- fusión de chats (el caso Esther + número) ---------------- */

const msg = (waId, en, texto) => ({ waId, id: waId, direccion: 'saliente', texto, en });

test('fusionarChats: junta mensajes sin duplicar waId y conserva el nombre real', () => {
  const destino = {
    telefono: '51995227235', nombre: 'Esther', nombreWa: 'Esther', noLeidos: 2,
    mensajes: [msg('a1', '2026-11-12T01:00:00Z', 'uno'), msg('a2', '2026-11-12T01:01:00Z', 'dos')]
  };
  const origen = {
    telefono: '123456789012345', nombre: '‪+51 995 227 235‬', noLeidos: 0,
    mensajes: [msg('a2', '2026-11-12T01:01:00Z', 'dos'), msg('a3', '2026-11-12T01:02:00Z', 'tres')]
  };
  const f = fusionarChats(destino, origen);
  assert.equal(f.telefono, '51995227235');
  assert.equal(f.nombre, 'Esther', 'conserva el nombre real, no el número');
  assert.equal(f.mensajes.length, 3, 'deduplica el mensaje a2');
  assert.equal(f.ultimoTexto, 'tres');
  assert.equal(f.noLeidos, 2);
  assert.equal(f._fusion.mensajesAgregados, 1);
});

test('elegirDestino: prefiere teléfono peruano sobre userid LID y, a igualdad, más mensajes', () => {
  const lid = { clave: '123456789012345', chat: { mensajes: [1, 2, 3] } };
  const tel = { clave: '51995227235', chat: { mensajes: [1] } };
  assert.equal(elegirDestino(lid, tel).clave, '51995227235');
  assert.equal(elegirDestino({ clave: '123456789012', chat: { mensajes: [] } }, { clave: '51995227235', chat: { mensajes: [] } }).clave, '51995227235');
  const a = { clave: '12345678901234', chat: { mensajes: [1] } };
  const b = { clave: '1234567890123', chat: { mensajes: [] } };
  assert.equal(elegirDestino(a, b).clave, '1234567890123', 'clave más corta (menos probable LID)');
});

test('detectarDuplicados: mismo chat.waId = confianza alta', () => {
  const chats = {
    51995227235: { waId: 'abc@lid', nombre: 'Esther', mensajes: [] },
    123456789012345: { waId: 'abc@lid', nombre: '‪+51 995 227 235‬', mensajes: [] }
  };
  const pares = detectarDuplicados(chats);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].confianza, 'alta');
  assert.equal(pares[0].motivos[0], 'mismo chat.waId=abc@lid');
});

test('detectarDuplicados: mensajes con el mismo waId (ecos) = alta si son 2+', () => {
  const chats = {
    51995227235: { nombre: 'Esther', mensajes: [msg('w1', '2026-11-12T01:00:00Z', 'hola'), msg('w2', '2026-11-12T01:01:00Z', 'x')] },
    123456789012345: { nombre: '‪+51 995 227 235‬', mensajes: [msg('w1', '2026-11-12T01:00:00Z', 'hola')] }
  };
  const pares = detectarDuplicados(chats);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].confianza, 'media');
  chats[123456789012345].mensajes.push(msg('w2', '2026-11-12T01:01:00Z', 'x'));
  assert.equal(detectarDuplicados(chats)[0].confianza, 'alta');
});

test('detectarDuplicados: chats sin relación o grupos no se proponen', () => {
  const chats = {
    51911111111: { nombre: 'Ana', mensajes: [msg('x1', '2026-11-12T01:00:00Z', 'a')] },
    51922222222: { nombre: 'Luis', mensajes: [msg('y1', '2026-11-12T01:00:00Z', 'b')] },
    123456789012345: { grupo: true, nombre: 'Grupo', mensajes: [msg('x1', '2026-11-12T01:00:00Z', 'a')] }
  };
  assert.deepEqual(detectarDuplicados(chats), []);
});

test('aplicarFusiones: fusiona solo confianza alta y deja la clave del teléfono', () => {
  const chats = {
    51995227235: { telefono: '51995227235', nombre: 'Esther', waId: 'abc@lid', mensajes: [msg('w1', '2026-11-12T01:00:00Z', 'hola'), msg('w2', '2026-11-12T01:01:00Z', 'dos')] },
    123456789012345: { telefono: '123456789012345', nombre: '‪+51 995 227 235‬', waId: 'abc@lid', mensajes: [msg('w1', '2026-11-12T01:00:00Z', 'hola')] }
  };
  const { chats: salida, fusiones } = aplicarFusiones(chats);
  assert.equal(fusiones.length, 1);
  assert.deepEqual(Object.keys(salida), ['51995227235']);
  assert.equal(salida[51995227235].mensajes.length, 2);
  assert.equal(salida[51995227235].nombre, 'Esther');
  // La entrada original no se muta.
  assert.ok(chats[123456789012345]);
});

test('nombrePareceTelefono/claveEsTelefonoPeru: utilidades de la heurística', () => {
  assert.equal(nombrePareceTelefono('‪+51 995 227 235‬'), true);
  assert.equal(nombrePareceTelefono('Esther'), false);
  assert.equal(claveEsTelefonoPeru('51995227235'), true);
  assert.equal(claveEsTelefonoPeru('123456789012345'), false);
});
