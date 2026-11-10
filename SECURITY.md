# Seguridad · CRM Perfumería Fina Perú

## Qué NUNCA se sube al repositorio

- `bot/.env` (ni ninguna copia con valores reales: `*.env`, `bot.env.produccion*`, `.env.local`).
- `servidor-payload*.json` (payload de Pterodactyl con variables de entorno).
- Claves de Supabase (`service_role` / `sb_secret_…`), `BOT_TOKEN`, claves de Gemini/Groq.
- Números de teléfono de clientes o del dueño dentro de código, SQL o docs.

En el repo solo viven plantillas con valores vacíos: `bot/.env.example`,
`bot/.env.production.example`, `deploy/pterodactyl/bot.env.production.example` y
`deploy/pterodactyl/servidor-payload.example.json`.

## Cómo se autentica cada pieza

| Pieza | Autenticación |
|---|---|
| Panel (Cloudflare Pages) | Login de Supabase Auth (email + contraseña). El panel manda el JWT en `Authorization: Bearer`. |
| Proxy `/api/*` (Pages Function) | Valida el JWT contra Supabase y exige que sea el dueño (`OWNER_EMAIL` / `OWNER_UID`). Sin sesión válida → 401. |
| Bot (`/api/*`) | Header `x-bot-token` con comparación de tiempo constante. **Si `BOT_TOKEN` está vacío en producción, el bot rechaza todo menos `/health`.** |
| `/panel` y `/qr` del bot | Basic Auth opcional (`PANEL_USER` / `PANEL_PASS`); si no están configurados, responden 404. |

## Rotación de claves (si alguna se filtró)

1. **Supabase `service_role`**: Project Settings → API Keys → revocar y crear nueva; actualizar `SUPABASE_SERVICE_ROLE_KEY` en el servidor y reiniciar.
2. **`BOT_TOKEN`**: generar uno nuevo:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Actualizarlo en el `.env` del servidor **y** en la variable `BOT_TOKEN` de Cloudflare Pages (el proxy lo inyecta).
3. **Gemini / Groq**: revocar la clave en su consola y crear otra; actualizar `GEMINI_API_KEY` / `GROQ_API_KEY`.
4. **Supabase publishable**: si se filtró, rotarla y actualizar `SUPABASE_KEY` dentro de `index.html`.

## Endurecimiento recomendado en producción

- **No exponer el bot por HTTP plano**: usar Cloudflare Tunnel
  (`cloudflared`) o un reverse proxy con TLS delante del puerto del bot, y
  limitar el firewall a las IPs de Cloudflare.
- Activar **RLS** en todas las tablas de Supabase (ver `sql/03_seguridad_rls.sql`
  y `sql/10_permisos_panel.sql`).
- Mantener el repo **privado**.
- Rotar `BOT_TOKEN` cada cierto tiempo y cuando alguien del equipo salga.

## Reportar un problema

Escribe al dueño del proyecto con: qué endpoint, cómo reproducirlo y el impacto.
No publiques el detalle en issues públicos.

## Estado de las claves (actualizado)

- `SUPABASE_SERVICE_ROLE_KEY`: rotada el 10/11/2026; la anterior ya no existe.
- `BOT_TOKEN`: rotado el 10/11/2026 (64 hex). El anterior quedó revocado.
- Pendiente del dueño: rotar la clave de Gemini y confirmar que el repo siga privado.
- Historial de git: los archivos con secretos se sacaron del índice; si el repo estuvo
  público, considerar reescribir la historia (`git filter-repo`) o asumir las claves viejas
  como comprometidas.
