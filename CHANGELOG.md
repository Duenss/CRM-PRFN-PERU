# Changelog

## 10/11/2026 · Endurecimiento (FASES 0–4 del encargo)

### Seguridad
- Secretos fuera del índice de git (`bot.env.produccion*`, `servidor-payload*.json`) y
  plantillas `.example` con valores vacíos; `SECURITY.md`.
- Proxy de Pages con **JWT de Supabase** validado contra `/auth/v1/user`, lista blanca de
  rutas y métodos, sin CORS `*`; el `BOT_TOKEN` se inyecta del lado del servidor.
- Bot con auth **falla cerrado** y comparación en tiempo constante; `/panel` y `/qr` con
  Basic Auth; límite de peticiones y validación de entrada.
- SSE sin token en la URL: `fetch` + cabecera `Authorization`; `supabase-js` auto-hospedado.
- `_headers` con CSP, HSTS, `X-Frame-Options`, `Referrer-Policy` y `Permissions-Policy`.
- RLS estricta: catálogo público de solo lectura; clientes, campañas y envíos privados.
- Rotadas `service_role` de Supabase y `BOT_TOKEN`.

### Panel
- Sin scroll horizontal en 360/768/1280 px; objetivos táctiles de 40–44 px.
- CSS y JS separados (`assets/app.css`, `assets/app.js`), fuentes Inter/Space Grotesk
  auto-hospedadas con `font-display: swap`; contraste `mute2` corregido a AA.
- Marca: monograma SVG de frasco en la barra lateral (`docs/MARCA.md`).
- Sonidos configurables (volumen y eventos), antirrebote de 1.5 s, contador de no leídos en el
  título y sonido apagado por defecto.
- Pedidos con respaldo local si el bot está apagado y sincronización automática.
- Selector de contactos para envíos masivos y selector de clientes al crear pedidos.
- Festivos completos en el calendario; no leídos que no “resucitan” al sincronizar.

### Bot / IA
- No se atienden consultas de mayoristas, revendedores, kits, envases o esencias: se deriva.
- Promo de 3 perfumes de 30 ml por S/ 90 explicada y derivada al administrador.
- Recomendaciones con preguntas previas (dama/caballero, notas, día/noche) y ficha corta de
  cada perfume (notas, ocasión, estilo) junto a la foto.
- Bienvenida, PDF y video configurables desde Ajustes.
- Supervisor con auto-reinicio del proceso del bot.

### Calidad
- Router `bot/src/routes/ajustes.js` separado de `app.js` (primera etapa del split).
- 78 pruebas: incluye lista blanca del proxy, validación del dueño y sanitización de `esc()`.
- Auditoría axe (WCAG AA) en 1280 y 360 px: **0 violaciones** en las 11 pestañas y el login.
- 69 pruebas unitarias, 11 e2e y CI de GitHub Actions.
