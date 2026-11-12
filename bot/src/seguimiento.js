// Seguimiento post-venta POR CHAT.
// Cada conversación tiene su propio interruptor (como la IA, pero individual).
// Se programan dos avisos al marcar un pedido como entregado:
//   - ~3 días:  ¿cómo te fue con el perfume?
//   - ~180 días: recompra (ya se te está acabando)
// Si el chat tiene el seguimiento apagado, el aviso no se envía: queda pendiente
// hasta que el dueño lo active.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escribirAtomico } from './almacen.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'seguimiento.json');

const DIAS_1 = Math.max(1, Number(process.env.SEGUIMIENTO_DIAS_1) || 3);
const DIAS_2 = Math.max(30, Number(process.env.SEGUIMIENTO_DIAS_2) || 180);
const MAX_TAREAS = 3000;

const limpiarTel = t => String(t || '').replace(/\D/g, '');
const ahora = () => new Date().toISOString();

function base() {
  return { chats: {}, tareas: [] };
}

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return {
      chats: j && typeof j.chats === 'object' && j.chats ? j.chats : {},
      tareas: Array.isArray(j?.tareas) ? j.tareas : []
    };
  } catch {
    return base();
  }
}

let estado = cargar();

function guardar() {
  if (!escribirAtomico(archivo, JSON.stringify(estado, null, 2))) {
    console.warn('[seguimiento] no se pudo guardar (escritura atómica falló).');
  }
}

/* ---------------- poda de chats antiguos (F-14) ---------------- */
// `chats` solo crecía: cada chat con seguimiento activado se quedaba para
// siempre. Se borran los que llevan más de 180 días sin actividad ni tareas.
// La fecha de referencia es la más reciente entre `desde`/`actualizado` del chat
// y las fechas de sus tareas (creado/enviadoEn/programadoEn), porque `chats` no
// guarda "último uso" y las tareas sí.
export const DIAS_PODA_CHATS = Math.max(30, Number(process.env.SEGUIMIENTO_DIAS_PODA) || 180);
const MS_DIA = 24 * 60 * 60 * 1000;

