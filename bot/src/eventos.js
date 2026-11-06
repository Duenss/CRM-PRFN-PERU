// Eventos en memoria para avisar al panel (derivaciones, comprobantes, pedidos).
// El panel los consulta con GET /api/eventos?desde=<id>. No se persisten:
// si el panel estaba cerrado, al abrirse empieza desde el último id conocido.

let seq = Date.now();
const lista = [];
const MAX = 300;

/**
 * Registra un evento para el panel.
 * @param {string} tipo 'derivacion' | 'comprobante' | 'pedido' | 'seguimiento'
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
  return evento;
}

/** Eventos posteriores a `desde` (id numérico). */
export function desde(desdeId = 0) {
  const n = Number(desdeId) || 0;
  return lista.filter(e => e.id > n);
}

export function ultimoId() {
  return seq;
}