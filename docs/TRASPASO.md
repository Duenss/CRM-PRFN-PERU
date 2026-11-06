# Traspaso técnico — CRM Perfumería Fina

> Este archivo existe para que **otra IA o otra persona** pueda continuar sin
> perder contexto ni romper lo que ya funciona.
> Se actualiza al terminar cada fase. Última actualización: 2026-11-06.

---

## Estado actual (2026-11-06) — FASES 1, 2, 3 y 4 COMPLETADAS

- Panel rediseñado (wacrm-style, acento dorado) en un solo `index.html`.
- 8 pestañas: Inicio, Bandeja, Campañas, Clientes, Catálogo, Calendario, Asistente IA, Ajustes.
- **Bandeja de entrada** en vivo y **Asistente IA** conectados al bot (`/api/ia`, `/api/conversaciones`).
- **Sincronización con WhatsApp**: "Sincronizar WhatsApp" (Bandeja) trae **todos** los chats del
  número vinculado, no solo los que recibió el bot; "Recaudar contactos" (Clientes) y la tarjeta de
  Ajustes guardan nombre + número en `clientes` **sin consentimiento** (no sobrescriben datos ya
  cargados). Al abrir un chat sincronizado se importa su historial desde WhatsApp a demanda.
  Rutas: `POST /api/sincronizar` y `POST /api/conversaciones/:telefono/importar`.
  - Los chats `@lid` (identificadores nuevos de WhatsApp Web) se resuelven a teléfono real vía
    `contact.phoneNumber` / `enforceLidAndPnRetrieval`; se excluye el chat propio **salvo que esté
    fijado** (así el orden refleja el de WhatsApp, donde el auto-chat suele estar anclado).
  - **Orden de la bandeja**: fijados primero (`c.pin > 0`) y luego por la hora real del último
    mensaje (ignorando reacciones). Los chats que solo tienen reacciones/avisos quedan sin fecha y
    al final, nunca por encima de conversaciones reales. La hora se muestra estilo WhatsApp
    (`HH:mm`, `Ayer`, día de la semana o fecha) en `horaWa()`.
  - `registrarCabecera` guarda a disco, así los chats sincronizados persisten tras reiniciar.
  - `getChats`/`getChatById`/`fetchMessages` de whatsapp-web.js fallan ("r") en la versión actual de
    WhatsApp Web: se leen chats y mensajes directo de la página, tolerando errores por chat.
- **QR sin caché**: `/api/estado` responde `Cache-Control: no-store` y el panel lo pide con
  cache-buster y refresca cada 2.5 s, para no mostrar un QR caducado ("no se puede conectar al dispositivo").
- **Modelo de IA**: `gemini-3-flash-preview` (el más rápido medido, ~1.2 s) con cadena de respaldo
  `gemini-flash-latest` → `gemini-3.8-flash`; `thinkingConfig:{thinkingBudget:0}` porque Gemini 3
  gasta tokens "pensando" y corta el JSON; timeout de 60 s por intento.
- **Conexión del bot dentro del dashboard**: chip de estado en la barra superior + tarjeta en IA/Ajustes.
- **Un solo dashboard**: el QR, el envío de prueba y el registro del bot viven en **Ajustes**;
  ya no se abre el panel externo del bot (`bot/src/panel.html` queda solo como respaldo de la API).
- **Sonidos de interfaz** (Web Audio, igual que `portafolio-v4`): botón de altavoz en la barra,
  clic 480 Hz, confirmación y error, interruptor 620/820. Guardado en `localStorage` (`ui_sound`).
- **Actualizaciones fantasma**: helper `fantasma()` / `fantasmaValor()` en `index.html`; las listas
  y contadores solo se repintan si el HTML cambió, con transición suave (sin parpadeos).
- Probado: todas las pestañas sin errores de consola; el QR se muestra en Ajustes; reintento
  de carga con datos idénticos no re-renderiza (identidad de nodo conservada).
- Config final: `HORA_INICIO=9`, `HORA_FIN=20`, `SIMULAR_ENTRANTES=false`, `NUMEROS_PRUEBA` con el número de prueba.
- Repo git inicializado con commit inicial; `.env`, `node_modules`, `wwebjs_auth` y `bot/data` ignorados.
- Probado end-to-end (sesión previa): entrante → respuesta IA; maestro off y pausa por chat cortan las respuestas.

