// Fotos locales de producto (empaquetadas desde la web del dueño).
//
// IMPORTANTE: la foto correcta vive en bot/media/products/<id>.jpg. No se usa
// `imagen_ruta` de Supabase para decidir la foto (esa columna puede estar
// desactualizada y apuntar a otra imagen o a una URL caída). Primero se busca
// aquí, por id de producto; si no existe, se conserva el fallback antiguo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTOS_MEDIA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'media',
  'products'
);

const EXTENSIONES = ['jpg', 'jpeg', 'png', 'webp'];

/**
 * Ruta local de la foto de un producto, o '' si no está empaquetada.
 * El id se sanea para que nunca pueda escapar del directorio.
 */
export function imagenLocalProducto(id, { dir = PRODUCTOS_MEDIA_DIR } = {}) {
  const clave = String(id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(clave)) return '';
  for (const ext of EXTENSIONES) {
    const ruta = path.join(dir, `${clave}.${ext}`);
    try {
      if (fs.statSync(ruta).isFile()) return ruta;
    } catch { /* prueba la siguiente extensión */ }
  }
  return '';
}

export default { PRODUCTOS_MEDIA_DIR, imagenLocalProducto };
