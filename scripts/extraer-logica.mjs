// Lógica pura de extracción de ejemplos para la IA (sin red ni disco).
//
// - ANONIMIZA teléfonos, nombres, direcciones, correos y links.
// - Extrae pares "pregunta del cliente → respuesta de la tienda" SOLO de
//   conversaciones con venta o pedido (evita ejemplos de charla sin valor).
// - Genera objetos editables: { id, pregunta, respuesta, etiquetas, aprobado }.
//
// Lo usa scripts/extraer-ejemplos.mjs y se prueba en bot/test/ejemplos-ia.test.mjs.

const MARCAS_MEDIA = /^\s*(📕|🎬|📷|🎤|🖼️|\[imagen\]|\[audio\]|\[documento\]|\[video\])/i;

/** Reemplaza teléfonos, nombres, direcciones, correos y links por marcadores. */
export function anonimizar(texto) {
  let t = String(texto || '');
  // Links antes que teléfonos (los links pueden contener números).
  t = t.replace(/https?:\/\/[^\s]+/gi, '[link]');
  t = t.replace(/www\.[^\s]+/gi, '[link]');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[correo]');
  // Teléfonos de Perú con/sin +51, con separadores, y números largos sueltos.
  t = t.replace(/(?:\+?51[\s.-]?)?9\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/g, '[teléfono]');
  t = t.replace(/\b\+?\d{9,15}\b/g, '[teléfono]');
  // Direcciones / estaciones con "Mz/Lote/Av/Calle/Jr/Urb/Dpto".
  t = t.replace(/\b(?:av(?:enida)?\.?|calle|jr\.?|jir[oó]n|urb\.?|urbanizaci[oó]n|mz\.?|manzana|lote|dpto\.?|departamento|distrito|estaci[oó]n)\s+[^\n,.;]{1,40}/gi, '[dirección]');
  // Nombres tras saludos, "Cliente:" o "soy/me llamo" (uno o dos nombres propios).
  t = t.replace(/((?:[Hh]ola|[Bb]uenas(?:\s+(?:[Tt]ardes|[Nn]oches|[Dd][ií]as))?|[Bb]uenos d[ií]as|[Ss]e[ñn]or(?:a)?|[Dd]on|[Dd]o[ñn]a)[,\s]+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/g, '$1[nombre]');
  t = t.replace(/(\bcliente[:\s]+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/gi, '$1[nombre]');
  t = t.replace(/(\b(?:soy|me llamo)\s+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})?)/gi, '$1[nombre]');
  return t.replace(/\s+/g, ' ').trim();
}

/** Etiquetas simples por palabra clave (familia olfativa, categoría y tema). */
export function etiquetasDe(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const ets = [];
  const temas = [
    ['precio', /(precio|cuanto|cuesta|s\/)/],
    ['envio', /(envio|delivery|provincia|llega)/],
    ['pago', /(yape|plin|transferencia|efectivo|pagar|pago)/],
    ['pedido', /(pedido|comprar|quiero|resumen|total)/],
    ['comprobante', /(comprobante|voucher|captura)/],
    ['reclamo', /(reclamo|queja|no llego|roto|reembolso|devolucion)/],
    ['catalogo', /(catalogo|pdf|fragancias|perfumes)/],
    ['saludo', /(hola|buenas|buenos dias|hey)/]
  ];
  for (const [et, re] of temas) if (re.test(t)) ets.push(et);
  const familias = ['amaderado', 'dulce', 'floral', 'fresco', 'citrico', 'frutal', 'oriental', 'gourmand', 'aromatico', 'especiado', 'acuatico', 'ambar'];
  for (const f of familias) if (t.includes(f)) ets.push(`familia:${f}`);
  if (/\barabe|\barabes/.test(t)) ets.push('categoria:arabe');
  if (/\bnicho/.test(t)) ets.push('categoria:nicho');
  if (/\bdisenador/.test(t)) ets.push('categoria:disenador');
  return [...new Set(ets)].slice(0, 6);
}

/** ¿La conversación evidencia una venta o un pedido? */
export function conversacionConVenta(mensajes = [], { tienePedido = false } = {}) {
  if (tienePedido) return true;
  const VENTA = /(pedido\s*(n[º°o.]?\s*)?P-?\d+|pedido registrado|registr[ée] tu pedido|resumen de (tu )?compra|total\s*:?\s*S\/|comprobante|pago (confirmado|verificado|recibido)|qued[oó] registrado)/i;
  return (Array.isArray(mensajes) ? mensajes : []).some(m => m && m.direccion === 'saliente' && VENTA.test(String(m.texto || '')));
}

const textoValido = t => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length < 6) return false;
  if (MARCAS_MEDIA.test(s)) return false;
  return true;
};

/**
 * Pares pregunta→respuesta de un chat: cada mensaje entrante útil seguido del
 * primer saliente útil (el dueño o la IA). No encadena varios salientes a la
 * misma pregunta.
 */
export function extraerParesDeChat(mensajes = [], { maxPares = 4 } = {}) {
  const pares = [];
  let pendiente = null;
  for (const m of Array.isArray(mensajes) ? mensajes : []) {
    if (!m || !textoValido(m.texto)) continue;
    if (m.direccion === 'entrante') {
      pendiente = String(m.texto).trim();
      continue;
    }
    if (m.direccion === 'saliente' && pendiente) {
      const pregunta = pendiente;
      const respuesta = String(m.texto).trim();
      pendiente = null;
      if (pregunta === respuesta) continue;
      if (/^\s*(📕|🎬|📷)/.test(respuesta) && respuesta.length < 60) continue;
      pares.push({ pregunta, respuesta, origen: m.origen || '' });
      if (pares.length >= Math.max(1, Number(maxPares) || 4)) break;
    }
  }
  return pares;
}

/**
 * Convierte conversaciones en ejemplos anonimizados y deduplicados.
 * `chats`: { telefono: { mensajes: [...] } } o array de { telefono, mensajes }.
 * `pedidosPorTel`: Set de teléfonos con pedido registrado.
 */
export function crearEjemplos({ chats = {}, pedidosPorTel = new Set(), maxPorChat = 4, maxTotal = 200 } = {}) {
  const entradas = Array.isArray(chats)
    ? chats.map(c => [c?.telefono, c])
    : Object.entries(chats || {});
  const vistos = new Set();
  const ejemplos = [];
  let conversaciones = 0;
  let pares = 0;
  for (const [tel, chat] of entradas) {
    const mensajes = chat?.mensajes || [];
    if (!Array.isArray(mensajes) || !mensajes.length) continue;
    if (!conversacionConVenta(mensajes, { tienePedido: pedidosPorTel.has(String(tel)) })) continue;
    conversaciones++;
    for (const par of extraerParesDeChat(mensajes, { maxPares: maxPorChat })) {
      pares++;
      const pregunta = anonimizar(par.pregunta);
      const respuesta = anonimizar(par.respuesta);
      if (pregunta.length < 4 || respuesta.length < 12) continue;
      const clave = `${pregunta.toLowerCase()}||${respuesta.toLowerCase()}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      ejemplos.push({
        id: `ej-${String(ejemplos.length + 1).padStart(3, '0')}`,
        pregunta,
        respuesta,
        etiquetas: etiquetasDe(`${par.pregunta} ${par.respuesta}`),
        aprobado: false
      });
      if (ejemplos.length >= maxTotal) break;
    }
    if (ejemplos.length >= maxTotal) break;
  }
  return { ejemplos, stats: { conversaciones, pares, ejemplos: ejemplos.length } };
}