### Correcciones de sincronización y bandeja
- **Entrantes de cualquier país**: `manejarMensaje` ya no descarta números que no son de Perú
  (antes `esNumeroPeru` bloqueaba, p. ej., el propio número del bot +56). Se valida solo que sea
  un número de 8–15 dígitos.
- **Chats `@lid`**: el teléfono real se resuelve con `resolverTelefonoWa()` (vía `WAWebApiContact` /
  `enforceLidAndPnRetrieval`) tanto para entrantes como para los mensajes que envías tú.
- **Multimedia**: imágenes, videos, audios, stickers y documentos se guardan como marcadores
  (`[imagen]`, `[video]`, `[nota de voz]`, …) para que el hilo quede completo; no disparan IA.
- **Tus propios mensajes**: `message_create` registra lo que envías desde el celular (origen "panel");
  los que manda el bot se descartan para no duplicar.
- **Historial completo y en orden**: `historialWa` ordena por fecha ascendente, incluye multimedia
  y deduplica por `waId` (obtenido de `id._serialized || id.id || key.id`). Al abrir un chat
  **siempre** se reimporta y se refresca cada 20 s; la lista cada 12 s.
- **Sin duplicados**: `importarMensajes` deduplica por `waId` y, si falta, por huella
  (`fecha|dirección|texto`). Verificado: importar dos veces seguidas da `nuevos: 0`.
- **Scroll de la Bandeja**: `grid-template-rows:minmax(0,1fr)` y `min-height:0` para que la lista
  de contactos y el hilo tengan su propio scroll.
- **Clientes**: el panel lee `clientes` con sesión de Supabase; si por RLS/sesión viniera vacío,
  cae al respaldo `GET /api/clientes` (servicio) para que la lista nunca se vea en blanco.
- **Números de prueba**: `NUMEROS_PRUEBA` y `OWNER_NUMBER` reciben respuesta de la IA aunque sea
  fuera del horario de atención (para poder probar a cualquier hora).

Pendiente del dueño antes de producción (ver `README.md` → *Puesta en producción*):
`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, ejecutar SQL 01–03, crear usuario dueño,
y decidir dónde vive el bot 24/7.

---

## 0. Reglas que NO se negocian

1. El panel sigue siendo **un solo `index.html`** con CSS y JS inline. Sin build, sin React.
2. No se renombran IDs, `data-*` ni funciones que el JS usa (lista en §5).
3. No se tocan las tablas/columnas de Supabase ya creadas (ver §4).
4. `service_role` y claves de IA **nunca** en el navegador. Solo en `bot/.env` y variables de Cloudflare.
5. La IA **nunca** envía campañas sola. Solo redacta borradores y responde consultas entrantes.
6. Todo mensaje promocional exige consentimiento, respeta BAJA y el horario configurado.
7. El diseño sigue el contrato de [`DISENO_PANEL.md`](DISENO_PANEL.md). Acento dorado `#DDB75F`.
8. Antes de cada fase: `git init` + commit, o copia `.bak` de `index.html`.

## 1. Objetivo de la fase actual

Rediseñar el panel con la estructura visual de **wacrm** y agregar la pantalla
**Asistente IA** con:

- interruptor maestro (IA encendida/apagada),
- interruptor de respuesta automática,
- máximo de respuestas por conversación,
- pausar/reanudar la IA **por cliente**,
- estado del bot y del número en vivo.

Sin cambiar la lógica de campañas, catálogo, clientes ni calendario.

## 2. Repo de referencia

- URL: <https://github.com/ArnasDon/wacrm>
- Licencia: **MIT** (`Copyright (c) 2026 Arnas Donauskas`). Se puede reutilizar
  dejando el aviso de licencia. Aun así **no copiamos código**: replicamos concepto
  y tokens. Si se copia un fragmento literal, agregar el aviso MIT en `docs/CREDITOS.md`.
- Clon local (temporal, puede no existir):
  `C:\Users\Juan Pablo\AppData\Local\Temp\opencode\wacrm`
  Para recuperarlo:
  ```powershell
  git clone --depth 1 https://github.com/ArnasDon/wacrm.git "$env:TEMP\wacrm"
  ```
