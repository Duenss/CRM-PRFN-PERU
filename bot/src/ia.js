import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { escribirAtomico } from './almacen.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'ia.json');

const base = () => ({
  activa: true,
  autoRespuesta: config.autoRespuesta,
  // 0 = sin límite de respuestas automáticas por conversación.
  maxPorConversacion: 0,
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
  if (!escribirAtomico(archivo, JSON.stringify(estado, null, 2))) {
    console.warn('[ia] no se pudo guardar el estado (escritura atómica falló).');
  }
}

/* ---------------- poda de pausados antiguos (F-14) ---------------- */
// `pausados` solo crecía: un cliente que derivó una vez quedaba listado para
// siempre. Se borran las pausas con más de 90 días; un chat que vuelve a
// derivar se pausa de nuevo. Sin fecha válida no se puede medir la antigüedad:
// se conserva (no se "despausa" a ciegas datos viejos).
export const DIAS_PAUSADOS = 90;
const MS_DIA = 24 * 60 * 60 * 1000;

/**
 * Versión pura de la poda: recibe el objeto de pausados y devuelve una copia
 * sin las entradas vencidas + el número de borradas. No toca el estado global.
 */
export function podarPausadosDe(pausados = {}, ahoraMs = Date.now(), dias = DIAS_PAUSADOS) {
  const corte = ahoraMs - Math.max(1, Number(dias) || DIAS_PAUSADOS) * MS_DIA;
  const salida = {};
  let borrados = 0;
  for (const [telefono, valor] of Object.entries(pausados || {})) {
    const desde = Date.parse(String(valor?.desde || ''));
    if (Number.isFinite(desde) && desde < corte) {
      borrados++;
      continue;
    }
    salida[telefono] = valor;
  }
  return { pausados: salida, borrados };
}

/** Poda y persiste `pausados` (si borró algo). Devuelve { borrados }. */
export function podarPausados(ahoraMs = Date.now(), dias = DIAS_PAUSADOS) {
  const resultado = podarPausadosDe(estado.pausados, ahoraMs, dias);
  if (!resultado.borrados) return { borrados: 0 };
  estado.pausados = resultado.pausados;
  estado.actualizado = new Date().toISOString();
  guardar();
  return { borrados: resultado.borrados };
}

// Poda al cargar: si el bot estuvo apagado meses, el archivo ya queda limpio.
podarPausados();

const limpiarTel = t => String(t || '').replace(/\D/g, '');

export function estadoIA() {
  return {
    activa: !!estado.activa,
    autoRespuesta: !!estado.autoRespuesta,
    maxPorConversacion: Number.isFinite(Number(estado.maxPorConversacion)) ? Number(estado.maxPorConversacion) : 0,
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
    if (Number.isFinite(n)) estado.maxPorConversacion = Math.min(99, Math.max(0, Math.round(n)));
  }
  if (typeof cambios.prompt === 'string') estado.prompt = cambios.prompt.slice(0, 2000);
  estado.actualizado = new Date().toISOString();
  podarPausados(); // mantenimiento oportunista: no deja crecer `pausados`
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
    maxPorConversacion: Number.isFinite(Number(estado.maxPorConversacion)) ? Number(estado.maxPorConversacion) : 0,
    pausadas: Object.keys(estado.pausados).length
  };
}
