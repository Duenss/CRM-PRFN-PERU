// Eventos en memoria para avisar al panel de lo que pasa en el bot.
// Hay dos formas de recibirlos, y ninguna rompe a la otra:
//  - SSE en vivo: GET /api/stream (el panel nuevo los recibe al instante).
//  - Polling de respaldo: GET /api/eventos?desde=<id> (panel anterior/viejo).
// No se persisten: si el panel estaba cerrado, al abrirse empieza desde el
// último id conocido (y para lo que importa de verdad, las conversaciones y
// pedidos viven en JSON/Supabase).

let seq = Date.now();
const lista = [];
const MAX = 300;

/** Suscriptores SSE (funciones que reciben cada evento). */
const oyentes = new Set();

/**
 * Suscribe una función a los eventos en vivo (SSE).
 * Devuelve la función para desuscribirse (se llama al cerrar la conexión).
 */
export function suscribir(fn) {
  if (typeof fn !== 'function') return () => {};
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}

/** Nº de suscriptores activos (diagnóstico). */
export function suscriptores() {
  return oyentes.size;
}

/**
 * Registra un evento para el panel y lo reparte a los suscriptores SSE.
 * @param {string} tipo 'mensaje' | 'ack' | 'leido' | 'campana' | 'ia' | 'pedido' |
 *                      'derivacion' | 'comprobante' | 'seguimiento'
 * @param {object} datos
 */
export function emitir(tipo, datos = {}) {
  const evento = {
    id: ++seq,
    tipo: String(tipo || 'aviso'),
    en: new Date().toISOString(),
    ...datos
  };
  lista.push(evento);
  if (lista.length > MAX) lista.shift();
  // Un suscriptor roto (SSE cerrado, res.write fallando) no debe tumbar a
  // emitir() ni al emisor original: se aísla cada aviso.
  for (const fn of oyentes) {
    try { fn(evento); } catch {}
  }
  return evento;
}

/** Eventos posteriores a `desde` (id numérico) para /api/eventos. */
export function desde(desdeId = 0) {
  const n = Number(desdeId) || 0;
  return lista.filter(e => e.id > n);
}

export function ultimoId() {
  return seq;
}

/**
 * Línea con el formato exacto de Server-Sent Events:
 *   id: <n>\ndata: <json>\n\n
 * Se exporta para poder probarla y para que el endpoint y el ping usen lo mismo.
 */
export function lineaSSE(evento) {
  return `id: ${evento.id}\ndata: ${JSON.stringify(evento)}\n\n`;
}
