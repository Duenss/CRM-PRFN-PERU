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
