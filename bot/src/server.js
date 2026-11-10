import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validarConfig, esNumeroPeru, normalizar } from './config.js';
import { sb, getCliente, getClientes, getProductos, logMensaje, historial, marcarBaja, importarClientes } from './supabase.js';
import { iniciarWhatsApp, enviar, enviarImagen, enviarArchivo, estadoWa, cerrarSesion, reiniciarSesion, hayConexion, sesionDisponible, listarChatsWa, listarContactosWa, historialWa, resolverTelefonoWa, idMensaje, descargarMediaWa, conTimeout } from './whatsapp.js';
import { redactarRespuesta, transcribirAudio, redactarBorradores, redactarAnuncio, productoPorId, productoMencionado } from './ai.js';
import { Cola, dormir, esperaEntreEnvios } from './queue.js';
import { estadoIA, actualizarIA, pausarIA, estaPausado, promptIA, resumenIA } from './ia.js';
import { registrar, listar, obtener, marcarLeido, respuestasIA, porDia, resumen as resumenChats, registrarCabecera, importarMensajes, yaExisteWa, actualizarAck, mensajesEntrantes, flush as flushConversaciones } from './conversaciones.js';
import * as pedidos from './pedidos.js';
import * as anuncios from './anuncios.js';
// (Las plantillas de pago se eliminaron: las billeteras digitales las verifica el admin.)
import * as seguimiento from './seguimiento.js';
import { emitir, desde as eventosDesde, ultimoId as ultimoEventoId, suscribir, lineaSSE } from './eventos.js';
import { reclamarEnvioCon, marcarEnvioCon, cerrarCampanaSiCompleta, barrerEnviosColgados, verificarMigracionEnviosCon, esErrorDeMigracion, mensajeErrorMigracion } from './campanas.js';
import { esEfectivo, decidirEstadoPedidoIA, debeDerivarPago, textoAvisoPagoDigital, corregirEstadoPedidoIA } from './politicas.js';

const panelPath = fileURLToPath(new URL('./panel.html', import.meta.url));
const app = express();
app.use(express.json({ limit: '12mb' }));
// Evita que el navegador cachee respuestas de la API (el QR rota cada pocos segundos).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

/* ---------------- utilidades ---------------- */
const logs = [];
function log(mensaje) {
  const linea = `[${new Date().toLocaleString('es-PE', { timeZone: config.zona })}] ${mensaje}`;
  console.log(linea);
  logs.push(linea);
  if (logs.length > 250) logs.shift();
}

/**
 * Escrituras crÃ­ticas a Supabase: supabase-js v2 NO lanza, devuelve `{ error }`.
 * `must()` convierte ese error silencioso en excepciÃ³n para que el llamador lo
 * vea (y el flujo no siga como si hubiera guardado).
 */
function must(resultado, etiqueta) {
  if (resultado && resultado.error) {
    const e = resultado.error;
    throw new Error(`${etiqueta}: ${e.message || e}`);
  }
  return resultado;
}

/** Conexiones SSE abiertas (se cierran en el apagado ordenado). */
const sseClientes = new Set();

