// Anuncios: un mensaje único que el dueño redacta y envía a un grupo de
// clientes (todos, por etiquetas o seleccionados). Es independiente de las
// campañas: no usa plantillas ni programación, se envía cuando el dueño pulsa
// "Enviar ahora" y respeta consentimiento, baja, horario y límite diario.
//
// Persistencia simple en bot/data/anuncios.json (sin dependencias externas).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'anuncios.json');
const MAX_ANUNCIOS = 300;

export const ESTADOS = ['borrador', 'enviando', 'enviado', 'cancelado'];
export const FILTROS = ['todos', 'etiquetas', 'telefonos'];

const ahora = () => new Date().toISOString();
const limpiarTel = t => String(t || '').replace(/\D/g, '');

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return Array.isArray(j) ? j : Array.isArray(j.anuncios) ? j.anuncios : [];
  } catch {
    return [];
  }
}

let anuncios = cargar();
let guardando = null;

function guardar() {
  if (guardando) clearTimeout(guardando);
  guardando = setTimeout(() => {
    guardando = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(archivo, JSON.stringify({ anuncios }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[anuncios] no se pudo guardar:', e.message);
    }
  }, 300);
}

/** Fuerza el guardado pendiente (para pruebas y apagado limpio). */
export function flush() {
  if (guardando) {
    clearTimeout(guardando);
    guardando = null;
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(archivo, JSON.stringify({ anuncios }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[anuncios] no se pudo guardar:', e.message);
  }
}

function siguienteId() {
  const n = anuncios.reduce((max, a) => {
    const m = String(a.id || '').match(/(\d+)/);
    return Math.max(max, m ? Number(m[1]) : 0);
  }, 0) + 1;
  return 'A-' + String(n).padStart(3, '0');
}

export function normalizarFiltro(filtro = {}) {
  const tipo = FILTROS.includes(String(filtro.tipo)) ? String(filtro.tipo) : 'todos';
  const etiquetas = (Array.isArray(filtro.etiquetas) ? filtro.etiquetas : String(filtro.etiquetas || '').split(','))
    .map(t => String(t || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
  const telefonos = (Array.isArray(filtro.telefonos) ? filtro.telefonos : String(filtro.telefonos || '').split(/[\s,;]+/))
    .map(limpiarTel)
    .filter(t => /^\d{8,15}$/.test(t))
    .slice(0, 2000);
  return { tipo, etiquetas, telefonos };
}

export function normalizarAdjuntos(lista) {
  const permitidos = ['catalogo', 'video'];
  return (Array.isArray(lista) ? lista : String(lista || '').split(','))
    .map(a => String(a || '').trim().toLowerCase())
    .filter(a => permitidos.includes(a))
    .slice(0, 2);
}

export function crear(datos = {}) {
  const titulo = String(datos.titulo || '').trim().slice(0, 80);
  const texto = String(datos.texto || '').trim().slice(0, 1200);
  if (!titulo) throw new Error('Ponle un título al anuncio.');
  if (!texto) throw new Error('El anuncio necesita un mensaje.');
  const anuncio = {
    id: siguienteId(),
    titulo,
    texto,
    filtro: normalizarFiltro(datos.filtro),
    incluirSinConsentimiento: datos.incluirSinConsentimiento === true,
    adjuntos: normalizarAdjuntos(datos.adjuntos),
    estado: 'borrador',
    stats: { total: 0, enviados: 0, omitidos: 0, errores: 0 },
    creado: ahora(),
    actualizado: ahora(),
    enviadoEn: null
  };
  anuncios.push(anuncio);
  if (anuncios.length > MAX_ANUNCIOS) anuncios = anuncios.slice(-MAX_ANUNCIOS);
  guardar();
  return { ...anuncio };
}

export function listar({ estado = '', limite = 100 } = {}) {
  return anuncios
    .filter(a => !estado || a.estado === estado)
    .sort((a, b) => String(b.actualizado).localeCompare(String(a.actualizado)))
    .slice(0, Math.max(1, Math.min(MAX_ANUNCIOS, Number(limite) || 100)))
    .map(a => ({ ...a }));
}

export function obtener(id) {
  const a = anuncios.find(x => String(x.id) === String(id));
  return a ? { ...a } : null;
}

export function actualizar(id, cambios = {}) {
  const a = anuncios.find(x => String(x.id) === String(id));
  if (!a) throw new Error('Anuncio no encontrado.');
  if (a.estado === 'enviando') throw new Error('El anuncio se está enviando; espera a que termine.');
  if (cambios.titulo !== undefined) {
    const t = String(cambios.titulo || '').trim().slice(0, 80);
    if (!t) throw new Error('Ponle un título al anuncio.');
    a.titulo = t;
  }
  if (cambios.texto !== undefined) {
    const t = String(cambios.texto || '').trim().slice(0, 1200);
    if (!t) throw new Error('El anuncio necesita un mensaje.');
    a.texto = t;
  }
  if (cambios.filtro !== undefined) a.filtro = normalizarFiltro(cambios.filtro);
  if (cambios.adjuntos !== undefined) a.adjuntos = normalizarAdjuntos(cambios.adjuntos);
  if (typeof cambios.incluirSinConsentimiento === 'boolean') a.incluirSinConsentimiento = cambios.incluirSinConsentimiento;
  if (cambios.estado !== undefined && ESTADOS.includes(String(cambios.estado))) a.estado = String(cambios.estado);
  a.actualizado = ahora();
  guardar();
  return { ...a };
}

/** Marca progreso de envío (lo llama el servidor mientras recorre clientes). */
export function progreso(id, { total, enviados, omitidos, errores, estado, enviadosA } = {}) {
  const a = anuncios.find(x => String(x.id) === String(id));
  if (!a) return null;
  a.stats = {
    total: Math.max(0, Number(total ?? a.stats.total) || 0),
    enviados: Math.max(0, Number(enviados ?? a.stats.enviados) || 0),
    omitidos: Math.max(0, Number(omitidos ?? a.stats.omitidos) || 0),
    errores: Math.max(0, Number(errores ?? a.stats.errores) || 0)
  };
  // Memoria de a quién ya se le envió, para poder reanudar sin duplicar.
  if (Array.isArray(enviadosA)) a.enviadosA = enviadosA.slice(-5000);
  if (estado && ESTADOS.includes(String(estado))) a.estado = String(estado);
  if (a.estado === 'enviado' && !a.enviadoEn) a.enviadoEn = ahora();
  a.actualizado = ahora();
  guardar();
  return { ...a };
}

export function eliminar(id) {
  const i = anuncios.findIndex(x => String(x.id) === String(id));
  if (i < 0) return false;
  if (anuncios[i].estado === 'enviando') throw new Error('No puedes borrar un anuncio mientras se está enviando.');
  anuncios.splice(i, 1);
  guardar();
  return true;
}

export function resumen() {
  const porEstado = {};
  for (const e of ESTADOS) porEstado[e] = 0;
  for (const a of anuncios) porEstado[a.estado] = (porEstado[a.estado] || 0) + 1;
  const enviados = anuncios.reduce((n, a) => n + (a.stats?.enviados || 0), 0);
  return { total: anuncios.length, porEstado, mensajesEnviados: enviados };
}

export default { crear, listar, obtener, actualizar, progreso, eliminar, resumen, normalizarFiltro, flush, ESTADOS, FILTROS };