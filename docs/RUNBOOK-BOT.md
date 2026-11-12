# Runbook del bot — Perfumería Fina Perú (1 página)

> Contabo + Coolify · Docker Compose · Supabase · Cloudflare Pages.
> Documento largo: `docs/DESPLIEGUE-COOLIFY-CONTABO.md`.

## 1 · Desplegar

1. Merge a `master` y push → Coolify hace **deploy automático** (GitHub App).
2. Ver logs del contenedor (`pf-bot`). Arranque sano:
   - `Chromium: /root/.cache/puppeteer/...` (Chrome for Testing de Puppeteer)
   - `Backup diario programado a las 03:00 (America/Lima)`
   - `WhatsApp conectado como +51…` (si la sesión persiste) o `QR generado…`
3. Si pide QR: panel → **Ajustes → Conectar WhatsApp** y escanear con el celular de la tienda.
4. Verificar: `curl -s https://bot.perfumeriafinaperu.com/api/health` → `{"ok":true,"zombi":false}`
   (siempre 200; `zombi:true` = conectado >10 min sin mensajes).
   Detalle con token: `curl -H "x-bot-token: $BOT_TOKEN" …/api/estado` → `salud` y `problemas`.

## 2 · Restaurar datos

1. Ver respaldos: `node --env-file=bot/.env scripts/restore-bot.mjs --list`
2. Restaurar (pide confirmación; `--si` para automatizar):
   `node --env-file=bot/.env scripts/restore-bot.mjs --from YYYY-MM-DD`
   - Valida JSON, guarda lo actual en `bot/data/.pre-restore-*` y escribe atómico.
   - `data/*.json` y `comprobantes/` salen de la carpeta elegida; `archivos/`
     (PDF, video, foto) se reconstruye con la **versión más reciente entre todas
     las carpetas**, para no perder una subida nueva hecha después del día elegido.
3. Reiniciar el bot (Coolify → Restart/Redeploy del servicio `bot`).
4. **La sesión de WhatsApp NO se respalda** (`.wwebjs_auth`, volumen `bot-auth-v3`).
   Si el bot pide QR tras restaurar/reinstalar: escanear de nuevo. Por eso el volumen
   `bot-auth-v3` no se debe borrar ni renombrar.
5. Respaldo manual: `node --env-file=bot/.env scripts/backup-bot.mjs` (el job diario del
   bot lo hace solo a las 03:00; bucket privado `bot-backups`, retención 14 días).

## 3 · Qué mirar en los logs

| Patrón en el log | Qué significa | Acción |
|---|---|---|
| `WhatsApp conectado como +51…` | Sesión OK | Nada |
| `Reintentando conexión en 15 s… 5 min (intento N)` | Caída de red; backoff infinito | Esperar; si dura horas, revisar red/VPS |
| `LOGOUT… / Fallo de autenticación` | Sesión desvinculada/corrupta | Se borró la sesión local y hay **un** QR nuevo: escanear |
| `QR generado` | Esperando vínculo | Escanear desde el panel |
| `Sesión de WhatsApp cerrada` | Logout manual o apagado ordenado | Nada |
| `El Chrome anterior no cerró a tiempo` | Chrome viejo forzado a morir | Nada (autocuración) |
| `Backup YYYY-MM-DD: N archivos subidos` | Respaldo diario OK | Nada |
| `El bucket "bot-backups" no existe` | Falta el bucket privado en Supabase Storage | Crearlo (privado); el bot sigue vivo |
| `no se pudo guardar (escritura atómica falló)` | Disco lleno/permisos en `bot/data` | Revisar disco del volumen `bot-data-v2` |
| `zombi:true` en `/api/health` o `sesion_zombi` en `problemas` del panel | Socket muerto sin `disconnected` | Reiniciar sesión en Ajustes (no se reinicia solo) |

## 4 · Emergencias rápidas

- **Bot no responde, pero health OK**: revisar `zombi` y `problemas` en `/api/estado`; reiniciar
  sesión: panel → Ajustes → Conectar WhatsApp → Reiniciar (o `POST /api/sesion/reiniciar` con token).