- Archivos que inspiran el diseño:
  - `src/app/globals.css` → tokens de color y radios.
  - `src/components/layout/sidebar.tsx` → navegación.
  - `src/components/dashboard/*` → KPIs, tarjetas, actividad.
  - `src/components/settings/ai-config.tsx` → `is_active`, `auto_reply_enabled`,
    `auto_reply_max_per_conversation`, `handoff_agent_id`, `system_prompt`.
  - `src/app/api/ai/autoreply/[conversationId]/route.ts` → pausa por conversación.

## 3. Arquitectura real del proyecto

```
Crm Perfumeriafina/
├── index.html              Panel (Supabase + UI). Único archivo del front.
├── functions/api/borradores.js   Cloudflare Pages Function (Gemini/Anthropic)
├── sql/                    Esquema e inserts (01a–01d, 02, 03)
├── bot/
│   ├── src/server.js       Express: API, scheduler, auto-respuesta, /panel, /qr
│   ├── src/whatsapp.js     whatsapp-web.js + vigilante de conexión
│   ├── src/config.js       Lectura de .env
│   ├── src/supabase.js     Cliente service_role + helpers
│   ├── src/ia.js           (PENDIENTE) estado y pausas de IA
│   ├── src/panel.html      Panel propio del bot (QR grande)
│   └── .env                Config local (no subir)
├── docs/
│   ├── DISENO_PANEL.md     Contrato visual
│   ├── TRASPASO.md         Este archivo
│   └── referencia/panel-tokens.css   Borrador de tokens (aún no aplicado)
└── README.md
```

### Entorno verificado

| Cosa | Valor |
| --- | --- |
| Bot | `http://localhost:3000` (corriendo) |
| Panel | `http://localhost:8080/index.html` (Python static) |
| WhatsApp | Conectado como **+56 9 5948 9595** (sesión guardada) |
| Chromium del bot | `C:\Users\Juan Pablo\.cache\puppeteer\chrome\win64-146.0.7680.31` |
| Librería | `whatsapp-web.js@1.34.7` |
| Modo | `MODO_PRUEBA=false` (envíos reales) |
| Horario | `9–20`, lunes a sábado (producción) |
| Supabase | `https://pcesvmsewfpvmqmfmswn.supabase.co` |

## 4. Datos

Tablas usadas: `clientes`, `productos`, `campanas`, `plantillas`, `envios`,
`configuracion_tienda`.

Pendiente en Supabase (bloquea partes del panel):

- [ ] Ejecutar `sql/02_datos_y_esquema.sql` → crea `mensajes` y `campanas.numero_emisor`.
- [ ] Ejecutar `sql/03_seguridad_rls.sql` → policies.
- [ ] Cargar catálogo (`sql/01a`–`01d`) si está vacío.
- [ ] Pegar `SUPABASE_SERVICE_ROLE_KEY` en `bot/.env`.
- [ ] Crear usuario dueño en Auth y cerrar registro público.
- [ ] `GEMINI_API_KEY` en Cloudflare o `.dev.vars`.

> Hasta que exista `mensajes`, los KPIs de mensajes y la "cola de respuestas"
> se alimentan del bot en memoria. El diseño debe tolerar datos vacíos.

## 5. Contrato del front actual (no romper)

- Navegación: `#tabs button[data-tab]` → `irTab('inicio'|'campanas'|...)`.
- Secciones: `#t-inicio`, `#t-campanas`, `#t-clientes`, `#t-catalogo`,
  `#t-calendario`, `#t-bot` (se renombra a `#t-ajustes` solo si se actualiza el JS).
- Login: `#login`, `#lform`, `#l-mail`, `#l-pass`, `#l-btn`, `#l-err`.
- Clientes: `#cq`, `#c-list`, `#c-count`, `#c-new`, `#c-imp`, `#c-file`, diálogo `#dlg`.
- Campañas: `#k-tit`, `#k-obj`, `#k-fecha`, `#k-num`, `#k-pla`, `#k-prod`, `#k-add`,
  `#k-chips`, `#k-msg`, `#k-cond`, `#k-ai`, `#k-drafts`, `#k-baja`, `#k-seg`,
  `#k-info`, `#k-manual`, `#k-program`, `#k-send`, `#k-list`, `#k-prev`.
- Catálogo: `#pq`, `#p-cat`, `#p-gen`, `#p-count`, `#p-list`, `#p-more`.
- Calendario: `#cal-prev`, `#cal-next`, `#cal-today`, `#cal-title`, `#cal-grid`,
  `#cal-day`, `#cal-up`.
