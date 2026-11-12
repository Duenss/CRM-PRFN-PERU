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
13. **A futuro (pedido del dueño, 2026-11-12)**: el catálogo puede llegar a ser **hasta 2**
    (uno varón y otro dama, porque a veces maneja dos catálogos). Por ahora se mantiene el
    catálogo único actual (`bot/media/catalogo-navidad-2026.pdf`). Requeriría un cambio de
    esquema en Ajustes (lista de catálogos en vez de `catalogoArchivo` único) y en la
    secuencia de bienvenida. NO implementado: quedó fuera del alcance de esta tarea.

## Estabilidad conexión/despliegue (rama estabilidad/conexion-despliegue)

14. **Migrar a chromium del sistema (pedido explícito del dueño, 2026-11-12)**: hoy la imagen
    usa el **Chrome for Testing** que descarga puppeteer 24.38.0 al construir (`~/.cache/puppeteer`).
    Migrar al paquete `chromium` de apt en `bot/Dockerfile` (+ `PUPPETEER_SKIP_DOWNLOAD=1`) se
    dejó FUERA de esta tarea a propósito: **requiere prueba aparte porque puede invalidar la
    sesión del volumen `bot-auth-v3`** (el perfil de usuario es del Chrome actual). Probar en
    un deploy de ensayo antes de aplicarlo en producción.
15. `bot/src/anuncios.js`, `bot/src/ocultos.js`, `bot/src/bajas.js`: guardan todavía con
    `writeFileSync` directo (sin tmp+rename). La tarea pedía escritura atómica solo en
    ajustes, seguimiento, ia, pedidos y pagos (hecha); estos tres quedan como endurecimiento
    futuro. (2026-11-12.)
16. `Dockerfile` de la raíz: marcado **OBSOLETO** con banner (usar `bot/Dockerfile`). Si algún
    flujo externo lo referencia (p. ej. documentación vieja), apuntarlo a `bot/Dockerfile`;
    se conserva el archivo solo como referencia histórica. (2026-11-12.)

## Anti-bloqueo de WhatsApp (rama wa/anti-bloqueo-validacion)

17. `bot/test/sanitizacion.test.mjs` (líneas 11-12): **falla en checkout Windows con finales de
    línea CRLF** — la regex de extracción de `esc()` exige `;\n` y `assets/app.js` usa `\r\n`.
    Verificado que falla igual en HEAD (worktree temporal) y que en Linux/LF pasa; NO lo arreglé
    por estar fuera del alcance de esta tarea. Si se quiere verde en Windows: aceptar `\r?\n`
    en las dos regex del test (1 línea). (2026-11-12.)
18. El panel no tiene botón que dispare `POST /api/validar-contactos` (solo se llama por API/curl);
    con el nuevo flujo por lotes convendría un botón "Validar WhatsApp (lento)" en Ajustes/Bot.
    Fuera del alcance de esta tarea (el alcance solo pedía revisar/restaurar los marcados).
    (2026-11-12.)
19. `actualizarHistorialesConocidos()` (bot/src/app.js) sigue importando el historial completo de
    hasta 250 chats al conectar/reconectar: es una sola pasada por conexión (no periódica), pero
    es la lectura más pesada que queda. Si el número vuelve a mostrar señales de bloqueo, el
    siguiente paso natural es convertirla también a incremental (misma técnica que
    `listarChatsActivosWa`). Anotado, no implementado. (2026-11-12.)
