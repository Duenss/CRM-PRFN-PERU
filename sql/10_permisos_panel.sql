-- Permisos del CRM (panel + bot) en Supabase.
-- Ejecutar UNA VEZ en Supabase → SQL Editor → Run.
--
-- Qué hace:
--   • Activa RLS en las tablas del CRM (si no estaba).
--   • Da acceso total a los usuarios LOGUEADOS del panel (rol authenticated).
--   • Deja SOLO el catálogo (productos) en lectura pública; los datos de
--     clientes, campañas y envíos NO se exponen sin sesión.
--
-- No borra ni cambia datos: solo crea/reemplaza políticas.

begin;

do $$
declare
  t text;
  -- Tablas con acceso total para el dueño logueado.
  privadas text[] := array['clientes', 'campanas', 'envios', 'plantillas', 'configuracion_tienda', 'mensajes'];
  -- Tablas legibles sin sesión (escaparate/catálogo).
  publicas text[] := array['productos'];
begin
  foreach t in array privadas loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);

      execute format('drop policy if exists crm_panel_todo on public.%I', t);
      execute format(
        'create policy crm_panel_todo on public.%I for all to authenticated using (true) with check (true)', t
      );

      -- Sin políticas para anon: sin sesión no se lee ni se escribe.
      raise notice 'Privada lista: %', t;
    else
      raise notice 'La tabla % no existe, se omite', t;
    end if;
  end loop;

  foreach t in array publicas loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);

      execute format('drop policy if exists crm_panel_todo on public.%I', t);
      execute format(
        'create policy crm_panel_todo on public.%I for all to authenticated using (true) with check (true)', t
      );

      execute format('drop policy if exists crm_lectura_publica on public.%I', t);
      execute format(
        'create policy crm_lectura_publica on public.%I for select to anon using (true)', t
      );

      raise notice 'Pública (solo lectura): %', t;
    else
      raise notice 'La tabla % no existe, se omite', t;
    end if;
  end loop;
end $$;

commit;

-- Comprobación rápida (opcional): muestra cuántas filas hay en cada tabla.
select 'clientes' as tabla, count(*) from public.clientes
union all select 'campanas', count(*) from public.campanas
union all select 'envios', count(*) from public.envios
union all select 'productos', count(*) from public.productos;
