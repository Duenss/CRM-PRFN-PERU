// Plantillas de pago (Yape, Plin, transferencia, etc.).
// El dueño sube la imagen oficial desde el panel; el bot solo reenvía esa
// plantilla. Nunca genera ni inventa datos de pago (evita estafas con capturas
// falsas o números cambiados por terceros).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'pagos.json');
const MAX_PLANTILLAS = 20;

const ahora = () => new Date().toISOString();
const limpiar = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return Array.isArray(j) ? j : Array.isArray(j.plantillas) ? j.plantillas : [];
  } catch {
    return [];
  }
}

let plantillas = cargar();

function guardar() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(archivo, JSON.stringify({ plantillas }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[pagos] no se pudo guardar:', e.message);
  }
}

function siguienteId() {
  const n = plantillas.reduce((max, p) => {
    const m = String(p.id || '').match(/(\d+)/);
    return Math.max(max, m ? Number(m[1]) : 0);
  }, 0) + 1;
  return 'PA-' + String(n).padStart(3, '0');
}

function validarImagen(imagen) {
  const s = String(imagen || '').trim();
  if (!s) return '';
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s)) {
    throw new Error('La plantilla debe ser una imagen PNG, JPG o WEBP.');
  }
  if (s.length > 6 * 1024 * 1024) throw new Error('La imagen es demasiado grande (máximo 6 MB).');
  return s;
}

export function listar() {
  return plantillas
    .slice()
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)))
    .map(p => ({ ...p }));
}

export function obtener(id) {
  const p = plantillas.find(x => String(x.id) === String(id));
  return p ? { ...p } : null;
}

export function crear(datos = {}) {
  const nombre = String(datos.nombre || '').trim().slice(0, 40);
  if (!nombre) throw new Error('Ponle un nombre a la plantilla (por ejemplo, Yape).');
  if (plantillas.length >= MAX_PLANTILLAS) throw new Error('Ya tienes el máximo de plantillas.');
  const plantilla = {
    id: siguienteId(),
    nombre,
    titular: String(datos.titular || '').slice(0, 80),
    numero: String(datos.numero || '').replace(/[^\d+]/g, '').slice(0, 20),
    nota: String(datos.nota || '').slice(0, 300),
    imagen: validarImagen(datos.imagen),
    activo: datos.activo !== false,
    creado: ahora(),
    actualizado: ahora()
  };
  plantillas.push(plantilla);
  guardar();
  return { ...plantilla };
}

export function actualizar(id, cambios = {}) {
  const p = plantillas.find(x => String(x.id) === String(id));
  if (!p) throw new Error('Plantilla no encontrada.');
  if (cambios.nombre !== undefined) p.nombre = String(cambios.nombre || p.nombre).slice(0, 40);
  if (cambios.titular !== undefined) p.titular = String(cambios.titular || '').slice(0, 80);
  if (cambios.numero !== undefined) p.numero = String(cambios.numero || '').replace(/[^\d+]/g, '').slice(0, 20);
  if (cambios.nota !== undefined) p.nota = String(cambios.nota || '').slice(0, 300);
  if (cambios.imagen !== undefined) p.imagen = validarImagen(cambios.imagen);
  if (typeof cambios.activo === 'boolean') p.activo = cambios.activo;
  p.actualizado = ahora();
  guardar();
  return { ...p };
}

export function eliminar(id) {
  const i = plantillas.findIndex(x => String(x.id) === String(id));
  if (i < 0) return false;
  plantillas.splice(i, 1);
  guardar();
  return true;
}

/** Busca la plantilla activa que corresponde al método elegido. */
export function paraMetodo(metodo) {
  const m = limpiar(metodo);
  if (!m) return null;
  const activas = plantillas.filter(p => p.activo !== false);
  return activas.find(p => limpiar(p.nombre) === m || limpiar(p.nombre).includes(m) || m.includes(limpiar(p.nombre))) || null;
}

/** Separa un dataURL en { mimetype, base64 } para enviarlo por WhatsApp. */
export function partesImagen(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) return null;
  return { mimetype: m[1], base64: m[2] };
}

export default { listar, obtener, crear, actualizar, eliminar, paraMetodo, partesImagen };