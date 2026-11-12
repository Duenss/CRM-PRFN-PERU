// Idempotencia acotada para endpoints que disparan efectos externos (F-16).
//
// El envío manual del panel (`POST /api/conversaciones/:telefono/enviar`) puede
// repetirse por doble clic o un reintento del navegador. Con una `idempotencyKey`
// la misma petición dentro de la ventana (15 s) devuelve la respuesta anterior y
// NO vuelve a enviar el mensaje.
//
// El mapa es pequeño y acotado a propósito: TTL para que las claves viejas se
// purguen solas y tope de entradas para que no crezca sin límite. Se prueba sin
// reloj real inyectando `ahoraMs` en cada llamada.
export const TTL_IDEMPOTENCIA_MS = 15 * 1000;
export const MAX_IDEMPOTENCIA = 5000;

/**
 * Crea un almacén de idempotencia en memoria.
 *
 * @param {{ ttlMs?: number, max?: number }} [opciones]
 */
export function crearIdempotencia({ ttlMs = TTL_IDEMPOTENCIA_MS, max = MAX_IDEMPOTENCIA } = {}) {
  // clave -> { valor, t } donde `t` es el momento de la última escritura.
  const mapa = new Map();

  /** Borra claves vencidas y recorta al tope. Devuelve cuántas quedan. */
  function podar(ahoraMs = Date.now()) {
    for (const [clave, entrada] of mapa) {
      if (ahoraMs - entrada.t >= ttlMs) mapa.delete(clave);
    }
    while (mapa.size > max) {
      // Map conserva el orden de inserción: se descarta la más vieja.
      mapa.delete(mapa.keys().next().value);
    }
    return mapa.size;
  }

  /** Guarda (o reemplaza) el resultado de una clave. */
  function recordar(clave, valor, ahoraMs = Date.now()) {
    podar(ahoraMs);
    mapa.set(String(clave), { valor, t: ahoraMs });
    while (mapa.size > max) mapa.delete(mapa.keys().next().value);
    return valor;
  }

  /** Devuelve el valor recordado de la clave, o null si no existe/venció. */
  function obtener(clave, ahoraMs = Date.now()) {
    podar(ahoraMs);
    const entrada = mapa.get(String(clave));
    return entrada ? entrada.valor : null;
  }

  /** Elimina una clave (p. ej. si el envío falló y el reintento debe ejecutarse). */
  function olvidar(clave) {
    return mapa.delete(String(clave));
  }

  const tamano = () => mapa.size;
  const limpiar = () => { mapa.clear(); };

  return { recordar, obtener, olvidar, podar, tamano, limpiar };
}

/** Instancia compartida por el endpoint de envío manual. */
export const idempotenciaEnvios = crearIdempotencia();

// Atajos con la instancia compartida, por comodidad (mismo efecto que usar
// `idempotenciaEnvios.recordar(...)`, etc.).
export const recordar = (clave, valor, ahoraMs) => idempotenciaEnvios.recordar(clave, valor, ahoraMs);
export const obtener = (clave, ahoraMs) => idempotenciaEnvios.obtener(clave, ahoraMs);
export const olvidar = clave => idempotenciaEnvios.olvidar(clave);
export const podar = ahoraMs => idempotenciaEnvios.podar(ahoraMs);
