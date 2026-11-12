-- ============================================================
-- 13_wa_estado_clientes.sql — estados anti-bloqueo de WhatsApp
-- Pegar en Supabase > SQL Editor > Run. Idempotente.
-- ============================================================
-- Qué hace:
--   1) Agrega a clientes el estado de validación de WhatsApp:
--        wa_estado              'sin_verificar' | 'verificado' | 'sin_whatsapp'
--        wa_fallos              fallos limpios de "no existe" acumulados
--        wa_primer_fallo_en     momento del primer fallo (regla de 2 momentos)
--        wa_ultima_verificacion_en  última consulta completada
--   2) Limpia los falsos positivos de la validación anterior (decisión del
--      dueño, 2026-11-12): se quita la etiqueta 'sin-wsp' de TODOS los
--      clientes. El bot re-valida desde cero con la regla de 2 fallos en
--      momentos distintos (nunca por timeout, sesión caída o historial).

begin;

alter table public.clientes
  add column if not exists wa_estado text not null default 'sin_verificar';
alter table public.clientes
  add column if not exists wa_fallos integer not null default 0;
alter table public.clientes
  add column if not exists wa_primer_fallo_en timestamptz;
alter table public.clientes
  add column if not exists wa_ultima_verificacion_en timestamptz;

create index if not exists clientes_wa_estado_idx on public.clientes (wa_estado);

-- Limpieza de la etiqueta 'sin-wsp' (tanto si la columna es array como jsonb).
do $$
declare
  tipo text;
begin
  select data_type into tipo
  from information_schema.columns
  where table_schema = 'public' and table_name = 'clientes' and column_name = 'etiquetas';

  if tipo = 'ARRAY' then
    update public.clientes
      set etiquetas = array_remove(etiquetas, 'sin-wsp')
    where etiquetas is not null and 'sin-wsp' = any(etiquetas);
  elsif tipo = 'jsonb' then
    update public.clientes
      set etiquetas = (
        select coalesce(jsonb_agg(x), '[]'::jsonb)
        from jsonb_array_elements(etiquetas) as x
        where x <> to_jsonb('sin-wsp'::text)
      )
    where etiquetas is not null and etiquetas @> '["sin-wsp"]'::jsonb;
  end if;
end $$;

commit;

-- Comprobación (opcional): cuántos quedan en cada estado.
select wa_estado, count(*) from public.clientes group by wa_estado order by wa_estado;
