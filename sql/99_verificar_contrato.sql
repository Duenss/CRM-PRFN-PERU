-- ============================================================================
-- 99_verificar_contrato.sql — Verificación del contrato de datos del CRM
-- ============================================================================
-- Contexto (hallazgo H-01 de la auditoría): el DDL de las tablas base
-- (clientes, productos, campanas, plantillas, envios, configuracion_tienda)
-- nunca se versionó en el repo. Este script NO cambia nada: comprueba que la
-- base cumple TODO lo que el bot (bot/src) y el panel (assets/app.js) leen y
-- escriben hoy, y FALLA con un mensaje que lista exactamente lo que falta.
--
-- Cómo usarlo (Supabase Studio → SQL Editor → pegar → Run):
--   · Termina con "Contrato de datos: OK" → la app y la base están alineadas.
--   · Lanza "Contrato incompleto: ..." → el mensaje lista tablas/columnas.
--   · Los índices faltantes NO rompen la ejecución: se avisan con NOTICE.
--
-- Para versionar el DDL real (la otra mitad de H-01), genera el esquema de
-- producción y comételo en sql/ (nuevo archivo numerado, p. ej. 16):
--   pg_dump "postgresql://<usuario>:<clave>@<host>:6543/postgres" \
--     --schema=public --schema-only --no-owner --no-privileges \
--     > sql/16_esquema_base_produccion.sql
--   (con el CLI de Supabase:  supabase db dump --schema public --schema-only)
-- ============================================================================

do $$
declare
  problemas text[] := array[]::text[];
  avisos    text[] := array[]::text[];
  r record;
begin
  -- 1) Tablas ----------------------------------------------------------------
  for r in
    select unnest(array[
      'clientes', 'productos', 'plantillas', 'campanas', 'envios',
      'configuracion_tienda', 'mensajes', 'testimonios', 'testimonios_contacto'
    ]) as tabla
  loop
    if to_regclass('public.' || r.tabla) is null then
      problemas := problemas || ('tabla public.' || r.tabla);
    end if;
  end loop;

  -- 2) Columnas que el código usa hoy ----------------------------------------
  for r in
    select v.tabla, v.columna
    from (values
      ('clientes', 'id'), ('clientes', 'nombre'), ('clientes', 'telefono'),
      ('clientes', 'activo'), ('clientes', 'baja'), ('clientes', 'consentimiento'),
      ('clientes', 'etiquetas'), ('clientes', 'fecha_cumpleanos'),
      ('clientes', 'ultima_compra'), ('clientes', 'notas'),
      ('clientes', 'fecha_consentimiento'), ('clientes', 'fecha_baja'),
      ('productos', 'id'), ('productos', 'codigo'), ('productos', 'nombre'),
      ('productos', 'casa_inspirada'), ('productos', 'categoria'), ('productos', 'genero'),
      ('productos', 'familia_olfativa'), ('productos', 'notas'),
      ('productos', 'descripcion'), ('productos', 'precio_50ml'),
      ('productos', 'precio_100ml'), ('productos', 'imagen_ruta'),
      ('productos', 'url_producto'), ('productos', 'activo'),
      ('plantillas', 'id'), ('plantillas', 'nombre'), ('plantillas', 'tipo'),
      ('plantillas', 'texto_base'),
      ('campanas', 'id'), ('campanas', 'estado'), ('campanas', 'titulo'),
      ('campanas', 'mensaje_final'), ('campanas', 'segmento'),
      ('campanas', 'fecha_programada'), ('campanas', 'numero_emisor'),
      ('campanas', 'creado_en'),
      ('envios', 'id'), ('envios', 'campana_id'), ('envios', 'cliente_id'),
      ('envios', 'estado'), ('envios', 'fecha_envio'),
      ('envios', 'wa_id'), ('envios', 'nota'),
      ('configuracion_tienda', 'nombre'), ('configuracion_tienda', 'logo_url'),
      ('configuracion_tienda', 'colores'), ('configuracion_tienda', 'tono_de_voz'),
      ('configuracion_tienda', 'medios_de_pago'), ('configuracion_tienda', 'enlace_web'),
      ('configuracion_tienda', 'whatsapp'), ('configuracion_tienda', 'horario'),
      ('configuracion_tienda', 'envios'),
      ('mensajes', 'id'), ('mensajes', 'cliente_id'), ('mensajes', 'telefono'),
      ('mensajes', 'direccion'), ('mensajes', 'texto'), ('mensajes', 'origen'),
      ('mensajes', 'estado'), ('mensajes', 'creado_en'),
      ('testimonios', 'id'), ('testimonios', 'nombre'), ('testimonios', 'ciudad'),
      ('testimonios', 'fragancia'), ('testimonios', 'estrellas'),
      ('testimonios', 'mensaje'), ('testimonios', 'aprobado'),
      ('testimonios', 'creado_en'),
      ('testimonios_contacto', 'testimonio_id'), ('testimonios_contacto', 'correo'),
      ('testimonios_contacto', 'creado_en')
    ) as v(tabla, columna)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = r.tabla
        and column_name = r.columna
    ) then
      problemas := problemas || ('columna ' || r.tabla || '.' || r.columna);
    end if;
  end loop;

  -- 3) Índices (advisory: se avisan, no rompen) ------------------------------
  for r in
    select v.tabla, v.indice
    from (values
      ('clientes',    'clientes_telefono_key'),
      ('clientes',    'clientes_cumpleanos_idx'),
      ('clientes',    'clientes_nombre_idx'),
      ('campanas',    'campanas_fecha_programada_idx'),
      ('campanas',    'campanas_creado_en_idx'),
      ('envios',      'envios_campana_estado_idx'),
      ('mensajes',    'mensajes_telefono_idx'),
      ('productos',   'productos_codigo_key'),
      ('testimonios', 'testimonios_aprobado_idx')
    ) as v(tabla, indice)
  loop
    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and tablename = r.tabla
        and indexname = r.indice
    ) then
      avisos := avisos || ('indice ' || r.tabla || '.' || r.indice);
    end if;
  end loop;

  if cardinality(avisos) > 0 then
    raise notice 'Índices recomendados pendientes (ver sql/00, sql/07 y sql/14): %',
      array_to_string(avisos, ', ');
  end if;

  if cardinality(problemas) > 0 then
    raise exception 'Contrato incompleto: %', array_to_string(problemas, ', ');
  end if;
end $$;

-- Si el bloque anterior no lanzó error, llegamos hasta aquí:
select 'Contrato de datos: OK' as estado;
