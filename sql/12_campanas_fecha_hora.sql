-- Campañas: guardar la HORA de programación, no solo la fecha.
--
-- La columna `fecha_programada` estaba como DATE, así que al programar una
-- campaña "hoy a las 20:00" la base guardaba solo "hoy" y el bot la enviaba en
-- el primer tick del día (no a la hora elegida).
--
-- Este script la pasa a `timestamptz` conservando la hora. Las fechas que ya
-- existían se interpretan como medianoche de Lima.
--
-- Ejecutar en Supabase → SQL Editor → Run.

begin;

alter table public.campanas
  alter column fecha_programada type timestamptz
  using ((fecha_programada::timestamp) at time zone 'America/Lima');

comment on column public.campanas.fecha_programada is 'Fecha y hora de envío (zona America/Lima)';

commit;
