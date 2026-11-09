// Pedidos y pagos de Perfumería Fina.
// Persistencia simple en bot/data/pedidos.json (sin dependencias externas).
//
// Regla de oro del negocio:
//  - El BOT nunca confirma un pago ni cierra una venta con billetera digital
//    (Yape, Plin, transferencia, etc.). Solo registra el comprobante y avisa.
//  - El dueño verifica el comprobante en el panel y recién ahí pasa a
//    "por_entregar" y luego a "entregado".
//  - En efectivo la venta puede quedar cerrada como "por_entregar"
//    (falta entregar / se cobra al entregar).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'pedidos.json');
const MAX_PEDIDOS = 1200;

export const ESTADOS = ['borrador', 'esperando_pago', 'comprobante_recibido', 'por_entregar', 'entregado', 'cancelado'];
export const METODOS = ['yape', 'plin', 'transferencia', 'efectivo', 'otro'];

const limpiarTel = t => String(t || '').replace(/\D/g, '');
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const ahora = () => new Date().toISOString();

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    if (Array.isArray(j)) return j;
    return Array.isArray(j.pedidos) ? j.pedidos : [];
  } catch {
    return [];
  }
}

let pedidos = cargar();
let guardando = null;
function guardar() {
  if (guardando) clearTimeout(guardando);
  guardando = setTimeout(() => {
    guardando = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(archivo, JSON.stringify({ pedidos }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[pedidos] no se pudo guardar:', e.message);
    }
  }, 500);
}

function siguienteId() {
  const n = pedidos.reduce((max, p) => {
    const m = String(p.id || '').match(/(\d+)/);
    return Math.max(max, m ? Number(m[1]) : 0);
  }, 0) + 1;
  return 'P-' + String(n).padStart(4, '0');
}

function metodoValido(m) {
  const t = String(m || '').toLowerCase().trim();
  return METODOS.includes(t) ? t : '';
}

function estadoValido(e) {
  return ESTADOS.includes(String(e || '')) ? String(e) : 'borrador';
}

function normalizarItem(it = {}) {
  const ml = Number(it.ml) === 100 ? 100 : 50;
  const cantidad = Math.max(1, Math.round(num(it.cantidad, 1)));
  const precio = Math.max(0, num(it.precio, 0));
  return {
    productoId: String(it.productoId || '').trim(),
    nombre: String(it.nombre || 'Perfume').slice(0, 120),
    ml,
    cantidad,
    precio
  };
}

const totalizar = items => items.reduce((n, it) => n + it.precio * it.cantidad, 0);

function recalcular(p) {
  p.items = (Array.isArray(p.items) ? p.items : []).map(normalizarItem);
  p.total = totalizar(p.items);
  p.adelanto = Math.max(0, num(p.adelanto, 0));
  p.saldo = Math.max(0, p.total - p.adelanto);
  return p;
}

/** Crea un pedido. Los ítems llevan precio unitario (no se recalcula del catálogo). */
export function crear(datos = {}) {
  const tel = limpiarTel(datos.telefono);
  if (!tel || !/^\d{8,15}$/.test(tel)) throw new Error('Teléfono inválido.');
  const items = (Array.isArray(datos.items) ? datos.items : []).map(normalizarItem).filter(it => it.precio > 0 || it.productoId);
  if (!items.length) throw new Error('El pedido necesita al menos un producto.');
  const metodo = metodoValido(datos.metodo);
  const estado = estadoValido(datos.estado || (metodo === 'efectivo' ? 'por_entregar' : metodo ? 'esperando_pago' : 'borrador'));
  const pedido = recalcular({
    id: siguienteId(),
    telefono: tel,
    nombre: String(datos.nombre || `+${tel}`).slice(0, 120),
    clienteId: datos.clienteId || null,
    items,
    total: 0,
    adelanto: datos.adelanto,
    saldo: 0,
    metodo,
    estado,
    // Entrega: 'delivery' (a domicilio) o 'estacion' (recojo en estación).
    entrega: ['delivery', 'estacion'].includes(String(datos.entrega || '')) ? String(datos.entrega) : '',
    estacion: String(datos.estacion || '').slice(0, 120),
    fechaEntrega: String(datos.fechaEntrega || '').slice(0, 10),
    horaEntrega: String(datos.horaEntrega || '').slice(0, 5),
    refExterna: String(datos.refExterna || '').slice(0, 80),
    comprobantes: [],
    pagoEnviadoEn: null,
    notas: String(datos.notas || '').slice(0, 800),
    creado: ahora(),
    actualizado: ahora(),
    entregadoEn: null,
    canceladoEn: null
  });
  pedidos.push(pedido);
  if (pedidos.length > MAX_PEDIDOS) pedidos = pedidos.slice(-MAX_PEDIDOS);
  guardar();
  return pedido;
}

export function listar({ estado = '', telefono = '', limite = 200 } = {}) {
  const tel = limpiarTel(telefono);
  return pedidos
    .filter(p => (!estado || p.estado === estado) && (!tel || p.telefono === tel))
    .sort((a, b) => String(b.actualizado).localeCompare(String(a.actualizado)))
    .slice(0, Math.max(1, Math.min(MAX_PEDIDOS, Number(limite) || 200)))
    .map(p => ({ ...p }));
}

export function obtener(id) {
  const p = pedidos.find(x => String(x.id) === String(id));
  return p ? { ...p } : null;
}

/** Pedido abierto (aún no entregado ni cancelado) del teléfono. */
export function pedidoAbierto(telefono) {
  const tel = limpiarTel(telefono);
  const abierto = [...pedidos].reverse().find(p =>
    p.telefono === tel && ['borrador', 'esperando_pago', 'comprobante_recibido', 'por_entregar'].includes(p.estado)
  );
  return abierto ? { ...abierto } : null;
}

/** Último pedido del teléfono, sin importar su estado. */
export function ultimoPedido(telefono) {
  const tel = limpiarTel(telefono);
  const p = [...pedidos].reverse().find(x => x.telefono === tel);
  return p ? { ...p } : null;
}

export function actualizar(id, cambios = {}) {
  const p = pedidos.find(x => String(x.id) === String(id));
  if (!p) throw new Error('Pedido no encontrado.');
  if (cambios.nombre !== undefined) p.nombre = String(cambios.nombre || p.nombre).slice(0, 120);
  if (cambios.metodo !== undefined) p.metodo = metodoValido(cambios.metodo);
  if (cambios.adelanto !== undefined) p.adelanto = cambios.adelanto;
  if (cambios.notas !== undefined) p.notas = String(cambios.notas || '').slice(0, 800);
  if (cambios.items !== undefined) p.items = cambios.items;
  if (cambios.entrega !== undefined && ['delivery', 'estacion', ''].includes(String(cambios.entrega))) p.entrega = String(cambios.entrega);
  if (cambios.estacion !== undefined) p.estacion = String(cambios.estacion || '').slice(0, 120);
  if (cambios.fechaEntrega !== undefined) p.fechaEntrega = String(cambios.fechaEntrega || '').slice(0, 10);
  if (cambios.horaEntrega !== undefined) p.horaEntrega = String(cambios.horaEntrega || '').slice(0, 5);
  if (cambios.refExterna !== undefined) p.refExterna = String(cambios.refExterna || '').slice(0, 80);
  if (cambios.estado !== undefined) {
    const nuevo = estadoValido(cambios.estado);
    p.estado = nuevo;
    if (nuevo === 'entregado' && !p.entregadoEn) p.entregadoEn = ahora();
    if (nuevo === 'cancelado' && !p.canceladoEn) p.canceladoEn = ahora();
  }
  recalcular(p);
  p.actualizado = ahora();
  guardar();
  return { ...p };
}

/** Agrega o reemplaza un ítem del mismo producto y tamaño (no duplica). */
export function ponerItem(id, item = {}) {
  const p = pedidos.find(x => String(x.id) === String(id));
  if (!p) throw new Error('Pedido no encontrado.');
  const nuevo = normalizarItem(item);
  const i = p.items.findIndex(x => x.productoId === nuevo.productoId && Number(x.ml) === Number(nuevo.ml));
  if (i >= 0) p.items[i] = nuevo;
  else p.items.push(nuevo);
  recalcular(p);
  p.actualizado = ahora();
  guardar();
  return { ...p };
}

export function agregarComprobante(id, { archivo = '', mimetype = '', nota = '' } = {}) {
  const p = pedidos.find(x => String(x.id) === String(id));
  if (!p) throw new Error('Pedido no encontrado.');
  p.comprobantes = Array.isArray(p.comprobantes) ? p.comprobantes : [];
  p.comprobantes.push({
    archivo: String(archivo || ''),
    mimetype: String(mimetype || ''),
    nota: String(nota || '').slice(0, 300),
    en: ahora()
  });
  // El bot solo deja constancia; el dueño es quien verifica y cierra.
  // Si el pedido ya está por entregar o entregado, no se retrocede el estado.
  if (!['comprobante_recibido', 'por_entregar', 'entregado', 'cancelado'].includes(p.estado)) {
    p.estado = 'comprobante_recibido';
  }
  p.actualizado = ahora();
  guardar();
  return { ...p };
}

export function marcarPagoEnviado(id) {
  const p = pedidos.find(x => String(x.id) === String(id));
  if (!p) return null;
  p.pagoEnviadoEn = ahora();
  p.actualizado = ahora();
  guardar();
  return { ...p };
}

export function resumen() {
  const porEstado = {};
  for (const e of ESTADOS) porEstado[e] = 0;
  for (const p of pedidos) porEstado[p.estado] = (porEstado[p.estado] || 0) + 1;
  const abiertos = pedidos.filter(p => ['esperando_pago', 'comprobante_recibido', 'por_entregar'].includes(p.estado)).length;
  return {
    total: pedidos.length,
    abiertos,
    porEstado,
    ventasEntregadas: pedidos.filter(p => p.estado === 'entregado').reduce((n, p) => n + num(p.total, 0), 0)
  };
}

/**
 * Etiquetas que el panel muestra en la lista de chats (Bandeja).
 * Devuelve [{ texto, tipo }] según el pedido abierto del teléfono.
 */
export function etiquetasChat(telefono) {
  const abierto = pedidoAbierto(telefono);
  if (!abierto) return [];
  const e = abierto.estado;
  if (e === 'borrador') return [{ texto: 'Solo consulta', tipo: 'mute' }];
  if (e === 'esperando_pago') return [{ texto: 'Falta pagar', tipo: 'warn' }];
  if (e === 'comprobante_recibido') return [{ texto: 'Verificar pago', tipo: 'warn' }];
  if (e === 'por_entregar') {
    return [{ texto: abierto.metodo === 'efectivo' ? 'Paga al entregar' : 'Falta entregar', tipo: 'ok' }];
  }
  return [];
}

/** Métricas para la pestaña Analíticas (pedidos y productos). */
export function estadisticas() {
  const activos = pedidos.filter(p => p.estado !== 'cancelado');
  const entregados = pedidos.filter(p => p.estado === 'entregado');
  const porProducto = new Map();
  for (const p of activos) {
    for (const it of p.items || []) {
      const clave = String(it.nombre || '').toLowerCase();
      if (!clave) continue;
      const fila = porProducto.get(clave) || {
        nombre: it.nombre,
        cantidad: 0,
        pedidos: 0,
        total: 0
      };
      fila.cantidad += num(it.cantidad, 0);
      fila.total += num(it.precio, 0) * num(it.cantidad, 0);
      fila.pedidos += 1;
      porProducto.set(clave, fila);
    }
  }
  const masPedidos = [...porProducto.values()].sort((a, b) => b.cantidad - a.cantidad || b.total - a.total).slice(0, 12);

  const porMetodo = {};
  for (const m of METODOS) porMetodo[m] = 0;
  for (const p of activos) if (p.metodo) porMetodo[p.metodo] = (porMetodo[p.metodo] || 0) + 1;

  const porEstado = {};
  for (const e of ESTADOS) porEstado[e] = 0;
  for (const p of pedidos) porEstado[p.estado] = (porEstado[p.estado] || 0) + 1;

  const ventas = entregados.reduce((n, p) => n + num(p.total, 0), 0);
  return {
    totalPedidos: pedidos.length,
    pedidosActivos: activos.length,
    ventas,
    ticketPromedio: entregados.length ? Math.round((ventas / entregados.length) * 100) / 100 : 0,
    entregados: entregados.length,
    porEstado,
    porMetodo,
    masPedidos
  };
}

export default { crear, listar, obtener, actualizar, ponerItem, agregarComprobante, marcarPagoEnviado, pedidoAbierto, ultimoPedido, resumen, etiquetasChat, estadisticas, ESTADOS, METODOS };