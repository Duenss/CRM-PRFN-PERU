-- ============================================================================
-- 07_envios_claim.sql — Claim atómico de envíos de campaña (arreglo F-01)
-- ============================================================================
-- Qué hace (idempotente: se puede ejecutar varias veces):
--   1. Añade envios.wa_id (id real del mensaje de WhatsApp) y envios.nota
--      (motivo del error) para poder auditar cada envío.
--   2. Permite el estado 'enviando' en envios.estado, reemplazando SOLO el
--      CHECK que menciona la columna estado (no toca otros constraints).
--   3. Crea el índice (campana_id, estado) que usan el claim y el cierre.
--
-- Por qué: el bot reclama cada fila pendiente→'enviando' ANTES de mandar el
-- mensaje; si el update falla ya no se envía nada (fail-safe). Sin este estado
-- el update falla y la campaña se reenviaría cada 60 s (F-01, P0).
--
-- Cómo aplicarlo:
--   Supabase Studio → SQL Editor → pegar este archivo → Run.
--   O desde psql:  \i sql/07_envios_claim.sql
--
-- Verificación posterior (debe devolver las 3 filas esperadas):
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'envios'
--      and column_name in ('wa_id', 'nota');
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.envios'::regclass and contype = 'c';
--   select indexname from pg_indexes
--    where schemaname = 'public' and tablename = 'envios'
--      and indexname = 'envios_campana_estado_idx';
-- ============================================================================

begin;

-- 1) Columnas nuevas (idempotente) ------------------------------------------
alter table public.envios add column if not exists wa_id text;
alter table public.envios add column if not exists nota text;

comment on column public.envios.wa_id is
  'Id del mensaje devuelto por WhatsApp (sendMessage); permite auditar envíos y evita reenvíos.';
comment on column public.envios.nota is
  'Motivo visible cuando un envío queda en error (p. ej. "proceso interrumpido").';

-- 2) Permitir el estado 'enviando' ------------------------------------------
-- Se eliminan únicamente los CHECK de public.envios cuya definición mencione la
-- palabra "estado" como columna (hoy: envios_estado_valido). Después se recrea
-- con la lista nueva. Nota: Postgres no soporta
-- "alter table ... add constraint if not exists", por eso se hace por bloque DO
-- y resulta idempotente.
do $$
declare
  r record;
begin
  for r in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.envios'::regclass
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ~ '\mestado\M'
  loop
    execute format('alter table public.envios drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.envios
  add constraint envios_estado_valido
  check (estado in ('pendiente', 'enviando', 'enviado', 'omitido', 'error'));

-- 3) Índice para el claim y el cierre de campaña ----------------------------
-- (create index if not exists dentro de la transacción es válido; para tablas
--  grandes en producción se puede crear antes/después con CONCURRENTLY).
create index if not exists envios_campana_estado_idx
  on public.envios (campana_id, estado);

commit;

-- ============================================================================
-- Nota operativa: si ya había filas de envíos en 'enviando' de una ejecución
-- anterior, el bot las barre al arrancar (>10 min → 'error' con nota
-- "proceso interrumpido"). No hace falta hacerlo a mano.
-- ============================================================================
