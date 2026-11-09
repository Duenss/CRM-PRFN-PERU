/**
 * Limpieza para producción · Perfumería Fina
 *
 * Hace SIEMPRE un respaldo antes de borrar (en bot/data/backups/, carpeta que
 * no se sube al repositorio) y luego deja el sistema en blanco.
 *
 * Uso (desde la carpeta bot/):
 *   node scripts/limpiar-datos.mjs                 # respalda y limpia todo
 *   node scripts/limpiar-datos.mjs --solo-clientes # solo la tabla clientes
 *   node scripts/limpiar-datos.mjs --solo-local    # solo los datos locales
 *   node scripts/limpiar-datos.mjs --dry-run       # no borra: solo informa
 *
 * Qué borra:
 *   - Supabase: tabla `clientes` (los clientes cargados durante las pruebas).
 *   - Local: data/conversaciones.json, pedidos.json, anuncios.json,
 *     seguimiento.json (y sus .bak).
 *
 * NO borra: catálogo de productos, configuración de la tienda, SQL ni el PDF.
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const botDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(botDir, '.env') });

const { sb, getClientes } = await import('../src/supabase.js');

const dataDir = path.join(botDir, 'data');
const backupsDir = path.join(dataDir, 'backups');
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');
const soloClientes = args.has('--solo-clientes');
const soloLocal = args.has('--solo-local');
const hacerClientes = !soloLocal;
const hacerLocal = !soloClientes;

const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function respaldar(nombre, contenido) {
  if (dry) return;
  fs.mkdirSync(backupsDir, { recursive: true });
  const destino = path.join(backupsDir, `${nombre}-${sello}.json`);
  fs.writeFileSync(destino, contenido, 'utf8');
  console.log(`   respaldo → ${path.relative(botDir, destino)}`);
}

async function limpiarClientes() {
  console.log('\n1) Clientes en Supabase');
  if (!sb) {
    console.warn('   ⚠️  Sin SUPABASE_SERVICE_ROLE_KEY: se omite la limpieza de la nube.');
    return;
  }
  const clientes = await getClientes().catch(() => []);
  console.log(`   clientes actuales: ${clientes.length}`);
  if (!clientes.length) return;
  respaldar('clientes', JSON.stringify(clientes, null, 2));
  if (dry) {
    console.log('   [dry-run] se borrarían esos clientes.');
    return;
  }
  // Supabase exige un filtro: borramos todo lo que tenga id no nulo.
  const { error } = await sb.from('clientes').delete().not('id', 'is', null);
  if (error) throw new Error('No se pudieron borrar los clientes: ' + error.message);
  const restantes = await getClientes().catch(() => []);
  console.log(`   ✔ eliminados. Quedan: ${restantes.length}`);
}

function limpiarLocal() {
  console.log('\n2) Datos locales del bot');
  const vacios = {
    'conversaciones.json': {},
    'pedidos.json': { pedidos: [] },
    'anuncios.json': { anuncios: [] },
    'seguimiento.json': {}
  };
  for (const [nombre, vacio] of Object.entries(vacios)) {
    const ruta = path.join(dataDir, nombre);
    if (!fs.existsSync(ruta)) {
      console.log(`   ${nombre}: no existe, se omite.`);
      continue;
    }
    const crudo = fs.readFileSync(ruta, 'utf8');
    let resumen = 'archivo';
    try {
      const j = JSON.parse(crudo);
      const n = Array.isArray(j) ? j.length
        : Array.isArray(j.pedidos) ? j.pedidos.length
          : Array.isArray(j.anuncios) ? j.anuncios.length
            : Object.keys(j).length;
      resumen = `${n} registro(s)`;
    } catch {
      resumen = `${(crudo.length / 1024).toFixed(1)} KB (no era JSON válido)`;
    }
    console.log(`   ${nombre}: ${resumen}`);
    respaldar(nombre.replace('.json', ''), crudo);
    if (dry) continue;
    fs.writeFileSync(ruta, JSON.stringify(vacio, null, 2), 'utf8');
    const bak = ruta + '.bak';
    if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
    console.log(`   ✔ ${nombre} vaciado`);
  }
}

try {
  console.log(`Limpieza para producción${dry ? ' (dry-run: no se borra nada)' : ''}`);
  console.log(`Respaldo en: ${path.relative(botDir, backupsDir)}`);
  if (hacerClientes) await limpiarClientes();
  if (hacerLocal) limpiarLocal();
  console.log('\n✅ Listo. Los respaldos quedaron en bot/data/backups (no se suben al repo).');
  // Cierre ordenado: sin esto, Windows puede quejarse al salir con conexiones abiertas.
  try { sb?.removeAllChannels?.(); } catch { /* opcional */ }
  await new Promise(r => setTimeout(r, 300));
  process.exit(0);
} catch (e) {
  console.error('\n❌ Error: ' + e.message);
  process.exit(1);
}