#!/usr/bin/env node
/**
 * Restaura un respaldo de los datos del bot (JSON) a Pterodactyl.
 *
 * Uso:
 *   node scripts/restore-bot.mjs --panel https://panel.sakurasmp.xyz \
 *     --server 1938d04a --key ptlc_xxxx --from backups/2026-11-10-08-09-05
 *
 * Pide confirmación salvo que se pase --si. Reinicia el bot al terminar para que
 * cargue los datos restaurados.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const PANEL = String(arg('panel', process.env.PTERO_PANEL || 'https://panel.sakurasmp.xyz')).replace(/\/+$/, '');
const SERVER = arg('server', process.env.PTERO_SERVER || '');
const KEY = arg('key', process.env.PTERO_CLIENT_KEY || '');
const DESDE = arg('from', '');
const DIR = arg('dir', '/bot/data');
const SI = args.includes('--si');

if (!SERVER || !KEY || !DESDE) {
  console.error('Faltan --server, --key o --from (carpeta del respaldo).');
  process.exit(1);
}
if (!fs.existsSync(DESDE)) { console.error('No existe la carpeta:', DESDE); process.exit(1); }

const archivos = fs.readdirSync(DESDE).filter(f => /\.json$/i.test(f) && f !== '_manifiesto.json');
if (!archivos.length) { console.error('La carpeta no tiene archivos .json para restaurar.'); process.exit(1); }

if (!SI) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resp = await rl.question(`Se van a sobrescribir ${archivos.length} archivo(s) en ${DIR} del servidor ${SERVER}.\n¿Continuar? (escribe "si"): `);
  rl.close();
  if (String(resp).trim().toLowerCase() !== 'si') { console.log('Cancelado.'); process.exit(1); }
}

const base = `${PANEL}/api/client/servers/${SERVER}`;
const H = { Authorization: `Bearer ${KEY}` };
let ok = 0;
for (const nombre of archivos) {
  const contenido = fs.readFileSync(path.join(DESDE, nombre), 'utf8');
  // Validación básica: debe ser JSON válido.
  try { JSON.parse(contenido); } catch { console.log('  ERROR', nombre, 'no es JSON válido'); continue; }
  const r = await fetch(`${base}/files/write?file=${encodeURIComponent(DIR + '/' + nombre)}`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'text/plain' }, body: contenido
  });
  if (r.ok) { ok++; console.log('  ok', nombre); }
  else console.log('  ERROR', nombre, r.status);
}

console.log(`\n${ok}/${archivos.length} archivos restaurados.`);
if (ok) {
  await fetch(`${base}/power`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{"signal":"restart"}' });
  console.log('Bot reiniciado para cargar los datos.');
}
process.exitCode = ok === archivos.length ? 0 : 2;
