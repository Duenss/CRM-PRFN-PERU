// Escritura atómica compartida para los archivos del bot (JSON de bot/data y
// binarios como los comprobantes de pago).
//
// Se escribe un `.tmp` y se renombra encima del archivo real. `rename` es
// atómico en el mismo volumen (NTFS/ext4), así que un corte de luz, un disco
// lleno o un `kill -9` deja el archivo anterior intacto en vez de uno truncado
// a la mitad. Devuelve false (sin lanzar) si no se pudo escribir, limpiando el
// temporal; el llamador decide si avisar.
import fs from 'node:fs';
import path from 'node:path';

export function escribirAtomico(ruta, contenido) {
  const destino = String(ruta);
  const tmp = destino + '.tmp';
  try {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(tmp, contenido);
    fs.renameSync(tmp, destino);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* no había temporal o no se pudo borrar */ }
    return false;
  }
}
