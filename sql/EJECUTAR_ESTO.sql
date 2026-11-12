-- ============================================================
-- EJECUTAR_ESTO.sql — acciones SQL pendientes del plan final/todo-en-uno
-- Fecha: 2026-11-12
--
-- CONTEXTO: en el entorno del agente NO existía la variable SUPABASE_DB_URL,
-- así que no se ejecutó nada en Supabase (regla del dueño). Este archivo junta
-- lo que hay que pegar en Supabase → SQL Editor → Run, en este orden:
--
--   1) sql/11_arreglar_estado_campanas.sql   (necesario para T4: estado 'error')
--   2) sql/13_wa_estado_clientes.sql         (necesario para la validación anti-bloqueo)
--
-- Ambos son IDEMPOTENTES (se pueden correr más de una vez). Este archivo es
-- una copia de ambos para pegar de una sola vez; si prefieres, ejecuta los dos
-- archivos originales por separado.
--
-- ANTES de ejecutar (recomendado): Supabase → Database → Backups (o un
-- pg_dump de la tabla `clientes`). El bloque 2 quita la etiqueta 'sin-wsp'
-- de los clientes (decisión del dueño 2026-11-12: re-validar desde cero).
--
-- DESPUÉS de ejecutar: verifica con el SELECT final y reinicia el bot
-- (Coolify → Restart/Redeploy del servicio `bot`) para que arranque con las
-- columnas nuevas.
-- ============================================================


-- ============================================================
-- BLOQUE 1 = sql/11_arreglar_estado_campanas.sql
-- ============================================================
begin;

do $$
declare
  r record;
begin
  -- Quita cualquier check sobre la columna `estado` de campanas.
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.campanas'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%estado%'
  loop
    execute format('alter table public.campanas drop constraint %I', r.conname);
    raise notice 'Restricción eliminada: %', r.conname;
  end loop;

  alter table public.campanas
    add constraint campanas_estado_valido
    check (estado in ('borrador', 'aprobada', 'programada', 'enviando', 'enviada', 'cancelada', 'pausada', 'error'));

  raise notice 'Listo: campanas_estado_valido instalada.';
end $$;

commit;


-- ============================================================
-- BLOQUE 2 = sql/13_wa_estado_clientes.sql
-- ============================================================
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


-- ============================================================
-- COMPROBACIÓN
-- ============================================================
-- 1) Estados de clientes (debe haber filas con sin_verificar/verificado/sin_whatsapp):
select wa_estado, count(*) from public.clientes group by wa_estado order by wa_estado;

-- 2) La restricción de campañas debe incluir 'error':
select pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.campanas'::regclass and conname = 'campanas_estado_valido';
