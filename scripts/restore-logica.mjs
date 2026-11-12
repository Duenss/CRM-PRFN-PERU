// Lógica pura del restore de respaldos (sin red ni disco) para poder probarla.
//
// Regla: los `data/*.json` y `comprobantes/` se restauran de la carpeta elegida,
// pero `archivos/` (PDF, video, foto subidos desde Ajustes) se reconstruye con
// la VERSIÓN MÁS RECIENTE de cada archivo entre TODAS las carpetas del bucket:
// una subida nueva desde Ajustes puede vivir solo en la carpeta más reciente,
// aunque se restaure un día anterior.

/**
 * Elige, para cada archivo de `archivos/`, la carpeta más reciente que lo
 * contiene.
 * @param {Array<{carpeta: string, archivos: string[]}>} entradas
 *   Carpetas ordenadas de la MÁS RECIENTE a la MÁS VIEJA; `archivos` con los
 *   nombres de archivo (sin subcarpetas) de `<carpeta>/archivos/`.
 * @returns {Array<{archivo: string, carpeta: string}>} ordenado por archivo.
 */
export function elegirArchivosMasRecientes(entradas = []) {
  const mapa = new Map();
  for (const e of Array.isArray(entradas) ? entradas : []) {
    const carpeta = String(e?.carpeta || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(carpeta)) continue;
    for (const nombre of Array.isArray(e?.archivos) ? e.archivos : []) {
      const archivo = String(nombre || '').trim();
      if (!archivo || archivo.includes('/')) continue;
      if (!mapa.has(archivo)) mapa.set(archivo, carpeta); // la primera = la más reciente
    }
  }
  return [...mapa.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([archivo, carpeta]) => ({ archivo, carpeta }));
}

/**
 * Arma la lista de descargas del restore:
 *  - de la carpeta elegida: todos los objetos menos `archivos/` (data/, comprobantes/);
 *  - de `archivos/`: cada nombre desde la carpeta más reciente que lo tenga.
 * `origen` es la ruta dentro del bucket; `destino`, la ruta relativa en bot/data.
 */
export function planificarDescargas({ desde, objetosDesde = [], archivosRecientes = [] } = {}) {
  const plan = [];
  for (const nombre of Array.isArray(objetosDesde) ? objetosDesde : []) {
    const n = String(nombre || '');
    if (!n || n.endsWith('/') || n.startsWith('archivos/') || n === 'backup-ultimo.json') continue;
    plan.push({ origen: `${desde}/${n}`, destino: n });
  }
  for (const { archivo, carpeta } of Array.isArray(archivosRecientes) ? archivosRecientes : []) {
    if (!archivo || !carpeta) continue;
    plan.push({ origen: `${carpeta}/archivos/${archivo}`, destino: `archivos/${archivo}` });
  }
  return plan;
}