- Bot: `#b-url`, `#b-token`, `#b-test`, `#b-open`, `#b-status`.
- Funciones: `boot`, `load`, `irTab`, `renderClientes`, `renderCatalogo`,
  `renderCampanas`, `renderInicio`, `renderCalendario`, `abrirCampana`, `crearCampana`,
  `botFetch`, `guardarBot`, `prev`, `toast`.
- Persistencia local: `localStorage.bot_url`, `localStorage.bot_token`.

## 6. Contrato nuevo — API de IA del bot

Implementar en `bot/src/ia.js` + rutas en `bot/src/server.js`.
Persistencia en `bot/data/ia.json` (crear carpeta, agregar a `.gitignore`).

```http
GET /api/ia
→ {
    "activa": true,
    "autoRespuesta": true,
    "maxPorConversacion": 3,
    "prompt": "Eres el asistente de Perfumería Fina...",
    "pausados": [{ "telefono": "51910418951", "nombre": "Juan", "desde": "2026-11-06T05:12:00Z" }],
    "actualizado": "2026-11-06T05:12:00Z"
  }

POST /api/ia
body: { "activa"?: bool, "autoRespuesta"?: bool, "maxPorConversacion"?: 1..99, "prompt"?: string }
→ estado completo (mismo shape que GET)

POST /api/ia/pausar
body: { "telefono": "51910418951", "pausado": true, "motivo"?: "pidió hablar con humano" }
→ { "ok": true, "pausados": [...] }

GET /api/ia/conversaciones?limite=20
→ [{ "telefono", "nombre", "ultimoTexto", "ultimoEn", "pausado", "clienteId" }]
```

Reglas de comportamiento en `responderMensaje` (server.js):

1. Si `MODO_PRUEBA` → solo log.
2. Si BAJA/opt-out → marcar y **no** responder con IA.
3. Si `!activa` → no responder nada.
4. Si `!autoRespuesta` → no responder (pero sí registrar el mensaje).
5. Si el teléfono está en `pausados` → no responder.
6. Si se superó `maxPorConversacion` en la ventana de 24 h → no responder.
7. Si el mensaje requiere decisión humana → aviso al dueño, no inventar.

Cada cambio de estado debe quedar en el log del bot (`log()`).

## 7. Procedimiento por fases

Cada fase termina con: **commit/backup + verificación + este archivo actualizado**.

### Fase 0 — Preparación (15 min)
- [ ] `git init` en la raíz y commit inicial del estado actual.
- [ ] Copia `index.html` → `index.bak.html`.
- [ ] Confirmar bot en 3000 y panel en 8080.
- **Aceptación:** el panel actual sigue funcionando y hay commit.

### Fase 1 — Cáscara visual (sidebar + topbar + tokens)
- [ ] Reemplazar el bloque `<style>` por los tokens de `docs/referencia/panel-tokens.css`.
- [ ] Nuevo sidebar con secciones y 7 ítems; topbar sticky con chip de estado.
- [ ] Mantener todos los IDs; solo cambia el contenedor.
- **Aceptación:** las 6 pestañas siguen funcionando; se ve en 1440 y 390 px.

### Fase 2 — Inicio (dashboard)
- [ ] Cabecera con saludo, fecha y selector 7/30 días.
- [ ] 4 KPIs reales (clientes, enviados hoy, programadas, respuestas IA).
- [ ] Gráfico de barras de 7 días + cola de respuestas + campañas + cumpleaños + actividad.
- **Aceptación:** sin datos no se rompe; con datos coincide con Supabase.

### Fase 3 — Asistente IA (backend + pantalla)
- [ ] `bot/src/ia.js` con estado persistido.
- [ ] Rutas de §6 y pruebas con `curl`.
- [ ] Integración en `responderMensaje`.
- [ ] Pantalla "Asistente IA" según §6.1 de `DISENO_PANEL.md`.
- **Aceptación:** apagar el maestro detiene las respuestas; pausar un cliente
  detiene solo a ese; los cambios sobreviven al reinicio del bot.

### Fase 4 — Resto de pantallas
- [ ] Campañas, Clientes, Catálogo, Calendario y Ajustes con las tarjetas nuevas.
- **Aceptación:** paridad funcional 1:1 con lo actual.

