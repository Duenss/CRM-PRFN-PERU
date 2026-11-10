// Lista local de bajas (para números que escribieron BAJA y aún no son clientes).
// Se usa al armar anuncios masivos: nunca se les vuelve a escribir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'bajas.json');

let cache = null;

function cargar() {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    cache = new Set((Array.isArray(j) ? j : []).map(t => String(t).replace(/\D/g, '')).filter(Boolean));
  } catch {
    cache = new Set();
  }
  return cache;
}

function guardar() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(archivo, JSON.stringify([...cargar()], null, 2), 'utf8');
  } catch (e) {
    console.warn('[bajas] no se pudo guardar:', e.message);
  }
}

const limpiar = t => String(t || '').replace(/\D/g, '');

export function esBaja(telefono) {
  const tel = limpiar(telefono);
  return !!tel && cargar().has(tel);
}

export function marcarBajaLocal(telefono) {
  const tel = limpiar(telefono);
  if (!tel) return false;
  cargar().add(tel);
  guardar();
  return true;
}

export function quitarBaja(telefono) {
  const tel = limpiar(telefono);
  const quitado = cargar().delete(tel);
  if (quitado) guardar();
  return quitado;
}

export function listaBajas() {
  return [...cargar()];
}
