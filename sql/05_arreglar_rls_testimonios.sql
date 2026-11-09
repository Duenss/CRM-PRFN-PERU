-- ============================================================
-- ARREGLO RÁPIDO: políticas de los testimonios de la web
-- Ejecutar en Supabase → SQL Editor → Ctrl+A → Run.
--
-- Sirve si las tablas ya existen pero la web no puede insertar
-- (error 42501 / 401 "row-level security policy").
-- Es idempotente: se puede ejecutar las veces que quieras.
-- ============================================================

-- 1) Asegurar columnas clave (no rompe nada si ya existen) ----------
alter table public.testimonios
  add column if not exists aprobado boolean not null default false;

alter table public.testimonios
  add column if not exists creado_en timestamptz not null default now();

alter table public.testimonios
  add column if not exists ciudad text;

alter table public.testimonios
  add column if not exists fragancia text;

alter table public.testimonios
  add column if not exists correo text;

-- 2) RLS activo -----------------------------------------------------
alter table public.testimonios enable row level security;
alter table public.testimonios_contacto enable row level security;

-- 3) Políticas del testimonio público -------------------------------
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

-- 4) Políticas de los correos (privados) ----------------------------
drop policy if exists "web_guarda_correo" on public.testimonios_contacto;
drop policy if exists "panel_lee_correo"  on public.testimonios_contacto;

create policy "web_guarda_correo" on public.testimonios_contacto
  for insert to anon, authenticated
  with check (true);

create policy "panel_lee_correo" on public.testimonios_contacto
  for select to authenticated
  using (true);

-- 5) Permisos de tabla para los roles de la API ---------------------
grant usage on schema public to anon, authenticated;
grant insert, select on public.testimonios to anon, authenticated;
grant insert on public.testimonios_contacto to anon, authenticated;
grant select on public.testimonios_contacto to authenticated;

-- 6) Comprobación ---------------------------------------------------
-- Debe devolver "ok":
select 'ok' as estado,
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'testimonios') as politicas_testimonios;
