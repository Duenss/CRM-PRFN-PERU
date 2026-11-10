// Autodiagnóstico del esquema de Supabase.
// Detecta problemas que rompen funciones del CRM (por ejemplo, el constraint
// viejo de `campanas` que no permite el estado 'programada').
//
// No deja datos: si la prueba crea una fila, la borra en el mismo paso.
export async function revisarCampanas(sb) {
  if (!sb) return { ok: true };
  let creada = null;
  try {
    const { data, error } = await sb
      .from('campanas')
      .insert({ titulo: '__schema_check__', mensaje_final: 'x', estado: 'programada', segmento: [] })
      .select()
      .single();
    if (error) {
      const msg = String(error.message || error);
      if (String(error.code) === '23514' && /estado/i.test(msg)) {
        return {
          ok: false,
          problema: {
            codigo: 'campanas_estado',
            mensaje: 'La tabla de campañas no acepta el estado "programada": las campañas programadas fallarán.',
            solucion: 'Ejecuta sql/11_arreglar_estado_campanas.sql en Supabase → SQL Editor.'
          }
        };
      }
      return { ok: false, problema: { codigo: 'campanas_insert', mensaje: msg, solucion: 'Revisa los permisos/RLS y el esquema de campañas.' } };
    }
    creada = data?.id || null;
    return { ok: true };
  } catch (e) {
    return { ok: false, problema: { codigo: 'campanas_insert', mensaje: e.message, solucion: 'Revisa la conexión con Supabase.' } };
  } finally {
    if (creada) {
      try { await sb.from('campanas').delete().eq('id', creada); } catch { /* limpieza best-effort */ }
    }
  }
}

/** Corre todos los chequeos y devuelve la lista de problemas. */
export async function revisarEsquema(sb) {
  const problemas = [];
  try {
    const r = await revisarCampanas(sb);
    if (r && r.problema) problemas.push(r.problema);
  } catch { /* el diagnóstico nunca debe tumbar el bot */ }
  return problemas;
}
