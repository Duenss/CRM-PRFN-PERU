-- Permisos del CRM (panel + bot) en Supabase.
-- Ejecutar UNA VEZ en Supabase → SQL Editor → Run.
--
-- Qué hace:
--   • Activa RLS en las tablas del CRM (si no estaba).
--   • Da acceso total a los usuarios LOGUEADOS del panel (rol authenticated).
--   • Da solo lectura pública (rol anon) para que el catálogo se vea sin sesión.
--
-- No borra ni cambia datos: solo crea/reemplaza políticas.

do $$
declare
  t text;
  tablas text[] := array['clientes', 'campanas', 'envios', 'productos'];
begin
  foreach t in array tablas loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);

      -- Panel (usuario logueado): todo.
      execute format('drop policy if exists crm_panel_todo on public.%I', t);
      execute format(
        'create policy crm_panel_todo on public.%I for all to authenticated using (true) with check (true)', t
      );

      -- Catálogo público: solo lectura.
      execute format('drop policy if exists crm_lectura_publica on public.%I', t);
      execute format(
        'create policy crm_lectura_publica on public.%I for select to anon using (true)', t
      );

      raise notice 'Permisos listos para %', t;
    else
      raise notice 'La tabla % no existe, se omite', t;
    end if;
  end loop;
end $$;

-- Comprobación rápida (opcional): muestra cuántas filas hay en cada tabla.
select 'clientes' as tabla, count(*) from public.clientes
union all select 'campanas', count(*) from public.campanas
union all select 'envios', count(*) from public.envios
union all select 'productos', count(*) from public.productos;
