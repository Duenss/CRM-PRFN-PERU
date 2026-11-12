# CRM Perfumería Fina Perú

Panel de ventas + bot de WhatsApp con IA para Perfumería Fina Perú.

- **Panel**: un `index.html` estático (Cloudflare Pages) que lee y escribe en Supabase.
- **Proxy**: `functions/api/[[path]].js` valida la sesión del dueño y reenvía `/api/*` al bot.
- **Bot**: Node + Express + whatsapp-web.js, desplegado en Pterodactyl.

## Requisitos

- Node.js 20+ (probado con 24).
- Proyecto de Supabase (tablas del CRM) y un usuario de Auth para el dueño.
- Un servidor para el bot (Pterodactyl/Wings o cualquier VPS con Docker y Chromium).
- Cuenta de Cloudflare (Pages) para el panel.

## Instalación en 5 pasos

1. **Base de datos**: ejecuta en Supabase → SQL Editor los archivos de `sql/` en orden:
   `00_instalar_todo.sql` (o `01`…`02`), `03_seguridad_rls.sql`, `07_envios_claim.sql`,
   `10_permisos_panel.sql`, `11_arreglar_estado_campanas.sql`, `12_campanas_fecha_hora.sql`,
   `14_indices_rendimiento.sql` y `15_testimonios_sin_auto.sql` (testimonios con aprobación
   manual). Opcional: `99_verificar_contrato.sql` (solo comprueba que el esquema cumpla lo
   que la app usa; no cambia nada). Crea el usuario del dueño en **Authentication → Users**.
2. **Bot local**:
   ```bash
   cd bot
   cp .env.example .env      # completa valores
   npm install
   node src/server.js
   ```
3. **Bot en producción**: usa la imagen `ghcr.io/duenss/crm-prfn-bot-image:latest` con el
   `STARTUP` de Pterodactyl (`cd /home/container/bot; exec node src/server.js`). Detalles en
   `docs/DESPLIEGUE-PRODUCCION.md`.
4. **Panel en Cloudflare Pages**: conecta este repo, preset *None*, build vacío, salida `/`.
   Variables en Pages: `BOT_URL`, `BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `OWNER_EMAIL` y `PANEL_ORIGIN` (ver `docs/DESPLIEGUE-PRODUCCION.md`).
5. **WhatsApp**: abre el panel, entra a *Ajustes → Conectar WhatsApp (QR)* y escanea el QR con
   el número de la tienda.

## Variables de entorno del bot

| Variable | Descripción |
|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave secreta de Supabase (solo servidor) |
| `BOT_TOKEN` | Token largo para la API del bot (obligatorio en producción) |
| `GEMINI_API_KEY` | IA para respuestas, anuncios y transcripción |
| `MAX_POR_DIA` | `0` = sin límite diario |
| `DELAY_MIN` / `DELAY_MAX` | Segundos entre mensajes (25–40 por defecto) |
| `PANEL_ORIGINS` | Orígenes permitidos para CORS |
| `PANEL_USER` / `PANEL_PASS` | Basic Auth para `/panel` y `/qr` |

Plantilla completa: `bot/.env.production.example`.

## Pruebas

```bash
cd bot
npm test                 # unitarias (88)
node ../scripts/e2e-panel.mjs   # e2e del panel (11)
```

## Troubleshooting

- **“Bot apagado” en el panel**: el bot no responde. Revisa el servidor en Pterodactyl y
  `BOT_URL`/`BOT_TOKEN` en Cloudflare Pages.
- **“Sesión requerida” en `/api/*`**: falta login o el `SUPABASE_ANON_KEY` de Pages no es el
  correcto.
- **Sin permisos al guardar**: ejecuta `sql/10_permisos_panel.sql` (RLS).
- **No llega el QR**: revisa que Chromium exista en el contenedor y el log del bot.

## Documentación

`docs/ENTREGA.md` (resumen de entrega) · `docs/GUIA-DUENO.md` (manual de uso) · `docs/VERIFICACION-PANEL.md` · `docs/PRUEBAS-CHAT.md` · `scripts/probar-chat.mjs` (pruebas simuladas del chat) · `docs/DESPLIEGUE-PRODUCCION.md` · `docs/TRASPASO.md` · `docs/DISENO_PANEL.md` ·
`docs/MARCA.md` · `SECURITY.md` · `CHANGELOG.md`
