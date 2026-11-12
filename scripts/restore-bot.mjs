#!/usr/bin/env node
/**
 * Restaura un respaldo diario desde Supabase Storage (bucket privado
 * 'bot-backups') a bot/data.
 *
 * Credenciales: solo del entorno, nunca del repo.
 *   node --env-file=bot/.env scripts/restore-bot.mjs --list
 *   node --env-file=bot/.env scripts/restore-bot.mjs --from 2026-11-11 --si
 *   node --env-file=bot/.env scripts/restore-bot.mjs --from 2026-11-11 --dir /ruta/temporal
 *
 * - --list  muestra las carpetas diarias disponibles (y sus tamaños no; solo fechas).
 * - Sin --from usa la carpeta más reciente.
 * - `data/*.json` y `comprobantes/` salen de la carpeta elegida.
 * - `archivos/` se reconstruye con la VERSIÓN MÁS RECIENTE de cada archivo
 *   entre TODAS las carpetas (una subida nueva puede estar solo en la última).
 * - Valida que cada data/*.json sea JSON válido ANTES de tocar nada.
 * - Antes de sobrescribir, guarda una copia de los archivos actuales en
 *   <dir>/.pre-restore-<fecha>/ por si hay que revertir.
 * - Escribe de forma atómica (tmp+rename) y pide confirmación salvo --si.
 * - NO restaura la sesión de WhatsApp (.wwebjs_auth NO se respalda): al
 *   terminar, reinicia el bot y escanea el QR de nuevo si la sesión se perdió.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { elegirArchivosMasRecientes, planificarDescargas } from './restore-logica.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const URL_BASE = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const BUCKET = arg('bucket', process.env.BACKUP_BUCKET || 'bot-backups');
const DIR = path.resolve(arg('dir', path.join('bot', 'data')));
const DESDE = arg('from', '');
const SI = args.includes('--si');
const LISTAR = args.includes('--list');

if (!URL_BASE || !KEY) {
  console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno (usa --env-file=bot/.env).');
  process.exit(1);
}

const H = { Authorization: `Bearer ${KEY}`, apikey: KEY };

async function api(ruta, opciones = {}) {
  const r = await fetch(`${URL_BASE}/storage/v1/${ruta}`, { ...opciones, headers: { ...H, ...(opciones.headers || {}) } });
  if (!r.ok) {
    let detalle = '';
    try { detalle = await r.text(); } catch {}
    const err = new Error(`${r.status} ${String(detalle).slice(0, 140)}`);
    err.status = r.status;
    throw err;
  }
  return r;
}

async function carpetas() {
  const r = await api(`object/list/${BUCKET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 200, offset: 0, sortBy: { column: 'name', order: 'desc' } })
  });
  const j = await r.json();
  return (j || [])
    .filter(x => x && (x.id === null || x.id === undefined) && /^\d{4}-\d{2}-\d{2}$/.test(String(x.name)))
    .map(x => String(x.name));
}

if (LISTAR) {
  console.log(`Carpetas diarias en ${BUCKET}:`);
  for (const c of await carpetas()) console.log(' ', c);
  process.exit(0);
}

const disponibles = await carpetas();
if (!disponibles.length) {
  console.error(`No hay respaldos en el bucket "${BUCKET}".`);
  process.exit(1);
}
const desde = DESDE || disponibles[0];
if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
  console.error('--from debe ser una carpeta diaria YYYY-MM-DD (ver --list).');
  process.exit(1);
}

// 1) Inventario del respaldo elegido + `archivos/` más reciente de TODAS las carpetas.
const r = await api(`object/list/${BUCKET}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prefix: `${desde}/`, limit: 500, offset: 0, sortBy: { column: 'name', order: 'asc' } })
});
const j = await r.json();
const objetosDesde = (j || [])
  .map(x => String(x && x.name || ''))
  .filter(n => n && !n.endsWith('/'));

// Las carpetas del bucket vienen de la más nueva a la más vieja: se busca en
// cada una la subcarpeta archivos/ y se elige la versión más reciente por nombre.
const carpetasDesc = [...new Set(disponibles)].sort().reverse();
const entradasArchivos = [];
for (const c of carpetasDesc) {
  try {
    const rr = await api(`object/list/${BUCKET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: `${c}/archivos/`, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } })
    });
    const jj = await rr.json();
    entradasArchivos.push({
      carpeta: c,
      archivos: (jj || []).map(x => String(x && x.name || '')).filter(n => n && !n.endsWith('/'))
    });
  } catch { entradasArchivos.push({ carpeta: c, archivos: [] }); }
}
const archivosRecientes = elegirArchivosMasRecientes(entradasArchivos);
const descargas = planificarDescargas({ desde, objetosDesde, archivosRecientes });
if (!descargas.length && !archivosRecientes.length) {
  console.error(`La carpeta ${desde} no tiene archivos.`);
  process.exit(1);
}
const nombres = descargas.map(d => d.destino);
if (archivosRecientes.length) {
  console.log(`archivos/: ${archivosRecientes.length} archivo(s) se reconstruyen con la versión más reciente entre las ${carpetasDesc.length} carpetas.`);
}

// 2) Descarga a una zona de preparación y valida los JSON antes de tocar nada.
const marca = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const staging = path.join(DIR, `.restore-staging-${marca}`);
const previos = path.join(DIR, `.pre-restore-${marca}`);
fs.mkdirSync(staging, { recursive: true });

let descargados = 0;
for (const { origen, destino: relativo } of descargas) {
  try {
    const resp = await api(`object/${BUCKET}/${origen}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const destino = path.join(staging, ...relativo.split('/'));
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, buf);
    if (relativo.startsWith('data/') && relativo.endsWith('.json')) {
      try { JSON.parse(buf.toString('utf8')); } catch {
        console.error(`  ERROR: ${relativo} del respaldo NO es JSON válido; se cancela la restauración.`);
        fs.rmSync(staging, { recursive: true, force: true });
        process.exit(1);
      }
    }
    descargados++;
    console.log('  ok', origen);
  } catch (e) {
    console.error(`  ERROR descargando ${origen}: ${e.message}`);
    fs.rmSync(staging, { recursive: true, force: true });
    process.exit(1);
  }
}

if (!SI) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resp = await rl.question(`Se van a restaurar ${descargados} archivo(s) del respaldo ${desde} en ${DIR}.\nLos actuales quedarán en ${previos}.\n¿Continuar? (escribe "si"): `);
  rl.close();
  if (String(resp).trim().toLowerCase() !== 'si') {
    console.log('Cancelado.');
    fs.rmSync(staging, { recursive: true, force: true });
    process.exit(1);
  }
}

// 3) Copia de seguridad de lo actual (si existe) y aplicación atómica.
const escribirAtomico = (ruta, contenido) => {
  const tmp = ruta + '.tmp';
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, ruta);
};
let aplicados = 0;
try {
  for (const nombre of nombres) {
    const origen = path.join(staging, ...nombre.split('/'));
    const destino = path.join(DIR, ...nombre.split('/'));
    if (fs.existsSync(destino)) {
      fs.mkdirSync(path.join(previos, ...nombre.split('/').slice(0, -1)), { recursive: true });
      fs.copyFileSync(destino, path.join(previos, ...nombre.split('/')));
    }
    escribirAtomico(destino, fs.readFileSync(origen));
    aplicados++;
  }
} catch (e) {
  console.error(`ERROR aplicando el respaldo (${e.message}). Los archivos ya copiados quedaron aplicados; revertir desde ${previos} si hace falta.`);
  process.exit(1);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

console.log(`\n${aplicados}/${nombres.length} archivos restaurados desde ${desde}.`);
console.log(`Copia de lo anterior: ${previos}`);
console.log('Reinicia el bot para que cargue los datos: en Coolify → Redeploy/Restart del servicio bot.');
console.log('La sesión de WhatsApp NO se restaura (.wwebjs_auth): si el bot pide QR, escanéalo desde Ajustes → Conectar WhatsApp.');
