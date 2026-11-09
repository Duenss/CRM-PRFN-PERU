-- ============================================================
-- TESTIMONIOS DE LA WEB PÚBLICA
-- Ejecutar en Supabase → SQL Editor (una sola vez).
--
-- Qué crea:
--   public.testimonios           → lo que ve la web (solo aprobados)
--   public.testimonios_contacto  → correos, privados (la web no los lee)
--
-- Reglas:
--   · cualquiera puede INSERTAR un testimonio, siempre con aprobado = false
--   · la web solo puede LEER lo aprobado
--   · el dueño con sesión (CRM) puede leer y moderar todo
--   · los correos: la web escribe pero nunca puede leer
--
-- Moderar: Table Editor → testimonios → cambiar `aprobado` a true.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- 1. Testimonios públicos ----------
create table if not exists public.testimonios (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  ciudad      text,
  fragancia   text,
  estrellas   smallint not null,
  mensaje     text not null,
  aprobado    boolean not null default false,
  creado_en   timestamptz not null default now(),
  constraint testimonios_nombre_largo   check (char_length(nombre) between 3 and 40),
  constraint testimonios_ciudad_largo   check (ciudad is null or char_length(ciudad) <= 40),
  constraint testimonios_fragancia_largo check (fragancia is null or char_length(fragancia) <= 40),
  constraint testimonios_mensaje_largo  check (char_length(mensaje) between 20 and 420),
  constraint testimonios_estrellas_rango check (estrellas between 1 and 5)
);

create index if not exists testimonios_aprobado_idx
  on public.testimonios (aprobado, creado_en desc);

alter table public.testimonios enable row level security;

drop policy if exists "web_lee_aprobados"   on public.testimonios;
drop policy if exists "web_inserta_pendiente" on public.testimonios;
drop policy if exists "panel_administra"    on public.testimonios;

-- La web lee solo lo aprobado
create policy "web_lee_aprobados" on public.testimonios
  for select to anon, authenticated
  using (aprobado = true);

-- La web inserta, pero nunca puede auto-aprobarse
create policy "web_inserta_pendiente" on public.testimonios
  for insert to anon, authenticated
  with check (aprobado = false);

-- El panel (sesión del dueño) modera todo
create policy "panel_administra" on public.testimonios
  for all to authenticated
  using (true) with check (true);

-- ---------- 2. Correos (privados) ----------
create table if not exists public.testimonios_contacto (
  testimonio_id uuid primary key references public.testimonios(id) on delete cascade,
  correo        text not null,
  creado_en     timestamptz not null default now(),
  constraint testimonios_correo_largo check (char_length(correo) <= 120)
);

alter table public.testimonios_contacto enable row level security;

drop policy if exists "web_guarda_correo" on public.testimonios_contacto;
drop policy if exists "panel_lee_correo"  on public.testimonios_contacto;

-- Se puede escribir, pero no leer desde la web
create policy "web_guarda_correo" on public.testimonios_contacto
  for insert to anon, authenticated
  with check (true);

-- Solo el panel con sesión puede leer los correos
create policy "panel_lee_correo" on public.testimonios_contacto
  for select to authenticated
  using (true);

-- ---------- 3. Comprobación ----------
-- Debe devolver 0 filas sin error:
select id, nombre, aprobado from public.testimonios limit 1;

-- ============================================================
-- NOTA: si además te faltan las tablas del CRM, ejecuta antes
--   sql/02_datos_y_esquema.sql   (crea tienda y calendario)
-- ============================================================
