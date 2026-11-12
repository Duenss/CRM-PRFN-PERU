-- ============================================================================
-- 15_testimonios_sin_auto.sql — Testimonios de la web con APROBACIÓN MANUAL
-- ============================================================================
-- Decisión del dueño (2026-11-11): los testimonios enviados desde la web
-- quedan `aprobado = false` y solo se publican cuando el dueño los aprueba
-- desde el panel. Esto revierte el modo de auto-publicación del archivo
-- 06_testimonios_auto_publicar.sql y cierra la contradicción entre 05 y 06
-- (hallazgo H-05 de la auditoría: la política `web_inserta_auto` sobrevivía
-- a la ejecución de 05 porque nunca se eliminaba).
--
-- Qué hace (idempotente: se puede ejecutar varias veces):
--   1. Elimina la política `web_inserta_auto` si existe (por el 06).
--   2. Deja el trío definitivo, igual que 04/05 y 00_instalar_todo.sql:
--        · web_lee_aprobados     → la web lee SOLO lo aprobado
--        · web_inserta_pendiente → la web inserta SIEMPRE con aprobado=false
--        · panel_administra      → el dueño (sesión) lee, aprueba y borra todo
--   3. Asegura los permisos de tabla para los roles anon/authenticated.
--
-- No borra ni cambia datos: los testimonios ya publicados siguen publicados.
-- El sitio web debe quedar en modo con revisión (autoPublish: false).
-- Moderar: Table Editor → testimonios → cambiar `aprobado` a true.
--
-- Cómo aplicarlo:
--   Supabase Studio → SQL Editor → pegar este archivo → Run.
-- ============================================================================

alter table public.testimonios enable row level security;

-- 1) Fuera la auto-publicación (nunca se eliminaba en 05 ni en 00).
drop policy if exists "web_inserta_auto" on public.testimonios;

-- 2) Trío definitivo de aprobación manual.
drop policy if exists "web_lee_aprobados"     on public.testimonios;
drop policy if exists "web_inserta_pendiente" on public.testimonios;
drop policy if exists "panel_administra"      on public.testimonios;

create policy "web_lee_aprobados" on public.testimonios
  for select to anon, authenticated
  using (coalesce(aprobado, false) = true);

create policy "web_inserta_pendiente" on public.testimonios
  for insert to anon, authenticated
  with check (coalesce(aprobado, false) = false);

create policy "panel_administra" on public.testimonios
  for all to authenticated
  using (true) with check (true);

-- 3) Permisos de tabla para los roles de la API.
grant usage on schema public to anon, authenticated;
grant insert, select on public.testimonios to anon, authenticated;

-- ============================================================================
-- Verificación (debe devolver 3 políticas y NINGUNA llamada web_inserta_auto):
--   select policyname from pg_policies
--    where schemaname = 'public' and tablename = 'testimonios'
--    order by policyname;
-- ============================================================================
