// Respaldo diario de bot/data hacia Supabase Storage (bucket privado
// 'bot-backups', creado a mano por el dueño en Supabase → Storage).
//
// - data/*.json y comprobantes/ se suben SIEMPRE.
// - archivos/ (PDF, video, foto subidos desde Ajustes) SOLO si su hash cambió
//   desde el último backup (son grandes y casi nunca cambian).
// - Retención: 14 carpetas diarias (YYYY-MM-DD); las más viejas se borran.
// - Si el bucket no existe, se registra un error claro y el bot sigue vivo.
// - La sesión de WhatsApp (.wwebjs_auth) NO se respalda: perderla obliga a
//   escanear el QR de nuevo (ver docs/RUNBOOK-BOT.md).
//
// El job corre dentro del bot (usa las credenciales de Supabase que ya tiene
// en el entorno); los scripts manuales equivalentes están en scripts/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sb } from './supabase.js';
import { config } from './config.js';
import { escribirAtomico } from './almacen.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const comprobantesDir = path.join(dataDir, 'comprobantes');
const archivosDir = path.join(dataDir, 'archivos');
const estadoFile = path.join(dataDir, 'backup-ultimo.json');

export const BUCKET = process.env.BACKUP_BUCKET || 'bot-backups';
export const RETENCION_DIAS = 14;
export const HORA_BACKUP = 3; // 03:00 hora local del bot (config.zona)

/** Fecha local (zona del bot) en formato YYYY-MM-DD para la carpeta del backup. */
export function fechaCarpeta(ahora = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.zona, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(ahora);
}

export const sha256 = contenido => crypto.createHash('sha256').update(contenido).digest('hex');

/** Hash de contenido de cada archivo de una carpeta (para subir solo lo que cambió). */
export function hashesArchivos(dir = archivosDir) {
  const salida = {};
  let archivos = [];
  try { archivos = fs.readdirSync(dir); } catch { return salida; }
  for (const nombre of archivos.sort()) {
    try {
      const p = path.join(dir, nombre);
      if (!fs.statSync(p).isFile()) continue;
      salida[nombre] = sha256(fs.readFileSync(p));
    } catch { /* archivo que desapareció mientras se leía: se omite */ }
  }
  return salida;
}

