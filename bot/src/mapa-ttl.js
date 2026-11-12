// Map acotado con TTL para memorias por chat (F-14).
//
// `cooldown` en app.js guardaba el último momento de respuesta por teléfono y
// nunca se limpiaba: la RAM crecía con los meses. Este Map:
//  - olvida las entradas con más de `ttlMs` de antigüedad (15 min por defecto),
//  - se recorta a `max` entradas (5.000 por defecto) al insertar,
//  - usa el orden de inserción del Map para descartar primero la más antigua.
//
// El reloj se puede inyectar para probarlo sin esperas reales.
export function crearMapaTtl({ ttlMs = 15 * 60 * 1000, max = 5000, ahora = () => Date.now() } = {}) {
  // clave -> { valor, t }
  const mapa = new Map();

  /** Borra entradas vencidas y recorta al tope. Devuelve el tamaño resultante. */
  function podar(ahoraMs = ahora()) {
    for (const [clave, entrada] of mapa) {
      if (ahoraMs - entrada.t >= ttlMs) mapa.delete(clave);
    }
    while (mapa.size > max) mapa.delete(mapa.keys().next().value);
    return mapa.size;
  }

  function get(clave, ahoraMs = ahora()) {
    podar(ahoraMs);
    const entrada = mapa.get(String(clave));
    return entrada ? entrada.valor : undefined;
  }

  function has(clave, ahoraMs = ahora()) {
    podar(ahoraMs);
    return mapa.has(String(clave));
  }

  function borrar(clave) {
    return mapa.delete(String(clave));
  }

  // El tope se respeta AL INSERTAR: nunca queda más de `max` entradas guardadas.
  function set(clave, valor, ahoraMs = ahora()) {
    podar(ahoraMs);
    mapa.set(String(clave), { valor, t: ahoraMs });
    while (mapa.size > max) mapa.delete(mapa.keys().next().value);
    return api;
  }

  const tamano = () => mapa.size;
  const limpiar = () => { mapa.clear(); };

  const api = { set, get, has, delete: borrar, podar, tamano, limpiar };
  return api;
}
