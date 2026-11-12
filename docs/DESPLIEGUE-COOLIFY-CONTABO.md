# Despliegue del bot en Contabo + Coolify Cloud

Estado actual del bot de WhatsApp del CRM (noviembre 2026). Verificado contra lo que
REALMENTE corre: `docker-compose.yml`, `bot/Dockerfile`, `bot/src/whatsapp.js`
(`buscarChromium`) y `bot/package-lock.json` (puppeteer 24.38.0).

## Arquitectura

| Pieza | Detalle |
|---|---|
| Servidor | Contabo Cloud VPS 4 — 4 vCPU / 8 GB RAM / 100 GB — `62.171.182.130` |
| Panel de despliegue | **Coolify Cloud** (v4.5.3) |
| Repositorio | GitHub `Duenss/CRM-PRFN-PERU` vía **GitHub App** |
| Proyecto/env | `My first project` → `production` |
| Aplicación | **crm-bot** (Docker Compose) |
| Dominio | **https://bot.perfumeriafinaperu.com** |
| Contenedor | `pf-bot` (servicio `bot`, puerto interno 25577) |
| Healthcheck | `GET /api/health` → siempre 200, `{ ok, zombi }` (definido en `bot/Dockerfile`) |

## Archivos de despliegue

- `docker-compose.yml` (raíz del repo): servicio `bot`, contexto `./bot`,
  volúmenes **`bot-data-v2`** → `/app/data`, **`bot-auth-v3`** → `/app/.wwebjs_auth`,
  **`bot-cache-v3`** → `/app/.wwebjs_cache` (NO renombrar: conservan la sesión y los datos).
- `bot/Dockerfile`: Node 22 (bookworm-slim) + librerías de Chrome + `tini` + `xvfb`,
  healthcheck `/api/health`, `EXPOSE 25577`. **No instala `chromium` de apt** (ver nota
  de Chrome más abajo).
- `bot/.dockerignore`: excluye `node_modules`, `data`, `.wwebjs_auth`, `.env`.
- `deploy/.env.example`: variables necesarias (las reales viven en Coolify → Environment Variables y en `bot/.env`, nunca en el repo).
- `Dockerfile` de la RAÍZ: **OBSOLETO** (solo referencia histórica; usar `bot/Dockerfile`).

## Chrome: cuál se usa realmente

1. `npm ci` en la imagen ejecuta el postinstall de **puppeteer 24.38.0** (dependencia de
   whatsapp-web.js), que descarga **Chrome for Testing** a `~/.cache/puppeteer`
   (`/root/.cache/puppeteer/chrome-linux64/…` o `chrome-headless-shell-linux64/…`).
2. `buscarChromium()` en `bot/src/whatsapp.js` prueba en orden: `CHROME_PATH`,
   `PUPPETEER_EXECUTABLE_PATH`, `/usr/bin/chromium` (NO existe en la imagen), snap, y por
   último el caché de Puppeteer → **encuentra el Chrome for Testing descargado**.
3. `HEADLESS=false` + `DISPLAY=:99`: el CMD del Dockerfile arranca **Xvfb** y el Chrome
   corre "con ventana" virtual en el display 99.

> ⚠️ El compose NO fija `CHROME_PATH` (la doc vieja lo decía mal). Migrar a
> `chromium` de apt (`/usr/bin/chromium`) es una mejora pendiente anotada en
> `docs/PENDIENTES.md`: requiere prueba aparte porque puede invalidar la sesión del
> volumen `bot-auth-v3`.

## Variables de entorno (Coolify → Environment Variables)

El compose las toma de `${...}` y fija además: `PORT=25577`, `TZ=America/Lima`,
`HEADLESS=false`, `DISPLAY=:99`, `SESSION_PATH=/app/.wwebjs_auth`. Claves principales:

```
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY
BOT_TOKEN
OWNER_NUMBER / OWNER_EMAIL
GEMINI_API_KEY / AI_MODEL
MODO_PRUEBA=false / NUMEROS_PRUEBA= / SIMULAR_ENTRANTES=false
AUTO_RESPUESTA=true / RESPONDER_DESCONOCIDOS=true
PANEL_URL=https://perfumeriafinaperu.com
PANEL_ORIGINS=https://crm.perfumeriafinaperu.com,https://crm-prfn-peru.pages.dev
PANEL_USER=dueno / PANEL_PASS=... (privado)
DELAY_MIN=25 / DELAY_MAX=40 / MAX_POR_DIA=0
HORA_INICIO=9 / HORA_FIN=20 / LUNES_A_SABADO=true
SEGUIMIENTO_DIAS_1=3 / SEGUIMIENTO_DIAS_2=180
SALUD_ZOMBI_SEGUNDOS=600        (umbral de sesión zombi; opcional)
```

