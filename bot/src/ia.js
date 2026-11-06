import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'ia.json');

const base = () => ({
  activa: true,
  autoRespuesta: config.autoRespuesta,
  maxPorConversacion: 3,
  prompt: '',
  pausados: {},
  actualizado: new Date().toISOString()
});

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return { ...base(), ...j, pausados: j.pausados && typeof j.pausados === 'object' ? j.pausados : {} };
  } catch {
    return base();
  }
}

let estado = cargar();

function guardar() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(archivo, JSON.stringify(estado, null, 2), 'utf8');
  } catch (e) {
    console.warn('[ia] no se pudo guardar el estado:', e.message);
  }
}

const limpiarTel = t => String(t || '').replace(/\D/g, '');

export function estadoIA() {
  return {
    activa: !!estado.activa,
    autoRespuesta: !!estado.autoRespuesta,
    maxPorConversacion: Number(estado.maxPorConversacion) || 3,
    prompt: String(estado.prompt || ''),
    pausados: Object.entries(estado.pausados).map(([telefono, v]) => ({
      telefono,
      nombre: v?.nombre || '',
      motivo: v?.motivo || '',
      desde: v?.desde || null
    })),
    actualizado: estado.actualizado
  };
}

export function actualizarIA(cambios = {}) {
  if (typeof cambios.activa === 'boolean') estado.activa = cambios.activa;
  if (typeof cambios.autoRespuesta === 'boolean') estado.autoRespuesta = cambios.autoRespuesta;
  if (cambios.maxPorConversacion !== undefined) {
    const n = Number(cambios.maxPorConversacion);
    if (Number.isFinite(n)) estado.maxPorConversacion = Math.min(99, Math.max(1, Math.round(n)));
  }
  if (typeof cambios.prompt === 'string') estado.prompt = cambios.prompt.slice(0, 2000);
  estado.actualizado = new Date().toISOString();
  guardar();
  return estadoIA();
}

export function pausarIA(telefono, pausado, motivo = '', nombre = '') {
  const tel = limpiarTel(telefono);
  if (!tel) throw new Error('Teléfono inválido');
  if (pausado) {
    estado.pausados[tel] = {
      desde: estado.pausados[tel]?.desde || new Date().toISOString(),
      motivo: String(motivo || '').slice(0, 200),
      nombre: String(nombre || estado.pausados[tel]?.nombre || '').slice(0, 120)
    };
  } else {
    delete estado.pausados[tel];
  }
  estado.actualizado = new Date().toISOString();
  guardar();
  return estadoIA();
}

export function estaPausado(telefono) {
  return !!estado.pausados[limpiarTel(telefono)];
}

export function puedeResponder(telefono) {
  return !!estado.activa && !!estado.autoRespuesta && !estaPausado(telefono);
}

export function promptIA() {
  return String(estado.prompt || '');
}

export function resumenIA() {
  return {
    activa: !!estado.activa,
    autoRespuesta: !!estado.autoRespuesta,
    maxPorConversacion: Number(estado.maxPorConversacion) || 3,
    pausadas: Object.keys(estado.pausados).length
  };
}
