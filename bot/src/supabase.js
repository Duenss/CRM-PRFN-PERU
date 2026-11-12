import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { crearCacheTtl, TTL_CONFIGURACION_MS } from './cache-ttl.js';

export const sb = config.supabaseKey
  ? createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

// Caché de la configuración de la tienda (F-12): antes se consultaba en CADA
// respuesta de IA. 5 minutos de TTL; si Supabase falla se mantiene el último
// valor bueno en vez de romper la respuesta (degradación silenciosa, como antes).
const cacheConfiguracion = crearCacheTtl({ ttlMs: TTL_CONFIGURACION_MS });

export async function getConfiguracion() {
  if (!sb) return {};
  try {
    return await cacheConfiguracion.obtener(async () => {
      const { data, error } = await sb.from('configuracion_tienda').select('*').limit(1);
      if (error) throw new Error(error.message || String(error));
      return data?.[0] || {};
    });
  } catch {
    // Se devuelve el último valor cacheado (aunque haya vencido) o {}.
    return cacheConfiguracion.ultimo() || {};
  }
}

/**
 * Invalida la caché de `configuracion_tienda`. Llamar desde cualquier endpoint
 * que actualice esa tabla para que el cambio se vea al instante (si no, tarda
 * como máximo 5 minutos).
 */
export function invalidarConfiguracion() {
  cacheConfiguracion.invalidar();
}

export async function getCliente(telefono) {
  if (!sb) return null;
  const { data } = await sb.from('clientes').select('*').eq('telefono', telefono).limit(1);
  return data?.[0] || null;
}

export async function getClientes() {
  if (!sb) return [];
  const salida = [];
  const paso = 1000;
  for (let i = 0; i < 30; i++) {
    const { data, error } = await sb.from('clientes').select('*').range(i * paso, (i + 1) * paso - 1);
    if (error) { console.warn('[supabase] getClientes:', error.message); break; }
    salida.push(...(data || []));
    if (!data || data.length < paso) break;
  }
  return salida;
}

export async function getProductos() {
  if (!sb) return [];
  const { data } = await sb.from('productos').select('id,nombre,casa_inspirada,categoria,genero,familia_olfativa,notas,descripcion,precio_50ml,precio_100ml,imagen_ruta,url_producto,activo');
  return (data || []).filter(p => p.activo !== false);
}

export async function logMensaje({ clienteId, telefono, direccion, texto, origen = 'bot', estado = 'ok' }) {
  if (!sb) return;
  const { error } = await sb.from('mensajes').insert({
    cliente_id: clienteId || null,
    telefono,
    direccion,
    texto: String(texto || '').slice(0, 4000),
    origen,
    estado
  });
  if (error) console.warn('[mensajes] no se pudo registrar:', error.message);
}

export async function historial(telefono, limite = 8) {
  if (!sb) return [];
  const { data } = await sb
    .from('mensajes')
    .select('direccion,texto,creado_en')
    .eq('telefono', telefono)
    .order('creado_en', { ascending: false })
    .limit(limite);
  return (data || []).reverse();
}

export async function marcarBaja(cliente) {
  if (!sb || !cliente) return;
  const { error } = await sb.from('clientes').update({
    baja: true,
    fecha_baja: new Date().toISOString().slice(0, 10)
  }).eq('id', cliente.id);
  if (error) throw error;
}

/**
 * Importa contactos a la tabla clientes sin sobrescribir los que ya existen.
 * `ignoreDuplicates` deja intactos cumpleaños, etiquetas y consentimiento ya cargados.
 */
export async function importarClientes(lista = []) {
  if (!sb || !lista.length) return { insertados: 0, total: lista.length };
  let insertados = 0;
  for (let i = 0; i < lista.length; i += 200) {
    const lote = lista.slice(i, i + 200);
    const { data, error } = await sb
      .from('clientes')
      .upsert(lote, { onConflict: 'telefono', ignoreDuplicates: true })
      .select('id');
    if (error) throw error;
    insertados += data?.length || 0;
  }
  return { insertados, total: lista.length };
}

/* ---------------- estado anti-bloqueo de WhatsApp (columnas de sql/13) ---------------- */

/**
 * Estado de validación de un cliente. Defensivo: si las columnas de sql/13 no
 * existen todavía, toda fila se lee como 'sin_verificar' sin fallos (nunca se
 * marca nada, solo se degrada a "pendiente").
 */
export function estadoWaDe(cliente) {
  return {
    estado: String(cliente?.wa_estado || 'sin_verificar'),
    fallos: Number(cliente?.wa_fallos) || 0,
    primerFalloEn: cliente?.wa_primer_fallo_en || null,
    ultimaVerificacionEn: cliente?.wa_ultima_verificacion_en || null
  };
}

/** ¿La tabla clientes ya tiene las columnas de estado (sql/13 aplicado)? */
export function hayColumnasWa(clienteEjemplo) {
  return !!clienteEjemplo && Object.prototype.hasOwnProperty.call(clienteEjemplo, 'wa_estado');
}

/** Guarda cambios de estado de validación; lanza si Supabase devuelve error. */
export async function guardarEstadoWa(clienteId, cambios = {}) {
  if (!sb || !clienteId) return false;
  const { error } = await sb.from('clientes').update(cambios).eq('id', clienteId);
  if (error) throw error;
  return true;
}