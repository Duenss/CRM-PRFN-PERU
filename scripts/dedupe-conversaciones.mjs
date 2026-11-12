#!/usr/bin/env node
/**
 * Detecta y (opcionalmente) fusiona chats duplicados de la Bandeja.
 *
 * Causa típica: la migración de WhatsApp a LID deja el mismo hilo bajo dos
 * claves (teléfono real y userid del LID). El bot ya no crea nuevos duplicados,
 * pero los históricos se limpian con este script.
 *
 * Uso:
 *   node scripts/dedupe-conversaciones.mjs                 # solo informe (dry-run)
 *   node scripts/dedupe-conversaciones.mjs --min=media     # incluye confianza media
 *   node scripts/dedupe-conversaciones.mjs --aplicar       # fusiona (con backup)
 *
 * Archivo por defecto: bot/data/conversaciones.json (volumen bot-data-v2).
 * Siempre hace una copia .bak-pre-dedupe-<fecha> antes de escribir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectarDuplicados, aplicarFusiones } from '../bot/src/fusion.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (nombre, def) => {
  const i = args.indexOf('--' + nombre);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const ARCHIVO = path.resolve(arg('archivo', path.join(RAIZ, 'bot', 'data', 'conversaciones.json')));
const MIN = String(arg('min', 'alta')); // alta | media | todas
const APLICAR = args.includes('--aplicar');

if (!fs.existsSync(ARCHIVO)) {
  console.error(`No existe ${ARCHIVO}. Copia bot/data/conversaciones.json desde el servidor.`);
  process.exit(1);
}

let crudo;
try { crudo = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (e) {
  console.error(`El archivo no es JSON válido: ${e.message}`);
  process.exit(1);
}
const envuelto = !!(crudo && typeof crudo === 'object' && crudo.chats && typeof crudo.chats === 'object');
const chats = envuelto ? crudo.chats : (crudo && typeof crudo === 'object' ? crudo : {});
const total = Object.keys(chats).length;
const pares = detectarDuplicados(chats);

console.log(`Archivo: ${ARCHIVO}`);
console.log(`Chats: ${total} · pares duplicados detectados: ${pares.length}\n`);

if (!pares.length) {
  console.log('No se detectaron duplicados. Nada que hacer.');
  process.exit(0);
}

const describir = e => {
  const c = e.chat || {};
  const n = (c.mensajes || []).length;
  return `clave=${e.clave} nombre="${c.nombre || c.nombreWa || '—'}" mensajes=${n} waId=${c.waId || '—'}`;
};
for (const [i, p] of pares.entries()) {
  console.log(`${i + 1}. [${p.confianza}] ${p.motivos.join('; ')}`);
  console.log(`   A: ${describir(p.a)}`);
  console.log(`   B: ${describir(p.b)}`);
  if (p.waIdsCompartidos.length) console.log(`   waIds compartidos: ${p.waIdsCompartidos.join(', ')}`);
  console.log('');
}

if (!APLICAR) {
  const aplicables = pares.filter(p => MIN === 'todas' ? true : MIN === 'media' ? true : p.confianza === 'alta');
  console.log(`DRY-RUN: ${aplicables.length} par(es) se fusionarían con --min=${MIN}.`);
  console.log('Para aplicarlo: node scripts/dedupe-conversaciones.mjs --aplicar' + (MIN !== 'alta' ? ` --min=${MIN}` : ''));
  process.exit(0);
}

const marca = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const backup = `${ARCHIVO}.bak-pre-dedupe-${marca}`;
fs.copyFileSync(ARCHIVO, backup);
const { chats: fusionados, fusiones } = aplicarFusiones(chats, { soloConfianza: MIN === 'todas' ? 'todas' : MIN });
const tmp = ARCHIVO + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(envuelto ? { ...crudo, chats: fusionados } : fusionados, null, 2), 'utf8');
fs.renameSync(tmp, ARCHIVO);

console.log(`\nFusiones aplicadas: ${fusiones.length}`);
for (const f of fusiones) console.log(`  ${f.origen} → ${f.destino} (${f.motivos.join('; ')})`);
console.log(`Chats: ${total} → ${Object.keys(fusionados).length}`);
console.log(`Backup: ${backup}`);
console.log('\nReinicia el bot (Coolify → Restart/Redeploy) para que cargue la Bandeja limpia.');
