-- Arreglo de los estados de campaña.
--
-- Problema: la tabla `campanas` conserva una restricción vieja
-- (`campanas_estado_check`) que solo permite 'borrador', 'aprobada' y 'enviada'.
-- Por eso el panel falla al programar una campaña (estado 'programada') y el bot
-- no puede marcarla como 'enviando'/'cancelada'.
--
-- Este script elimina esa restricción y deja una sola con todos los estados que
-- usa el CRM. Se puede ejecutar más de una vez sin problema.
--
-- Ejecutar en Supabase → SQL Editor → Run.

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