const pad = n => String(n).padStart(2, '0');
function partesLima(fecha = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.zona, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
  });
  const o = {};
  for (const p of fmt.formatToParts(fecha)) o[p.type] = p.value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, min: +o.minute, wd: dias[o.weekday] ?? 1 };
}
function dentroHorario() {
  const p = partesLima();
  if (config.lunesASabado && p.wd === 0) return false;
  return p.h >= config.horaInicio && p.h < config.horaFin;
}
function fechaLima(p) {
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
function proximaAperturaISO() {
  const p = partesLima();
  let base;
  if (p.h < config.horaInicio) {
    base = new Date(`${fechaLima(p)}T${pad(config.horaInicio)}:00:00-05:00`);
  } else {
    base = new Date(`${fechaLima(p)}T${pad(config.horaInicio)}:00:00-05:00`);
    base.setDate(base.getDate() + 1);
  }
  while (config.lunesASabado && base.getDay() === 0) base.setDate(base.getDate() + 1);
  return base.toISOString();
}

let dia = { fecha: fechaLima(partesLima()), n: 0 };
function contarEnvio() {
  const hoy = fechaLima(partesLima());
  if (dia.fecha !== hoy) dia = { fecha: hoy, n: 0 };
  dia.n++;
}
function limiteAlcanzado() {
  const hoy = fechaLima(partesLima());
  if (dia.fecha !== hoy) dia = { fecha: hoy, n: 0 };
  return dia.n >= config.maxPorDia;
}
const primerNombre = n => String(n || '').trim().split(/\s+/)[0] || 'cliente';
/** Saludo segÃºn la hora de Lima (no la del servidor). */
function saludoHora() {
  const h = partesLima().h;
  if (h >= 5 && h < 12) return 'Buenos dÃ­as';
  if (h >= 12 && h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}
/** 15:00 -> "3:00 p. m." para que el cliente nunca tenga que adivinar AM/PM. */
function hora12(hora) {
  const m = String(hora || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(hora || '');
  let h = Number(m[1]);
  const suf = h >= 12 ? 'p. m.' : 'a. m.';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${suf}`;
}
const puede = c => c && c.activo !== false && !!c.consentimiento && !c.baja;

/* ---------------- pedidos, pagos y seguimiento ---------------- */
const botDataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const comprobantesDir = path.join(botDataDir, 'comprobantes');
const raizProyecto = path.join(botDataDir, '..', '..');

/** Guarda la imagen de un comprobante y devuelve su nombre de archivo. */
function guardarComprobante(pedidoId, media = {}) {
  const mime = String(media.mimetype || 'image/jpeg').toLowerCase();
  const ext = mime.includes('png') ? 'png'
    : mime.includes('webp') ? 'webp'
    : mime.includes('pdf') ? 'pdf'
    : (mime.includes('jpeg') || mime.includes('jpg')) ? 'jpg'
    : 'bin';
  const nombre = `${String(pedidoId || 'pedido')}-${Date.now()}.${ext}`;
  fs.mkdirSync(comprobantesDir, { recursive: true });
  fs.writeFileSync(path.join(comprobantesDir, nombre), Buffer.from(String(media.data || ''), 'base64'));
  return nombre;
}

/** Ruta local o URL pÃºblica de la foto de un producto. */
function mediaProducto(p) {
  const ruta = String(p?.imagen_ruta || '').trim();
  if (!ruta) return null;
  if (/^https?:\/\//i.test(ruta)) return { url: ruta };
  const local = path.join(raizProyecto, ruta);
  if (fs.existsSync(local)) return { archivo: local };
  if (!config.panelUrl) return null;
  return { url: `${config.panelUrl}/${ruta.replace(/^\.?\//, '')}` };
}

function normalizarMetodo(m) {
  const t = String(m || '').toLowerCase();
  if (/yape/.test(t)) return 'yape';
  if (/plin/.test(t)) return 'plin';
  if (/transfer|banco|bcp|interbank|bbva/.test(t)) return 'transferencia';
  if (/efectivo|contra entrega|al entregar/.test(t)) return 'efectivo';
  return '';
}

const ESTADOS_PAGO = ['esperando_pago', 'comprobante_recibido', 'por_entregar'];

/** Texto con el resumen del pedido (panel y avisos). */
function resumenPedido(p) {
  const lineas = [];
  lineas.push(`ðŸ“¦ *Pedido ${p.id}*`);
  lineas.push(`ðŸ‘¤ Cliente: ${p.nombre || '+' + p.telefono}`);
  lineas.push(`ðŸ“± WhatsApp: +${p.telefono}`);
  lineas.push('');
  lineas.push('*PRODUCTOS*');
  for (const it of (p.items || [])) {
    lineas.push(`â€¢ ${it.cantidad} Ã— *${it.nombre}* â€” ${it.ml} ml â€” S/ ${(Number(it.precio) || 0) * (Number(it.cantidad) || 1)}`);
  }
  lineas.push('');
  lineas.push(`ðŸ’° Total: *S/ ${p.total}*`);
  if (Number(p.adelanto) > 0) lineas.push(`ðŸ’µ Adelanto: S/ ${p.adelanto} Â· Saldo: S/ ${p.saldo}`);
  lineas.push(`ðŸ’³ Pago: ${p.metodo || 'por definir'}`);
  lineas.push(`ðŸ“Œ Estado: ${p.estado}`);
  if (p.entrega) {
    lineas.push('');
    lineas.push('*ENTREGA*');
    lineas.push(`â€¢ ${p.entrega === 'estacion' ? 'Recojo en estaciÃ³n' : 'Delivery'}${p.estacion ? ': ' + p.estacion : ''}`);
    if (p.fechaEntrega) lineas.push(`â€¢ Fecha: ${p.fechaEntrega}${p.horaEntrega ? ' Â· ' + hora12(p.horaEntrega) : ''}`);
  }
  if (p.refExterna) lineas.push(`ðŸ”– Ref: ${p.refExterna}`);
  return lineas.join('\n');
}

/**
 * Crea o actualiza el pedido que la IA detectÃ³. Nunca confirma pagos:
 * solo deja el pedido listo para que el dueÃ±o lo revise.
 * Regla del negocio (bot/src/politicas.js): el efectivo puede cerrar la venta
 * como "por_entregar"; Yape/Plin/transferencia NUNCA se confirman.
 */
async function procesarPedidoIA({ tel, nombre, clienteId, pedidoIA }) {
  if (!pedidoIA || !pedidoIA.productoId) return null;
  const prod = await productoPorId(pedidoIA.productoId);
  if (!prod) return null;
  const ml = Number(pedidoIA.ml) === 100 ? 100 : 50;
  const precio = Number(ml === 100 ? prod.precio_100ml : prod.precio_50ml) || 0;
  if (!precio) return null;
  const metodo = normalizarMetodo(pedidoIA.metodo);
  const estadoPedido = decidirEstadoPedidoIA({ metodo });
  const item = {
    productoId: prod.id,
    nombre: prod.nombre,
    ml,
    cantidad: Math.max(1, Math.min(9, Number(pedidoIA.cantidad) || 1)),
    precio
  };
  const entrega = ['delivery', 'estacion'].includes(String(pedidoIA.entrega || '').toLowerCase()) ? String(pedidoIA.entrega).toLowerCase() : '';
  const estacion = String(pedidoIA.estacion || '').slice(0, 120);
  const fechaEntrega = String(pedidoIA.fecha || '').slice(0, 10);
  const horaEntrega = String(pedidoIA.hora || '').slice(0, 5);

  let p = pedidos.pedidoAbierto(tel);
  let nuevo = false;
  if (p && ['borrador', 'esperando_pago'].includes(p.estado)) {
    p = pedidos.ponerItem(p.id, item);
    const cambios = {};
    if (metodo && !p.metodo) cambios.metodo = metodo;
    if (esEfectivo(metodo)) cambios.estado = estadoPedido;
    else if (metodo && p.estado === 'borrador') cambios.estado = estadoPedido;
    if (entrega) cambios.entrega = entrega;
    if (estacion) cambios.estacion = estacion;
    if (fechaEntrega) cambios.fechaEntrega = fechaEntrega;
    if (horaEntrega) cambios.horaEntrega = horaEntrega;
    p = pedidos.actualizar(p.id, cambios);
  } else if (!p || p.estado === 'entregado' || p.estado === 'cancelado') {
    p = pedidos.crear({
      telefono: tel,
      nombre,
      clienteId,
      items: [item],
      metodo,
      estado: estadoPedido,
      entrega,
      estacion,
      fechaEntrega,
      horaEntrega
    });
    nuevo = true;
  }

  // Si el modelo se equivocÃ³ e intentÃ³ cerrar una venta digital (o marcar
  // "entregado"), se corrige antes de tocar el pedido y se deja rastro.
  const correccion = corregirEstadoPedidoIA({
    metodo,
    estadoSugerido: String(pedidoIA.estado || ''),
    tieneComprobante: Array.isArray(p.comprobantes) && p.comprobantes.length > 0
  });
  let corregido = false;
  if (correccion.corregido) {
    corregido = true;
    log(`âš ï¸ IA: ${correccion.motivo} (pedido ${p.id}, +${tel}).`);
    try {
      if (p.estado !== correccion.estado) p = pedidos.actualizar(p.id, { estado: correccion.estado });
    } catch (e) {
      log(`No se pudo corregir el estado del pedido ${p.id}: ${e.message}`);
    }
    emitir('derivacion', {
      telefono: tel,
      nombre,
      motivo: 'Pago digital pendiente de verificaciÃ³n',
      mensaje: `La IA intentÃ³ cerrar el pedido ${p.id} con pago digital (${p.metodo || metodo || 'sin mÃ©todo'}). Queda esperando verificaciÃ³n del dueÃ±o.`
    });
    await notificarDueno(
      `âš ï¸ *CORRECCIÃ“N DE PEDIDO*\n\nðŸ“ Motivo: ${correccion.motivo}\n\n${resumenPedido(p)}\n\nðŸ‘‰ Revisa el comprobante en *Pedidos* y confirma tÃº el pago.`,
      null
    );
  }

  if (nuevo) {
    emitir('pedido', {
      telefono: tel,
      nombre,
      pedidoId: p.id,
      estado: p.estado,
      total: p.total,
      producto: prod.nombre,
      detalle: resumenPedido(p)
    });
    // El dueÃ±o se entera siempre, aunque no tenga que aprobar nada. Si es pago
    // digital, el aviso deja claro que el bot NO confirma el pago.
    const avisoDueno = debeDerivarPago(p.metodo)
      ? textoAvisoPagoDigital({ nombre, pedido: p })
      : `ðŸ›’ *NUEVO PEDIDO*\n\n${resumenPedido(p)}`;
    await notificarDueno(avisoDueno, null);
    if (debeDerivarPago(p.metodo)) {
      emitir('derivacion', {
        telefono: tel,
        nombre,
        motivo: 'Pago digital pendiente de verificaciÃ³n',
        mensaje: resumenPedido(p)
      });
    }
    log(`Pedido ${p.id} creado para +${tel}: ${prod.nombre} ${ml} ml Â· S/ ${p.total} (${p.estado}).`);
  }

  // Pago digital = derivar DE VERDAD: se pausa la IA en este chat hasta que el
  // dueÃ±o verifique el comprobante y la reanude desde el panel. El efectivo no
  // se pausa (la venta se cierra al entregar/cobrar).
  if (p.metodo && debeDerivarPago(p.metodo) && !estaPausado(tel)) {
    try {
      const motivo = 'Pago digital pendiente de verificaciÃ³n';
      const estado = pausarIA(tel, true, motivo, nombre);
      emitir('ia', {
        accion: 'pausar',
        telefono: tel,
        pausado: true,
        motivo,
        pausadas: estado.pausados.length,
        activa: estado.activa,
        autoRespuesta: estado.autoRespuesta
      });
      log(`IA pausada para +${tel} hasta que el dueÃ±o verifique el pago (pedido ${p.id}, ${p.metodo}).`);
    } catch (e) {
      log(`No se pudo pausar la IA para +${tel} tras el pago digital: ${e.message}`);
    }
  }
  return { pedido: p, producto: prod, nuevo, corregido };
}

/* ---------------- resumen de compra, pago y agenda (determinÃ­stico) ---------------- */

/** EnvÃ­a un texto y lo deja registrado en Bandeja + Supabase. */
async function enviarRegistrado({ tel, texto, nombre = '', clienteId = null, sesionId = null, origen = 'bot' }) {
  const env = await enviar(tel, texto, sesionId);
  await logMensaje({ clienteId, telefono: tel, direccion: 'saliente', texto, origen });
  registrar({ telefono: tel, texto, direccion: 'saliente', nombre, clienteId, origen, waId: env?.waId || '' });
  return env;
}

function saludoConNombre(nombre) {
  const nom = /^\+/.test(String(nombre || '')) ? '' : primerNombre(nombre);
  return `${saludoHora()}${nom ? ', ' + nom : ''}`;
}

// TelÃ©fonos a los que ya se les enviÃ³ el saludo de bienvenida hace poco: sirve
// para no volver a saludar en el mismo turno (la bienvenida ya saluda).
const recienSaludado = new Map();
function marcarSaludado(tel) {
  recienSaludado.set(tel, Date.now());
  if (recienSaludado.size > 500) recienSaludado.delete(recienSaludado.values().next().value);
}
/** Saludo solo si NO se acaba de enviar la bienvenida (evita "Buenas tardes" x2). */
function saludoONada(tel, nombre) {
  if (Date.now() - (recienSaludado.get(tel) || 0) < 180000) return '';
  return saludoConNombre(nombre);
}
/** Antepone el saludo (si corresponde) sin dejar puntuaciÃ³n rara. */
function conSaludo(tel, nombre, cuerpo) {
  const s = saludoONada(tel, nombre);
  return s ? `${s}. ${cuerpo}` : cuerpo;
}

/** Mensaje 1 de toda conversaciÃ³n nueva: saludo + agradecimiento. */
async function enviarBienvenida({ tel, nombre, clienteId, sesionId }) {
  const nom = /^\+/.test(String(nombre || '')) ? '' : primerNombre(nombre);
  const texto = `${saludoHora()}${nom ? ', ' + nom : ''}. Nos alegra que hayas elegido a *PerfumerÃ­a Fina PerÃº* como tu perfumerÃ­a de preferencia. âœ¨`;
  await enviarRegistrado({ tel, texto, nombre, clienteId, sesionId, origen: 'ia' });
  marcarSaludado(tel);
  log(`Bienvenida enviada a +${tel}.`);
  return true;
}

/** Â¿Pide el catÃ¡logo completo / la lista de fragancias? */
function pideCatalogo(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /(catalogo|lista de (perfumes|fragancias|productos|precios)|pdf|todas? (sus|las) (fragancias|perfumes)|que (perfumes|fragancias) (tienen|manejan|venden))/.test(t);
}

/** Datos del catÃ¡logo PDF (generados por scripts/catalogo/build.mjs). */
function infoCatalogo() {
  const ruta = path.join(raizProyecto, 'docs', 'catalogo', 'catalogo-info.json');
  const pdf = path.join(raizProyecto, 'docs', 'catalogo', 'catalogo-navidad-2026.pdf');
  let info = null;
  try { info = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { info = null; }
  return { info, pdf, existe: fs.existsSync(pdf) };
}

/** EnvÃ­a el catÃ¡logo PDF con la explicaciÃ³n de pÃ¡ginas por categorÃ­a. */
async function enviarCatalogo({ tel, nombre, clienteId, sesionId }) {
  const { info, pdf, existe } = infoCatalogo();
  const secciones = Array.isArray(info?.secciones) ? info.secciones : [];
  const lineas = secciones.map(s => {
    const d = s.productosDesde || s.desde;
    const h = s.productosHasta || s.hasta;
    return `â€¢ PÃ¡ginas *${d} a ${h}*: perfumes de ${s.nombre}`;
  });
  const detalle = lineas.length
    ? `\n\n${lineas.join('\n')}`
    : '\n\nâ€¢ Perfumes de *diseÃ±ador*, *Ã¡rabes* y de *nicho*';
  const texto = `Claro, estimado. A continuaciÃ³n le envÃ­o un PDF con nuestras fragancias ðŸ“„${detalle}\n\nQuedo atento a tu respuesta; si deseas alguna recomendaciÃ³n, tambiÃ©n nos tienes aquÃ­ ðŸ˜Š`;
  await enviarRegistrado({ tel, texto, nombre, clienteId, sesionId, origen: 'ia' });
  if (existe) {
    try {
      const env = await enviarArchivo(tel, pdf, 'application/pdf', 'Catalogo-Perfumeria-Fina-Navidad-2026.pdf', 'ðŸ“• CatÃ¡logo *Navidad 2026* Â· PerfumerÃ­a Fina PerÃº', sesionId);
      await logMensaje({ clienteId, telefono: tel, direccion: 'saliente', texto: 'ðŸ“• [catÃ¡logo PDF enviado]', origen: 'ia' });
      registrar({ telefono: tel, texto: 'ðŸ“• CatÃ¡logo Navidad 2026 (PDF)', direccion: 'saliente', nombre, clienteId, origen: 'ia', waId: env?.waId || '' });
      log(`CatÃ¡logo PDF enviado a +${tel}.`);
    } catch (e) {
      log('No se pudo enviar el catÃ¡logo PDF: ' + e.message);
      await enviarRegistrado({
        tel,
        texto: 'El catÃ¡logo se estÃ¡ actualizando; en un momento te lo comparto ðŸ™Œ',
        nombre,
        clienteId,
        sesionId,
        origen: 'bot'
      });
    }
  } else {
    log('No existe el PDF del catÃ¡logo; se enviÃ³ solo la explicaciÃ³n.');
  }
  return true;
}

/** Imagen/precio de un producto concreto sin gastar IA (flujo de venta). */
async function responderProductoDirecto({ tel, nombre, clienteId, texto, sesionId }) {
  const t = String(texto || '').toLowerCase();
  const pideImagen = /(foto|imagen|mu[eÃ©]strame|verlo|ver la|m[aÃ¡]ndame)/.test(t);
  const pidePrecio = /(precio|cu[aÃ¡]nto|cuesta|vale|tarifa)/.test(t);
  if (!pideImagen && !pidePrecio) return false;
  let productoId = '';
  try { productoId = await productoMencionado(texto); } catch { productoId = ''; }
  if (!productoId) productoId = ultimoProducto.get(tel) || '';
  if (!productoId) return false;
  const prod = await productoPorId(productoId).catch(() => null);
  if (!prod) return false;
  ultimoProducto.set(tel, prod.id);
  const p50 = prod.precio_50ml ?? 56;
  const p100 = prod.precio_100ml ?? 78;
  const casa = prod.casa_inspirada ? ` (inspirado en ${prod.casa_inspirada})` : '';
  const saludo = saludoONada(tel, nombre);
  try {
    if (pideImagen) {
      const media = mediaProducto(prod);
      if (media) {
        const caption = `${saludo}. AquÃ­ tienes *${prod.nombre}*${casa} ðŸ“¸`;
        const env = await enviarImagen(tel, media, caption, sesionId);
        await logMensaje({ clienteId, telefono: tel, direccion: 'saliente', texto: 'ðŸ“· ' + caption, origen: 'bot' });
        registrar({ telefono: tel, texto: 'ðŸ“· ' + caption, direccion: 'saliente', nombre, clienteId, origen: 'bot', waId: env?.waId || '' });
        if (!pidePrecio) {
          const extra = 'Â¿Quieres que te pase los precios? ðŸ˜Š';
          await enviarRegistrado({ tel, texto: extra, nombre, clienteId, sesionId });
        }
      }
    }
    if (pidePrecio) {
      const msg = `${saludo}. Precios de *${prod.nombre}*:\n\nâ€¢ 50 ml â€” *S/ ${p50}*\nâ€¢ 100 ml â€” *S/ ${p100}*\n\nÂ¿CuÃ¡l prefieres? ðŸ˜Š`;
      await enviarRegistrado({ tel, texto: msg, nombre, clienteId, sesionId });
    }
    log(`Respuesta directa de producto ${prod.nombre} a +${tel} (${pideImagen ? 'imagen' : ''}${pideImagen && pidePrecio ? '+' : ''}${pidePrecio ? 'precio' : ''}).`);
    return true;
  } catch (e) {
    log(`No se pudo enviar la imagen/precio de ${prod.nombre} a +${tel}: ${e.message}`);
    return false;
  }
}

/**
 * Cierre de compra directo: si el cliente ya vio un producto y dice "lo quiero
 * en efectivo / Yape", crea el pedido sin depender de la IA. La fecha/hora y
 * la estaciÃ³n se guardan para el calendario y la validaciÃ³n de cupos.
 */
async function procesarCompraDirecta({ tel, nombre, clienteId, texto, sesionId }) {
  const t = String(texto || '').toLowerCase();
  const intencion = /\b(lo quiero|me lo llevo|lo compro|quiero comprar|deseo comprar|lo pago|pagar con|pago con|cerrar la compra|cerrar el pedido)\b/.test(t);
  if (!intencion) return false;
  const metodo = normalizarMetodo(texto);
  if (!metodo) return false;
  const abierto = pedidos.pedidoAbierto(tel);
  if (abierto && abierto.estado !== 'borrador') return false;
  let productoId = '';
  try { productoId = await productoMencionado(texto); } catch { productoId = ''; }
  if (!productoId) productoId = ultimoProducto.get(tel) || '';
  if (!productoId) return false;
  const prod = await productoPorId(productoId).catch(() => null);
  if (!prod) return false;
  const mlm = t.match(/(\d{2,3})\s*ml/);
  const ml = Number(mlm && mlm[1]) === 100 ? 100 : 50;
  const precio = Number(ml === 100 ? prod.precio_100ml : prod.precio_50ml) || 0;
  const cantm = t.match(/(\d+)\s*(?:unidad|unidades|frascos?|perfumes?)/);
  const cantidad = Math.max(1, Math.min(9, Number(cantm && cantm[1]) || 1));
  const estm = String(texto).match(/estaci[oÃ³]n\s+([^\n,.;]{3,50}?)(?=\s+(?:maÃ±ana|hoy|pasado|a\s+las|para|el\s+\d|por\s+la)|[,.!]?$)/i);
  const entrega = estm ? 'estacion' : /delivery|domicilio|env[iÃ­]o a/.test(t) ? 'delivery' : '';
  const estacion = estm ? estm[1].trim() : '';
  const fh = parseFechaHoraPedido(texto);
  try {
    let pedido;
    if (abierto && abierto.estado === 'borrador') {
      pedido = pedidos.ponerItem(abierto.id, { productoId: prod.id, nombre: prod.nombre, ml, cantidad, precio });
      pedido = pedidos.actualizar(pedido.id, {
        entrega: entrega || pedido.entrega,
        estacion: estacion || pedido.estacion,
        fechaEntrega: fh ? fh.fecha : pedido.fechaEntrega,
        horaEntrega: fh ? fh.hora : pedido.horaEntrega
      });
    } else {
      pedido = pedidos.crear({
        telefono: tel,
        nombre,
        clienteId,
        items: [{ productoId: prod.id, nombre: prod.nombre, ml, cantidad, precio }],
        metodo: '',
        estado: 'borrador',
        entrega,
        estacion,
        fechaEntrega: fh ? fh.fecha : '',
        horaEntrega: fh ? fh.hora : ''
      });
    }
    ultimoProducto.set(tel, prod.id);
    emitir('pedido', { telefono: tel, nombre, pedidoId: pedido.id, estado: pedido.estado, total: pedido.total, detalle: resumenPedido(pedido) });
    log(`Compra directa detectada (+${tel}): pedido ${pedido.id}, ${prod.nombre} ${ml} ml, ${metodo}.`);
    return await procesarMetodoPagoPedido({ tel, nombre, clienteId, texto, sesionId });
  } catch (e) {
    log('No se pudo cerrar la compra directa: ' + e.message);
    return false;
  }
}

function fechaMasDias(iso, dias) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + dias));
  return dt.toISOString().slice(0, 10);
}

/** Detecta y parsea el resumen de compra que manda la web/Pedidos. */
function parseResumenCompra(texto) {
  const t = String(texto || '');
  if (!/NUEVO PEDIDO|PEDIDO:|RESUMEN|Total\s*:?/i.test(t)) return null;
  const items = [];
  const re = /(\d+)\s*[Ã—x]\s*(.+?)\s*[â€”â€“-]\s*(50|100)\s*ml\s*[â€”â€“-]\s*S\/?\s*([\d.,]+)/gi;
  let m;
  while ((m = re.exec(t))) {
    items.push({
      cantidad: Math.max(1, Math.min(9, Number(m[1]) || 1)),
      nombre: String(m[2] || '').replace(/\*/g, '').trim(),
      ml: Number(m[3]) === 100 ? 100 : 50,
      precio: Number(String(m[4]).replace(',', '.')) || 0
    });
  }
  if (!items.length) return null;
  const totalM = t.match(/Total\s*:?\s*S\/?\s*([\d.,]+)/i);
  const refM = t.match(/Pedido\s*:?\s*([A-Z0-9-]{4,})/i);
  const estM = t.match(/Recojo en estaci[oÃ³]n\s*:?\s*([^\n]+)/i);
  const delivery = /Delivery|Env[iÃ­]o a domicilio|domicilio/i.test(t);
  return {
    items,
    total: totalM ? Number(String(totalM[1]).replace(',', '.')) : 0,
    ref: refM ? refM[1].trim() : '',
    entrega: estM ? 'estacion' : delivery ? 'delivery' : '',
    estacion: estM ? estM[1].replace(/\*/g, '').trim().slice(0, 120) : ''
  };
}

/** Crea/actualiza el pedido del resumen y responde con el saludo + forma de pago. */
async function procesarResumenCompra({ tel, nombre, clienteId, texto, sesionId }) {
  const r = parseResumenCompra(texto);
  if (!r) return false;
  try {
    const items = [];
    for (const it of r.items) {
      const prod = await productoPorId(it.nombre).catch(() => null);
      const precio = it.precio || Number(prod ? (it.ml === 100 ? prod.precio_100ml : prod.precio_50ml) : 0) || 0;
      items.push({
        productoId: prod?.id || '',
        nombre: prod?.nombre || it.nombre,
        ml: it.ml,
        cantidad: it.cantidad,
        precio
      });
    }
    if (!items.length) return false;
    const abierto = pedidos.pedidoAbierto(tel);
    const notas = `${r.ref ? 'Ref. ' + r.ref + ' Â· ' : ''}${r.entrega === 'estacion' ? 'Recojo: ' + (r.estacion || 'estaciÃ³n') : r.entrega === 'delivery' ? 'Delivery' : 'Entrega por coordinar'}`;
    let pedido;
    if (abierto && abierto.estado === 'borrador') {
      pedido = pedidos.actualizar(abierto.id, {
        items,
        entrega: r.entrega,
        estacion: r.estacion,
        refExterna: r.ref,
        notas
      });
    } else if (abierto && !['cancelado', 'entregado'].includes(abierto.estado)) {
      // Ya hay un pedido en curso: no duplicar; se avisa al cliente.
      const msg = conSaludo(tel, nombre, `Ya tengo tu pedido *${abierto.id}* en curso${r.ref ? ` (ref. ${r.ref})` : ''}. Â¿Deseas pagar con *efectivo*, *Yape*, *Plin* u otro medio? ðŸ˜Š`);
      await enviarRegistrado({ tel, texto: msg, nombre, clienteId, sesionId, origen: 'ia' });
      log(`Resumen ${r.ref || 'sin ref'} repetido de +${tel}; se reutiliza pedido ${abierto.id}.`);
      return true;
    } else {
      pedido = pedidos.crear({
        telefono: tel,
        nombre,
        clienteId,
        items,
        metodo: '',
        estado: 'borrador',
        entrega: r.entrega,
        estacion: r.estacion,
        refExterna: r.ref,
        notas
      });
      log(`Pedido ${pedido.id} creado desde resumen de compra (+${tel}, ref ${r.ref || 'â€”'}).`);
    }
    emitir('pedido', {
      telefono: tel,
      nombre,
      pedidoId: pedido.id,
      estado: pedido.estado,
      total: pedido.total,
      detalle: resumenPedido(pedido)
    });
    const nom = /^\+/.test(String(nombre || '')) ? '' : primerNombre(nombre);
    const msg = conSaludo(tel, nombre, 'Nos alegra que hayas elegido *PerfumerÃ­a Fina PerÃº*; los productos escogidos son una muy buena elecciÃ³n. Â¿Deseas pagar con *efectivo*, *Yape*, *Plin* u otro medio de pago? ðŸ˜Š');
    await enviarRegistrado({ tel, texto: msg, nombre, clienteId, sesionId, origen: 'ia' });
    log(`Resumen de compra procesado para +${tel}: pedido ${pedido.id}, ${items.length} Ã­tem(s), S/ ${pedido.total}.`);
    return true;
  } catch (e) {
    log('No se pudo procesar el resumen de compra: ' + e.message);
    return false;
  }
}

/** Datos de pago configurados por variables de entorno (sin plantillas). */
function datosPagoMetodo(metodo) {
  const up = String(metodo || '').toUpperCase();
  return {
    numero: String(process.env[`PAGO_${up}_NUMERO`] || '').trim(),
    titular: String(process.env[`PAGO_${up}_TITULAR`] || '').trim()
  };
}

/** EnvÃ­a las indicaciones de pago digital; el administrador verifica el comprobante. */
async function enviarDatosPago({ tel, pedido, nombre, clienteId, sesionId }) {
  const metodo = pedido.metodo;
  const datos = datosPagoMetodo(metodo);
  const monto = Number(pedido.adelanto) > 0 ? Number(pedido.adelanto) : Number(pedido.total);
  const msg = datos.numero
    ? `Puede realizar el adelanto a los siguientes medios de pago:\n\nâœ… Monto: S/ ${monto.toFixed(2)}\n\nðŸ“± ${etiquetaPago(metodo)}: ${datos.numero}${datos.titular ? `\nðŸ‘¤ A nombre de: ${datos.titular}` : ''}\n\nCuando lo hagas, envÃ­a tu comprobante por aquÃ­. El administrador verificarÃ¡ el pago y te confirma.`
    : `El administrador te comparte en un momento los datos de *${etiquetaPago(metodo)}*. Cuando realices el pago, envÃ­a tu comprobante por aquÃ­; el pago lo verifica el administrador.`;
  await enviarRegistrado({ tel, texto: msg, nombre, clienteId, sesionId, origen: 'bot' });
  pedidos.marcarPagoEnviado(pedido.id);
  return !!datos.numero;
}

function etiquetaPago(metodo) {
  return ({ yape: 'Yape', plin: 'Plin', transferencia: 'Transferencia', efectivo: 'Efectivo' })[metodo] || 'Pago';
}

/** Si el cliente elige mÃ©todo de pago para el pedido abierto, responde y registra. */
async function procesarMetodoPagoPedido({ tel, nombre, clienteId, texto, sesionId }) {
  const pedido = pedidos.pedidoAbierto(tel);
  if (!pedido || pedido.estado !== 'borrador') return false;
  const metodo = normalizarMetodo(texto);
  if (!metodo) return false;
  const nom = /^\+/.test(String(nombre || '')) ? '' : primerNombre(nombre);
  try {
    if (metodo === 'efectivo') {
      const actualizado = pedidos.actualizar(pedido.id, { metodo, estado: 'por_entregar' });
      emitir('pedido', { telefono: tel, nombre, pedidoId: actualizado.id, estado: actualizado.estado, total: actualizado.total, metodo, detalle: resumenPedido(actualizado) });
      const msgAgenda = actualizado.fechaEntrega
        ? `Perfecto, pago en *efectivo* al entregar o al recoger. QuedÃ³ agendado para el *${actualizado.fechaEntrega}*${actualizado.horaEntrega ? ' a las *' + hora12(actualizado.horaEntrega) + '*' : ''}. Â¡Gracias por tu compra! ðŸ™Œ`
        : 'Perfecto, pago en *efectivo* al entregar o al recoger. Â¿QuÃ© dÃ­a y hora te acomoda? ðŸ“…';
      const msg = conSaludo(tel, nombre, msgAgenda);
      await enviarRegistrado({ tel, texto: msg, nombre, clienteId, sesionId, origen: 'bot' });
      await notificarDueno(`ðŸ›’ *PEDIDO NUEVO â€” PAGO EN EFECTIVO*\n\n${resumenPedido(actualizado)}\n\nðŸ‘‰ Coordina la entrega o el recojo con el cliente.`, sesionId);
      log(`Pedido ${actualizado.id}: efectivo, pendiente de coordinar entrega.`);
      return true;
    }
    // Digital: primero "Entendido", luego los datos del medio de pago.
    const actualizado = pedidos.actualizar(pedido.id, { metodo, estado: 'esperando_pago' });
    await enviarRegistrado({ tel, texto: `Entendido, ${nom || 'gracias'} ðŸ˜Š`, nombre, clienteId, sesionId, origen: 'bot' });
    await enviarDatosPago({ tel, pedido: actualizado, nombre, clienteId, sesionId });
    await notificarDueno(`ðŸ›’ *NUEVA COMPRA â€” VERIFICAR PAGO*\n\n${resumenPedido(actualizado)}\n\nðŸ‘‰ Revisa el pago en la pestaÃ±a *Pedidos*.`, sesionId);
    emitir('derivacion', {
      telefono: tel,
      nombre,
      motivo: 'Pago digital pendiente de verificaciÃ³n',
      mensaje: resumenPedido(actualizado)
    });
    emitir('pedido', { telefono: tel, nombre, pedidoId: actualizado.id, estado: actualizado.estado, total: actualizado.total, metodo, detalle: resumenPedido(actualizado) });
    pausarIA(tel, true, 'Pago digital pendiente de verificaciÃ³n', nombre);
    log(`Pedido ${actualizado.id}: pago digital ${metodo}, esperando comprobante/verificaciÃ³n.`);
    return true;
  } catch (e) {
    log('No se pudo procesar el mÃ©todo de pago: ' + e.message);
    return false;
  }
}

/** Interpreta una fecha/hora escrita por el cliente (hoy, maÃ±ana, lunes 3 pm...). */
function parseFechaHoraPedido(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!/(hoy|manana|pasado|lunes|martes|miercoles|jueves|viernes|sabado|domingo|a las|hs|am|pm|tarde|noche|:)/.test(t)) return null;
  let fecha = fechaLima(partesLima());
  if (/pasado manana/.test(t)) fecha = fechaMasDias(fecha, 2);
  else if (/\bmanana\b/.test(t)) fecha = fechaMasDias(fecha, 1);
  else if (!/\bhoy\b/.test(t)) {
    const dias = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
    for (const [nombre, num] of Object.entries(dias)) {
      if (!new RegExp(`\\b${nombre}\\b`).test(t)) continue;
      const base = new Date(fecha + 'T12:00:00Z');
      let dif = (num - base.getUTCDay() + 7) % 7;
      if (dif === 0) dif = 7;
      fecha = fechaMasDias(fecha, dif);
      break;
    }
  }
  let mh = t.match(/(?:a\s+las?\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?/i);
  if (!mh) mh = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!mh) mh = t.match(/\b(\d{1,2})\s*(am|pm|a\.?m\.?|p\.?m\.?)\b/i);
  if (!mh) mh = t.match(/\b(\d{1,2})\s*(?:hs|horas)\b/i);
  if (!mh) return null;
  let h = Number(mh[1]);
  const min = Number(mh[2] || 0);
  const suf = String(mh[3] || '');
  if (/pm|p\.?m\.?/.test(suf) && h < 12) h += 12;
  if (/am|a\.?m\.?/.test(suf) && h === 12) h = 0;
  if (!/am|pm|a\.?m\.?|p\.?m\.?/.test(suf) && h <= 7 && /tarde|noche/.test(t)) h += 12;
  if (h < 8 || h > 21 || min < 0 || min > 59) return null;
  return { fecha, hora: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
}

/** Si hay un pedido abierto y el cliente da fecha/hora, agenda validando cupos de estaciÃ³n. */
async function procesarAgendaPedido({ tel, nombre, clienteId, texto, sesionId }) {
  const pedido = pedidos.pedidoAbierto(tel);
  if (!pedido || pedido.fechaEntrega) return false;
  const fh = parseFechaHoraPedido(texto);
  if (!fh) return false;
  const nom = /^\+/.test(String(nombre || '')) ? '' : primerNombre(nombre);
  try {
    if (pedido.entrega === 'estacion') {
      const cupos = Math.max(1, Number(process.env.CUPOS_ESTACION || 2));
      const usados = pedidos.listar({ limite: 1200 }).filter(p =>
        p.id !== pedido.id && p.entrega === 'estacion' && p.fechaEntrega === fh.fecha &&
        p.horaEntrega === fh.hora && !['cancelado', 'entregado'].includes(p.estado)
      ).length;
      if (usados >= cupos) {
        const [hh] = fh.hora.split(':').map(Number);
        const alternativas = [hh + 1, hh + 2, hh + 3].filter(h => h <= 21).map(h => hora12(`${String(h).padStart(2, '0')}:00`));
        const msg = alternativas.length
          ? `Ese horario para recoger en estaciÃ³n ya estÃ¡ completo ðŸ˜… Te propongo ${alternativas.join(' o ')}. Â¿CuÃ¡l te acomoda?`
          : 'Ese horario para recoger ya estÃ¡ completo. Â¿Te acomoda otro dÃ­a u otra hora?';
        await enviarRegistrado({ tel, texto: msg, nombre, clienteId, sesionId, origen: 'ia' });
        return true;
      }
    }
    const actualizado = pedidos.actualizar(pedido.id, { fechaEntrega: fh.fecha, horaEntrega: fh.hora });
    const donde = actualizado.entrega === 'estacion'
      ? `recojo en *${actualizado.estacion || 'estaciÃ³n'}*`
      : 'tu *delivery*';
    const msg = conSaludo(tel, nombre, `Listo, agendamos ${donde} para el *${fh.fecha}* a las *${hora12(fh.hora)}*. Cualquier cambio me avisas ðŸ˜Š`);
    await enviarRegistrado({ tel, texto: msg, nombre, clienteId, sesionId, origen: 'bot' });
    emitir('pedido', { telefono: tel, nombre, pedidoId: actualizado.id, estado: actualizado.estado, total: actualizado.total, entrega: actualizado.entrega, detalle: resumenPedido(actualizado) });
    log(`Pedido ${actualizado.id} agendado: ${actualizado.entrega} ${fh.fecha} ${fh.hora}.`);
    return true;
  } catch (e) {
    log('No se pudo agendar el pedido: ' + e.message);
    return false;
  }
}

/* ---------------- anuncios (mensaje Ãºnico con filtros) ---------------- */

/** Etiquetas de un cliente, normalizadas a minÃºsculas. */
function etiquetasDe(c) {
  const v = c?.etiquetas;
  const lista = Array.isArray(v) ? v : String(v || '').split(',');
  return lista.map(x => String(x || '').trim().toLowerCase()).filter(Boolean);
}

/** Une la base de clientes con los chats de la Bandeja en una sola lista. */
function listaDestinatarios(clientes, chats) {
  const mapa = new Map();
  for (const c of clientes || []) {
    if (!c || !c.telefono) continue;
    const tel = String(c.telefono);
    mapa.set(tel, {
      telefono: tel,
      nombre: c.nombre || `+${tel}`,
      clienteId: c.id || null,
      consentimiento: !!c.consentimiento,
      activo: c.activo !== false,
      baja: !!c.baja,
      etiquetas: etiquetasDe(c),
      origen: 'cliente'
    });
  }
  for (const ch of chats || []) {
    const tel = String(ch.telefono || '');
    if (!/^\d{8,15}$/.test(tel)) continue;
    const actual = mapa.get(tel);
    if (actual) {
      if ((!actual.nombre || actual.nombre === `+${tel}`) && (ch.nombre || ch.nombreWa)) {
        actual.nombre = ch.nombre || ch.nombreWa;
      }
      continue;
    }
    mapa.set(tel, {
      telefono: tel,
      nombre: ch.nombre || ch.nombreWa || `+${tel}`,
      clienteId: ch.clienteId || null,
      consentimiento: false,
      activo: true,
      baja: false,
      etiquetas: [],
      origen: 'chat'
    });
  }
  return [...mapa.values()];
}

/** Aplica filtro y consentimiento a la lista de destinatarios. */
function destinatariosAnuncio(clientes, chats, anuncio) {
  const filtro = anuncio.filtro || { tipo: 'todos' };
  return listaDestinatarios(clientes, chats).filter(d => {
    if (!d.activo || d.baja) return false;
    // Con "incluir sin consentimiento" se llega a TODOS los chats/clientes.
    if (!anuncio.incluirSinConsentimiento && !d.consentimiento) return false;
    if (filtro.tipo === 'etiquetas') return filtro.etiquetas.some(t => d.etiquetas.includes(String(t).toLowerCase()));
    if (filtro.tipo === 'telefonos') return filtro.telefonos.includes(d.telefono);
    return true;
  });
}

/** Adjuntos que se pueden enviar junto con un anuncio. */
function adjuntosAnuncio() {
  return {
    catalogo: {
      ruta: path.join(raizProyecto, 'docs', 'catalogo', 'catalogo-navidad-2026.pdf'),
      mimetype: 'application/pdf',
      nombre: 'Catalogo-Perfumeria-Fina-Navidad-2026.pdf',
      caption: 'ðŸ“• CatÃ¡logo *Navidad 2026* Â· PerfumerÃ­a Fina PerÃº'
    },
    video: {
      ruta: path.join(raizProyecto, 'docs', 'entrega', 'perfumeria-fina-crm.mp4'),
      mimetype: 'video/mp4',
      nombre: 'Perfumeria-Fina-CRM.mp4',
      caption: 'ðŸŽ¬ AsÃ­ funciona *PerfumerÃ­a Fina CRM*'
    }
  };
}

async function enviarAdjuntosAnuncio(anuncio, destino) {
  const disponibles = adjuntosAnuncio();
  for (const clave of anuncio.adjuntos || []) {
    const adj = disponibles[clave];
    if (!adj) continue;
    if (!fs.existsSync(adj.ruta)) {
      log(`Anuncio: el adjunto "${clave}" no estÃ¡ en el servidor (${path.basename(adj.ruta)}).`);
      continue;
    }
    try {
      const env = await enviarArchivo(destino.telefono, adj.ruta, adj.mimetype, adj.nombre, adj.caption);
      registrar({
        telefono: destino.telefono,
        texto: 'ðŸ“Ž ' + adj.nombre,
        direccion: 'saliente',
        nombre: destino.nombre,
        clienteId: destino.clienteId,
        origen: 'anuncio',
        waId: env?.waId || ''
      });
    } catch (e) {
      log(`Anuncio: no se pudo enviar "${clave}" a +${destino.telefono}: ${e.message}`);
    }
  }
}

/** Calcula (sin enviar) a cuÃ¡ntos llegarÃ­a el anuncio. */
async function previsualizarAnuncio(datos = {}) {
  const clientes = await getClientes();
  const chats = listar(5000);
  const anuncio = {
    filtro: anuncios.normalizarFiltro(datos.filtro),
    incluirSinConsentimiento: datos.incluirSinConsentimiento === true
  };
  const todos = listaDestinatarios(clientes, chats);
  const lista = destinatariosAnuncio(clientes, chats, anuncio);
  return {
    total: lista.length,
    sinConsentimiento: todos.filter(d => d.activo && !d.baja && !d.consentimiento).length,
    soloChats: todos.filter(d => d.origen === 'chat').length,
    ejemplos: lista.slice(0, 8).map(d => ({ nombre: d.nombre, telefono: d.telefono, origen: d.origen }))
  };
}

/** EnvÃ­a un anuncio a sus destinatarios, uno por uno y con pausas. */
async function enviarAnuncio(id) {
  let anuncio = anuncios.obtener(id);
  if (!anuncio) throw new Error('Anuncio no encontrado');
  if (anuncio.estado === 'enviando') return;
  if (!config.modoPrueba && !hayConexion()) throw new Error('NingÃºn WhatsApp estÃ¡ conectado.');
  if (!dentroHorario()) {
    log(`Anuncio "${anuncio.titulo}": fuera de horario; no se envÃ­a.`);
    return;
  }
  const clientes = await getClientes();
  const chats = listar(5000);
  const lista = destinatariosAnuncio(clientes, chats, anuncio);
  anuncio = anuncios.progreso(id, { total: lista.length, enviados: 0, omitidos: 0, errores: 0, estado: 'enviando' });
  log(`Anuncio "${anuncio.titulo}": ${lista.length} destinatarios${anuncio.incluirSinConsentimiento ? ' (incluye sin consentimiento)' : ''}.`);
  emitir('anuncio', { id, titulo: anuncio.titulo, estado: 'enviando', enviados: 0, total: lista.length, errores: 0 });

  let enviados = 0;
  let errores = 0;
  for (const d of lista) {
    if (!dentroHorario() || limiteAlcanzado()) {
      anuncio = anuncios.progreso(id, { enviados, errores, omitidos: 0, estado: 'borrador' });
      emitir('anuncio', { id, titulo: anuncio.titulo, estado: 'borrador', enviados, total: lista.length, errores, motivo: 'horario o lÃ­mite diario' });
      log(`Anuncio "${anuncio.titulo}" pausado tras ${enviados} envÃ­os (horario o lÃ­mite diario).`);
      return;
    }
    const texto = String(anuncio.texto || '').replaceAll('{nombre}', primerNombre(d.nombre));
    try {
      const r = await enviar(d.telefono, texto);
      registrar({
        telefono: d.telefono,
        texto,
        direccion: 'saliente',
        nombre: d.nombre,
        clienteId: d.clienteId,
        origen: 'anuncio',
        waId: r?.waId || ''
      });
      try { await logMensaje({ clienteId: d.clienteId, telefono: d.telefono, direccion: 'saliente', texto, origen: 'anuncio' }); } catch { /* historial opcional */ }
      await enviarAdjuntosAnuncio(anuncio, d);
      contarEnvio();
      enviados++;
      emitir('anuncio', { id, titulo: anuncio.titulo, estado: 'enviando', enviados, total: lista.length, errores });
      await dormir(esperaEntreEnvios());
    } catch (e) {
      errores++;
      log(`Anuncio "${anuncio.titulo}": fallÃ³ el envÃ­o a +${d.telefono}: ${e.message}`);
      emitir('anuncio', { id, titulo: anuncio.titulo, estado: 'enviando', enviados, total: lista.length, errores });
      await dormir(3000);
    }
  }
  anuncio = anuncios.progreso(id, { enviados, errores, omitidos: 0, estado: 'enviado' });
  emitir('anuncio', { id, titulo: anuncio.titulo, estado: 'enviado', enviados, total: lista.length, errores });
  log(`Anuncio "${anuncio.titulo}" terminado: ${enviados}/${lista.length} enviados, ${errores} errores.`);
}

/* ---------------- cola ---------------- */
const cola = new Cola(log);
let revisando = false;

async function revisarProgramadas(forzar = false) {
  if (!sb) return;
  if (!config.modoPrueba && !hayConexion()) return;
  if (revisando) return;
  if (!forzar && !dentroHorario()) return;
  revisando = true;
  try {
    const { data, error } = await sb
      .from('campanas')
      .select('*')
      .eq('estado', 'programada')
      .lte('fecha_programada', new Date().toISOString())
      .order('fecha_programada', { ascending: true })
      .limit(5);
    if (error) throw error;
    for (const c of data || []) {
      if (cola.add('camp:' + c.id, () => enviarCampana(c.id))) log(`CampaÃ±a en cola: ${c.titulo}`);
    }
  } catch (e) {
    log('Error al revisar campaÃ±as: ' + e.message);
  } finally {
    revisando = false;
  }
}

async function reprogramar(campana, minutos) {
  const fecha = (limiteAlcanzado() || !dentroHorario())
    ? proximaAperturaISO()
    : new Date(Date.now() + Math.max(5, minutos || 30) * 60000).toISOString();
  try {
    must(await sb.from('campanas').update({ fecha_programada: fecha }).eq('id', campana.id), `reprogramar campaÃ±a ${campana.id}`);
  } catch (e) {
    log(`No se pudo reprogramar la campaÃ±a "${campana.titulo}" (${campana.id}): ${e.message}`);
    return;
  }
  log(`CampaÃ±a "${campana.titulo}" reprogramada para ${new Date(fecha).toLocaleString('es-PE', { timeZone: config.zona })}`);
}

/** Update de una fila de `envios` revisando el { error } de Supabase (F-13). */
async function actualizarEnvio(id, cambios, etiqueta) {
  try {
    must(await sb.from('envios').update(cambios).eq('id', id), etiqueta);
    return true;
  } catch (e) {
    log(`${etiqueta} (envÃ­o ${id}): ${e.message}`);
    return false;
  }
}

// Solo se avisa una vez por proceso (evita spam cada 60 s si falta la migraciÃ³n).
let migracionAvisada = false;

/** Reclamo atÃ³mico pendienteâ†’enviando de un envÃ­o de campaÃ±a (F-01). */
async function reclamarEnvio(id) {
  return reclamarEnvioCon(sb, id);
}

/** Aviso SSE de avance de campaÃ±a (la barra de progreso del panel). */
function emitirProgresoCampana(campana, { enviados = 0, total = 0, errores = 0, estado: estadoCampana = 'programada', ...extra } = {}) {
  emitir('campana', {
    campanaId: String(campana.id),
    estado: estadoCampana,
    enviados,
    total,
    errores,
    ...extra
  });
}

/**
 * Cierre garantizado de campaÃ±a (finally de enviarCampana): si ya no quedan
 * envÃ­os pendientes la pasa a 'enviada'; si quedan, la deja programada para el
 * siguiente tick. Nunca deja la campaÃ±a "a medias" sin avisar al panel.
 */
async function cerrarCampana(campana, { enviados = 0, total = 0, errores = 0, motivo = '' } = {}) {
  let resultado;
  try {
    resultado = await cerrarCampanaSiCompleta(sb, campana.id);
  } catch (e) {
    log(`No se pudo verificar/cerrar la campaÃ±a "${campana.titulo}" (${campana.id}): ${e.message}`);
    return;
  }
  if (resultado.cerrada) {
    log(`CampaÃ±a "${campana.titulo}" completada (${enviados}/${total} enviados, ${errores} errores)${motivo ? ' Â· ' + motivo : ''}.`);
    emitirProgresoCampana(campana, { enviados, total, errores, estado: 'enviada' });
  } else {
    log(`CampaÃ±a "${campana.titulo}" queda con ${resultado.pendientes}/${total} envÃ­o(s) pendiente(s)${motivo ? ' (' + motivo + ')' : ''}.`);
    emitirProgresoCampana(campana, { enviados, total, errores, estado: 'programada', pendientes: resultado.pendientes, pausada: true, motivo });
  }
}

/**
 * EnvÃ­a una campaÃ±a con claim atÃ³mico por envÃ­o (F-01).
 * Regla: ningÃºn mensaje sale sin haber reclamado antes su fila en Supabase.
 * Si el claim falla (p. ej. falta sql/07), NO se envÃ­a nada y la campaÃ±a queda
 * programada: se prefiere un envÃ­o perdido visible a un duplicado al cliente.
 */
async function enviarCampana(id) {
  let campana = null;
  let procesando = false;
  let enviados = 0;
  let total = 0;
  let errores = 0;
  let motivo = '';
  try {
    const { data, error } = await sb.from('campanas').select('*').eq('id', id).single();
    must({ data, error }, `leer campaÃ±a ${id}`);
    campana = data;
    if (!campana) throw new Error('la campaÃ±a no existe');
    if (campana.estado !== 'programada') {
      campana = null; // ya la cerrÃ³ otro tick/proceso: no hay nada que hacer
      return;
    }

    const emisor = campana.numero_emisor ? String(campana.numero_emisor) : null;
    if (!sesionDisponible(emisor)) {
      log(`CampaÃ±a "${campana.titulo}": el nÃºmero ${emisor || 'asignado'} no estÃ¡ conectado. Se reintentarÃ¡ en 15 minutos.`);
      await reprogramar(campana, 15);
      return;
    }

    if (!dentroHorario()) {
      log(`Fuera de horario. Se pospone "${campana.titulo}".`);
      await reprogramar(campana, 30);
      return;
    }

    const { data: envios, error: errorEnvios } = await sb
      .from('envios').select('id,cliente_id,estado').eq('campana_id', id).eq('estado', 'pendiente');
    must({ data: envios, error: errorEnvios }, `leer envÃ­os de la campaÃ±a ${id}`);

    procesando = true; // desde aquÃ­ el finally DEBE cerrar/verificar la campaÃ±a
    total = envios?.length || 0;
    if (!total) {
      log(`CampaÃ±a "${campana.titulo}": no quedan envÃ­os pendientes; se cierra.`);
      return;
    }

    const clientes = await getClientes();
    const mapa = new Map(clientes.map(c => [String(c.id), c]));
    log(`Iniciando campaÃ±a "${campana.titulo}" con ${total} envÃ­os pendientes.`);
    emitirProgresoCampana(campana, { enviados: 0, total, errores: 0 });

    for (const e of envios) {
      if (!dentroHorario() || limiteAlcanzado()) {
        motivo = 'horario o lÃ­mite diario';
        await reprogramar(campana, 30);
        log(`CampaÃ±a pausada despuÃ©s de ${enviados} envÃ­os (horario o lÃ­mite diario).`);
        return;
      }

      const c = mapa.get(String(e.cliente_id));
      if (!puede(c)) {
        await actualizarEnvio(e.id, { estado: 'omitido', fecha_envio: new Date().toISOString() }, 'marcar envÃ­o omitido');
        log(`Omitido: ${c?.nombre || e.cliente_id} (sin consentimiento, baja o inactivo).`);
        continue;
      }

      const texto = String(campana.mensaje_final || '').replaceAll('{nombre}', primerNombre(c.nombre));

      // 1) Claim atÃ³mico ANTES de enviar. Si esto falla, no se manda nada.
      let reclamado = false;
      try {
        reclamado = await reclamarEnvio(e.id);
      } catch (err) {
        motivo = 'no se pudo reclamar el envÃ­o';
        if (esErrorDeMigracion(err)) {
          if (!migracionAvisada) {
            migracionAvisada = true;
            log('âŒ ' + mensajeErrorMigracion(err));
          } else {
            log(`F-01: sigue sin poder reclamarse el envÃ­o ${e.id}; no se envÃ­a nada (fail-safe).`);
          }
        } else {
          log(`No se pudo reclamar el envÃ­o ${e.id}; no se envÃ­a (fail-safe). ${err.message}`);
        }
        return; // la campaÃ±a queda programada para el siguiente tick
      }
      if (!reclamado) {
        log(`EnvÃ­o ${e.id} ya no estaba pendiente (lo tomÃ³ otro proceso o ya se enviÃ³); se omite.`);
        continue;
      }

      // 2) Enviar y marcar SIEMPRE con filtro estado='enviando'.
      try {
        const r = await enviar(c.telefono, texto, emisor);
        // Registrar tambiÃ©n en la Bandeja (antes solo iba a Supabase y no se veÃ­a).
        registrar({
          telefono: c.telefono,
          texto,
          direccion: 'saliente',
          nombre: c.nombre,
          clienteId: c.id,
          origen: 'campana',
          waId: r?.waId || ''
        });
        const marcado = await marcarEnvioCon(sb, e.id, {
          estado: 'enviado',
          fecha_envio: new Date().toISOString(),
          wa_id: r?.waId || null,
          nota: null
        });
        if (marcado.error) {
          log(`[envÃ­o ${e.id}] se enviÃ³ pero no se pudo confirmar en Supabase: ${marcado.error.message || marcado.error}`);
        }
        try {
          await logMensaje({ clienteId: c.id, telefono: c.telefono, direccion: 'saliente', texto, origen: 'campana' });
        } catch (eLog) {
          log(`[envÃ­o ${e.id}] se enviÃ³ pero no se pudo registrar en mensajes: ${eLog.message}`);
        }
        contarEnvio();
        enviados++;
        errores = 0;
        log(`Enviado a ${c.nombre} (+${c.telefono}) Â· ${dia.n}/${config.maxPorDia} hoy.`);
        emitirProgresoCampana(campana, { enviados, total, errores });
      } catch (err) {
        errores++;
        log(`Error con ${c.nombre} (+${c.telefono}): ${err.message}`);
        const marcado = await marcarEnvioCon(sb, e.id, {
          estado: 'error',
          fecha_envio: new Date().toISOString(),
          nota: String(err.message || err).slice(0, 200)
        });
        if (marcado.error) {
          log(`[envÃ­o ${e.id}] no se pudo marcar el error en Supabase: ${marcado.error.message || marcado.error}`);
        }
        if (errores >= 3) {
          motivo = '3 errores seguidos';
          await reprogramar(campana, 30);
          log('CampaÃ±a pausada por 3 errores seguidos.');
          return;
        }
      }

      await dormir(esperaEntreEnvios(config.delayMin, config.delayMax));
    }
    motivo = 'completada';
  } catch (e) {
    motivo = motivo || 'error';
    log(`Error al procesar la campaÃ±a ${id}: ${e.message}`);
  } finally {
    // Cierre SIEMPRE: es el arreglo central de F-01. Si el claim por envÃ­o no
    // pudo hacerse (migraciÃ³n pendiente), procesando sigue false y la campaÃ±a
    // queda programada, tal como pide el modo fail-safe.
    if (campana && procesando) {
      await cerrarCampana(campana, { enviados, total, errores, motivo });
    }
  }
}

/* ---------------- auto-respuesta ---------------- */
// Ids de mensajes entrantes ya procesados: evita responder dos veces al mismo
// mensaje cuando WhatsApp Web emite el evento duplicado (historial + en vivo).
const yaRespondidos = new Set();
// Ãšltimo producto mostrado por chat, para cerrar compras sin volver a pedir el nombre.
const ultimoProducto = new Map();
// Ãšltima respuesta por telÃ©fono: frena rÃ¡fagas sin bloquear (cooldown corto).
const cooldown = new Map();

/** Texto de un mensaje o un marcador si es multimedia. */
function textoDe(msg) {
  const real = String((msg && (msg.body || msg.caption)) || '').trim();
  if (real) return real;
  const tipo = String((msg && msg.type) || '');
  const mapa = {
    image: '[imagen]', video: '[video]', audio: '[audio]', ptt: '[nota de voz]',
    document: '[documento]', sticker: '[sticker]', location: '[ubicaciÃ³n]',
    vcard: '[contacto]', multi_vcard: '[contactos]'
  };
  return mapa[tipo] || (msg && msg.hasMedia ? '[archivo]' : '');
}

/**
 * Mensajes que envÃ­as tÃº mismo desde el celular (no los del bot).
 * Se guardan como salientes del panel para que la conversaciÃ³n quede completa.
 */
async function manejarMensajePropio(msg, sesionId = null) {
  if (!msg.fromMe || msg.isStatus) return;
  if (String(msg.type || '') === 'reaction' || msg.isNotification) return;
  const dest = String(msg.to || '');
  if (dest.endsWith('@g.us') || dest === 'status@broadcast') return;
  let tel = normalizar(dest.split('@')[0]);
  if (!dest.endsWith('@c.us')) {
    const real = await resolverTelefonoWa(dest, sesionId);
    if (real) tel = real;
  }
  if (!/^\d{8,15}$/.test(tel)) return;
  // Ignora mensajes dirigidos al propio nÃºmero del bot (chat contigo mismo / ubicaciones).
  let propios = [];
  try { propios = estadoWa().map(s => String(s.numero || '')).filter(Boolean); } catch {}
  if (propios.includes(tel)) return;
  const texto = textoDe(msg);
  if (!texto) return;
  const waId = idMensaje(msg);
  if (yaExisteWa(tel, waId)) return;
  let cliente = null;
  try { cliente = await getCliente(tel); } catch {}
  const nombre = msg._data?.notifyName || cliente?.nombre || '';
  registrar({ telefono: tel, texto, direccion: 'saliente', nombre, clienteId: cliente?.id, origen: 'panel', waId });
  try { await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto, origen: 'panel' }); } catch {}
}

/** Texto legible del estado de entrega/lectura de WhatsApp (palomitas). */
const TEXTO_ACK = { 0: 'pendiente â³', 1: 'enviado âœ“', 2: 'entregado âœ“âœ“', 3: 'leÃ­do âœ“âœ“', 4: 'reproducido âœ“âœ“' };

/**
 * Estado de entrega/lectura de un mensaje saliente. WhatsApp lo emite por el
 * evento `message_ack`; aquÃ­ se refleja en la conversaciÃ³n para mostrar las
 * palomitas en el panel y dejar constancia en el registro.
 */
async function manejarAck(msg, ack, sesionId = null) {
  try {
    if (!msg || !msg.fromMe) return;
    const dest = String(msg.to || '');
    if (!dest || dest.endsWith('@g.us') || dest === 'status@broadcast') return;
    let tel = normalizar(dest.split('@')[0]);
    if (!dest.endsWith('@c.us')) {
      const real = await resolverTelefonoWa(dest, sesionId);
      if (real) tel = real;
    }
    if (!/^\d{8,15}$/.test(tel)) return;
    const waId = idMensaje(msg);
    if (!waId) return;
    if (actualizarAck(tel, waId, ack)) {
      log(`Mensaje a +${tel} ${TEXTO_ACK[Number(ack)] || ('estado ' + ack)}.`);
    }
  } catch (e) {
    log('Error al registrar el estado del mensaje: ' + e.message);
  }
}

async function notificarDueno(texto, sesionId = null) {
  if (!config.ownerNumber) return;
  try {
    let env;
    try {
      env = await enviar(config.ownerNumber, texto, sesionId);
    } catch {
      env = await enviar(config.ownerNumber, texto);
    }
    await logMensaje({ telefono: config.ownerNumber, direccion: 'saliente', texto, origen: 'aviso' });
    // TambiÃ©n queda en la Bandeja: ningÃºn aviso del bot debe quedar fuera del panel.
    registrar({ telefono: config.ownerNumber, texto, direccion: 'saliente', nombre: 'Aviso del bot', origen: 'aviso', waId: env?.waId || '' });
  } catch (e) {
    log('No se pudo avisar al dueÃ±o: ' + e.message);
  }
}

async function manejarMensaje(msg, sesionId = null) {
  if (msg.fromMe || msg.isStatus) return;
  if (String(msg.type || '') === 'reaction' || msg.isNotification) return;
  const chat = String(msg.from || '');
  if (chat.endsWith('@g.us') || chat === 'status@broadcast') return;
  let tel = normalizar(chat.split('@')[0]);
  if (!chat.endsWith('@c.us')) {
    const real = await resolverTelefonoWa(chat, sesionId);
    if (real) tel = real;
  }
  if (!/^\d{8,15}$/.test(tel)) return;

  if (config.modoPrueba && !config.numerosPrueba.includes(tel)) {
    log(`[PRUEBA] Mensaje de +${tel} ignorado (no estÃ¡ en NUMEROS_PRUEBA).`);
    return;
  }

  // Dedupe por id crudo del mensaje: WhatsApp Web puede reemitir el mismo
  // mensaje (historial + en vivo), y sin esto la IA responderÃ­a dos veces.
  const waId = idMensaje(msg);
  if (waId && yaRespondidos.has(waId)) return;
  if (waId) {
    yaRespondidos.add(waId);
    if (yaRespondidos.size > 1200) yaRespondidos.delete(yaRespondidos.values().next().value);
  }

  let texto = textoDe(msg);
  if (!texto) {
    log(`Mensaje vacÃ­o de +${tel} (sin texto ni multimedia).`);
    return;
  }
  let esTextoReal = !/^\[/.test(texto);
  // Texto que se envÃ­a a la IA: sin el prefijo de las notas de voz, para que las
  // reglas (saludos, precios, etc.) funcionen igual que con texto normal.
  let textoIA = texto; // los marcadores [imagen]/[video]/â€¦ no son texto real
  let audioFallido = false;

  // Notas de voz: se transcriben con IA para poder responderlas como texto.
  // Se detecta por tipo, por _data.type y por mimetype: si no, algunos audios
  // caÃ­an en el bloque de multimedia y el bot los ignoraba en silencio.
  const tipoMsg = String(msg.type || (msg._data && msg._data.type) || '').toLowerCase();
  const mimetypeMsg = String((msg._data && msg._data.mimetype) || msg.mimetype || '').toLowerCase();
  const esAudio = /^(ptt|audio)$/.test(tipoMsg) || (msg.hasMedia && /audio|ogg|opus|mpeg/.test(mimetypeMsg));
  if (!esTextoReal && esAudio) {
    try {
      const media = await descargarMediaWa(msg, sesionId);
      if (media && media.data) {
        const tr = await transcribirAudio({ base64: media.data, mimeType: media.mimetype || 'audio/ogg' });
        const dur = Number((msg._data && msg._data.duration) || msg.duration || 0);
        if (tr) {
          texto = 'ðŸŽ¤ ' + tr;
          textoIA = tr;
          esTextoReal = true;
          log(`Nota de voz de +${tel}${dur ? ` (${dur}s)` : ''} transcrita (${tr.length} caracteres): ${tr.slice(0, 120)}`);
        } else {
          audioFallido = true;
          log(`Nota de voz de +${tel}${dur ? ` (${dur}s)` : ''} sin transcripciÃ³n (audio vacÃ­o/no entendible). Se pedirÃ¡ repetir.`);
        }
      } else {
        audioFallido = true;
        log(`No se pudo obtener el audio de +${tel}: ${(media && media.error) || 'sin datos de descarga'}.`);
      }
    } catch (e) {
      audioFallido = true;
      log(`No se pudo transcribir la nota de voz de +${tel}: ${e.message}`);
    }
  }

  const cliente = await getCliente(tel);
  const hist = await historial(tel, 8);
  const nombreChat = msg._data?.notifyName || cliente?.nombre || `+${tel}`;
  await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'entrante', texto, origen: 'cliente' });
  registrar({ telefono: tel, texto, direccion: 'entrante', nombre: nombreChat, clienteId: cliente?.id, origen: 'cliente', waId });

  // Si el audio no se pudo transcribir, nunca se deja al cliente en visto.
  if (audioFallido) {
    const aviso = 'No pude escuchar bien tu audio ðŸ˜• Â¿Me lo escribes o me lo mandas de nuevo, un poquito mÃ¡s corto?';
    try {
      const envA = await enviar(tel, aviso, sesionId);
      await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: aviso, origen: 'bot' });
      registrar({ telefono: tel, texto: aviso, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'bot', waId: envA?.waId || '' });
    } catch (e) { log('No se pudo avisar que el audio fallÃ³: ' + e.message); }
    return;
  }

  // Baja explÃ­cita
  if (esTextoReal && /^\s*(baja|stop|no me escribas|no quiero recibir|eliminar)\s*[.!]*\s*$/i.test(texto)) {
    if (cliente) {
      try {
        await marcarBaja(cliente);
        const r = 'Listo, no volveremos a enviarte promociones. Gracias por avisarnos ðŸ™Œ';
        const env = await enviar(tel, r, sesionId);
        await logMensaje({ clienteId: cliente.id, telefono: tel, direccion: 'saliente', texto: r, origen: 'bot' });
        registrar({ telefono: tel, texto: r, direccion: 'saliente', nombre: nombreChat, clienteId: cliente.id, origen: 'bot', waId: env?.waId || '' });
        log(`Baja registrada: ${cliente.nombre} (+${tel}).`);
      } catch (e) { log('Error al registrar baja: ' + e.message); }
    }
    return;
  }

  // Toda conversaciÃ³n nueva empieza con saludo + agradecimiento (mensaje 1).
  // Solo se envÃ­a una vez por chat: si ya hay algÃºn mensaje saliente, no repite.
  const chatPrevio = obtener(tel);
  const yaHuboSaliente = !!(chatPrevio && (chatPrevio.mensajes || []).some(m => m.direccion === 'saliente'));
  if (esTextoReal && !yaHuboSaliente) {
    try {
      await enviarBienvenida({ tel, nombre: nombreChat, clienteId: cliente?.id, sesionId });
    } catch (e) { log('No se pudo enviar la bienvenida: ' + e.message); }
  }

  // CatÃ¡logo: se envÃ­a el PDF con los rangos de pÃ¡ginas por categorÃ­a.
  if (esTextoReal && pideCatalogo(texto)) {
    try {
      await enviarCatalogo({ tel, nombre: nombreChat, clienteId: cliente?.id, sesionId });
    } catch (e) { log('No se pudo enviar el catÃ¡logo: ' + e.message); }
    return;
  }

  // Flujos determinÃ­sticos de compra: resumen, mÃ©todo de pago y agenda.
  // Van antes de la IA para que el pedido exista aunque la IA estÃ© apagada.
  if (esTextoReal) {
    if (await procesarResumenCompra({ tel, nombre: nombreChat, clienteId: cliente?.id, texto, sesionId })) return;
    if (await procesarMetodoPagoPedido({ tel, nombre: nombreChat, clienteId: cliente?.id, texto, sesionId })) return;
    if (await procesarAgendaPedido({ tel, nombre: nombreChat, clienteId: cliente?.id, texto, sesionId })) return;
    if (await responderProductoDirecto({ tel, nombre: nombreChat, clienteId: cliente?.id, texto, sesionId })) return;
    if (await procesarCompraDirecta({ tel, nombre: nombreChat, clienteId: cliente?.id, texto, sesionId })) return;
  }

  // Multimedia sin texto: si es un comprobante y hay un pedido abierto, se
  // guarda en el mÃ³dulo de pedidos. El bot NO confirma el pago: solo avisa.
  if (!esTextoReal) {
    const abierto = pedidos.pedidoAbierto(tel);
    const tipo = String(msg.type || '');
    if (abierto && /^(image|document)$/.test(tipo)) {
      try {
        const media = await descargarMediaWa(msg, sesionId);
        if (media && media.data) {
          const archivo = guardarComprobante(abierto.id, media);
          const actualizado = pedidos.agregarComprobante(abierto.id, {
            archivo,
            mimetype: media.mimetype,
            nota: 'Enviado por WhatsApp'
          });
          const textoComp = 'ðŸ§¾ [comprobante de pago]';
          await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'entrante', texto: textoComp, origen: 'cliente' });
          registrar({ telefono: tel, texto: textoComp, direccion: 'entrante', nombre: nombreChat, clienteId: cliente?.id, origen: 'cliente', waId });
          emitir('comprobante', {
            telefono: tel,
            nombre: nombreChat,
            pedidoId: actualizado.id,
            total: actualizado.total,
            archivo,
            detalle: resumenPedido(actualizado)
          });
          // Aviso al dueÃ±o SIEMPRE (web con sonido + WhatsApp).
          await notificarDueno(
            `ðŸ§¾ *COMPROBANTE RECIBIDO*\n\n${resumenPedido(actualizado)}\n\nðŸ‘‰ Revisa el comprobante en la pestaÃ±a *Pedidos* y confirma el pago.`,
            sesionId
          );
          const aviso = 'RecibÃ­ tu comprobante âœ… Ya quedÃ³ registrado. Te confirmo por aquÃ­ en un momento.';
          const env = await enviar(tel, aviso, sesionId);
          await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: aviso, origen: 'bot' });
          registrar({ telefono: tel, texto: aviso, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'bot', waId: env?.waId || '' });
          log(`Comprobante del pedido ${actualizado.id} recibido de +${tel} (${archivo}). Sin confirmar pago.`);
          return;
        }
        log(`No se pudo descargar el comprobante de +${tel}: ${media?.error || 'sin datos'}.`);
      } catch (e) {
        log('No se pudo guardar el comprobante de +' + tel + ': ' + e.message);
      }
    }
    log(`Multimedia de +${tel} guardada (${texto}).`);
    return;
  }

  const ia = estadoIA();
  if (!ia.activa) { log(`Asistente IA apagado; no se responde a +${tel}.`); return; }
  if (!ia.autoRespuesta) { log(`Respuesta automÃ¡tica desactivada; no se responde a +${tel}.`); return; }
  if (estaPausado(tel)) { log(`ConversaciÃ³n con +${tel} en pausa; la IA no responde.`); return; }
  // Los nÃºmeros de prueba (y el del dueÃ±o) reciben respuesta aunque sea fuera de horario.
  // Solo los números configurados explícitamente en NUMEROS_PRUEBA tienen el
  // trato de prueba. En producción esa lista va vacía: todos son clientes reales.
  const esPrueba = config.numerosPrueba.includes(tel);
  if (!esPrueba && !dentroHorario()) { log(`Mensaje fuera de horario de +${tel}; no se responde automÃ¡ticamente.`); return; }
  if (!cliente && !config.responderDesconocidos) return;
  if (!esPrueba && ia.maxPorConversacion > 0 && respuestasIA(tel) >= ia.maxPorConversacion) {
    log(`LÃ­mite de ${ia.maxPorConversacion} respuestas automÃ¡ticas alcanzado con +${tel}; queda para el dueÃ±o.`);
    return;
  }
  if (!esPrueba && config.cooldownSegundos > 0 && Date.now() - (cooldown.get(tel) || 0) < config.cooldownSegundos * 1000) {
    log(`Respuesta omitida por enfriamiento corto (${tel}, ${config.cooldownSegundos}s).`);
    return;
  }
  cooldown.set(tel, Date.now());

  try {
    log(`Pensando respuesta para +${tel}...`);
    const ai = await redactarRespuesta({ mensaje: textoIA, historial: hist, cliente, contexto: promptIA() });
    if (ai.derivar) {
      // Con nÃºmeros de prueba (o el del dueÃ±o) nunca se pausa ni se avisa: se
      // responde algo Ãºtil para poder seguir probando el flujo con IA.
      if (esPrueba) {
        const ayuda = /reclamo/i.test(ai.motivo)
          ? 'Lamento lo ocurrido. Te paso con un administrador para que revise tu caso personalmente ðŸ™Œ'
          : 'Te paso con un administrador para que te atienda personalmente ðŸ™Œ';
        log(`Enviando respuesta a +${tel}...`);
        const envP = await enviar(tel, ayuda, sesionId);
        await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: ayuda, origen: 'ia' });
        registrar({ telefono: tel, texto: ayuda, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'ia', waId: envP?.waId || '' });
        log(`DerivaciÃ³n evitada (nÃºmero de prueba) con +${tel}: ${ai.motivo}`);
        return;
      }
      pausarIA(tel, true, ai.motivo, nombreChat);
      await notificarDueno(
        `âš ï¸ *ATENCIÃ“N REQUERIDA*\n\nðŸ‘¤ Cliente: ${cliente?.nombre || '+' + tel}\nðŸ“± WhatsApp: +${tel}\nðŸ“ Motivo: ${ai.motivo}\n\nðŸ’¬ *ÃšLTIMO MENSAJE*\n${String(texto).slice(0, 300)}\n\nðŸ‘‰ AtiÃ©ndelo desde la pestaÃ±a *Bandeja*.`,
        sesionId
      );
      emitir('derivacion', {
        telefono: tel,
        nombre: nombreChat,
        motivo: ai.motivo,
        mensaje: String(texto).slice(0, 300)
      });
      const aviso = /reclamo/i.test(ai.motivo)
        ? 'Lamento lo ocurrido. Te paso con un administrador para que revise tu caso personalmente ðŸ™Œ'
        : 'Te paso con un administrador para que te atienda personalmente ðŸ™Œ';
      const env2 = await enviar(tel, aviso, sesionId);
      await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: aviso, origen: 'bot', estado: 'derivado' });
      registrar({ telefono: tel, texto: aviso, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'sistema', estado: 'derivado', waId: env2?.waId || '' });
      log(`ConversaciÃ³n derivada al dueÃ±o y pausada: +${tel} (${ai.motivo}).`);
      return;
    }
    log(`Enviando respuesta a +${tel}...`);
    // Saludo obligatorio en el primer mensaje y cuando llega un resumen de compra.
    // La IA puede omitirlo; aquÃ­ se garantiza sin duplicar si ya saluda.
    const chatLocal = obtener(tel);
    const yaRespondio = !!(chatLocal && (chatLocal.mensajes || []).some(m => m.direccion === 'saliente'));
    const esResumenCompra = !!(ai.pedido && (ai.pedido.productoId || ai.pedido.ml));
    if (!yaRespondio || esResumenCompra) {
      const nom = /^\+/.test(String(nombreChat || '')) ? '' : primerNombre(nombreChat);
      let cuerpo = String(ai.texto || '').trim();
      const yaSaluda = /^[Â¡!Â¿\s]*(buenos|buenas|hola|qu[eÃ©] tal|hey)/i.test(cuerpo);
      if (yaSaluda) {
        cuerpo = cuerpo.replace(/^[Â¡!Â¿\s]*(buenos d[iÃ­]as|buenas tardes|buenas noches|hola|qu[eÃ©] tal|hey)[,!. ]*/i, '').trim();
      }
      if (cuerpo) ai.texto = `${saludoHora()}${nom ? ', ' + nom : ''}. ${cuerpo}`;
    }
    // Si la IA detectÃ³ una compra, el pedido queda registrado en el mÃ³dulo.
    // Nunca se confirma el pago: solo se prepara para que el dueÃ±o lo revise.
    let pedidoIA = null;
    if (ai.pedido?.productoId) {
      pedidoIA = await procesarPedidoIA({
        tel,
        nombre: nombreChat,
        clienteId: cliente?.id,
        pedidoIA: ai.pedido
      });
    }
    const pagoPendiente = !!(
      pedidoIA &&
      pedidoIA.pedido.estado === 'esperando_pago' &&
      ['yape', 'plin', 'transferencia'].includes(pedidoIA.pedido.metodo) &&
      !pedidoIA.pedido.pagoEnviadoEn
    );

    // Foto del perfume recomendado + precio. Si hay que enviar la plantilla de
    // pago, se prioriza el texto y luego la plantilla (no dos imÃ¡genes seguidas).
    const prod = ai.productoId ? await productoPorId(ai.productoId) : null;
    if (prod) ultimoProducto.set(tel, prod.id);
    const media = prod ? mediaProducto(prod) : null;
    let enviado = false;
    if (media && !pagoPendiente) {
      try {
        const envFoto = await enviarImagen(tel, media, ai.texto, sesionId);
        const textoReg = 'ðŸ“· ' + ai.texto;
        await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: textoReg, origen: 'ia' });
        registrar({ telefono: tel, texto: textoReg, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'ia', waId: envFoto?.waId || '' });
        enviado = true;
        log(`Respuesta IA con foto de ${prod.nombre} a +${tel}.`);
      } catch (e) {
        log(`No se pudo enviar la foto de ${prod?.nombre || 'producto'} a +${tel}: ${e.message}`);
      }
    }
    if (!enviado) {
      const env = await enviar(tel, ai.texto, sesionId);
      await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: ai.texto, origen: 'ia' });
      registrar({ telefono: tel, texto: ai.texto, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'ia', waId: env?.waId || '' });
    }

    // Segundo mensaje: pregunta cÃ¡lida con tamaÃ±os y precios. Solo cuando la IA
    // recomendÃ³ una fragancia y el cliente todavÃ­a no confirmÃ³ un pedido.
    const preguntaIA = ai.pregunta || (prod && !pedidoIA && !/S\//i.test(ai.texto)
      ? `Â¿Te gustarÃ­a que te preparemos el ${prod.nombre}? Tenemos 50 ml por S/ ${prod.precio_50ml ?? 56} y 100 ml por S/ ${prod.precio_100ml ?? 78} ðŸ˜Š`
      : '');
    if (prod && preguntaIA && !pedidoIA) {
      try {
        await new Promise(r => setTimeout(r, 1200));
        const envQ = await enviar(tel, preguntaIA, sesionId);
        await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: preguntaIA, origen: 'ia' });
        registrar({ telefono: tel, texto: preguntaIA, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'ia', waId: envQ?.waId || '' });
        log(`Pregunta interactiva enviada a +${tel}.`);
      } catch (e) {
        log('No se pudo enviar la pregunta de la IA: ' + e.message);
      }
    }

    // Efectivo: la venta se cierra de una vez (se cobra al entregar o recoger).
    if (pedidoIA && pedidoIA.nuevo && pedidoIA.pedido.metodo === 'efectivo' && pedidoIA.pedido.estado === 'por_entregar') {
      const items = (pedidoIA.pedido.items || []).map(i => `${i.cantidad} Ã— ${i.nombre} ${i.ml} ml`).join(' Â· ');
      const cierre = `âœ… Pedido ${pedidoIA.pedido.id} registrado: ${items}. Total S/ ${pedidoIA.pedido.total}. Pago en efectivo al momento de la entrega o recojo. El encargado coordina contigo la entrega ðŸ™Œ`;
      const envC = await enviar(tel, cierre, sesionId);
      await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: cierre, origen: 'bot' });
      registrar({ telefono: tel, texto: cierre, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'bot', waId: envC?.waId || '' });
    }

    if (pagoPendiente) {
      await enviarDatosPago({ tel, pedido: pedidoIA.pedido, nombre: nombreChat, clienteId: cliente?.id, sesionId });
    }

    if (ai.respaldo) {
      log(`Respuesta de respaldo a +${tel}${ai.motivoFallo ? ' (fallÃ³ la IA: ' + ai.motivoFallo + ')' : ''}: ${ai.texto.slice(0, 90)}`);
    } else {
      log(`Respuesta IA a +${tel}: ${ai.texto.slice(0, 90)}${ai.texto.length > 90 ? '...' : ''}`);
    }
  } catch (e) {
    log('Error al responder con IA: ' + e.message);
  }
}

