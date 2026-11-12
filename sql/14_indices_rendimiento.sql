-- ============================================================================
-- 14_indices_rendimiento.sql — Índices faltantes para las consultas del panel
-- (hallazgo H-09 de la auditoría senior).
-- ============================================================================
-- Qué hace (idempotente: se puede ejecutar varias veces):
--   1. campanas(creado_en desc): el panel lista y ordena las campañas por
--      creado_en en cada carga (assets/app.js: order('creado_en', descending)).
--   2. clientes(nombre): el panel ordena TODA la tabla de clientes por nombre
--      en cada carga (assets/app.js: order('nombre')) y el bot la recorre
--      entera en campañas, anuncios y sincronización.
--
-- Por qué: sin estos índices, Postgres hace un sort en disco en cada refresco
-- del panel; con más de 1.000 clientes el dashboard tarda de más y carga el
-- servidor de Supabase sin necesidad.
--
-- Cómo aplicarlo:
--   Supabase Studio → SQL Editor → pegar este archivo → Run.
--   (También psql:  \i sql/14_indices_rendimiento.sql)
--
-- Verificación posterior (debe devolver las 2 filas):
--   select indexname from pg_indexes
--    where schemaname = 'public'
--      and tablename in ('campanas', 'clientes')
--      and indexname in ('campanas_creado_en_idx', 'clientes_nombre_idx');
-- ============================================================================

begin;

create index if not exists campanas_creado_en_idx
  on public.campanas (creado_en desc);

create index if not exists clientes_nombre_idx
  on public.clientes (nombre);

commit;

-- ============================================================================
-- Nota: si la columna no existiera en tu base, Postgres falla aquí con un
-- error claro (no se crea nada a medias: la transacción revierte). Revisa
-- entonces sql/99_verificar_contrato.sql para ver qué falta.
-- ============================================================================