## DNS

Cloudflare → `perfumeriafinaperu.com` → DNS → Records:

```
A  bot  62.171.182.130  (DNS only / nube gris)
```

> Debe ser **DNS only** para que Coolify emita el certificado Let's Encrypt. Si se activa el proxy naranja después, usar SSL/TLS **Full (strict)**.

## Panel (Cloudflare Pages)

En el proyecto `crm-prfn-peru` → Settings → Environment variables:

```
BOT_URL = https://bot.perfumeriafinaperu.com
```

Guardar y **Redeploy** para que el proxy `/api/*` use el bot nuevo.

## Conexión de WhatsApp (estabilidad)

- Caída de red/WhatsApp: reconexión con **backoff exponencial infinito 15 s → 5 min**.
- **LOGOUT** (desvinculado desde el celular) o fallo de autenticación: se borra la
  sesión local, se genera **un único QR** y NO se reintenta en bucle (espera el escaneo
  o un reinicio manual desde Ajustes → Conectar WhatsApp).
- Un solo Chrome por sesión: cada client nuevo destruye el anterior (timeout 10 s y
  kill del proceso si no cierra); timers rastreados y cancelados en logout/reinicio.
- Versión de WhatsApp Web: copia **local** en `data/web-version-cache.html` (el remoto
  solo se consulta para refrescarla cada 7 días; sin red, arranca con la copia).
- Sesión zombi (conectada >10 min sin mensajes): `zombi=true` en `/api/health` y aviso
  rojo en el panel vía `/api/estado` → `problemas` (no reinicia nada solo).

## Backups

- Job **diario dentro del bot** (03:00 hora de Lima) → Supabase Storage, bucket privado
  **`bot-backups`** (crearlo a mano en Supabase → Storage; si no existe, el bot solo
  registra el error y sigue vivo). Sube `data/*.json` + `comprobantes/` siempre y
  `archivos/` solo si su hash cambió. **Retención: 14 días.**
- Manual (misma lógica): `node --env-file=bot/.env scripts/backup-bot.mjs` y
  `scripts/restore-bot.mjs --list | --from YYYY-MM-DD [--si]`.
- **La sesión de WhatsApp (`.wwebjs_auth`, volumen `bot-auth-v3`) NO se respalda**:
  si se pierde, hay que escanear el QR de nuevo. Detalles en `docs/RUNBOOK-BOT.md`.

## Operación

1. Push a `master` → GitHub App notifica a Coolify → **Deploy automático**.
2. La primera build tarda ~4–6 min (descarga Chrome for Testing dentro de la imagen).
3. El bot arranca en estado `qr`; se muestra en el panel (Ajustes → Conectar WhatsApp).
4. Escanear con el celular de la tienda; luego **Sincronizar WhatsApp** para traer chats.
5. 24/7: Ajustes → Horario → **0** a **24** (o botón “Poner 24/7”) → Guardar.

## Troubleshooting

- **Error 503 en el dominio / estado “Degraded”**: casi siempre el healthcheck. Verificar
  que la versión desplegada tenga `GET /api/health` (`bot/src/app.js`) y que el commit
  esté pusheado.
- **`/api/health` devuelve `zombi:true`**: sesión conectada >10 min sin mensajes.
  Mirar `/api/estado` (con token) → `salud`/`problemas` y los logs; si persiste,
  reiniciar la sesión desde Ajustes → Conectar WhatsApp.
- **Log: "El bucket bot-backups no existe…"**: crear el bucket privado en Supabase →
  Storage. El bot no se cae por esto.
- **Log: "Reintentando conexión en N s"**: caída de red; el bot se recupera solo con
  backoff hasta 5 min. Si escala a horas, revisar la VPS/red.
- **Log: "LOGOUT / Fallo de autenticación"**: borró la sesión local y espera un QR
  nuevo; escanear desde el panel.
- **QR se regenera constantemente**: normal hasta escanear.
- **`conversaciones.json corrupto` al primer arranque**: el volumen está vacío; el bot
  lo recrea automáticamente.
- **`Could not read Git source` / repo privado**: usar **GitHub App** (Integrations →
  Sources) en vez de deploy key.
- **Puerto “Unrecognized internal port”** al agregar dominio: aceptar con “Use This
  Port Anyway” (25577).

## Notas

- Backups automáticos de Coolify: **no configurados** (decisión del dueño); el respaldo
  de datos del bot se cubre con el job a Supabase Storage.
- La VPS anterior (Sakura/Pterodactyl) queda fuera de uso; el bot corre en Contabo.
- El panel del CRM sigue en Cloudflare Pages: `https://crm.perfumeriafinaperu.com`.
- Runbook de operación (desplegar/restaurar/logs): `docs/RUNBOOK-BOT.md`.
