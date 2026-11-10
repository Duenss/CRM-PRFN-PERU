#!/usr/bin/env node
/**
 * Respaldo de los datos del bot (JSON) desde Pterodactyl.
 *
 * Descarga conversaciones, pedidos, anuncios, ajustes, IA, seguimiento, bajas…
 * y los guarda en `backups/AAAAMMDD-HHMMSS/`.
 *
 * Uso:
 *   node scripts/backup-bot.mjs --panel https://panel.sakurasmp.xyz \
 *     --server 1938d04a --key ptlc_xxxx
 *
 * La clave es la del **Cliente** de Pterodactyl (permiso de archivos), no la
 * de aplicación. No se guarda en el repo.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const PANEL = String(arg('panel', process.env.PTERO_PANEL || 'https://panel.sakurasmp.xyz')).replace(/\/+$/, '');
const SERVER = arg('server', process.env.PTERO_SERVER || '');
const KEY = arg('key', process.env.PTERO_CLIENT_KEY || '');
const DIR = arg('dir', '/bot/data');
const SALIDA = path.resolve(arg('out', 'backups'));

if (!SERVER || !KEY) {
  console.error('Faltan --server y --key (clave de Cliente de Pterodactyl).');
  process.exit(1);
}

const H = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
const base = `${PANEL}/api/client/servers/${SERVER}/files`;

async function listar(directorio) {
  const r = await fetch(`${base}/list?directory=${encodeURIComponent(directorio)}`, { headers: H });
  if (!r.ok) throw new Error('list ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  return j.data || [];
}
async function descargar(ruta) {
  const r = await fetch(`${base}/contents?file=${encodeURIComponent(ruta)}`, { headers: { ...H, Accept: 'text/plain' } });
  if (!r.ok) throw new Error('contents ' + r.status);
  return r.text();
}

const marca = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const destino = path.join(SALIDA, marca);
fs.mkdirSync(destino, { recursive: true });

const archivos = (await listar(DIR))
  .map(x => x.attributes || x)
  .filter(x => x.is_file && /\.json$/i.test(x.name));
let total = 0;
let errores = 0;
for (const f of archivos) {
  try {
    const contenido = await descargar(`${DIR}/${f.name}`);
    fs.writeFileSync(path.join(destino, f.name), contenido, 'utf8');
    total += Buffer.byteLength(contenido);
    console.log('  ok', f.name, Math.round(contenido.length / 1024) + ' KB');
  } catch (e) {
    errores++;
    console.log('  ERROR', f.name, e.message);
  }
}

// Manifiesto
fs.writeFileSync(path.join(destino, '_manifiesto.json'), JSON.stringify({
  fecha: new Date().toISOString(),
  servidor: SERVER,
  directorio: DIR,
  archivos: archivos.map(f => f.name),
  errores,
  bytes: total
}, null, 2), 'utf8');

console.log(`\nRespaldo en ${destino}`);
console.log(`${archivos.length - errores}/${archivos.length} archivos · ${(total / 1024).toFixed(1)} KB`);
process.exitCode = errores ? 2 : 0;
