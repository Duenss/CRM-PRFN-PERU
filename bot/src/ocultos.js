// Chats que el dueño quitó de la Bandeja ("no molestar" en la vista).
// Viven en bot/data/ocultos.json y la sincronización los salta, para que al
// volver a sincronizar no reaparezcan. Si el contacto vuelve a escribir, el
// chat se registra de nuevo (una conversación nueva sí debe verse).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'ocultos.json');
const MAX = 800;

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    const lista = Array.isArray(j) ? j : Array.isArray(j.telefonos) ? j.telefonos : [];
    return new Set(lista.map(t => String(t || '').replace(/\D/g, '')).filter(t => /^\d{8,15}$/.test(t)));
  } catch {
    return new Set();
  }
}

let ocultos = cargar();

function guardar() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(archivo, JSON.stringify({ telefonos: [...ocultos].slice(-MAX) }, null, 2), 'utf8');
  } catch { /* si falla el disco no rompemos la Bandeja */ }
}

/** ¿Este teléfono está oculto de la Bandeja? */
export function oculto(tel) {
  return ocultos.has(String(tel || '').replace(/\D/g, ''));
}

/** Oculta un chat de la Bandeja para que no lo re-importe la sincronización. */
export function ocultar(tel) {
  const t = String(tel || '').replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(t) || ocultos.has(t)) return false;
  ocultos.add(t);
  guardar();
  return true;
}

/** Vuelve a mostrar todos (lo usa "Limpiar Bandeja"). */
export function limpiar() {
  ocultos = new Set();
  guardar();
}

export function listar() {
  return [...ocultos];
}
