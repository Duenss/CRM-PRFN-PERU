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
- Respuestas rápidas en la bandeja (saludo, catálogo, promo 3×90, pagos, horario) con el nombre del cliente.
- Selector de contactos para envíos masivos y selector de clientes al crear pedidos.
- Festivos completos en el calendario; no leídos que no “resucitan” al sincronizar.

### Bot / IA
- No se atienden consultas de mayoristas, revendedores, kits, envases o esencias: se deriva.
- Promo de 3 perfumes de 30 ml por S/ 90 explicada y derivada al administrador.
- Recomendaciones con preguntas previas (dama/caballero, notas, día/noche) y ficha corta de
  cada perfume (notas, ocasión, estilo) junto a la foto.
- Bienvenida, PDF y video configurables desde Ajustes.
- Supervisor con auto-reinicio del proceso del bot.

### Envío masivo
- Motor de anuncios verificado en simulación: texto con `{nombre}` + PDF + video, estado `enviado` 1/1 y 0 errores.

### Bajas
- `BAJA/STOP` se confirma siempre y se guarda también para números que aún no son clientes (`bot/data/bajas.json`); anuncios y selector de contactos los excluyen.

### Pruebas del chat
- `scripts/probar-chat.mjs` + `docs/PRUEBAS-CHAT.md`: guion de pruebas simuladas (sin QR) y reales.
- Corregido saludo vacío en la respuesta de precios y en la **ficha del perfume** (foto con notas, ocasión y estilo). y la IA ya usa la hora de Lima (no saluda "buenas tardes" de noche).
- Al recomendar se menciona la promo 3 × S/ 90 y se ofrece pasar con un administrador.

### Calidad
- Routers separados de `app.js`: `routes/ajustes.js`, `routes/pedidos.js`, `routes/seguimiento.js`, `routes/anuncios.js` y `routes/conversaciones.js`.
- 78 pruebas: incluye lista blanca del proxy, validación del dueño y sanitización de `esc()`.
- Auditoría axe (WCAG AA) en 1280 y 360 px: **0 violaciones** en las 11 pestañas y el login.
- 69 pruebas unitarias, 11 e2e y CI de GitHub Actions.
