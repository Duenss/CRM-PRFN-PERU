-- ============================================================
-- TESTIMONIOS: PUBLICACIÓN AUTOMÁTICA (sin aprobación)
-- Ejecutar SOLO si querés que se publiquen al instante.
--
-- OJO: con esto la web puede escribir `aprobado = true` directamente.
-- Nadie revisa antes de que el texto quede visible y indexable.
-- Para volver al modo con revisión, ejecutá 05_arreglar_rls_testimonios.sql.
--
-- Además hay que poner autoPublish: true en assets/js/data.js del sitio.
-- ============================================================

alter table public.testimonios enable row level security;

drop policy if exists "web_inserta_pendiente" on public.testimonios;
drop policy if exists "web_inserta_auto"      on public.testimonios;
drop policy if exists "web_lee_aprobados"     on public.testimonios;

-- La web puede insertar tanto pendientes como ya aprobados.
create policy "web_inserta_auto" on public.testimonios
  for insert to anon, authenticated
  with check (true);

-- Se sigue leyendo solo lo aprobado.
create policy "web_lee_aprobados" on public.testimonios
  for select to anon, authenticated
  using (coalesce(aprobado, false) = true);

-- El panel conserva control total para ocultar/borrar.
drop policy if exists "panel_administra" on public.testimonios;
create policy "panel_administra" on public.testimonios
  for all to authenticated
  using (true) with check (true);

grant insert, select on public.testimonios to anon, authenticated;

-- ------------------------------------------------------------
-- Despublicar rápido un comentario (sin borrarlo):
--   update public.testimonios set aprobado = false where id = '...';
--
-- Ver la cola completa desde el panel:
--   select creado_en, nombre, estrellas, left(mensaje, 60) as inicio, aprobado
--   from public.testimonios order by creado_en desc limit 50;
-- ------------------------------------------------------------