- **Desvincular/volver a vincular**: `POST /api/logout` (o el botón del panel) → borra y genera QR.
- **Revertir una restauración**: copiar de `bot/data/.pre-restore-<fecha>/` y reiniciar.
- **Cambiar Chrome del contenedor**: NO tocar; la migración a chromium de apt está pendiente
  (`docs/PENDIENTES.md`) y puede invalidar la sesión de `bot-auth-v3`.

## 5 · Validación anti-bloqueo de contactos (2026-11-12)

`POST /api/validar-contactos` (con token) corre como trabajo de prioridad **baja**
en la cola: cede ante mensajes de clientes. Requiere `sql/13_wa_estado_clientes.sql`
(o `sql/EJECUTAR_ESTO.sql`). Variables (todas opcionales):

| Variable | Por defecto | Qué hace |
|---|---|---|
| `VALIDACION_POR_DIA` | `0` | `0` = **sin tope diario**; >0 recorta el día |
| `VALIDACION_MIN_MS` / `VALIDACION_MAX_MS` | `4000` / `10000` | Ritmo entre números (4-10 s, ~7 s). **No bajarlo** |
| `VALIDACION_HORA_INICIO` / `VALIDACION_HORA_FIN` | `9` / `22` | Ventana de Lima; fuera no consulta y retoma al abrir |
| `VALIDACION_LOTE_MIN` / `VALIDACION_LOTE_MAX` | `80` / `120` | Pausa larga cada N números consultados |
| `VALIDACION_PAUSA_LARGA_MIN_MS` / `MAX_MS` | `180000` / `360000` | Duración de la pausa larga (3-6 min) |
| `VALIDACION_ERRORES_PAUSA` / `VALIDACION_PAUSA_MS` | `3` / `900000` | Pausa automática tras 3 errores de infra (15 min) |
| `VALIDACION_UMBRAL_ENTRE_FALLOS_MS` | `600000` | 2 fallos limpios separados ≥10 min confirman "sin WhatsApp" |

Un timeout o una sesión caída **nunca** marca un número: solo 2 respuestas
limpias `no existe` en momentos distintos.

## 6 · IA: ejemplos curados (2026-11-12)

1. `node scripts/extraer-ejemplos.mjs` (lee `bot/data/conversaciones.json` y pedidos;
   `--supabase` añade la tabla `mensajes`). Anonimiza teléfonos, nombres,
   direcciones, correos y links y escribe `bot/data/ejemplos-ia.json`.
2. Revisa el JSON y marca `"aprobado": true` en los ejemplos que quieras usar.
3. Actívalo en el panel: **Ajustes → Asistente IA → Usar ejemplos curados**
   (ajuste `ejemplosIAActivos`, **apagado por defecto**).
4. Los ejemplos que mencionan precios, stock o promociones se descartan; precios
   y promos salen siempre del catálogo y de Ajustes.
5. Si el LLM falla por completo: el cliente recibe un mensaje de respaldo (nunca
   queda en visto) y el dueño recibe un aviso por WhatsApp (máx. 1 cada 30 min
   por chat). Orden de proveedores: Gemini → Groq → Anthropic.
6. Evaluación de 30 casos: `node --env-file=bot/.env scripts/probar-chat.mjs --local --reporte docs/EVALUACION-IA.md`.

## 7 · Cambios operativos 2026-11-12 (final/todo-en-uno)

- **Backups**: la retención lista objetos y borra **por ruta**; antes de borrar
  una carpeta antigua conserva la última copia de `archivos/` resubiéndola al
  backup del día. El restore reconstruye `archivos/` con la versión más reciente
  entre todas las carpetas.
- **409**: `/api/revisar` y `/api/sincronizar` responden 409 si ya hay una
  operación en curso (antes 200). Una campaña con emisor no configurado pasa a
  `estado='error'` visible (requiere `sql/11`; ver `sql/EJECUTAR_ESTO.sql`).
- **Envío manual**: acepta `idempotencyKey` (TTL 15 s) para no duplicar envíos.
- **Contador diario** persistido en `bot/data/contador.json` (sobrevive reinicios).
- **Podas**: IA pausada >90 días y chats de seguimiento >180 días se limpian solos.
- **Panel**: filtros de Bandeja (no leídos, sin responder, con pedido, etiqueta,
  fechas) y de Pedidos (estado, entrega, fechas), con búsqueda persistente.
