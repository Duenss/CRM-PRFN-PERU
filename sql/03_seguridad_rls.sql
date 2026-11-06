-- ============================================================
-- Perfumeria Fina Peru - Seguridad (RLS)
-- Pegar en Supabase > SQL Editor > Run.
--
-- IMPORTANTE: este script elimina las politicas actuales de estas
-- tablas y deja solo acceso para usuarios con sesion iniciada.
-- El panel usa Supabase Auth, asi que el dueno seguira entrando normal.
-- La clave publishable sola (sin login) ya no podra leer ni escribir.
-- ============================================================

begin;

alter table public.clientes            enable row level security;
alter table public.productos           enable row level security;
alter table public.plantillas          enable row level security;
alter table public.campanas            enable row level security;
alter table public.envios              enable row level security;
alter table public.configuracion_tienda enable row level security;
alter table public.mensajes            enable row level security;

-- Quitar politicas anteriores de estas tablas
do $$
declare r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in ('clientes','productos','plantillas','campanas','envios','configuracion_tienda','mensajes')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- Acceso total solo para el dueno con sesion iniciada
create policy panel_clientes on public.clientes
  for all to authenticated using (true) with check (true);
create policy panel_productos on public.productos
  for all to authenticated using (true) with check (true);
create policy panel_plantillas on public.plantillas
  for all to authenticated using (true) with check (true);
create policy panel_campanas on public.campanas
  for all to authenticated using (true) with check (true);
create policy panel_envios on public.envios
  for all to authenticated using (true) with check (true);
create policy panel_configuracion on public.configuracion_tienda
  for all to authenticated using (true) with check (true);
create policy panel_mensajes on public.mensajes
  for all to authenticated using (true) with check (true);

-- Datos obligatorios y validaciones basicas
alter table public.clientes alter column telefono set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clientes_telefono_formato') then
    alter table public.clientes
      add constraint clientes_telefono_formato check (telefono ~ '^51[0-9]{9}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'envios_estado_valido') then
    alter table public.envios
      add constraint envios_estado_valido check (estado in ('pendiente','enviado','omitido','error'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campanas_estado_valido') then
    alter table public.campanas
      add constraint campanas_estado_valido check (estado in ('borrador','aprobada','programada','enviada'));
  end if;
end $$;

commit;

-- Despues de ejecutar:
-- 1. Ve a Authentication > Sign In / Providers y desactiva "Allow new users to sign up".
-- 2. Crea el usuario del dueno en Authentication > Users (email + password).
-- 3. Nunca pongas la clave service_role en el navegador ni en Cloudflare Pages.