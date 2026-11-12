#!/usr/bin/env node
/**
 * Respaldo manual de bot/data a Supabase Storage (bucket privado 'bot-backups').
 *
 * Es el mismo respaldo que hace el job diario del bot (bot/src/backups.js,
 * 03:00 hora del bot), para correrlo a mano desde la máquina o el servidor.
 *
 * Credenciales: se leen SOLO del entorno, nunca del repo.
 *   node --env-file=bot/.env scripts/backup-bot.mjs
 *   node --env-file=bot/.env scripts/backup-bot.mjs --dir bot/data --retencion 14
 *
 * Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. El bucket "bot-backups"
 * debe existir (privado) en Supabase → Storage; si no existe, el script lo
 * informa claramente y sale con error (no lo crea).
 *
 * Qué sube:
 *   - data/*.json y data/comprobantes/* SIEMPRE.
 *   - data/archivos/* (PDF/video/foto de Ajustes) SOLO si su hash cambió
 *     desde el último respaldo (estado en data/backup-ultimo.json).
 * Retención: 14 carpetas diarias; las más viejas se eliminan.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const URL_BASE = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const BUCKET = arg('bucket', process.env.BACKUP_BUCKET || 'bot-backups');
const DIR = path.resolve(arg('dir', path.join('bot', 'data')));
const RETENCION = Math.max(1, Number(arg('retencion', 14)) || 14);
const ZONA = process.env.ZONA_HORARIA || 'America/Lima';

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

const fechaCarpeta = () => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
};
const sha256 = c => crypto.createHash('sha256').update(c).digest('hex');

// 1) El bucket debe existir (lo crea el dueño, privado).
try {
  await api(`bucket/${BUCKET}`);
} catch (e) {
  console.error(`El bucket "${BUCKET}" no existe en Supabase Storage (${e.message}).`);
  console.error('Críalo privado en Supabase → Storage → New bucket → "bot-backups" (privado) y vuelve a correr.');
  process.exit(2);
}

const carpeta = fechaCarpeta();
const estadoFile = path.join(DIR, 'backup-ultimo.json');
let previo = {};
try { previo = JSON.parse(fs.readFileSync(estadoFile, 'utf8')); } catch {}

// 2) Inventario de lo que se sube.
const archivos = [];
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.json') && x !== 'backup-ultimo.json')) {
  archivos.push({ nombre: `data/${f}`, ruta: path.join(DIR, f), tipo: 'application/json' });
}
try {
  for (const f of fs.readdirSync(path.join(DIR, 'comprobantes'))) {
    archivos.push({ nombre: `comprobantes/${f}`, ruta: path.join(DIR, 'comprobantes', f), tipo: 'application/octet-stream' });
  }
} catch { /* sin comprobantes */ }

const hashes = {};
try {
  for (const f of fs.readdirSync(path.join(DIR, 'archivos')).sort()) {
    const p = path.join(DIR, 'archivos', f);
    try { if (fs.statSync(p).isFile()) hashes[f] = sha256(fs.readFileSync(p)); } catch {}
  }
} catch { /* sin archivos */ }
const hashesPrevios = previo.hashes || {};
for (const f of Object.keys(hashes).sort()) {
  if (hashes[f] !== hashesPrevios[f]) {
    archivos.push({ nombre: `archivos/${f}`, ruta: path.join(DIR, 'archivos', f), tipo: 'application/octet-stream' });
  }
}

// 3) Subida.
let subidos = 0;
const errores = [];
for (const a of archivos) {
  try {
    const datos = fs.readFileSync(a.ruta);
    await api(`object/${BUCKET}/${carpeta}/${a.nombre}`, {
      method: 'POST',
      headers: { 'Content-Type': a.tipo },
      body: datos
    });
    subidos++;
    console.log('  ok', a.nombre);
  } catch (e) {
    errores.push(`${a.nombre}: ${e.message}`);
    console.log('  ERROR', a.nombre, e.message);
  }
}

// 4) Retención: borrar carpetas diarias más viejas del límite.
try {
  const r = await api(`object/list/${BUCKET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 200, offset: 0, sortBy: { column: 'name', order: 'asc' } })
  });
  const j = await r.json();
  const limite = new Date(`${carpeta}T00:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() - RETENCION);
  const limiteIso = limite.toISOString().slice(0, 10);
  const viejas = (j || [])
    .filter(x => x && (x.id === null || x.id === undefined) && /^\d{4}-\d{2}-\d{2}$/.test(String(x.name)) && String(x.name) < limiteIso)
    .map(x => String(x.name));
  for (const v of viejas) {
    try {
      await api(`object/${BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes: [v] }) });
      console.log('  borrada carpeta antigua', v);
    } catch (e) {
      console.log('  no se pudo borrar', v, e.message);
    }
  }
} catch (e) {
  console.log('  retención: no se pudo revisar:', e.message);
}

// 5) Estado local (escritura atómica) para comparar hashes en el próximo ciclo.
const estado = {
  ultimoOk: errores.length ? (previo.ultimoOk || null) : new Date().toISOString(),
  carpeta,
  subidos,
  errores,
  hashes
};
const tmp = estadoFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(estado, null, 2));
fs.renameSync(tmp, estadoFile);

console.log(`\nRespaldo ${carpeta}: ${subidos}/${archivos.length} archivos a ${BUCKET}.`);
process.exitCode = errores.length ? 2 : 0;
