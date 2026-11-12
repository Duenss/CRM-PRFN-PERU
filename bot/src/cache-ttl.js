// Caché asíncrona con TTL para lecturas frecuentes a Supabase (F-12).
//
// `getConfiguracion()` pegaba a Supabase en CADA respuesta de IA. Aquí se guarda
// el último valor 5 minutos; si dos respuestas piden la configuración a la vez,
// ambas comparten la misma consulta en vuelo (una sola llamada a `cargar`).
//
// La invalidación manual está expuesta para cuando el panel/administración
// cambie `configuracion_tienda`: el siguiente `obtener()` vuelve a consultar.
export const TTL_CONFIGURACION_MS = 5 * 60 * 1000;

/**
 * @param {object} [opciones]
 * @param {number} [opciones.ttlMs] Vida del valor cacheado (5 min por defecto).
 * @param {() => number} [opciones.ahora] Reloj inyectable (ms) para los tests.
 */
export function crearCacheTtl({ ttlMs = TTL_CONFIGURACION_MS, ahora = () => Date.now() } = {}) {
  let valor;            // undefined = todavía no hay valor cacheado
  let venceEn = 0;      // instante (ms) en que el valor deja de servir
  let enVuelo = null;   // promesa de carga en curso (evita consultas duplicadas)
  let generacion = 0;   // sube al invalidar: descarta resultados de cargas viejas

  /**
   * Devuelve el valor cacheado si sigue vigente; si no, llama a `cargar`.
   * @param {() => Promise<any>} cargar Consulta real (solo si hace falta).
   */
  async function obtener(cargar) {
    if (valor !== undefined && ahora() < venceEn) return valor;
    if (enVuelo) return enVuelo;
    const g = generacion;
    enVuelo = (async () => {
      try {
        const nuevo = await cargar();
        // Si invalidaron mientras se consultaba, NO se cachea el resultado viejo.
        if (g === generacion) {
          valor = nuevo;
          venceEn = ahora() + ttlMs;
        }
        return nuevo;
      } finally {
        enVuelo = null;
      }
    })();
    return enVuelo;
  }

  /** Fuerza a que la próxima lectura consulte de nuevo. */
  function invalidar() {
    valor = undefined;
    venceEn = 0;
    generacion++;
  }

  /** Último valor guardado (aunque haya vencido), para degradar sin romper. */
  function ultimo() {
    return valor;
  }

  /** ¿Hay un valor cacheado vigente? (diagnóstico/tests) */
  function vigente() {
    return valor !== undefined && ahora() < venceEn;
  }

  return { obtener, invalidar, ultimo, vigente };
}