/** Fecha (ms) más reciente conocida de un chat: su estado + sus tareas. */
function ultimaFechaChat(telefono, chat, tareas = []) {
  const fechas = [chat?.actualizado, chat?.desde];
  for (const t of tareas) {
    if (String(t?.telefono || '') !== String(telefono)) continue;
    fechas.push(t.enviadoEn, t.creado, t.programadoEn);
  }
  let max = 0;
  for (const f of fechas) {
    const ms = Date.parse(String(f || ''));
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max;
}

/**
 * Versión pura de la poda: devuelve { chats, borrados } sin tocar el estado.
 * Un chat sin ninguna fecha válida se considera viejo y se borra.
 */
export function podarChatsDe(chats = {}, tareas = [], ahoraMs = Date.now(), dias = DIAS_PODA_CHATS) {
  const corte = ahoraMs - Math.max(1, Number(dias) || DIAS_PODA_CHATS) * MS_DIA;
  const salida = {};
  let borrados = 0;
  for (const [telefono, chat] of Object.entries(chats || {})) {
    const ultima = ultimaFechaChat(telefono, chat, tareas);
    if (!ultima || ultima < corte) {
      borrados++;
      continue;
    }
    salida[telefono] = chat;
  }
  return { chats: salida, borrados };
}

/** Poda y persiste `chats` (si borró algo). Devuelve { borrados }. */
export function podarChats(ahoraMs = Date.now(), dias = DIAS_PODA_CHATS) {
  const resultado = podarChatsDe(estado.chats, estado.tareas, ahoraMs, dias);
  if (!resultado.borrados) return { borrados: 0 };
  estado.chats = resultado.chats;
  guardar();
  return { borrados: resultado.borrados };
}

function siguienteId() {
  const n = estado.tareas.reduce((max, t) => {
    const m = String(t.id || '').match(/(\d+)/);
    return Math.max(max, m ? Number(m[1]) : 0);
  }, 0) + 1;
  return 'S-' + String(n).padStart(5, '0');
}

export function estaActivo(telefono) {
  const tel = limpiarTel(telefono);
  return !!estado.chats[tel]?.activo;
}

export function activar(telefono, activo = true, nombre = '') {
  const tel = limpiarTel(telefono);
  if (!tel) throw new Error('Teléfono inválido.');
  if (activo) {
    estado.chats[tel] = {
      activo: true,
      nombre: String(nombre || estado.chats[tel]?.nombre || '').slice(0, 120),
      desde: estado.chats[tel]?.desde || ahora()
    };
  } else if (estado.chats[tel]) {
    estado.chats[tel].activo = false;
    estado.chats[tel].actualizado = ahora();
  }
  guardar();
  return listar(tel);
}

export function listar(telefono) {
  const tel = limpiarTel(telefono);
  const tareas = estado.tareas
    .filter(t => t.telefono === tel)
    .sort((a, b) => String(a.programadoEn).localeCompare(String(b.programadoEn)));
  return { activo: estaActivo(tel), tareas };
}

export function resumen() {
  const activos = Object.values(estado.chats).filter(c => c.activo).length;
  const pendientes = estado.tareas.filter(t => t.estado === 'pendiente').length;
  const enviadas = estado.tareas.filter(t => t.estado === 'enviado').length;
  return { chatsActivos: activos, pendientes, enviadas };
}

/**
 * Programa los avisos de un pedido entregado (idempotente por pedido+tipo).
 * @returns {number} tareas nuevas
 */
export function programarPedido(pedido = {}) {
  const tel = limpiarTel(pedido.telefono);
  if (!tel || !pedido.id) return 0;
  const baseFecha = pedido.entregadoEn ? new Date(pedido.entregadoEn) : new Date();
  const producto = Array.isArray(pedido.items)
    ? pedido.items.map(i => i.nombre).filter(Boolean).slice(0, 3).join(', ')
    : '';
  const tipos = [
    { tipo: '3d', dias: DIAS_1 },
    { tipo: '180d', dias: DIAS_2 }
  ];
  let nuevas = 0;
  for (const { tipo, dias } of tipos) {
    const ya = estado.tareas.some(t => String(t.pedidoId) === String(pedido.id) && t.tipo === tipo);
    if (ya) continue;
    const cuando = new Date(baseFecha);
    cuando.setDate(cuando.getDate() + dias);
    estado.tareas.push({
      id: siguienteId(),
      telefono: tel,
      nombre: String(pedido.nombre || '').slice(0, 120),
      pedidoId: String(pedido.id),
      tipo,
      dias,
      producto,
      programadoEn: cuando.toISOString(),
      estado: 'pendiente',
      creado: ahora(),
      enviadoEn: null
    });
    nuevas++;
  }
  if (nuevas) {
    if (estado.tareas.length > MAX_TAREAS) estado.tareas = estado.tareas.slice(-MAX_TAREAS);
    guardar();
  }
  return nuevas;
}

/** Tareas vencidas y pendientes (aún sin enviar). */
export function pendientes(ahoraMs = Date.now()) {
  return estado.tareas
    .filter(t => t.estado === 'pendiente' && Date.parse(t.programadoEn) <= ahoraMs)
    .sort((a, b) => String(a.programadoEn).localeCompare(String(b.programadoEn)))
    .slice(0, 10);
}

export function marcarEnviada(id) {
  const t = estado.tareas.find(x => String(x.id) === String(id));
  if (!t) return null;
  t.estado = 'enviado';
  t.enviadoEn = ahora();
  guardar();
  return { ...t };
}

export function omitir(id, motivo = '') {
  const t = estado.tareas.find(x => String(x.id) === String(id));
  if (!t) return null;
  t.estado = 'omitido';
  t.motivo = String(motivo || '').slice(0, 120);
  t.enviadoEn = ahora();
  guardar();
  return { ...t };
}

export function cancelarPedido(pedidoId) {
  const tel = String(pedidoId || '');
  let n = 0;
  for (const t of estado.tareas) {
    if (String(t.pedidoId) === tel && t.estado === 'pendiente') {
      t.estado = 'omitido';
      t.motivo = 'Pedido cancelado';
      n++;
    }
  }
  if (n) guardar();
  return n;
}

export function plantilla(tipo, pedido = {}) {
  const nombre = String(pedido.nombre || '').trim().split(/\s+/)[0] || 'cliente';
  const producto = Array.isArray(pedido.items) && pedido.items.length
    ? pedido.items[0].nombre
    : 'tu perfume';
  if (tipo === '3d') {
    return `Hola ${nombre} 👋 ¿Cómo te fue con ${producto}? Espero que te esté encantando. Si tienes alguna duda de uso o quieres recomendaciones parecidas, escríbeme nomás.`;
  }
  return `Hola ${nombre} 👋 ¿Cómo va ${producto}? Si ya se te está acabando o quieres probar otra fragancia, tengo opciones parecidas y novedades. ¿Te paso el catálogo?`;
}

export default { estaActivo, activar, listar, resumen, programarPedido, pendientes, marcarEnviada, omitir, cancelarPedido, plantilla, podarChats };