### Fase 5 — QA y limpieza
- [ ] Responsive 1440/1280/1024/768/390.
- [ ] Teclado y foco visible.
- [ ] Consola sin errores.
- [ ] Restaurar `HORA_INICIO=9`, `HORA_FIN=20`.
- [ ] Borrar restos temporales (`bot/tmp-*.mjs`, CSS de borrador si ya se aplicó).
- **Aceptación:** checklist de §9 de `DISENO_PANEL.md` completo.

## 8. Cómo probar

```powershell
# Bot
cd bot
npm start                # deja la ventana abierta
curl http://localhost:3000/api/estado

# Panel
cd ..
python -m http.server 8080
# abrir http://localhost:8080/index.html

# IA (cuando exista)
curl http://localhost:3000/api/ia
curl -X POST http://localhost:3000/api/ia -H "Content-Type: application/json" -d '{"autoRespuesta":false}'
curl -X POST http://localhost:3000/api/ia/pausar -H "Content-Type: application/json" -d '{"telefono":"51910418951","pausado":true}'
```

## 9. Errores ya resueltos (no volver a investigarlos)

| Síntoma | Causa | Solución aplicada |
| --- | --- | --- |
| QR se vincula pero el bot sigue en "QR" | WhatsApp Web no dispara el evento que espera la librería | Vigilante en `whatsapp.js` que fuerza `onAppStateHasSyncedEvent()` cada 8 s |
| "No se pudo vincular el dispositivo" | Edge + Puppeteer | Usar Chrome for Testing de Puppeteer (`npx puppeteer browsers install chrome`) |
| `Cannot read properties of null (reading 'Socket')` | Dos sesiones a la vez | `SESIONES=1` y arranque escalonado de 12 s |
| `window.Store` es `false` | Normal en esta versión (usa `window.require`) | No es un problema |
| Cloudflare no puede correr el bot | Necesita Node + Chromium | Panel y función IA en Pages; bot en PC/VPS |
| Chats "fantasma" (Alvarito, etc.) arriba de conversaciones reales | WhatsApp sube `c.t` al reaccionar; el chat no tenía mensaje real | Se usa `tsReal` (último mensaje real, ignorando reacciones); si solo hay reacciones se usa la fecha del último mensaje guardado o queda sin fecha (al fondo) |
| Orden de la bandeja no coincide con WhatsApp | No se respetaban fijados y se usaba `c.t` (reacciones) | Orden: fijados primero (`c.pin > 0`) y luego por fecha real del último mensaje |
| Un archivo/imagen se veía como base64 | `m.body` de multimedia trae el thumbnail | Para tipos no-texto se usa `m.caption` o marcadores `[imagen]/[video]/[documento] nombre` |
| Mensajes vacíos (reacciones/avisos) contaminaban fechas | `registrar` aceptaba texto vacío | `registrar` ignora texto vacío; `manejarMensaje`/`manejarMensajePropio` ignoran `type:'reaction'` e `isNotification` |
| Respuestas IA tardaban ~90 s | Cooldown largo | `COOLDOWN_SEGUNDOS` (por defecto 10 s) + dedupe por id de mensaje; número de prueba y dueño lo saltan |

## 10. Prompt para la siguiente IA

Copiar y pegar tal cual:

```
Estás continuando el proyecto "CRM Perfumería Fina" en
C:\Users\Juan Pablo\Documents\WEB PROJECTS\Crm Perfumeriafina.

Antes de tocar código, lee en este orden:
1) docs/TRASPASO.md
2) docs/DISENO_PANEL.md
3) docs/referencia/panel-tokens.css

Reglas:
- index.html es un solo archivo con CSS/JS inline. No agregues build ni frameworks.
- No renombres IDs ni funciones listadas en TRASPASO.md §5.
- Mantén el acento dorado #DDB75F y los tokens de DISENO_PANEL.md §4.
- La IA nunca envía campañas sola; solo redacta y responde consultas.
- Nunca pongas service_role ni claves de IA en el navegador.
- Haz backup o commit antes de cada fase.
- Trabaja en el orden de fases de TRASPASO.md §7 y no saltes a la siguiente
  hasta cumplir el criterio de aceptación.
- Al terminar cada fase, actualiza TRASPASO.md (estado, decisiones, pendientes).

Objetivo inmediato: [FASE 1 | FASE 2 | FASE 3 | ...]
```
