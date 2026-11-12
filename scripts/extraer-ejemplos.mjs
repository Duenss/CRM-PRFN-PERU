#!/usr/bin/env node
/**
 * Extrae ejemplos pregunta→respuesta para la IA desde conversaciones reales.
 *
 * - Lee bot/data/conversaciones.json (o --archivo) y bot/data/pedidos.json.
 * - Con --supabase lee además la tabla `mensajes` (necesita SUPABASE_URL y
 *   SUPABASE_SERVICE_ROLE_KEY en el entorno; nunca imprime los valores).
 * - SOLO usa conversaciones con venta o pedido.
 * - ANONIMIZA teléfonos, nombres, direcciones, correos y links.
 * - Escribe bot/data/ejemplos-ia.json (atómico) con:
 *     { id, pregunta, respuesta, etiquetas, aprobado:false }
 *
 * Uso:
 *   node scripts/extraer-ejemplos.mjs
 *   node scripts/extraer-ejemplos.mjs --archive bot/data/conversaciones.json
 *   node scripts/extraer-ejemplos.mjs --supabase
 *
 * Después: revisa el JSON, pon "aprobado": true en los ejemplos que te gusten
 * y activa el ajuste `ejemplosIAActivos` en Ajustes (por defecto está apagado).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearEjemplos } from './extraer-logica.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (nombre, def) => {
  const i = args.indexOf('--' + nombre);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const ARCHIVO_CONV = path.resolve(arg('archivo', path.join(RAIZ, 'bot', 'data', 'conversaciones.json')));
const ARCHIVO_PEDIDOS = path.resolve(arg('pedidos', path.join(RAIZ, 'bot', 'data', 'pedidos.json')));
const SALIDA = path.resolve(arg('salida', path.join(RAIZ, 'bot', 'data', 'ejemplos-ia.json')));
const DESDE_SUPABASE = args.includes('--supabase');

function leerJson(archivo, defecto) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return defecto; }
}

function escribirAtomico(archivo, datos) {
  const tmp = archivo + '.tmp';
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2), 'utf8');
  fs.renameSync(tmp, archivo);
}

/** Normaliza el snapshot de conversaciones a { telefono: { mensajes } }. */
function chatsDeConversaciones(conv) {
  if (!conv) return {};
  if (conv.chats && typeof conv.chats === 'object') return conv.chats;
  if (Array.isArray(conv)) return Object.fromEntries(conv.map(c => [String(c?.telefono || ''), c]).filter(([t]) => t));
  return {};
}

/** Teléfonos con pedido registrado. */
function telefonosConPedido(pedidos) {
  const lista = Array.isArray(pedidos) ? pedidos : (Array.isArray(pedidos?.pedidos) ? pedidos.pedidos : []);
  return new Set(lista.map(p => String(p?.telefono || '').replace(/\D/g, '')).filter(Boolean));
}

async function chatsDesdeSupabase() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) {
    console.warn('AVISO: --supabase sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY; se omite esa fuente.');
    return {};
  }
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const filas = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const r = await fetch(`${url}/rest/v1/mensajes?select=telefono,direccion,texto,creado_en&order=creado_en.asc&limit=1000&offset=${offset}`, { headers: H });
    if (!r.ok) {
      console.warn(`AVISO: no se pudo leer mensajes de Supabase (${r.status}); se continúa solo con el JSON local.`);
      break;
    }
    const lote = await r.json();
    if (!Array.isArray(lote) || !lote.length) break;
    filas.push(...lote);
    if (lote.length < 1000) break;
  }
  const chats = {};
  for (const f of filas) {
    const tel = String(f.telefono || '').replace(/\D/g, '');
    if (!tel) continue;
    chats[tel] = chats[tel] || { telefono: tel, mensajes: [] };
    chats[tel].mensajes.push({ direccion: f.direccion, texto: f.texto, origen: f.origen || '' });
  }
  return chats;
}

const conv = leerJson(ARCHIVO_CONV, null);
const chats = chatsDeConversaciones(conv);
const pedidos = leerJson(ARCHIVO_PEDIDOS, []);
const pedidosPorTel = telefonosConPedido(pedidos);

if (Object.keys(chats).length) console.log(`Conversaciones locales: ${Object.keys(chats).length} chats (${ARCHIVO_CONV}).`);
else console.warn(`AVISO: no hay conversaciones en ${ARCHIVO_CONV}.`);

if (DESDE_SUPABASE) {
  const remotos = await chatsDesdeSupabase();
  const n = Object.keys(remotos).length;
  for (const [tel, chat] of Object.entries(remotos)) {
    if (!chats[tel]) chats[tel] = chat;
  }
  console.log(`Conversaciones desde Supabase: ${n} chats.`);
}
if (pedidosPorTel.size) console.log(`Pedidos registrados: ${pedidosPorTel.size} teléfonos.`);

const { ejemplos, stats } = crearEjemplos({ chats, pedidosPorTel });
if (!ejemplos.length) {
  console.error('No se encontraron pares de conversaciones con venta o pedido. No se escribió nada.');
  process.exit(2);
}
escribirAtomico(SALIDA, ejemplos);

console.log(`\nEjemplos extraídos: ${ejemplos.length} (de ${stats.conversaciones} conversaciones con venta/pedido, ${stats.pares} pares).`);
console.log(`Archivo: ${SALIDA}`);
console.log('\nSiguiente paso:');
console.log('  1. Revisa cada ejemplo (pregunta/respuesta ya anonimizadas).');
console.log('  2. Pon "aprobado": true SOLO en los que quieras que use la IA.');
console.log('  3. Activa el ajuste "ejemplosIAActivos" en el panel (Ajustes → Asistente IA).');
console.log('  Los ejemplos con precios, stock o promociones se descartan automáticamente.');
