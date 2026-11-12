// Lógica pura de la validación anti-bloqueo de números de WhatsApp.
// Sin dependencias de whatsapp.js ni de Supabase: todo lo que decide
// "qué estado queda y cuándo" vive aquí para poder probarlo en unitarios.
//
// Reglas del negocio:
//  - Ritmo lento y aleatorio (4-10 s por número) para no disparar bloqueos.
//  - VALIDACION_POR_DIA=0 (por defecto) = SIN tope diario; >0 recorta el día.
//  - Ventana horaria de Lima (VALIDACION_HORA_INICIO=9, VALIDACION_HORA_FIN=22):
//    fuera de la ventana no se consulta y se retoma sola al abrir.
//  - Pausa larga aleatoria (3-6 min) cada 80-120 números consultados.
//  - Pausa automática ante errores de infraestructura (timeout/sesión/red):
//    esos errores NUNCA cuentan como "sin WhatsApp".
//  - "sin WhatsApp (confirmado)" solo tras 2 respuestas limpias "no existe"
//    en momentos distintos (separadas al menos umbralEntreFallosMs).

export const ESTADOS_WA = {
  SIN_VERIFICAR: 'sin_verificar',
  VERIFICADO: 'verificado',
  SIN_WHATSAPP: 'sin_whatsapp'
};

/** Lee una variable de entorno numérica con defecto y sin NaN. */
function numEnv(env, clave, defecto) {
  const v = env?.[clave];
  if (v === undefined || v === null || v === '') return defecto;
  const n = Number(v);
  return Number.isFinite(n) ? n : defecto;
}

/** Configuración desde variables de entorno (defaults seguros de producción). */
export function configValidacion(env = process.env) {
  const minMs = Math.max(1000, numEnv(env, 'VALIDACION_MIN_MS', 4000));
  const maxMs = Math.max(minMs, numEnv(env, 'VALIDACION_MAX_MS', 10000));
  // 0 = SIN tope diario (valor por defecto). Nunca negativo.
  const porDia = Math.max(0, Math.trunc(numEnv(env, 'VALIDACION_POR_DIA', 0)));
  const horaInicio = Math.min(23, Math.max(0, Math.trunc(numEnv(env, 'VALIDACION_HORA_INICIO', 9))));
  const horaFin = Math.min(23, Math.max(0, Math.trunc(numEnv(env, 'VALIDACION_HORA_FIN', 22))));
  const loteMin = Math.max(1, Math.trunc(numEnv(env, 'VALIDACION_LOTE_MIN', 80)));
  const loteMax = Math.max(loteMin, Math.trunc(numEnv(env, 'VALIDACION_LOTE_MAX', 120)));
  const pausaLargaMinMs = Math.max(30000, numEnv(env, 'VALIDACION_PAUSA_LARGA_MIN_MS', 3 * 60 * 1000));
  const pausaLargaMaxMs = Math.max(pausaLargaMinMs, numEnv(env, 'VALIDACION_PAUSA_LARGA_MAX_MS', 6 * 60 * 1000));
  return {
    minMs,
    maxMs,
    porDia,
    pausaMs: Math.max(60000, numEnv(env, 'VALIDACION_PAUSA_MS', 15 * 60 * 1000)),
    erroresPausa: Math.max(1, numEnv(env, 'VALIDACION_ERRORES_PAUSA', 3)),
    umbralEntreFallosMs: Math.max(60000, numEnv(env, 'VALIDACION_UMBRAL_ENTRE_FALLOS_MS', 10 * 60 * 1000)),
    horaInicio,
    horaFin,
    loteMin,
    loteMax,
    pausaLargaMinMs,
    pausaLargaMaxMs
  };
}

/** Espera aleatoria entre consultas (min → max ms, ambos inclusive). */
export function esperaValidacionMs(cfg, rand = Math.random) {
  const min = Math.max(1, Number(cfg.minMs) || 4000);
  const max = Math.max(min, Number(cfg.maxMs) || 10000);
  return Math.round(min + rand() * (max - min));
}

/**
 * ¿Estamos dentro de la ventana horaria de validación? `partes` es la fecha
 * de Lima descompuesta ({ y, m, d, h, min }) que produce partesLima() en
 * app.js. Si horaInicio === horaFin se entiende "todo el día"; si la ventana
 * cruza medianoche (fin < inicio) se maneja como rango circular.
 */
export function enVentanaHoraria(cfg = {}, partes = {}) {
  const inicio = Number(cfg.horaInicio ?? 9);
  const fin = Number(cfg.horaFin ?? 22);
  const h = Number(partes.h);
  if (!Number.isFinite(h) || h < 0 || h > 23) return false;
  if (inicio === fin) return true;
  if (fin > inicio) return h >= inicio && h < fin;
  return h >= inicio || h < fin;
}

/**
 * Milisegundos hasta la próxima apertura de la ventana (0 si ya está abierta).
 * Lima es UTC-5 todo el año (sin horario de verano), así que el cálculo es
 * exacto: la apertura es hoy o mañana a las horaInicio en hora de Lima.
 * Recibe `ahoraMs` para poder probarse con reloj fijo.
 */
export function msHastaApertura(cfg = {}, partes = {}, ahoraMs = Date.now()) {
  if (enVentanaHoraria(cfg, partes)) return 0;
  const inicio = Number(cfg.horaInicio ?? 9);
  const y = Number(partes.y), m = Number(partes.m), d = Number(partes.d);
  let base = Date.UTC(y, m - 1, d, inicio) + 5 * 3600 * 1000; // 09:00 Lima = 14:00 UTC
  if (!Number.isFinite(base)) return 60 * 60 * 1000; // partes inválidas: reintenta en 1 h
  if (base <= ahoraMs) base += 24 * 3600 * 1000; // hoy ya cerró: mañana
  return Math.max(0, base - ahoraMs);
}

/**
 * Número de consultas hasta la próxima pausa larga anti-bloqueo
 * (aleatorio entre loteMin y loteMax, por defecto 80-120 números).
 */
export function proximaPausaLarga(cfg = {}, rand = Math.random) {
  const min = Math.max(1, Number(cfg.loteMin) || 80);
  const max = Math.max(min, Number(cfg.loteMax) || 120);
  return Math.round(min + rand() * (max - min));
}

/** Duración aleatoria de la pausa larga (por defecto 3-6 minutos). */
export function esperaPausaLargaMs(cfg = {}, rand = Math.random) {
  const min = Math.max(30000, Number(cfg.pausaLargaMinMs) || 3 * 60 * 1000);
  const max = Math.max(min, Number(cfg.pausaLargaMaxMs) || 6 * 60 * 1000);
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

/** Recorta la lista a lo que queda de la cuota diaria. porDia=0 = sin tope. */
export function planificarLote(lista = [], { hechosHoy = 0, porDia = 300 } = {}) {
  const arr = Array.isArray(lista) ? lista : [];
  const tope = Math.max(0, Math.trunc(Number(porDia) || 0));
  if (!tope) return arr.slice(); // 0 = sin límite diario
  const restantes = Math.max(0, tope - Number(hechosHoy));
  return arr.slice(0, restantes);
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
