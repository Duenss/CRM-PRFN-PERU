# PENDIENTES — hallazgos fuera de alcance (no arreglados a propósito)

> Regla del proyecto: aquí solo se ANOTA lo que se encontró fuera de la tarea en curso.
> Cada entrada: archivo/línea, descripción, fecha.

## Seguridad (auditoría de secretos, 2026-11-11)

1. **Supabase → API Keys**: la clave `service_role` legacy (`sb_secret_p5bu…`, expuesta en el
   historial antiguo) puede seguir listada y válida. Verificar y revocar si existe.
   (Fuente: comparación con `bot/.env`; no se pudo consultar el dashboard.)
2. **Coolify → Environment Variables**: comparar el `BOT_TOKEN` en producción con el expuesto
   (`H5CopP5N…`). Si coincide, rotarlo y actualizar `BOT_TOKEN` en Cloudflare Pages.
3. **`docs/auditoria/capturas/*.png`**: capturas que pueden contener nombres/teléfonos de
   clientes. Revisar a mano las ya versionadas (`01-inicio.png`, `02-bandeja.png`,
   `03-bandeja-sse.png`) y retirarlas con `git rm --cached` si muestran datos personales.
4. **`deploy/pterodactyl/bot.env.produccion3` (disco local)**: conserva la clave service_role
   expuesta. No se sube (ignorado), pero conviene eliminarlo o sanearlo al rotar.

## Despliegue / git

5. **Force-push pendiente**: la limpieza de historial vive en la rama
   `limpieza/historial-secretos`. Para aplicarla en GitHub (decisión del dueño):
   `git push --force-with-lease origin limpieza/historial-secretos:master` y luego
   re-sincronizar el deploy de Coolify (Push to deploy) y Cloudflare Pages.
6. **Rama `auditoria/lote3-sql-higiene`** (commit `924b738`): SQL 14/15/99 + docs + .gitignore
   del Lote 3, sin mergear a master. Los scripts `14` y `15` están pendientes de aplicar en
   Supabase a mano (el dueño los ejecuta).
7. **GitHub**: verificar si el repositorio tiene protección de rama/force-push habilitado y
   si existen forks o clones externos del repo público (conservarían el historial viejo con
   secretos aunque se limpie el origen).

## Código (anotaciones de otras sesiones, sin tocar)

8. `bot/src/app.js` ~1776-1804: ante fallo total de IA no se notifica al dueño por WhatsApp
   (solo evento SSE al panel). Requeriría tocar `app.js`; fuera del alcance de la tarea de IA.
9. Plan "Sprint 1/2" de `docs/auditoria/AUDITORIA-SENIOR.md`: **aparcado por decisión del
   dueño** (F-07, F-08, F-11, F-12, F-14, F-15, F-16, F-17, H-03 RLS por usuario, etc.).
   Tareas 3-8 de la cola (anti-bloqueo, bienvenida determinista, estabilidad conexión,
   IA few-shot, rediseño UI, auditoría T2-T8) siguen pendientes de aprobación una a una.
10. `scripts/e2e-panel.mjs` ST-01 (línea ~1161): el self-test exige que `index.html`
    contenga `SUPABASE_AUTH_KEY` o `SUPABASE_URL`, pero ese marcador no está en el HTML
    actual (tampoco en el HEAD previo a la rama de bienvenida). ST-01 falla por el panel,
    no por el mock; el resto del self-test y el e2e completo (11/11) pasan.
    (Encontrado al validar la rama `bienvenida/secuencia-determinista`, 2026-11-12.)

## Bienvenida determinista (notas de la rama bienvenida/secuencia-determinista)

11. Los medios de fábrica ahora viven en `bot/media/` (dentro de la imagen). Si se regenera
    el catálogo con `node scripts/catalogo/build.mjs`, el script ya copia el PDF a
    `bot/media/`; pero el video y la foto de fábrica **no tienen generador**: si se cambian
    en `docs/entrega/` o `assets/img/brand/`, hay que copiarlos a `bot/media/` a mano
    (o subir los nuevos desde Ajustes del panel, que siempre tienen prioridad).
12. Si en producción `data/ajustes.json` (volumen bot-data-v2) ya tenía `enviarVideo: false`
    guardado de antes, ese valor persiste (respetamos la elección guardada): el video seguirá
    apagado hasta que el dueño lo active en el panel. Los valores por defecto del código
    (video y foto activados) solo aplican a instalaciones sin ese archivo.
