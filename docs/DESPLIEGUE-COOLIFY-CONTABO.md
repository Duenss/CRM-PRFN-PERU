# Despliegue del bot en Contabo + Coolify Cloud

Estado actual del bot de WhatsApp del CRM (noviembre 2026).

## Arquitectura

| Pieza | Detalle |
|---|---|
| Servidor | Contabo Cloud VPS 4 — 4 vCPU / 8 GB RAM / 100 GB — `62.171.182.130` |
| Panel de despliegue | **Coolify Cloud** (v4.5.3) |
| Repositorio | GitHub `Duenss/CRM-PRFN-PERU` (privado) vía **GitHub App** |
| Proyecto/env | `My first project` → `production` |
| Aplicación | **crm-bot** (Docker Compose) |
| Dominio | **https://bot.perfumeriafinaperu.com** |
| Contenedor | `bot-...` (servicio `bot`, puerto interno 25577) |
| Healthcheck | `GET /api/health` (definido en `bot/Dockerfile`) |

## Archivos de despliegue

- `docker-compose.yml` (raíz del repo): servicio `bot`, volúmenes `bot-data`, `bot-auth`, `bot-cache`, variables `${...}`.
- `bot/Dockerfile`: Node 22 + Chromium del sistema (`/usr/bin/chromium`), `tini`, healthcheck.
- `bot/.dockerignore`: excluye `node_modules`, `data`, `.wwebjs_auth`, `.env`.
- `deploy/.env.example`: variables necesarias.

## Variables de entorno (Coolify → Environment Variables)

Se cargan desde `bot/.env`. Claves principales:

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
HEADLESS=true
```

El compose fija `CHROME_PATH=/usr/bin/chromium`, `SESSION_PATH=/app/.wwebjs_auth` y `PORT=25577`.

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

## Operación

1. Push a `master` → GitHub App notifica a Coolify → **Deploy automático** (Auto deploy on push).
2. La primera build tarda ~4–6 min (instala Chromium vía apt).
3. El bot arranca en estado `qr`; el QR se genera y se muestra en el panel (Ajustes → Conectar WhatsApp).
4. Escanear con el celular de la tienda; luego **Sincronizar WhatsApp** para traer chats.
5. 24/7: Ajustes → Horario → **0** a **24** (o botón “Poner 24/7”) → Guardar.

## Troubleshooting

- **Error 503 en el dominio / estado “Degraded”**: casi siempre es el healthcheck. Verificar que la versión desplegada tenga la ruta `GET /api/health` (`bot/src/app.js`) y que el commit esté pusheado.
- **`Could not read Git source` / repo privado**: usar **GitHub App** (Integrations → Sources → GitHub App) en vez de deploy key. GitHub rechaza llaves RSA cortas (< 3072 bits) en Deploy keys.
- **Puerto “Unrecognized internal port”** al agregar dominio: aceptar con “Use This Port Anyway” (25577).
- **QR se regenera constantemente**: normal hasta escanear; el cliente WhatsApp se reconecta.
- **`conversaciones.json corrupto`** al primer arranque: el volumen está vacío; el bot lo recrea automáticamente.

## Notas

- Backups automáticos de Coolify: **no configurados** (decisión del dueño).
- La VPS anterior (Sakura/Pterodactyl) queda fuera de uso; el bot ya corre en Contabo.
- El panel del CRM sigue en Cloudflare Pages: `https://crm.perfumeriafinaperu.com`.