/* ---------------- API ---------------- */
function auth(req, res, next) {
  if (!config.botToken) return next();
  const t = req.get('x-bot-token') || req.query.token || '';
  if (t === config.botToken) return next();
  res.status(401).json({ error: 'Token del bot invÃ¡lido' });
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (_req, res) => res.redirect('/panel'));
app.get('/panel', (_req, res) => res.sendFile(panelPath));
app.use('/media/comprobantes', express.static(comprobantesDir, { fallthrough: true, maxAge: '1h' }));
app.use('/media/productos', express.static(path.join(raizProyecto, 'assets', 'img', 'products'), { fallthrough: true, maxAge: '1d' }));

// PÃ¡gina mÃ­nima: solo el QR, grande y autorefrescante.
app.get('/qr', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>QR WhatsApp Â· PerfumerÃ­a Fina</title>
<style>
html,body{height:100%;margin:0;background:#07080C;color:#E8ECF4;font:16px system-ui,sans-serif;display:grid;place-items:center}
main{text-align:center;padding:20px}
h1{font-size:20px;color:#E0B85A;margin:0 0 .4rem}
img{width:min(78vmin,620px);height:auto;background:#fff;padding:16px;border-radius:16px;image-rendering:pixelated;display:block;margin:1rem auto}
p{color:#8B94A8;font-size:14px;margin:.4rem 0}
.hide{display:none}
</style></head><body><main>
<h1>Vincula tu WhatsApp</h1>
<p>WhatsApp &rarr; Dispositivos vinculados &rarr; Vincular dispositivo</p>
<img id="q" alt="QR de WhatsApp">
<p id="s">Generando QRâ€¦</p>
</main>
<script>
const q=document.getElementById('q'),s=document.getElementById('s'),h=document.querySelector('h1');
let last='';
async function tick(){
  try{
    const e=await (await fetch('/api/estado?t='+Date.now(),{cache:'no-store'})).json();
    const ses=(e.sesiones||[]).find(x=>String(x.id)==='1')||{};
    if(ses.estado==='conectado'){
      h.textContent='âœ… WhatsApp conectado';
      q.classList.add('hide');
      s.textContent='NÃºmero +'+(ses.numero||'')+' listo para enviar. Ya puedes cerrar esta pÃ¡gina.';
      return;
    }
    const r=await fetch('/api/qr?sesion=1&t='+Date.now(),{cache:'no-store'});
    if(r.ok){
      const b=await r.blob();
      const u=URL.createObjectURL(b);
      if(last)URL.revokeObjectURL(last);
      last=u;q.src=u;q.classList.remove('hide');
      s.textContent='QR activo Â· se actualiza solo';
    }else{
      q.classList.add('hide');
      s.textContent='Sin QR por ahora: puede que ya estÃ© conectado o que la sesiÃ³n estÃ© iniciandoâ€¦';
    }
  }catch(e){s.textContent='No se pudo cargar el QR: '+e.message}
}
tick();setInterval(tick,2500);
</script></body></html>`);
});

/* ---------------- estado (hot path cacheado, F-05/UI-08) ---------------- */
// El chip y el QR del panel llaman /api/estado constantemente. Antes cada
// llamada hacÃ­a un count a Supabase y devolvÃ­a el QR en base64. Ahora:
//  - la respuesta se cachea 2 s (sin I/O),
//  - el count de "programadas" se refresca en segundo plano cada 30 s,
//  - el campo qr ya NO viaja en el payload: el QR se sirve por /api/qr.
let programadas = 0;
let cacheEstado = { t: 0, cuerpo: null };

async function refrescarProgramadas() {
  if (!sb) return;
  try {
    const { count, error } = await conTimeout(
      sb.from('campanas').select('id', { count: 'exact', head: true }).eq('estado', 'programada'),
      8000,
      'contar campaÃ±as programadas'
    );
    if (error) throw new Error(error.message || String(error));
    programadas = Number(count) || 0;
  } catch (e) {
    log('No se pudo contar las campaÃ±as programadas: ' + e.message);
  }
}

app.get('/api/estado', auth, (_req, res) => {
  const ahora = Date.now();
  if (cacheEstado.cuerpo && ahora - cacheEstado.t < 2000) return res.json(cacheEstado.cuerpo);
  // Sin QR en el payload: /api/qr lo entrega binario y con su propio cacheo.
  const sesiones = estadoWa().map(({ qr, ...s } = {}) => s);
  const cuerpo = {
    sesiones,
    conectado: sesiones.some(s => s.conectado),
    cola: cola.size,
    programadas,
    enviadosHoy: dia.n,
    maxPorDia: config.maxPorDia,
    autoRespuesta: config.autoRespuesta,
    modoPrueba: config.modoPrueba,
    dentroHorario: dentroHorario(),
    horario: { inicio: config.horaInicio, fin: config.horaFin, lunesASabado: config.lunesASabado },
    delay: { min: config.delayMin, max: config.delayMax },
    ia: resumenIA(),
    chats: resumenChats(),
    version: '1.0.0'
  };
  cacheEstado = { t: ahora, cuerpo };
  res.json(cuerpo);
});

app.get('/api/qr', auth, (req, res) => {
  const s = req.query.sesion ? estadoWa().find(x => x.id === String(req.query.sesion)) : estadoWa().find(x => x.qr);
  if (!s?.qr) return res.status(404).json({ error: 'No hay QR disponible' });
  const base64 = s.qr.split(',')[1];
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(base64, 'base64'));
});

app.get('/api/campanas', auth, async (_req, res) => {
  if (!sb) return res.json({ campanas: [] });
  const { data, error } = await sb
    .from('campanas')
    .select('id,titulo,estado,fecha_programada,mensaje_final')
    .order('fecha_programada', { ascending: true, nullsFirst: false })
    .limit(25);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ campanas: data || [] });
});

app.get('/api/logs', auth, (_req, res) => res.json({ logs: logs.slice(-120) }));

/* ---------------- Borradores de campaÃ±a con IA ---------------- */
app.post('/api/borradores', auth, async (req, res) => {
  try {
    const borradores = await redactarBorradores({
      objetivo: req.body?.objetivo,
      condiciones: req.body?.condiciones,
      segmento: req.body?.segmento,
      productos: req.body?.productos
    });
    if (!borradores.length) return res.status(502).json({ error: 'La IA no devolviÃ³ borradores. Intenta de nuevo.' });
    log(`Borradores de campaÃ±a generados (${borradores.length}).`);
    res.json({ borradores });
  } catch (e) {
    log('Error al generar borradores: ' + e.message);
    res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
});

/* ---------------- Anuncios (mensaje Ãºnico con filtros) ---------------- */
app.get('/api/anuncios', auth, (_req, res) => {
  res.json({
    anuncios: anuncios.listar(),
    resumen: anuncios.resumen(),
    filtros: anuncios.FILTROS,
    estados: anuncios.ESTADOS
  });
});

app.post('/api/anuncios/preview', auth, async (req, res) => {
  try {
    res.json(await previsualizarAnuncio(req.body || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/anuncios/ia', auth, async (req, res) => {
  try {
    const texto = await redactarAnuncio({
      objetivo: req.body?.objetivo,
      tono: req.body?.tono,
      catalogo: req.body?.catalogo === true,
      video: req.body?.video === true
    });
    res.json({ ok: true, texto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/anuncios', auth, (req, res) => {
  try {
    const a = anuncios.crear(req.body || {});
    log(`Anuncio creado: ${a.titulo} (${a.id}).`);
    res.json({ ok: true, anuncio: a });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/anuncios/:id', auth, (req, res) => {
  try {
    res.json({ ok: true, anuncio: anuncios.actualizar(req.params.id, req.body || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/anuncios/:id', auth, (req, res) => {
  try {
    if (!anuncios.eliminar(req.params.id)) return res.status(404).json({ error: 'Anuncio no encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/anuncios/:id/enviar', auth, (req, res) => {
  const id = String(req.params.id || '');
  const a = anuncios.obtener(id);
  if (!a) return res.status(404).json({ error: 'Anuncio no encontrado.' });
  if (a.estado === 'enviando') return res.status(409).json({ error: 'El anuncio ya se estÃ¡ enviando.' });
  if (!config.modoPrueba && !hayConexion()) return res.status(503).json({ error: 'NingÃºn WhatsApp estÃ¡ conectado.' });
  const ok = cola.add('anuncio:' + id, () => enviarAnuncio(id).catch(e => log('Anuncio: ' + e.message)));
  log(`Anuncio "${a.titulo}" en cola (${a.id}).`);
  res.json({ ok, cola: cola.size });
});

/* ---------------- Pedidos y pagos ---------------- */
app.get('/api/pedidos', auth, (req, res) => {
  res.json({
    pedidos: pedidos.listar({
      estado: req.query.estado || '',
      telefono: req.query.telefono || '',
      limite: req.query.limite
    }),
    resumen: pedidos.resumen(),
    estados: pedidos.ESTADOS,
    metodos: pedidos.METODOS
  });
});

app.get('/api/pedidos/:id', auth, (req, res) => {
  const p = pedidos.obtener(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json({ pedido: p });
});

app.post('/api/pedidos', auth, (req, res) => {
  try {
    const p = pedidos.crear(req.body || {});
    emitir('pedido', {
      telefono: p.telefono,
      nombre: p.nombre,
      pedidoId: p.id,
      estado: p.estado,
      total: p.total,
      detalle: resumenPedido(p)
    });
    log(`Pedido ${p.id} creado desde el panel para +${p.telefono} (S/ ${p.total}, ${p.estado}).`);
    res.json({ ok: true, pedido: p });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/pedidos/:id', auth, (req, res) => {
  try {
    const p = pedidos.actualizar(req.params.id, req.body || {});
    if (p.estado === 'entregado') {
      const nuevas = seguimiento.programarPedido(p);
      if (nuevas) log(`Pedido ${p.id} entregado: ${nuevas} seguimiento(s) programado(s) para +${p.telefono}.`);
    }
    if (p.estado === 'cancelado') {
      const n = seguimiento.cancelarPedido(p.id);
      if (n) log(`Pedido ${p.id} cancelado: ${n} seguimiento(s) anulado(s).`);
    }
    log(`Pedido ${p.id} actualizado: ${p.estado}${p.metodo ? ' Â· ' + p.metodo : ''} Â· S/ ${p.total}.`);
    // Aviso en vivo al panel (SSE): el pedido cambiÃ³ de estado desde el CRM.
    emitir('pedido', {
      telefono: p.telefono,
      nombre: p.nombre,
      pedidoId: p.id,
      estado: p.estado,
      total: p.total,
      metodo: p.metodo || '',
      detalle: resumenPedido(p)
    });
    res.json({ ok: true, pedido: p });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Adjunta un comprobante subido desde el panel (dataURL). */
app.post('/api/pedidos/:id/comprobante', auth, (req, res) => {
  try {
    const p = pedidos.obtener(req.params.id);
    if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });
    const m = String(req.body?.imagen || '').match(/^data:([^;]+);base64,([\s\S]+)$/);
    if (!m) return res.status(400).json({ error: 'Sube una imagen vÃ¡lida (JPG, PNG o WEBP).' });
    const archivo = guardarComprobante(p.id, { mimetype: m[1], data: m[2] });
    const actualizado = pedidos.agregarComprobante(p.id, { archivo, mimetype: m[1], nota: 'Subido desde el panel' });
    emitir('comprobante', {
      telefono: actualizado.telefono,
      nombre: actualizado.nombre,
      pedidoId: actualizado.id,
      total: actualizado.total,
      archivo,
      detalle: resumenPedido(actualizado)
    });
    res.json({ ok: true, pedido: actualizado });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- Seguimiento post-venta por chat ---------------- */
app.get('/api/seguimiento', auth, (_req, res) => res.json(seguimiento.resumen()));

app.get('/api/seguimiento/:telefono', auth, (req, res) => {
  res.json(seguimiento.listar(req.params.telefono));
});

app.post('/api/seguimiento/:telefono', auth, (req, res) => {
  try {
    const tel = normalizar(req.params.telefono);
    if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'TelÃ©fono invÃ¡lido.' });
    const activo = req.body?.activo !== false;
    const estado = seguimiento.activar(tel, activo, req.body?.nombre || '');
    log(`Seguimiento post-venta ${activo ? 'activado' : 'desactivado'} para +${tel}.`);
    res.json({ ok: true, ...estado });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- AnalÃ­ticas ---------------- */
const sinTildes = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

app.get('/api/analiticas', auth, async (_req, res) => {
  try {
    const productos = await getProductos();
    const msgs = mensajesEntrantes(20000);
    const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nombres = productos
      .map(p => ({ nombre: p.nombre, clave: sinTildes(p.nombre) }))
      .filter(x => x.clave.length >= 4)
      .map(x => ({
        nombre: x.nombre,
        clave: x.clave,
        // Coincidencia por palabra/frase completa: evita falsos positivos
        // (p. ej. "King" dentro de "looking").
        re: new RegExp(`(^|[^a-z0-9])${escRe(x.clave)}([^a-z0-9]|$)`)
      }));
    const mapa = new Map();
    for (const m of msgs) {
      const t = sinTildes(m.texto);
      for (const n of nombres) {
        if (!n.re.test(t)) continue;
        const fila = mapa.get(n.clave) || { nombre: n.nombre, menciones: 0, chats: new Set() };
        fila.menciones++;
        fila.chats.add(m.telefono);
        mapa.set(n.clave, fila);
      }
    }
    const masConsultados = [...mapa.values()]
      .map(x => ({ nombre: x.nombre, menciones: x.menciones, chats: x.chats.size }))
      .sort((a, b) => b.menciones - a.menciones || b.chats - a.chats)
      .slice(0, 12);
    res.json({
      ok: true,
      chats: resumenChats(),
      analizados: msgs.length,
      dias: porDia(14),
      masConsultados,
      ...pedidos.estadisticas()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Eventos para el panel (sonido/notificaciÃ³n) ---------------- */
// Respaldo por polling (no se toca: el panel viejo lo sigue usando).
app.get('/api/eventos', auth, (req, res) => {
  const desdeId = Number(req.query.desde) || 0;
  res.json({ eventos: eventosDesde(desdeId), ultimo: ultimoEventoId() });
});

/**
 * SSE en vivo: GET /api/stream?token=... (EventSource no puede mandar cabeceras,
 * por eso el auth tambiÃ©n acepta `?token=`).
 * Formato de cada evento: `id: <n>\ndata: <json>\n\n`, con `retry: 3000` y un
 * ping `: ping` cada 15 s para que proxies no corten la conexiÃ³n.
 */
app.get('/api/stream', auth, (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  try { res.flushHeaders?.(); } catch {}
  try { res.write('retry: 3000\n\n'); } catch {}

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 15000);
  ping.unref?.();

  const quitar = suscribir(evento => {
    try { res.write(lineaSSE(evento)); } catch {}
  });
  let cerrado = false;
  const cerrar = () => {
    if (cerrado) return;
    cerrado = true;
    clearInterval(ping);
    quitar();
    sseClientes.delete(res);
    try { res.end(); } catch {}
  };
  sseClientes.add(res);
  req.on('close', cerrar);
  res.on('close', cerrar);
});

/* ---------------- Asistente IA ---------------- */
app.get('/api/ia', auth, (_req, res) => res.json(estadoIA()));

app.post('/api/ia', auth, (req, res) => {
  try {
    const estado = actualizarIA(req.body || {});
    emitir('ia', {
      accion: 'config',
      activa: estado.activa,
      autoRespuesta: estado.autoRespuesta,
      maxPorConversacion: estado.maxPorConversacion,
      pausadas: estado.pausados.length
    });
    res.json(estado);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/ia/pausar', auth, (req, res) => {
  try {
    const tel = normalizar(req.body?.telefono);
    if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'TelÃ©fono invÃ¡lido.' });
    const pausado = req.body?.pausado !== false;
    const estado = pausarIA(tel, pausado, req.body?.motivo || '', req.body?.nombre || '');
    log(`${pausado ? 'IA pausada' : 'IA reanudada'} para +${tel}${pausado && req.body?.motivo ? ' (' + req.body.motivo + ')' : ''}.`);
    emitir('ia', {
      accion: pausado ? 'pausar' : 'reanudar',
      telefono: tel,
      pausado,
      motivo: String(req.body?.motivo || ''),
      pausadas: estado.pausados.length,
      activa: estado.activa,
      autoRespuesta: estado.autoRespuesta
    });
    res.json(estado);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/estadisticas', auth, (req, res) => {
  const nDias = Math.min(30, Math.max(1, Number(req.query.dias) || 7));
  const dias = porDia(nDias);
  const totalEntrantes = dias.reduce((n, d) => n + d.entrantes, 0);
  const totalSalientes = dias.reduce((n, d) => n + d.salientes, 0);
  res.json({
    dias,
    totalEntrantes,
    totalSalientes,
    chats: resumenChats(),
    ia: resumenIA(),
    enviadosHoy: dia.n,
    maxPorDia: config.maxPorDia,
    programadas: null
  });
});

/* ---------------- Bandeja de entrada ---------------- */
/* ---------------- sincronizaciÃ³n desde WhatsApp ---------------- */

/**
 * Trae la lista completa de chats de WhatsApp y actualiza las cabeceras de la
 * Bandeja (Ãºltimo mensaje, no leÃ­dos, pin, nombre). AsÃ­ el panel se pone al dÃ­a
 * con lo que pasÃ³ mientras el bot estaba apagado, sin borrar mensajes locales.
 * Devuelve { lista, chats } para que el llamador loguee/emita el evento.
 */
async function sincronizarChatsDesdeWhatsApp(sesionId = null) {
  const lista = await conTimeout(listarChatsWa(sesionId), 50000, 'listar chats de WhatsApp');
  let chats = 0;
  for (const c of lista) {
    if (c.esGrupo || !/^\d{8,15}$/.test(c.telefono)) continue;
    registrarCabecera({
      telefono: c.telefono,
      nombre: c.nombre,
      nombreWa: c.nombreWa || c.nombre,
      nombreGuardado: c.nombreGuardado || '',
      pushname: c.pushname || '',
      verifiedName: c.verifiedName || '',
      esEmpresa: c.esEmpresa === true,
      ultimoTexto: c.ultimoTexto,
      ultimoEn: c.ultimoEn,
      noLeidos: c.noLeidos,
      pin: c.pin,
      real: c.real !== false
    });
    chats++;
  }
  return { lista, chats };
}

app.post('/api/sincronizar', auth, async (req, res) => {
  if (!config.modoPrueba && !sesionDisponible(req.body?.sesion || null)) {
    return res.status(503).json({ error: 'NingÃºn WhatsApp estÃ¡ conectado.' });
  }
  const hacerChats = req.body?.chats !== false;
  const hacerContactos = req.body?.contactos !== false;
  const salida = { ok: true, chats: 0, chatsTotal: 0, contactos: 0, contactosNuevos: 0, contactosExistentes: 0 };
  try {
    if (hacerChats) {
      const r = await sincronizarChatsDesdeWhatsApp(req.body?.sesion || null);
      salida.chatsTotal = r.lista.length;
      salida.chats = r.chats;
      if (req.body?.diagnostico) {
        salida.detalle = r.lista.map(c => ({
          telefono: c.telefono,
          nombre: c.nombre,
          nombreWa: c.nombreWa || '',
          esEmpresa: !!c.esEmpresa,
          tipo: c.tipo || '',
          ultimoEn: c.ultimoEn,
          pin: !!c.pin,
          real: c.real !== false,
          tsReal: c.tsReal || 0,
          hay: c.ultimoTexto ? String(c.ultimoTexto).slice(0, 24) : '',
          esGrupo: !!c.esGrupo,
          noLeidos: c.noLeidos || 0
        }));
      }
    }
    if (hacerContactos) {
      if (!sb) return res.status(503).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el bot.' });
      const contactos = await conTimeout(listarContactosWa(req.body?.sesion || null), 50000, 'listar contactos de WhatsApp');
      salida.contactos = contactos.length;
      const actuales = await getClientes();
      const existentes = new Set(actuales.map(c => c.telefono));
      const nuevos = contactos
        .filter(c => esNumeroPeru(c.telefono) && !existentes.has(c.telefono))
        .map(c => ({
          nombre: c.nombre || `+${c.telefono}`,
          telefono: c.telefono,
          activo: true,
          consentimiento: false,
          etiquetas: []
        }));
      salida.contactosExistentes = contactos.filter(c => esNumeroPeru(c.telefono)).length - nuevos.length;
      const r = await importarClientes(nuevos);
      salida.contactosNuevos = r.insertados;
    }
    log(`SincronizaciÃ³n: ${salida.chats} chats Â· ${salida.contactosNuevos} contactos nuevos (de ${salida.contactos}).`);
    emitir('sync', { motivo: 'manual', chats: salida.chats, total: salida.chatsTotal || salida.chats });
    res.json(salida);
  } catch (e) {
    log('Error al sincronizar: ' + (e?.stack || e?.message || e));
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/conversaciones/:telefono/importar', auth, async (req, res) => {
  const tel = normalizar(req.params.telefono);
  if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'TelÃ©fono invÃ¡lido.' });
  if (!config.modoPrueba && !sesionDisponible(req.body?.sesion || null)) {
    return res.status(503).json({ error: 'NingÃºn WhatsApp estÃ¡ conectado.' });
  }
  try {
    const msgs = await historialWa(tel, Number(req.body?.limite) || 50, req.body?.sesion || null);
    const nuevos = importarMensajes(tel, msgs);
    res.json({ ok: true, leidos: msgs.length, nuevos });
  } catch (e) {
    log('Error al importar historial de +' + tel + ': ' + (e?.stack || e?.message || e));
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clientes', auth, async (_req, res) => {
  try {
    res.json({ clientes: await getClientes() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/conversaciones', auth, (req, res) => {
  const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 40));
  const ia = estadoIA();
  const pausados = new Set(ia.pausados.map(p => p.telefono));
  res.json({
    conversaciones: listar(limite).map(c => ({
      ...c,
      pausado: pausados.has(c.telefono),
      seguimiento: seguimiento.estaActivo(c.telefono),
      etiquetas: pedidos.etiquetasChat(c.telefono)
    })),
    resumen: resumenChats(),
    ia: { activa: ia.activa, autoRespuesta: ia.autoRespuesta, pausadas: ia.pausados }
  });
});

app.get('/api/conversaciones/:telefono', auth, (req, res) => {
  const tel = normalizar(req.params.telefono);
  const c = obtener(tel);
  if (!c) return res.status(404).json({ error: 'ConversaciÃ³n no encontrada' });
  const ia = estadoIA();
  res.json({
    ...c,
    pausado: ia.pausados.some(p => p.telefono === tel),
    seguimiento: seguimiento.listar(tel),
    pedidos: pedidos.listar({ telefono: tel, limite: 20 }),
    etiquetas: pedidos.etiquetasChat(tel)
  });
});

app.post('/api/conversaciones/:telefono/leido', auth, (req, res) => {
  marcarLeido(normalizar(req.params.telefono));
  res.json({ ok: true });
});

app.post('/api/conversaciones/:telefono/enviar', auth, async (req, res) => {
  const tel = normalizar(req.params.telefono);
  const texto = String(req.body?.texto || '').trim();
  if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'TelÃ©fono invÃ¡lido.' });
  if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
  if (!config.modoPrueba && !sesionDisponible(req.body?.sesion || null)) {
    return res.status(503).json({ error: 'NingÃºn WhatsApp estÃ¡ conectado.' });
  }
  try {
    const cliente = await getCliente(tel);
    const env = await enviar(tel, texto, req.body?.sesion || null);
    await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto, origen: 'panel' });
    registrar({
      telefono: tel,
      texto,
      direccion: 'saliente',
      nombre: cliente?.nombre || '',
      clienteId: cliente?.id,
      origen: 'panel',
      waId: env?.waId || ''
    });
    log(`Mensaje manual a +${tel}: ${texto.slice(0, 80)}${texto.length > 80 ? '...' : ''}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/revisar', auth, async (_req, res) => {
  await revisarProgramadas(true);
  res.json({ ok: true, cola: cola.size });
});

app.post('/api/enviar/:id', auth, async (req, res) => {
  if (!sb) return res.status(503).json({ error: 'Supabase no configurado' });
  const ok = cola.add('camp:' + req.params.id, () => enviarCampana(req.params.id));
  res.json({ ok, cola: cola.size });
});

app.post('/api/prueba', auth, async (req, res) => {
  const tel = normalizar(req.body?.telefono);
  const texto = String(req.body?.texto || '').trim();
  if (!esNumeroPeru(tel)) return res.status(400).json({ error: 'TelÃ©fono invÃ¡lido. Usa 9 dÃ­gitos o 51XXXXXXXXX.' });
  if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
  const permitidos = new Set([config.ownerNumber, ...config.numerosPrueba].filter(Boolean));
  if (!config.modoPrueba && permitidos.size && !permitidos.has(tel)) {
    return res.status(403).json({ error: 'En modo real solo puedes probar con OWNER_NUMBER o NUMEROS_PRUEBA.' });
  }
  try {
    const env = await enviar(tel, texto, req.body?.sesion || null);
    await logMensaje({ telefono: tel, direccion: 'saliente', texto, origen: 'prueba' });
    // Que el mensaje de prueba tambiÃ©n aparezca en la Bandeja del panel.
    registrar({ telefono: tel, texto, direccion: 'saliente', nombre: '', origen: 'prueba', waId: env?.waId || '' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/prueba-video', auth, async (req, res) => {
  const tel = normalizar(req.body?.telefono);
  const permitidos = new Set([config.ownerNumber, ...config.numerosPrueba].filter(Boolean));
  if (!config.modoPrueba && permitidos.size && !permitidos.has(tel)) {
    return res.status(403).json({ error: 'En modo real solo puedes probar con OWNER_NUMBER o NUMEROS_PRUEBA.' });
  }
  const archivo = path.join(raizProyecto, 'docs', 'auditoria', 'video-crm', 'perfumeria-fina-crm.mp4');
  if (!fs.existsSync(archivo)) return res.status(404).json({ error: 'No existe el video.' });
  try {
    const caption = String(req.body?.texto || 'ðŸŽ¬ Te comparto el video de *PerfumerÃ­a Fina CRM*: rÃ¡pido, claro y sin humo.').slice(0, 300);
    const env = await enviarArchivo(tel, archivo, 'video/mp4', 'Perfumeria-Fina-CRM.mp4', caption, req.body?.sesion || null);
    await logMensaje({ telefono: tel, direccion: 'saliente', texto: 'ðŸŽ¬ ' + caption, origen: 'prueba' });
    registrar({ telefono: tel, texto: 'ðŸŽ¬ ' + caption, direccion: 'saliente', nombre: '', origen: 'prueba', waId: env?.waId || '' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/prueba-foto', auth, async (req, res) => {
  const tel = normalizar(req.body?.telefono || config.ownerNumber || '');
  const productoId = String(req.body?.productoId || '').trim();
  const caption = String(req.body?.texto || '').trim();
  if (!productoId) return res.status(400).json({ error: 'Falta productoId.' });
  const permitidos = new Set([config.ownerNumber, ...config.numerosPrueba].filter(Boolean));
  if (!config.modoPrueba && permitidos.size && !permitidos.has(tel)) {
    return res.status(403).json({ error: 'En modo real solo puedes probar con OWNER_NUMBER o NUMEROS_PRUEBA.' });
  }
  try {
    const prod = await productoPorId(productoId);
    if (!prod) return res.status(404).json({ error: 'Producto no encontrado: ' + productoId });
    const media = mediaProducto(prod);
    if (!media) return res.status(404).json({ error: 'El producto no tiene imagen.' });
    const env = await enviarImagen(tel, media, caption, req.body?.sesion || null);
    await logMensaje({ telefono: tel, direccion: 'saliente', texto: 'ðŸ“· ' + (caption || prod.nombre), origen: 'prueba' });
    registrar({ telefono: tel, texto: 'ðŸ“· ' + (caption || prod.nombre), direccion: 'saliente', nombre: '', origen: 'prueba', waId: env?.waId || '' });
    res.json({ ok: true, producto: prod.nombre, media, env });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: String(e.stack || '').split('\n').slice(0, 6) });
  }
});

app.post('/api/logout', auth, async (req, res) => {
  await cerrarSesion(req.body?.sesion || null);
  res.json({ ok: true });
});

app.post('/api/sesion/reiniciar', auth, async (req, res) => {
  try {
    const ids = await reiniciarSesion(req.body?.sesion || null);
    log(`SesiÃ³n(es) de WhatsApp reiniciada(s): ${ids.join(', ') || 'ninguna'}.`);
    res.json({ ok: true, sesiones: ids });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- prueba de auto-respuesta (apagada por defecto) ---------------- */
app.post('/api/simular-entrante', auth, async (req, res) => {
  if (String(process.env.SIMULAR_ENTRANTES || '').toLowerCase() !== 'true') {
    return res.status(403).json({ error: 'SimulaciÃ³n desactivada. Activa SIMULAR_ENTRANTES=true para probar.' });
  }
  const tel = normalizar(req.body?.telefono);
  const texto = String(req.body?.texto || '').trim();
  if (!esNumeroPeru(tel)) return res.status(400).json({ error: 'TelÃ©fono invÃ¡lido.' });
  if (!texto) return res.status(400).json({ error: 'Falta el texto.' });
  await manejarMensaje({
    from: `${tel}@c.us`,
    fromMe: false,
    isStatus: false,
    body: texto,
    _data: { notifyName: String(req.body?.nombre || '') }
  }, req.body?.sesion || null);
  res.json({ ok: true });
});

/* ---------------- arranque ---------------- */
const faltan = validarConfig();
if (faltan.length) {
  console.error('\nFaltan variables de entorno: ' + faltan.join(', '));
  console.error('Copia bot/.env.example a bot/.env y completa los datos.');
  console.error('El bot arrancarÃ¡ igual para WhatsApp, pero sin Supabase no habrÃ¡ campaÃ±as ni historial.\n');
}

app.listen(config.port, () => {
  log(`Panel del bot: http://localhost:${config.port}/panel`);
  log(`Modo: ${config.modoPrueba ? 'PRUEBA (sin WhatsApp real)' : 'REAL'} Â· Retraso: ${config.delayMin}-${config.delayMax}s Â· LÃ­mite diario: ${config.maxPorDia}`);
  log(`Chromium: ${config.headless ? 'sin ventana (HEADLESS=true) Â· el QR se escanea desde el panel' : 'CON ventana (HEADLESS=false) Â· recomendado solo para depurar'}.`);
  if (config.autoRespuesta) log(`Auto-respuesta ${config.geminiKey || config.anthropicKey ? 'con IA' : 'sin IA (respuestas bÃ¡sicas)'}.`);
});

iniciarWhatsApp({ onMensaje: manejarMensaje, onMensajePropio: manejarMensajePropio, onAck: manejarAck, log, sesionIds: config.sesiones }).catch(e => log('No se pudo iniciar WhatsApp: ' + e.message));

setInterval(() => revisarProgramadas(false), 60 * 1000);
setTimeout(() => revisarProgramadas(false), 8000);

/* ---------------- mantenimiento de envÃ­os (F-01) ---------------- */
// 1) Chequeo de la migraciÃ³n 07 (columnas wa_id/nota). 2) Barrido de envÃ­os que
// quedaron en 'enviando' por un proceso muerto. 3) Count de programadas en
// segundo plano para que /api/estado no toque Supabase en cada peticiÃ³n.
async function mantenimientoArranque() {
  if (!sb) {
    log('Sin Supabase: no se verifican envÃ­os ni campaÃ±as (modo WhatsApp solamente).');
    return;
  }
  try {
    const migracion = await verificarMigracionEnviosCon(sb);
    if (!migracion.ok) {
      const detalle = migracion.error?.message || String(migracion.error || '');
      log('âš ï¸ AVISO: no se pudo verificar la migraciÃ³n sql/07_envios_claim.sql (columnas wa_id/nota). ' +
        'Si faltan, las campaÃ±as NO se enviarÃ¡n (fail-safe) hasta aplicarla. Detalle: ' + detalle.slice(0, 300));
    } else {
      log('MigraciÃ³n de envÃ­os OK (columnas wa_id/nota presentes).');
    }
  } catch (e) {
    log('No se pudo verificar la migraciÃ³n de envÃ­os: ' + e.message);
  }

  try {
    const antes = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await barrerEnviosColgados(sb);
    log(`Barrido de envÃ­os colgados en 'enviando' (anteriores a ${antes}): revisado.`);
  } catch (e) {
    if (esErrorDeMigracion(e)) log('âŒ ' + mensajeErrorMigracion(e));
    else log('No se pudo barrer los envÃ­os colgados: ' + e.message);
  }

  await refrescarProgramadas();
}
setTimeout(() => { mantenimientoArranque().catch(e => log('Mantenimiento de arranque: ' + e.message)); }, 3000);
setInterval(refrescarProgramadas, 30 * 1000);

/* ---------------- sincronizaciÃ³n automÃ¡tica de la Bandeja ---------------- */
// Al conectar (y al reconectar) el bot trae la lista completa de chats de
// WhatsApp para que el panel no se quede con lo que habÃ­a la Ãºltima vez que se
// abriÃ³: Ãºltimos mensajes, no leÃ­dos, nombres y chats nuevos. Los eventos en
// vivo siguen actualizando el resto mientras el bot estÃ¡ conectado.
let syncAutoEnCurso = false;
let syncInicialHecho = false;
let ultimoEstadoConexion = false;

async function sincronizarAuto(motivo) {
  if (config.modoPrueba || syncAutoEnCurso || !hayConexion()) return;
  syncAutoEnCurso = true;
  try {
    const { chats, lista } = await sincronizarChatsDesdeWhatsApp(null);
    syncInicialHecho = true;
    log(`SincronizaciÃ³n automÃ¡tica (${motivo}): ${chats}/${lista.length} chats actualizados en la Bandeja.`);
    emitir('sync', { motivo, chats, total: lista.length });
  } catch (e) {
    log(`No se pudo sincronizar la Bandeja (${motivo}): ${e.message}`);
  } finally {
    syncAutoEnCurso = false;
  }
}

setInterval(() => {
  const conectado = hayConexion();
  if (conectado && !ultimoEstadoConexion) {
    ultimoEstadoConexion = true;
    // PequeÃ±a espera para que WhatsApp Web termine de cargar los chats.
    setTimeout(() => {
      sincronizarAuto(syncInicialHecho ? 'reconexion' : 'inicio');
      // DespuÃ©s de la cabecera, trae los mensajes recientes de los chats ya
      // conocidos (cubre lo que pasÃ³ mientras el bot estaba apagado).
      setTimeout(() => { if (!historialesHechos) actualizarHistorialesConocidos(); }, 8000);
    }, 4000);
  } else if (!conectado) {
    ultimoEstadoConexion = false;
    historialesHechos = false;
  }
}, 5000);
// Refresco periÃ³dico suave (los mensajes en vivo llegan por eventos; esto cubre
// huecos si el evento se perdiÃ³).
setInterval(() => { if (!config.modoPrueba && hayConexion()) sincronizarAuto('periodica'); }, 5 * 60 * 1000);

/**
 * Puesta al dÃ­a de los historiales de los chats ya conocidos. La lista de chats
 * de WhatsApp Web no siempre resuelve los contactos nuevos (@lid) y puede traer
 * solo grupos; para esos chats que ya estÃ¡n en la Bandeja, esto importa los
 * Ãºltimos mensajes reales (incluidos los que llegaron mientras el bot estaba
 * apagado). Se ejecuta una vez al conectar y de nuevo al reconectar.
 */
let historialesEnCurso = false;
let historialesHechos = false;

async function actualizarHistorialesConocidos({ limite = 25, maxChats = 120 } = {}) {
  if (config.modoPrueba || historialesEnCurso || !hayConexion()) return;
  historialesEnCurso = true;
  try {
    const chats = listar(400).filter(c => /^\d{8,15}$/.test(String(c.telefono || ''))).slice(0, maxChats);
    let actualizados = 0;
    for (const c of chats) {
      try {
        const msgs = await conTimeout(historialWa(c.telefono, limite), 30000, 'historial +' + c.telefono);
        if (msgs && msgs.length) {
          const nuevos = importarMensajes(c.telefono, msgs);
          if (nuevos) actualizados++;
        }
      } catch (e) {
        // Un chat problemÃ¡tico no debe detener la puesta al dÃ­a de los demÃ¡s.
        log(`No se pudo actualizar el historial de +${c.telefono}: ${e.message}`);
      }
      await dormir(250);
    }
    log(`Historiales al dÃ­a: ${actualizados}/${chats.length} chats actualizados (Ãºltimos ${limite} mensajes).`);
    emitir('sync', { motivo: 'historiales', chats: actualizados, total: chats.length });
    historialesHechos = true;
  } catch (e) {
    log('No se pudieron actualizar los historiales: ' + e.message);
  } finally {
    historialesEnCurso = false;
  }
}

/* ---------------- seguimiento post-venta ---------------- */
let revisandoSeg = false;
async function revisarSeguimientos() {
  if (revisandoSeg || !hayConexion() || !dentroHorario() || limiteAlcanzado()) return;
  revisandoSeg = true;
  try {
    for (const t of seguimiento.pendientes()) {
      if (limiteAlcanzado()) break;
      const p = pedidos.obtener(t.pedidoId);
      if (!p || p.estado === 'cancelado') {
        seguimiento.omitir(t.id, 'Pedido cancelado');
        continue;
      }
      // Interruptor individual del chat: si estÃ¡ apagado, no se envÃ­a.
      if (!seguimiento.estaActivo(t.telefono)) continue;
      const texto = seguimiento.plantilla(t.tipo, p);
      try {
        const env = await enviar(t.telefono, texto);
        await logMensaje({ clienteId: p.clienteId, telefono: t.telefono, direccion: 'saliente', texto, origen: 'seguimiento' });
        registrar({ telefono: t.telefono, texto, direccion: 'saliente', nombre: p.nombre, clienteId: p.clienteId, origen: 'seguimiento', waId: env?.waId || '' });
        seguimiento.marcarEnviada(t.id);
        contarEnvio();
        emitir('seguimiento', { telefono: t.telefono, nombre: p.nombre, tipo: t.tipo, pedidoId: p.id });
        log(`Seguimiento ${t.tipo} enviado a +${t.telefono} (pedido ${p.id}).`);
      } catch (e) {
        log(`No se pudo enviar el seguimiento a +${t.telefono}: ${e.message}`);
        break;
      }
      await dormir(esperaEntreEnvios(config.delayMin, config.delayMax));
    }
  } finally {
    revisandoSeg = false;
  }
}
setInterval(revisarSeguimientos, 60 * 1000);
setTimeout(revisarSeguimientos, 15000);

/* ---------------- apagado ordenado (SIGINT + SIGTERM, F-19) ---------------- */
let cerrando = false;

/**
 * Apagado ordenado:
 *  1. cierra las conexiones SSE (el panel reconecta solo),
 *  2. vacÃ­a los cambios pendientes de conversaciones (flush),
 *  3. cierra WhatsApp con timeout (no deja Chrome huÃ©rfano),
 *  4. da un margen corto para que los debounces de otros mÃ³dulos escriban.
 */
async function apagar(senal) {
  if (cerrando) return;
  cerrando = true;
  log(`Cerrando bot (${senal})â€¦`);
  for (const res of [...sseClientes]) {
    try { res.end(); } catch {}
  }
  sseClientes.clear();
  try {
    const escrito = flushConversaciones();
    log(escrito ? 'Conversaciones guardadas antes de salir.' : 'Sin cambios pendientes en conversaciones.');
  } catch (e) {
    log('No se pudo guardar conversaciones antes de salir: ' + e.message);
  }
  try {
    await conTimeout(cerrarSesion(), 10000, 'cerrar sesiÃ³n de WhatsApp');
    log('SesiÃ³n de WhatsApp cerrada.');
  } catch (e) {
    log('No se pudo cerrar WhatsApp limpiamente: ' + e.message);
  }
  // Margen para que los debounces de pedidos (500 ms) y otros mÃ³dulos escriban.
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', () => { apagar('SIGINT'); });
process.on('SIGTERM', () => { apagar('SIGTERM'); });