/** Carpetas diarias (YYYY-MM-DD) más viejas del límite de retención, ordenadas. */
export function carpetasViejas(carpetas = [], hoy = fechaCarpeta(), dias = RETENCION_DIAS) {
  const limite = new Date(`${hoy}T00:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() - dias);
  const limiteIso = limite.toISOString().slice(0, 10);
  return carpetas
    .filter(c => /^\d{4}-\d{2}-\d{2}$/.test(String(c)) && String(c) < limiteIso)
    .sort();
}

/**
 * Lista RECURSIVAMENTE las rutas completas de los objetos de una carpeta
 * (`YYYY-MM-DD/...`). Supabase Storage lista un nivel por vez: las entradas de
 * subcarpeta (id null) se recorren y las de archivo (id presente) se acumulan.
 */
export async function listarObjetos(storage, carpeta, { limite = 1000 } = {}) {
  const base = String(carpeta || '').replace(/\/+$/, '');
  if (!base) return [];
  const salida = [];
  const pendientes = [base];
  while (pendientes.length) {
    const prefijo = pendientes.shift();
    let offset = 0;
    for (;;) {
      const { data, error } = await storage.list(prefijo, {
        limit: limite, offset, sortBy: { column: 'name', order: 'asc' }
      });
      if (error) throw new Error(`No se pudo listar ${prefijo}: ${error.message || error}`);
      const items = Array.isArray(data) ? data : [];
      if (!items.length) break;
      for (const x of items) {
        const nombre = String((x && x.name) || '');
        if (!nombre) continue;
        const ruta = `${prefijo}/${nombre}`;
        // Las "carpetas" vienen sin id; los archivos, con id/metadata.
        if (x.id === null || x.id === undefined) pendientes.push(ruta);
        else salida.push(ruta);
      }
      if (items.length < limite) break;
      offset += limite;
    }
  }
  return salida;
}

/**
 * Borra objetos por RUTA completa, en lotes. Nunca se intenta borrar "la
 * carpeta" como prefijo (Supabase Storage no funciona así).
 */
export async function borrarObjetos(storage, rutas = [], { lote = 100 } = {}) {
  const lista = (Array.isArray(rutas) ? rutas : []).filter(r => typeof r === 'string' && r);
  let borrados = 0;
  for (let i = 0; i < lista.length; i += lote) {
    const grupo = lista.slice(i, i + lote);
    const { error } = await storage.remove(grupo);
    if (error) throw new Error(`No se pudieron borrar ${grupo.length} objeto(s): ${error.message || error}`);
    borrados += grupo.length;
  }
  return borrados;
}

/**
 * Antes de borrar una carpeta antigua, conserva en el backup de HOY la última
 * copia de cada archivo de `archivos/` que vivía solo ahí:
 *  - si el archivo sigue en disco, se resube su versión vigente;
 *  - si ya no está en disco, se copia el objeto remoto de la carpeta antigua.
 * Devuelve los nombres protegidos. `subir(nombre, buffer|null)` sube al
 * backup de hoy (buffer null = leer la versión local de archivos/).
 */
export async function protegerArchivosDeCarpeta({ storage, vieja, carpetaHoy, rutas = [], yaEnHoy = new Set(), hashes = {}, subir = null, log = () => {} } = {}) {
  const marca = `${String(vieja).replace(/\/+$/, '')}/archivos/`;
  const protegidos = [];
  for (const ruta of Array.isArray(rutas) ? rutas : []) {
    const i = String(ruta).indexOf(marca);
    if (i < 0) continue;
    const nombre = String(ruta).slice(i + marca.length);
    if (!nombre || yaEnHoy.has(nombre)) continue;
    if (typeof subir !== 'function') throw new Error('falta la función de subida del backup de hoy');
    if (hashes[nombre]) {
      await subir(nombre, null); // versión vigente en disco
    } else {
      const { data, error } = await storage.download(ruta);
      if (error || !data) throw new Error(`no se pudo descargar ${ruta}: ${(error && error.message) || 'sin datos'}`);
      const buffer = Buffer.from(await data.arrayBuffer());
      await subir(nombre, buffer); // el archivo ya no está en disco: se conserva el remoto
    }
    yaEnHoy.add(nombre);
    protegidos.push(nombre);
    log(`Backup: se conservó archivos/${nombre} (última copia en ${vieja}) en el backup de hoy.`);
  }
  return protegidos;
}

function leerEstado() {
  try { return JSON.parse(fs.readFileSync(estadoFile, 'utf8')); } catch { return {}; }
}

export async function ejecutarBackup({ log = console.log } = {}) {
  if (!sb) {
    log('Backup: sin Supabase configurado; no se respalda.');
    return { ok: false, error: 'Sin Supabase' };
  }
  // El bucket lo crea el dueño a mano (privado). Si falta: error claro, sin
  // tumbar el bot.
  const { data: bucket, error: errBucket } = await sb.storage.getBucket(BUCKET);
  if (errBucket || !bucket) {
    log(`Backup: el bucket "${BUCKET}" no existe en Supabase Storage (${(errBucket && errBucket.message) || 'no encontrado'}). Créalo privado en Supabase → Storage y el próximo ciclo lo usará.`);
    return { ok: false, error: 'bucket_falta' };
  }

  const carpeta = fechaCarpeta();
  const previo = leerEstado();

  let jsonFiles = [];
  try {
    jsonFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== 'backup-ultimo.json');
  } catch {}
  let comprobantes = [];
  try {
    comprobantes = fs.readdirSync(comprobantesDir).filter(f => {
      try { return fs.statSync(path.join(comprobantesDir, f)).isFile(); } catch { return false; }
    });
  } catch {}
  // archivos/: solo los que cambiaron desde el último backup (por hash).
  const hashes = hashesArchivos();
  const hashesPrevios = (previo && previo.hashes) || {};
  const archivos = Object.keys(hashes).filter(n => hashes[n] !== hashesPrevios[n]);

  const subir = async (rutaLocal, nombre, tipo) => {
    const datos = fs.readFileSync(rutaLocal);
    const { error } = await sb.storage.from(BUCKET).upload(`${carpeta}/${nombre}`, datos, {
      contentType: tipo,
      upsert: false
    });
    if (error) throw new Error(`${nombre}: ${error.message || error}`);
  };

  let subidos = 0;
  const errores = [];
  for (const f of jsonFiles) {
    try { await subir(path.join(dataDir, f), `data/${f}`, 'application/json'); subidos++; }
    catch (e) { errores.push(e.message); }
  }
  for (const f of comprobantes) {
    try { await subir(path.join(comprobantesDir, f), `comprobantes/${f}`, 'application/octet-stream'); subidos++; }
    catch (e) { errores.push(e.message); }
  }
  const archivosOk = new Set();
  for (const f of archivos) {
    try { await subir(path.join(archivosDir, f), `archivos/${f}`, 'application/octet-stream'); archivosOk.add(f); subidos++; }
    catch (e) { errores.push(e.message); }
  }

  // Retención: borrar las carpetas diarias más viejas de RETENCION_DIAS días.
  // Se LISTAN los objetos de cada carpeta y se borran POR RUTA (storage.remove
  // no borra carpetas por prefijo). Antes de borrar, si una carpeta antigua
  // guarda la última copia de un archivo de archivos/, se resube al backup de
  // hoy; si eso falla, esa carpeta NO se borra (nunca se pierde la última copia).
  try {
    const { data: lista, error: errLista } = await sb.storage.from(BUCKET).list('', {
      limit: 200,
      sortBy: { column: 'name', order: 'asc' }
    });
    if (!errLista && Array.isArray(lista)) {
      const carpetas = lista
        .filter(x => x && (x.id === null || x.id === undefined) && /^\d{4}-\d{2}-\d{2}$/.test(String(x.name)))
        .map(x => String(x.name));
      const storage = sb.storage.from(BUCKET);
      const archivosSubidosHoy = new Set(archivosOk);
      const subirHoy = async (nombre, buffer) => {
        const datos = buffer || fs.readFileSync(path.join(archivosDir, nombre));
        const { error } = await sb.storage.from(BUCKET).upload(`${carpeta}/archivos/${nombre}`, datos, {
          contentType: 'application/octet-stream',
          upsert: false
        });
        // Si ya existe en el backup de hoy, la copia está a salvo.
        if (error && !/already exists|duplicate/i.test(String(error.message || error))) {
          throw new Error(`${nombre}: ${error.message || error}`);
        }
        archivosSubidosHoy.add(nombre);
      };
      for (const vieja of carpetasViejas(carpetas, carpeta)) {
        try {
          const rutas = await listarObjetos(storage, vieja);
          const protegidos = await protegerArchivosDeCarpeta({
            storage, vieja, carpetaHoy: carpeta, rutas,
            yaEnHoy: archivosSubidosHoy, hashes, subir: subirHoy, log
          });
          if (protegidos.length) log(`Backup: ${protegidos.length} archivo(s) de archivos/ conservados antes de borrar ${vieja}.`);
          const borrados = await borrarObjetos(storage, rutas);
          log(`Backup: carpeta antigua ${vieja} eliminada por ruta (${borrados} objetos, retención ${RETENCION_DIAS} días).`);
        } catch (e) {
          log(`Backup: no se pudo eliminar la carpeta antigua ${vieja} (se conserva): ${e.message}`);
        }
      }
    }
  } catch (e) {
    log('Backup: no se pudo revisar la retención: ' + e.message);
  }

  const estado = {
    ultimoOk: errores.length === 0 ? new Date().toISOString() : (previo.ultimoOk || null),
    carpeta,
    subidos,
    errores,
    hashes
  };
  escribirAtomico(estadoFile, JSON.stringify(estado, null, 2));

  if (errores.length) log(`Backup ${carpeta}: ${subidos} subidos, ${errores.length} errores (primero: ${errores[0]}).`);
  else log(`Backup ${carpeta}: ${subidos} archivos subidos a ${BUCKET}.`);
  return { ok: errores.length === 0, carpeta, subidos, errores };
}

/** Milisegundos hasta la próxima HORA_BACKUP en la zona del bot. */
export function msHastaHoraLocal(hora = HORA_BACKUP, ahora = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.zona, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const o = {};
  for (const p of fmt.formatToParts(ahora)) o[p.type] = p.value;
  const ahoraSeg = (+o.hour) * 3600 + (+o.minute) * 60 + (+o.second);
  const objetivo = hora * 3600;
  return ((objetivo - ahoraSeg + 86400) % 86400) * 1000;
}

/**
 * Programa el job diario (03:00 hora del bot) y una puesta al día a los 90 s
 * del arranque si el último backup tiene más de 26 h. Nunca lanza: si el
 * bucket no existe o Supabase falla, solo queda el error en el log.
 */
export function programarBackups({ log = console.log } = {}) {
  if (config.modoPrueba && !/^(1|true|si|sí|yes|on)$/i.test(String(process.env.BACKUP_EN_PRUEBA || ''))) {
    log('Backups: desactivados en modo prueba (BACKUP_EN_PRUEBA=true para forzar).');
    return { cancelar: () => {} };
  }
  let corriendo = false;
  const lanzar = () => {
    if (corriendo) return;
    corriendo = true;
    ejecutarBackup({ log })
      .catch(e => log('Backup: error inesperado: ' + e.message))
      .finally(() => { corriendo = false; });
  };

  const estado = leerEstado();
  const ultimo = Date.parse(estado && estado.ultimoOk);
  const vencido = !Number.isFinite(ultimo) || Date.now() - ultimo > 26 * 3600 * 1000;
  if (vencido) {
    setTimeout(() => lanzar(), 90000).unref?.();
    log('Backup: último respaldo viejo o inexistente; puesta al día en 90 s.');
  }

  const t = setTimeout(() => {
    lanzar();
    setInterval(lanzar, 24 * 3600 * 1000).unref?.();
  }, msHastaHoraLocal(HORA_BACKUP));
  t.unref?.();
  log(`Backup diario programado a las ${String(HORA_BACKUP).padStart(2, '0')}:00 (${config.zona}).`);
  return { cancelar: () => clearTimeout(t) };
}
