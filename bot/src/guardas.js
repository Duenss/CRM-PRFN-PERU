// Reglas puras de los endpoints de campañas y sincronización (F-11/F-17).
//
// Se extraen de app.js para poder probarlas sin arrancar Express ni el bot:
//  - cuando ya hay una revisión/sincronización en curso, HTTP 409 (antes se
//    respondía 200 "ok" y el panel creía que había hecho algo);
//  - si una campaña apunta a una sesión de WhatsApp que no está configurada
//    (SESIONES), se marca en 'error' visible en vez de reprogramarla para
//    siempre cada 15 minutos.

/** HTTP 409 si ya hay una revisión de campañas en curso; null si puede empezar. */
export function guardaRevision(revisando) {
  return revisando
    ? { status: 409, cuerpo: { error: 'Revisión en curso' } }
    : null;
}

/** HTTP 409 si ya hay una sincronización en curso; null si puede empezar. */
export function guardaSincronizacion(enCurso) {
  return enCurso
    ? { status: 409, cuerpo: { error: 'sincronización en curso' } }
    : null;
}

/**
 * Decide qué hacer con el número emisor de una campaña.
 *
 * @param {object} datos
 * @param {string|null} [datos.emisor] `campanas.numero_emisor` ('1', '2'...).
 * @param {string[]|string} [datos.sesionesConfiguradas] Sesiones de la variable SESIONES.
 * @param {boolean} [datos.conectada] ¿La sesión está conectada ahora mismo?
 * @returns {{ accion: 'enviar'|'reprogramar'|'error', motivo: string }}
 *  - 'error': el emisor no existe en SESIONES → la campaña queda en error visible.
 *  - 'reprogramar': sesión válida pero caída/desconectada → se reintenta en 15 min.
 *  - 'enviar': sesión válida y conectada (o sin emisor fijo y hay conexión).
 */
export function decidirEmisorCampana({ emisor = null, sesionesConfiguradas = [], conectada = false } = {}) {
  const lista = (Array.isArray(sesionesConfiguradas) ? sesionesConfiguradas : String(sesionesConfiguradas || '').split(','))
    .map(s => String(s).trim())
    .filter(Boolean);
  const id = emisor === null || emisor === undefined || emisor === '' ? null : String(emisor);

  // Solo se puede validar contra SESIONES si la lista está configurada.
  if (id && lista.length && !lista.includes(id)) {
    return {
      accion: 'error',
      motivo: `La sesión de WhatsApp "${id}" no está configurada (SESIONES=${lista.join(',')}). ` +
        'Corrige el número emisor de la campaña o la variable SESIONES.'
    };
  }
  if (!conectada) {
    return {
      accion: 'reprogramar',
      motivo: `La sesión de WhatsApp ${id ? '"' + id + '"' : 'asignada'} no está conectada. Se reintentará en 15 minutos.`
    };
  }
  return { accion: 'enviar', motivo: '' };
}
