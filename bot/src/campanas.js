// Lógica de campañas y claims de envío (arreglo F-01).
//
// El problema original: si el update del `envio` fallaba, supabase-js v2 no
// lanza (devuelve `{ error }`), el envío quedaba `pendiente`, la campaña nunca
// se cerraba y el tick de 60 s la reenviaba completa.
//
// La solución: reclamar cada envío en la base ANTES de mandar el mensaje, con un
// update atómico `pendiente → enviando`, y cerrar la campaña siempre. Si el
// claim no se puede hacer (p. ej. la migración sql/07 no está aplicada), NO se
// envía nada: se prefiere un envío perdido visible (fila en error) antes que un
// duplicado al cliente.
//
// Todo recibe el cliente de Supabase inyectado para poder probarlo con un fake
// (bot/test/campanas.test.mjs) sin red ni credenciales.

/** Estados posibles de una fila de `envios` (tras aplicar sql/07). */
export const ESTADOS_ENVIO = ['pendiente', 'enviando', 'enviado', 'omitido', 'error'];

/** Un envío en 'enviando' más viejo que esto es de un proceso que murió. */
export const MS_ENVIO_COLGADO = 10 * 60 * 1000;

const MENSAJE_MIGRACION =
  'Falta aplicar sql/07_envios_claim.sql en Supabase (columna wa_id/nota o estado "enviando"). ' +
  'No se envía nada para no duplicar mensajes; la campaña queda programada.';

/** ¿El error de Supabase es porque falta la migración 07? */
export function esErrorDeMigracion(error) {
  const e = error || {};
  const codigo = String(e.code || '');
  const msg = String(e.message || e.hint || e.details || e || '');
  if (['PGRST204', '42703', '23514', '22P02'].includes(codigo)) return true;
  return /column .* does not exist|no existe la columna|schema cache|could not find the .*(column|'envios)|violates check constraint|check constraint|invalid input value for enum|could not find the 'wa_id'/i.test(msg);
}

/** Texto para el log cuando no se puede reclamar por falta de migración. */
export function mensajeErrorMigracion(error) {
  const detalle = String(error && (error.message || error) || '').slice(0, 300);
  return `${MENSAJE_MIGRACION} Detalle: ${detalle}`;
}

/** Convierte el `{ error }` de supabase-js en una excepción normal de JS. */
function errorSupabase(error) {
  if (error instanceof Error) return error;
  const e = new Error(String(error?.message || error || 'Error de Supabase'));
  if (error?.code) e.code = error.code;
  if (error?.hint) e.hint = error.hint;
  if (error?.details) e.details = error.details;
  return e;
}

/**
 * Reclama atómicamente un envío: solo un proceso puede pasar la fila de
 * 'pendiente' a 'enviando' (update ... where id = ? and estado = 'pendiente').
 *
 * Incluye `wa_id: null, nota: null` en el mismo update a propósito: si esas
 * columnas no existen todavía (migración 07 sin aplicar), el claim falla ANTES
 * de enviar y el arreglo queda en modo seguro (no se manda nada).
 *
 * Devuelve true si ESTE proceso reclamó el envío, false si ya lo tomó otro o ya
 * no estaba pendiente. Lanza si Supabase devuelve error.
 */
export async function reclamarEnvioCon(sb, id, { fecha = new Date() } = {}) {
  const { data, error } = await sb
    .from('envios')
    .update({ estado: 'enviando', fecha_envio: fecha.toISOString(), wa_id: null, nota: null })
    .eq('id', id)
    .eq('estado', 'pendiente')
    .select('id');
  if (error) throw errorSupabase(error);
  return Array.isArray(data) && data.length === 1;
}

/**
 * Marca el resultado de un envío reclamado. Filtra por `estado = 'enviando'`
 * para no pisar una fila que ya cerró otro proceso.
 * No lanza: devuelve `{ error }` para que el llamador loguee sin romper el bucle.
 */
export async function marcarEnvioCon(sb, id, cambios = {}) {
  const { error } = await sb
    .from('envios')
    .update({ ...cambios })
    .eq('id', id)
    .eq('estado', 'enviando');
  return { error: error || null };
}

/**
 * Cierre garantizado de campaña: cuenta los pendientes y, si ya no queda
 * ninguno, la pasa a 'enviada'. Se llama siempre (finally) al terminar de
 * procesar una campaña. Si quedan pendientes (pausa por horario/límite/errores),
 * la deja como está para que el tick de 60 s la retome.
 * Devuelve { cerrada, pendientes }. Lanza si Supabase devuelve error.
 */
export async function cerrarCampanaSiCompleta(sb, id) {
  const { count, error } = await sb
    .from('envios')
    .select('id', { count: 'exact', head: true })
    .eq('campana_id', id)
    .eq('estado', 'pendiente');
  if (error) throw errorSupabase(error);
  const pendientes = Number(count) || 0;
  if (pendientes > 0) return { cerrada: false, pendientes };
  const r = await sb.from('campanas').update({ estado: 'enviada' }).eq('id', id);
  if (r && r.error) throw errorSupabase(r.error);
  return { cerrada: true, pendientes: 0 };
}

/**
 * Barrido de arranque: los envíos que quedaron en 'enviando' por un proceso
 * muerto (más de 10 min) pasan a 'error' con nota visible. Así no se reintentan
 * solos (se perdería el envío, no se duplica) y el dueño puede reintentarlo a mano.
 */
export async function barrerEnviosColgados(sb, { ahora = Date.now(), antiguedadMs = MS_ENVIO_COLGADO } = {}) {
  const limite = new Date(ahora - antiguedadMs).toISOString();
  const { error } = await sb
    .from('envios')
    .update({ estado: 'error', nota: 'proceso interrumpido' })
    .eq('estado', 'enviando')
    .lt('fecha_envio', limite);
  if (error) throw errorSupabase(error);
  return { limite };
}

/**
 * Comprueba que las columnas de la migración 07 existan (chequeo de arranque,
 * best-effort). Devuelve { ok, error }.
 */
export async function verificarMigracionEnviosCon(sb) {
  const { error } = await sb.from('envios').select('id, wa_id, nota').limit(1);
  return error ? { ok: false, error } : { ok: true, error: null };
}
