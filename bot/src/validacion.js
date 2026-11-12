// Lógica pura de la validación anti-bloqueo de números de WhatsApp.
// Sin dependencias de whatsapp.js ni de Supabase: todo lo que decide
// "qué estado queda y cuándo" vive aquí para poder probarlo en unitarios.
//
// Reglas del negocio:
//  - Ritmo lento y aleatorio (4-10 s por número) para no disparar bloqueos.
//  - Lotes pequeños por día (cuota configurable).
//  - Pausa automática ante errores de infraestructura (timeout/sesión/red):
//    esos errores NUNCA cuentan como "sin WhatsApp".
//  - "sin WhatsApp (confirmado)" solo tras 2 respuestas limpias "no existe"
//    en momentos distintos (separadas al menos umbralEntreFallosMs).

export const ESTADOS_WA = {
  SIN_VERIFICAR: 'sin_verificar',
  VERIFICADO: 'verificado',
  SIN_WHATSAPP: 'sin_whatsapp'
};

/** Configuración desde variables de entorno (defaults seguros de producción). */
export function configValidacion(env = process.env) {
  const minMs = Math.max(1000, Number(env.VALIDACION_MIN_MS) || 4000);
  const maxMs = Math.max(minMs, Number(env.VALIDACION_MAX_MS) || 10000);
  return {
    minMs,
    maxMs,
    porDia: Math.max(1, Number(env.VALIDACION_POR_DIA) || 300),
    pausaMs: Math.max(60000, Number(env.VALIDACION_PAUSA_MS) || 15 * 60 * 1000),
    erroresPausa: Math.max(1, Number(env.VALIDACION_ERRORES_PAUSA) || 3),
    umbralEntreFallosMs: Math.max(60000, Number(env.VALIDACION_UMBRAL_ENTRE_FALLOS_MS) || 10 * 60 * 1000)
  };
}

/** Espera aleatoria entre consultas (min → max ms, ambos inclusive). */
export function esperaValidacionMs(cfg, rand = Math.random) {
  const min = Math.max(1, Number(cfg.minMs) || 4000);
  const max = Math.max(min, Number(cfg.maxMs) || 10000);
  return Math.round(min + rand() * (max - min));
}

/**
 * Clasifica un error lanzado por la consulta. Solo importa una distinción:
 * 'infra' (timeout, sesión caída, red, página rota…) vs cualquier otra cosa.
 * Ningún error cuenta como "el número no existe": el único fallo de existencia
 * válido es una respuesta limpia `{ existe: false }` de getNumberId.
 */
export function clasificarFallo(e) {
  const m = String((e && (e.message || e)) || e).toLowerCase();
  if (/timeout|no está conectad|ning[uú]n whatsapp|no se pudo|página de whatsapp|target closed|protocol error|session|desconectad/i.test(m)) return 'infra';
  return 'otro';
}

/**
 * Decide el estado tras una respuesta LIMPIA (existe: true | false).
 * Devuelve el nuevo estado, los fallos acumulados y si se confirmó.
 * Regla de los 2 fallos: solo se confirma cuando hay >= 2 fallos y el primer
 * fallo ocurrió hace al menos umbralEntreFallosMs ("momentos distintos").
 */
export function decidirEstado({
  estado = ESTADOS_WA.SIN_VERIFICAR,
  fallos = 0,
  primerFalloEn = null,
  existe,
  ahoraMs = Date.now(),
  umbralEntreFallosMs = 10 * 60 * 1000
} = {}) {
  if (existe === true) {
    return {
      estado: ESTADOS_WA.VERIFICADO,
      fallos: 0,
      primerFalloEn: null,
      confirmado: false,
      verificado: true
    };
  }
  // existe === false: respuesta limpia de "no registrado".
  // OJO: Number(null) es 0 (no NaN), así que el null se descarta a mano: un
  // primer fallo nulo no debe convertirse en epoch 0 (confirmaría al instante).
  const previo = (primerFalloEn === null || primerFalloEn === undefined || primerFalloEn === '')
    ? NaN
    : Number(primerFalloEn);
  const base = Number.isFinite(previo) ? previo : ahoraMs;
  const n = (Number(fallos) || 0) + 1;
  if (n >= 2 && ahoraMs - base >= umbralEntreFallosMs) {
    return {
      estado: ESTADOS_WA.SIN_WHATSAPP,
      fallos: n,
      primerFalloEn: base,
      confirmado: true,
      verificado: false
    };
  }
  return {
    estado: ESTADOS_WA.SIN_VERIFICAR,
    fallos: n,
    primerFalloEn: base,
    confirmado: false,
    verificado: false
  };
}

/**
 * Aplica el resultado de UNA consulta (limpia o con error) al estado previo.
 * - error / resultado no booleano → infra: no cambia nada, no cuenta fallo.
 * - existe true → verificado (y resetea fallos).
 * - existe false → acumula fallo y confirma solo con la regla de 2 momentos.
 */
export function aplicarResultado(prev = {}, { existe = undefined, error = null } = {}, cfg = {}) {
  if (error !== null && error !== undefined) {
    return {
      estado: prev.estado || ESTADOS_WA.SIN_VERIFICAR,
      fallos: Number(prev.fallos) || 0,
      primerFalloEn: prev.primerFalloEn || null,
      confirmado: false,
      verificado: false,
      infra: true,
      motivo: clasificarFallo(error)
    };
  }
  if (typeof existe !== 'boolean') {
    // Resultado inesperado: se trata como infra (fail-safe, nunca confirma).
    return {
      estado: prev.estado || ESTADOS_WA.SIN_VERIFICAR,
      fallos: Number(prev.fallos) || 0,
      primerFalloEn: prev.primerFalloEn || null,
      confirmado: false,
      verificado: false,
      infra: true,
      motivo: 'resultado_invalido'
    };
  }
  return decidirEstado({
    estado: prev.estado || ESTADOS_WA.SIN_VERIFICAR,
    fallos: Number(prev.fallos) || 0,
    primerFalloEn: prev.primerFalloEn || null,
    existe,
    umbralEntreFallosMs: Number(cfg.umbralEntreFallosMs) || 10 * 60 * 1000
  });
}

/** Recorta la lista a lo que queda de la cuota diaria (lotes pequeños). */
export function planificarLote(lista = [], { hechosHoy = 0, porDia = 300 } = {}) {
  const restantes = Math.max(0, Number(porDia) - Number(hechosHoy));
  return (Array.isArray(lista) ? lista : []).slice(0, restantes);
}

/** ¿N errores de infra seguidos merecen pausar la validación? */
export function pausaTrasErrores(seguidos, tope = 3) {
  return (Number(seguidos) || 0) >= (Number(tope) || 3);
}

/* ---------------- etiquetas (compatibles con array o csv) ---------------- */
export function etiquetasLista(ets) {
  if (Array.isArray(ets)) return ets.map(x => String(x || '').trim()).filter(Boolean);
  return String(ets || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function sinEtiqueta(ets, tag = 'sin-wsp') {
  return etiquetasLista(ets).filter(t => t !== tag);
}

export function conEtiqueta(ets, tag = 'sin-wsp') {
  const lista = etiquetasLista(ets);
  if (!lista.includes(tag)) lista.push(tag);
  return lista;
}
