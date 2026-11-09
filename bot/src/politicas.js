// Políticas de pago y pedidos de Perfumería Fina (reglas puras, sin I/O).
//
// Regla de oro del negocio:
//  - SOLO el pago en efectivo puede cerrar la venta desde el bot. El pedido
//    queda "por_entregar" (se cobra al entregar o al recoger).
//  - Yape / Plin / transferencia NUNCA se confirman desde el bot: el pedido
//    queda "esperando_pago" o "comprobante_recibido" hasta que el DUEÑO
//    verifique el comprobante en el panel.
//  - Ningún pedido pasa a "entregado" de forma automática: eso lo decide el
//    dueño cuando entrega físicamente el producto.
//
// Este módulo no importa nada para poder probarlo con node:test sin arrancar
// el bot ni tocar WhatsApp/Supabase.

/** Métodos de pago digital (billeteras/transferencia): nunca cierran venta. */
export const METODOS_DIGITALES = ['yape', 'plin', 'transferencia'];

/** Estados en los que la IA no puede dejar un pedido por su cuenta. */
export const ESTADOS_QUE_NO_CIERRAN_PAGO = ['por_entregar', 'entregado'];

/**
 * Normaliza el texto libre que devuelve la IA ("Yape", "PLIN", "transferencia
 * BCP", "pago contra entrega"…) a un método canónico.
 * Devuelve '' si no reconoce ninguno.
 */
export function normalizarMetodoPago(metodo) {
  const t = String(metodo || '').toLowerCase().trim();
  if (!t) return '';
  if (/yape/.test(t)) return 'yape';
  if (/plin/.test(t)) return 'plin';
  if (/transfer|banco|bcp|interbank|bbva|cuenta/.test(t)) return 'transferencia';
  if (/efectivo|contra ?entrega|al entregar|pago al recibir|en la entrega/.test(t)) return 'efectivo';
  return '';
}

/** ¿El método es Yape/Plin/transferencia (pago digital que exige verificación)? */
export function esPagoDigital(metodo) {
  return METODOS_DIGITALES.includes(normalizarMetodoPago(metodo));
}

/** ¿El método es efectivo (único que puede cerrar la venta desde el bot)? */
export function esEfectivo(metodo) {
  return normalizarMetodoPago(metodo) === 'efectivo';
}

/**
 * Estado que el bot puede dejar a un pedido detectado por la IA.
 * - eficaz: efectivo → 'por_entregar' (la venta se cierra al cobrar al entregar).
 * - digital → 'esperando_pago' (o 'comprobante_recibido' si ya llegó uno).
 * - sin método → 'borrador' (o 'comprobante_recibido' si ya llegó comprobante).
 * Nunca devuelve 'entregado': entregar es una decisión humana.
 */
export function decidirEstadoPedidoIA({ metodo, tieneComprobante = false } = {}) {
  if (esEfectivo(metodo)) return 'por_entregar';
  if (esPagoDigital(metodo)) return tieneComprobante ? 'comprobante_recibido' : 'esperando_pago';
  return tieneComprobante ? 'comprobante_recibido' : 'borrador';
}

/** ¿Hay que avisar al dueño porque un pago digital quedó pendiente de revisión? */
export function debeDerivarPago(metodo) {
  return esPagoDigital(metodo);
}

/**
 * Corrige lo que devolvió el modelo de IA cuando intenta cerrar una venta que
 * no puede cerrar:
 * - 'entregado' nunca es automático (ningún método).
 * - 'por_entregar' con método digital tampoco: queda esperando verificación.
 * Devuelve { estado, corregido, motivo }.
 */
export function corregirEstadoPedidoIA({ metodo, estadoSugerido = '', tieneComprobante = false } = {}) {
  const sugerido = String(estadoSugerido || '').toLowerCase().trim();
  const esperado = decidirEstadoPedidoIA({ metodo, tieneComprobante });
  if (!sugerido) return { estado: esperado, corregido: false, motivo: '' };
  if (esPagoDigital(metodo) && ESTADOS_QUE_NO_CIERRAN_PAGO.includes(sugerido)) {
    return {
      estado: esperado,
      corregido: true,
      motivo: `La IA intentó cerrar un pedido con pago digital (${normalizarMetodoPago(metodo)}) como "${sugerido}"; se deja en "${esperado}" hasta que el dueño verifique el pago.`
    };
  }
  if (sugerido === 'entregado') {
    return {
      estado: esperado,
      corregido: true,
      motivo: 'La IA intentó marcar un pedido como "entregado"; el bot nunca confirma entregas. Se deja pendiente de revisión del dueño.'
    };
  }
  return { estado: sugerido, corregido: false, motivo: '' };
}

/**
 * Texto en español para avisar al dueño (por WhatsApp y en el panel) que hay
 * un pago digital pendiente de verificación. `pedido` puede ser el objeto del
 * pedido o su id.
 */
export function textoAvisoPagoDigital({ nombre = '', pedido = null } = {}) {
  const esObjeto = pedido && typeof pedido === 'object';
  const id = esObjeto ? String(pedido.id || '') : String(pedido || '');
  const metodo = esObjeto ? normalizarMetodoPago(pedido.metodo) : '';
  const total = esObjeto ? Number(pedido.total) : NaN;
  const cliente = String(nombre || 'cliente');
  return [
    '⚠️ *PAGO DIGITAL PENDIENTE DE VERIFICACIÓN*',
    '',
    '*DATOS DEL PEDIDO*',
    `• Pedido: ${id || '—'}`,
    `• Cliente: ${cliente}`,
    metodo ? `• Método: ${metodo}` : '',
    Number.isFinite(total) && total > 0 ? `• Total: S/ ${total}` : '',
    '',
    '👉 Revisa el comprobante en la pestaña *Pedidos*.',
    'El bot NO confirma el pago: queda en *esperando_pago* hasta que lo verifiques.'
  ].filter(x => x !== '').join('\n').replace(/\n{3,}/g, '\n\n');
}
