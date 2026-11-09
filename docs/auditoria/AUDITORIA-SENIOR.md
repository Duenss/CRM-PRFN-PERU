# Auditoría senior — CRM Perfumería Fina

**Fecha:** 2026-11-08 · **Autor:** Lead (revisión propia + 2 auditorías en paralelo)
**Alcance:** `index.html` (panel completo), `bot/src/*` (Node/Express + whatsapp-web.js), `functions/api/borradores.js`, `sql/*`, `docs/*`.
**Método:** lectura estática completa, verificación de cada cita con `grep`/`read`, cruce de consultas reales contra el esquema declarado, `git status`/`git log`. **No** se levantó el bot (no respondió en `localhost:3000` al momento de la revisión) ni se ejecutó SQL contra Supabase.
**Anexos con el detalle línea por línea:** [`bot-flujos.md`](./bot-flujos.md) (20 hallazgos del backend) y [`datos-api.md`](./datos-api.md) (21 hallazgos de datos/API). Este documento es la síntesis y el plan; los anexos son la evidencia.

---

## 0. Veredicto (en una frase)

El producto **funciona en el camino feliz**, pero la sensación de *“flujo raro, no está en vivo, parpadea”* **no es un problema de CSS**: es la consecuencia de tres decisiones estructurales que se refuerzan entre sí — (1) el panel **hace polling** de un único proceso Node que guarda todo en **memoria + JSON** y **scrapea WhatsApp con Puppeteer**; (2) ese proceso tiene el **estado de campaña repartido** entre memoria, `bot/data/*.json` y Supabase, sin transacciones ni idempotencia; (3) la UI **destruye y recrea el DOM completo** con animaciones de entrada cada vez que “algo” cambió. Se arregla por capas: **P0 de datos/campañas primero**, luego **push (SSE) + un solo scheduler**, después **render por nodos con estado**, y finalmente **una sola fuente de verdad**.

Lo que ya está bien y no hay que tocar: guardas de concurrencia (`revisando`, `revisandoSeg`), dedupe de mensajes por `waId`, dedupe de la cola por id, topes de memoria, tokens de diseño, login con Supabase y la separación panel/bot.

---

## 1. Qué hay hoy (mapa real)

```
                    ┌─────────────────────────────────────────────┐
                    │  index.html  (134 KB, CSS+JS inline)         │
                    │  Cloudflare Pages · Supabase JS (publishable)│
                    │  ─ poll cada 2.5–20 s por vista              │
                    │  ─ innerHTML/animate por actualización       │
                    └───────┬──────────────────────────┬──────────┘
                            │ Supabase (lectura/escritura)│ fetch HTTP (bot)
                            ▼                             ▼
                 ┌────────────────────┐      ┌───────────────────────────────┐
                 │ Supabase Postgres   │      │ bot/src/server.js (Express)    │
                 │ clientes/productos  │◄────►│ estado en RAM + JSON en disco  │
                 │ campanas/envios     │      │ cola de envíos (1 worker)      │
                 │ mensajes (¡no se lee!)│    │ SSE/WebSocket: NO existe       │
                 └────────────────────┘      │ Puppeteer ─► WhatsApp Web      │
                                             └───────────────────────────────┘
```

Consecuencias directas:
- **Tres relojes para el mismo estado**: memoria del bot, JSON en disco y Supabase. El panel y el bot pueden mostrar cosas distintas del mismo envío.
- **Dos verdades para los mensajes**: `bot/data/conversaciones.json` (lo que ve la Bandeja) y la tabla `mensajes` (lo que se inserta y casi nadie lee).
- **Todo vive en un proceso**: cualquier bloqueo de CPU (un `writeFileSync` grande, `/api/analiticas` recorriendo 20 000 mensajes) frena WhatsApp, los envíos y la UI a la vez.
- **El único canal de actualización es `fetch` periódico**. No hay SSE, WebSocket, Realtime ni delta: lo “en vivo” llega hasta 20 s tarde y cuesta ~25–45 peticiones/min por pantalla abierta.

---

## 2. Los tres síntomas, explicados

### 2.1 “Los flujos se sienten raros” — estado y concurrencia, no UI

| Qué se ve | Por qué pasa | Evidencia |
|---|---|---|
| Una campaña sigue “programada” y **los clientes reciben el mismo mensaje cada minuto**; reiniciar el bot la retoma y repite a quienes ya recibieron | Los `update` de `envios` ignoran el `{ error }` de Supabase (en supabase-js v2 **no lanzan**). El envío queda `pendiente`, la campaña nunca pasa a `enviada` y el `setInterval` de 60 s la vuelve a encolar | `bot/src/server.js:291-303`, `:313-317`, `:1297`; `queue.js:14` |
| “Enviar ahora” de otra campaña responde OK pero **no envía en horas** | Una sola cola con `dormir(25–40 s)` **dentro** del job: una campaña de 80 destinatarios bloquea ~45–50 min el resto | `server.js:276-311`; `queue.js:20-35` |
| Campaña “aprobada” abierta con **0 destinatarios** o % incompleto | Campaña + `envios` se insertan en **dos llamadas sin transacción**; si falla la segunda queda huérfana. Con >1000 clientes, PostgREST trunca y el bot marca “omitido” a clientes que sí existen | `index.html:1123-1126`; `supabase.js:22-26`; `server.js:270-287` |
| Cliente recibe **dos veces** el seguimiento post-venta | Se marca `enviada` **después** de los logs; si algo falla después del envío, la tarea sigue pendiente y se reintenta; además no valida baja/consentimiento | `server.js:1317-1321`, `:1303` |
| Tras “Cerrar sesión” **reaparece** el QR; doble clic en “Reiniciar” deja Chrome huérfano | `setTimeout` de reconexión (15 s) y tick del vigilante (3 s) **no se cancelan**; `reiniciarSesion()` no tiene lock | `whatsapp.js:204-208`, `:287-288`, `:737-764` |
| “Enviando…”, “Sincronizando…” **para siempre**; cola clavada en 1 | `await` sin deadline sobre `sendMessage/getChats/page.evaluate` de Puppeteer | `whatsapp.js:300-320`, `:442`, `:664`; `queue.js:27` |
| La pantalla “se vacía sola” al parpadear la red o reiniciar el bot | Los `catch` **reemplazan** los datos por un `<p>Se perdió la conexión</p>`; no hay caché de último estado bueno | `index.html:1489`, `:1363`, `:1612` |
| Después de guardar un cliente, **todo el dashboard se re-renderiza** (y el gráfico se vuelve a animar) | Cada save hace `await load()`, que recarga las 4 tablas y repinta todas las vistas | `index.html:901-919`, `:1238-1249` |
| Cada hora (o al volver a la pestaña) **se recarga el panel entero** | `onAuthStateChange` llama a `show()` → `load()` para **cualquier** evento, incluido `INITIAL_SESSION` y `TOKEN_REFRESHED` | `index.html:880-891` |
| Campaña “desde Número 2” queda programada para siempre (con una sola sesión) | No se valida que la sesión emisora exista: se reprograma en silencio | `server.js:251-256`; `.env` con `SESIONES=1` |

### 2.2 “Las actualizaciones no se sienten en vivo” — el transporte y la fuente de verdad

Presupuesto de polling **calculado sobre el código** (no medido, porque el bot estaba apagado):

| Pantalla abierta | Peticiones/min | Scrapes de WhatsApp/min | Nota |
|---|---|---|---|
| Inicio | ~10,5 | 0 | chip 20 s + eventos 8 s + `renderInicio` al entrar |
| **Bandeja** | **~25,5** | **3** | bandeja 12 s **y** 15 s en paralelo + eventos 8 s + chip 20 s + hilo 20 s (POST importar **y** GET hilo) |
| **Ajustes** | **~44,5** | 0 | QR pide `/api/estado` cada **2,5 s** (24/min) + logs 6 s + eventos + chip |
| Ajustes mirando el QR | 27 de esas 44,5 son `/api/estado`, **y cada una hace un `count` a Supabase** | 0 | `server.js:754` |

Además:
- **No hay push.** El bot recibe el mensaje en vivo (evento `message` de WhatsApp Web), pero el panel no se entera: tiene que volver a preguntar. Entre el mensaje real y la UI pueden pasar **hasta 20 s** (hilo abierto) o **12–15 s** (lista).
- **El “en vivo” del hilo es un scrape**: `POST /api/conversaciones/:tel/importar` ejecuta `getNumberId` + hasta 8 `loadEarlierMsgs` dentro de la página de WhatsApp (`whatsapp.js:655-713`). Se llama **cada 20 s** con el chat abierto (`index.html:1534`), al abrir el chat (`:1530`) y otra vez después de enviar (`:1592` → `abrirChat`).
- **`/api/estado` es el hot path** de todos los chips: hace `count` a Supabase (`server.js:754`), recalcula `resumenChats()` sobre todos los mensajes (`conversaciones.js:371-379`) y devuelve el **QR en base64** (`whatsapp.js:774`, `estadoWa()`). Sin caché ni timeout: si Supabase tarda, las peticiones se apilan y la UI pinta respuestas viejas.
- **La tabla `mensajes` no se lee** y ninguna tabla está en `supabase_realtime`: aunque quisiéramos Realtime hoy, no funcionaría (no hay publicación). Ver H-02 del anexo.
- **No hay delta**: `/api/clientes` devuelve toda la tabla, `/api/pagos` devuelve las plantillas **con imágenes base64 de hasta 6 MB**, `/api/conversaciones/:tel` devuelve hasta 500 mensajes completos.

### 2.3 “Parpadeos” — cinco mecanismos concretos

El README dice *“actualizaciones fantasma: solo se repinta cuando cambia y sin parpadeos”*. Es verdad a medias: `fantasma()` evita el repintado **cuando el HTML es idéntico**, pero **no evita** lo que produce el parpadeo cuando algo cambia. Los mecanismos reales, en orden de impacto visual:

| # | Mecanismo | Evidencia | Por qué se percibe |
|---|---|---|---|
| 1 | **El hilo se reemplaza completo y se ancla al fondo cada 20 s** | `index.html:1546-1556` (`c.innerHTML=…` + `c.scrollTop=c.scrollHeight`), timer en `:1534`; CSS `animation:fade .22s` en `.msg` (`:305`) | Todos los mensajes **re-animan su `fade`** cada 20 s y, si estabas leyendo historial, **te tira al fondo**. Es el “parpadeo” más visible y además rompe el flujo de lectura |
| 2 | **`fantasma()` anima el contenedor entero** (`opacity:.45→1`, `translateY(3px)`, 240 ms) ante **cualquier** cambio | `index.html:852-868` (`:864`) | Cada mensaje nuevo hace “respirar” toda la lista. Y listas que **no** usan `fantasma` (clientes, catálogo, pedidos, calendario) se repintan sin transición: contraste de comportamiento según la pantalla |
| 3 | **Animaciones de entrada que se repiten**: tab `.fade`, barras del gráfico `rise .5s backwards` | `.tab` `:136`; `.chart .col` `:183`; `pintarChart` `:1238-1249` | Cada visita a Inicio o cada `load()` **re-anima** 7–30 barras con stagger. Al guardar un cliente, el dashboard “revive” entero |
| 4 | **Sustitución por estados transitorios**: “Cargando mensajes…”, “Bot apagado”, “Se perdió la conexión” | `:1519`, `:1489`, `:1363`, `:1612` | Un fallo de 1 s borra la lista y la vuelve a pintar: parpadeo + pérdida de contexto/scroll |
| 5 | **Doble poller y peticiones fuera de orden** | `:930` (bandeja 12 s) **y** `:1952` (bandeja 15 s) | Dos respuestas del mismo endpoint pueden llegar desordenadas: la vieja pinta después de la nueva y la lista “salta atrás”. Sin `AbortController` ni secuencia |

Agravantes de rendimiento que se notan como tirones (no como parpadeo):
- `backdrop-filter` en sidebar y topbar + `background-attachment:fixed` (`:40`, `:76`, `:105`): repintado caro al hacer scroll en la PC de la tienda.
- Catálogo: re-render de **60 tarjetas con `<img>` en cada tecla** del buscador (`:1062-1069`), sin debounce.
- `/api/analiticas` recorre 20 000 mensajes × 202 regex **en el hilo principal** (`server.js:944-985`): al abrir Analíticas se congela el bot y por tanto WhatsApp.
- `conversaciones.json`: `JSON.stringify` + `writeFileSync` **de todo el snapshot** por mensaje/ack, con debounce de 1,2 s (`conversaciones.js:23-35`); sin escritura atómica. Hoy son 100 KB (27 chats/328 mensajes), pero el tope de diseño es 400×500 → decenas de MB de JSON en el hilo principal. Es una bomba de tiempo.
- Sin `document.hidden`: eventos (8 s) y chip (20 s) siguen consultando con la pestaña en segundo plano (`:1791`, `:1951`); el hilo sí lo comprueba (`:1534`).

---

## 3. Hallazgos consolidados (P0–P3)

> Los IDs `F-*`/`H-*` remiten a los anexos, donde está la evidencia completa y el parche propuesto. `UI-*` son de esta revisión del panel. Esfuerzo: S ≤ 1 día, M 2–4 días, L ≥ 1 semana.

| ID | Sev | Área | Hallazgo | Evidencia | Arreglo (una línea) | Esf. |
|---|---|---|---|---|---|---|
| **F-01** | **P0** | Campañas | Campaña se reenvía completa cada 60 s si falla el guardado de cada `envio` | `server.js:291-303,313-317,1297` | Claim `pendiente→enviando` antes de enviar, revisar `{error}`, cerrar campaña siempre, barrer `enviando` viejos al arrancar | M |
| **H-01** | **P0** | Datos | No existe el DDL de las 6 tablas base: el CRM no se puede reconstruir ni auditar | `00_instalar_todo.sql:13`; `02_datos_y_esquema.sql:9`; grep sin `create table` para `clientes/productos/campanas/plantillas/envios/configuracion_tienda` | `pg_dump --schema-only` → `sql/00_esquema_base.sql` versionado + `99_verificar_contrato.sql` | M |
| **H-02** | **P0** | Datos | Bandeja y KPIs viven en la memoria/JSON del bot; `mensajes` no se lee; sin Realtime | `index.html:1217-1219,1484`; `conversaciones.js:5-12`; cero `alter publication`/`sb.channel` | Unificar en `mensajes` + vista de conversaciones, publicar tablas y suscribir; mientras, un solo poll | L |
| **F-02** | P1 | WhatsApp | Sin timeout en `sendMessage/getChats/evaluate`: un cuelgue frena todo el pipeline | `whatsapp.js:300-320,442,664`; `queue.js:27` | `conTimeout()` en cada operación + watchdog de 2 min en la cola | S |
| **F-03** | P1 | Sesiones | Timers de reconexión/vigilante huérfanos y reinicios sin lock: sesión fantasma, Chrome duplicado | `whatsapp.js:204-208,287-288,737-764` | Cancelar timers por sesión, lock por id y `destroy()` antes de recrear | M |
| **F-04** | P1 | Persistencia | JSON completo y sincrónico por mensaje, sin escritura atómica; `cargar()` devuelve `{}` si se corrompe | `conversaciones.js:23-35`; `pedidos.js:42-53`; `seguimiento.js:41-48`; `pagos.js:28-35`; `ia.js:30-37` | `tmp+rename`, debounce que no descarte, `flush()` y backup al cargar; luego NDJSON/SQLite | M |
| **F-05** | P1 | API bot | `/api/estado` sin caché ni timeout, con `count` a Supabase, `resumen()` O(mensajes) y QR base64 | `server.js:750-773`; `conversaciones.js:371-379`; `whatsapp.js:774` | Caché 2 s, `count` con timeout y caché 30 s, QR solo por `/api/qr` | S |
| **F-06** | P1 | Seguimiento | `marcarEnviada` después de los logs: fallo posterior = reenvío; no valida baja/consentimiento | `server.js:1317-1321`; `:1303` | Reclamar tarea antes de enviar, marcar estado primero, logs best-effort, validar `puede(cliente)` | M |
| **F-07** | P1 | Cola | `dormir(25–40 s)` dentro del job: una campaña bloquea la cola 45–50 min | `queue.js:20-35`; `server.js:276-311` | Un envío por paso y reprogramar con `setTimeout`, o carriles separados | M |
| **F-08** | P1 | IA | Respuestas duplicadas/fuera de orden; hasta 10 requests × 20 s; Anthropic sin timeout | `whatsapp.js:211-214`; `server.js:551-559`; `ai.js:254,298-299` | Serializar por chat, deadline total, cooldown al terminar, `AbortSignal` | M |
| **H-03** | P1 | Seguridad | RLS `for all to authenticated using(true)` en 7 tablas: cualquier cuenta lee/escribe todo | `03_seguridad_rls.sql:36-49` | Policy por `auth.uid()`/allowlist + desactivar registro + auditar usuarios | S |
| **H-06** | P1 | Datos | Límite 1000 filas de PostgREST sin paginar: `clientes`/`envios` se truncan en silencio | `supabase.js:22-26`; `index.html:903,1145` | Helper `allRows()` con `.range()` y prueba con 1200 filas | M |
| **H-07** | P1 | Migraciones | `03` borra policies y cambia constraints en un `BEGIN`: si falla, **RLS queda apagado** | `03_seguridad_rls.sql:11-70` | Preflight de datos + `begin/commit` en 04–06 + constraints `NOT VALID` y validar aparte | S |
| **H-08** | P1 | Panel | Errores de RLS silenciados: listas vacías con la app “funcionando”; el fallback al bot esconde el fallo | `index.html:907-913` | Propagar los 4 errores y mostrar banner “sin permiso/sesión”; fallback visible | S |
| **H-12** | P1 | Campañas | Campaña + `envios` en 2 `INSERT` sin transacción | `index.html:1123-1126` | RPC `crear_campana(...)` transaccional (o borrar la campaña en el `catch`) | S |
| **UI-01** | P1 | Render | Doble poller de Bandeja (12 s y 15 s) sin single-flight: respuestas fuera de orden | `index.html:930,1952` | Un solo scheduler por vista con single-flight y secuencia | S |
| **UI-02** | P1 | Render | Hilo recreado completo + scroll forzado al fondo cada 20 s; todas las burbujas re-animan | `index.html:1534,1546-1556`; CSS `:305` | Append por id, actualizar `ack` en su nodo y anclar al fondo **solo si ya estabas abajo** | M |
| **UI-03** | P1 | Render | `fantasma()` anima el contenedor entero; listas que no lo usan parpadean sin transición | `index.html:852-868` | Animar **solo el nodo nuevo** (`.nuevo`), no el contenedor; `fantasmaValor()` para números | S |
| **UI-04** | P1 | Render | `load()` repinta todas las vistas y `renderInicio` re-anima el gráfico tras cada guardado | `index.html:901-919,1238-1249`; CSS `:183` | Repintar solo la vista activa; gráfico: construir una vez y actualizar alturas con transición | S |
| **UI-05** | P1 | Sesión | `onAuthStateChange` → `load()` completo en `INITIAL_SESSION`/`TOKEN_REFRESHED` | `index.html:880-891` | Ignorar esos eventos, cargar una sola vez y deduplicar con promesa en vuelo | S |
| **UI-06** | P1 | Resiliencia | Un fallo transitorio borra la lista y muestra error | `index.html:1489,1363,1612` | Stale-while-revalidate: último snapshot en `localStorage` + badge “sin conexión, datos de hace X” | S |
| **F-09** | P2 | API bot | `/api/analiticas` bloquea el event loop (20 000 × 202 regex + query de productos) | `server.js:944-985` | Índice incremental de menciones al registrar + caché por snapshot | M |
| **F-10** | P2 | Payloads | `/api/pagos` con imágenes base64 (hasta 6 MB), `/api/clientes` y conversación completa sin paginar | `server.js:895,1125-1131,1149-1161`; `pagos.js:55-60` | Imagen por endpoint binario, proyección de campos y delta de mensajes | M |
| **F-11** | P2 | Sync | `/api/sincronizar` sin lock ni timeout; un chat = una escritura completa | `server.js:1036-1107`; `conversaciones.js:160-206` | Mutex, timeout 45 s y `registrarCabeceras()` en lote | M |
| **F-12** | P2 | IA | N+1 a Supabase por mensaje entrante; `configuracion_tienda` sin caché en cada respuesta | `server.js:471-475`; `supabase.js:12,18,34-56` | `Promise.all`, caché de configuración 5 min, logs en lote | S |
| **F-13** | P2 | Observabilidad | Errores silenciados en updates/selects críticos; `catch {}` vacíos | `server.js:242,264,266,285,293,302,313,315`; `supabase.js:12-56`; `whatsapp.js:164,467,594-596` | Helper `must()` que lance/registre + `/api/logs` con contexto | S |
| **F-14** | P2 | Memoria | `cooldown` Map sin tope; `ia.pausados` y `seguimiento.chats` solo crecen | `server.js:325,555`; `ia.js:70-85`; `seguimiento.js:58-78` | TTL/LRU (cooldown 15 min) y poda con fecha | S |
| **F-15** | P2 | Límites | Contador diario solo en RAM + TOCTOU entre dos loops: reiniciar resetea el límite | `server.js:67-77,295,1303,1321` | Persistir contador y contar en un único embudo de envío | S/M |
| **F-16** | P2 | Envíos | Envío manual sin idempotencia; filas duplicadas en `mensajes` | `server.js:1168-1194,304-368`; `index.html:1591` | `idempotencyKey` con TTL + dedupe por `waId` | S |
| **UI-07** | P2 | Catálogo | 60 tarjetas con imágenes re-renderizadas en cada tecla del buscador | `index.html:1062-1069` | Debounce 120–200 ms + filtrado sobre nodos existentes | S |
| **UI-08** | P2 | Estado | QR pide `/api/estado` cada 2,5 s; 24 `count` a Supabase/min al mirar Ajustes | `index.html:1408,1465-1475`; `server.js:750-773` | QR por `<img src="/api/qr?token=…">` cada 15–20 s + caché de estado | S |
| **UI-09** | P2 | Datos | Scrape de WhatsApp cada 20 s por chat abierto, con `catch` vacío | `index.html:1502-1509,1534` | Reemplazar por eventos del bot (SSE) + import solo al abrir y a demanda | M |
| **UI-10** | P2 | Rendimiento | Eventos/chip no pausan en `document.hidden`; pestaña de fondo sigue consultando | `index.html:1791,1951` | Scheduler con `visibilitychange` (parar en oculto, refrescar al volver) | S |
| **H-05** | P2 | SQL | `05` no revierte `06`: `web_inserta_auto` sobrevive y permite autopublicar testimonios | `06:19-21`; `05:31-41` | `drop policy if exists "web_inserta_auto"` + test con `set role anon` | S |
| **H-09** | P2 | Índices | Faltan índices para `envios(campana_id,estado)`, `campanas(creado_en)`, `clientes(nombre)` | consultas en `index.html:1145,1189`; `server.js:220-226,264,754` | `create index` (ver §5.1 del anexo datos-api) | S |
| **H-10** | P2 | IA duplicada | Pages Function de borradores quedó muerta y con contrato incompatible (`Bearer` vs `x-bot-token`, sin CORS) | `functions/api/borradores.js:29-51`; `index.html:1095` | Eliminarla o alinearla y corregir README/TRASPASO | S |
| **H-13** | P2 | UI/polling | Doble polling y re-render del hilo (coincide con UI-01/02) | `index.html:930,1952,1534,1546-1556` | Igual que UI-01/UI-02 | S |
| **H-16** | P2 | Git | `04/05/06` sin commitear; `00`/`01*`/`02` modificados; precios 58/82→56/78 sin commit | `git status`; `README.md:34-41` | Commitear todo y generar `00` desde 01–06 (o eliminarlo) | S |
| **UI-11** | P3 | Rendimiento | `backdrop-filter` + `background-attachment:fixed` jank en hardware modesto | `index.html:40,76,105` | Quitarlo en `@media (prefers-reduced-motion)`/dispositivos lentos, o usar fondo sólido | S |
| **UI-12** | P3 | Deploy | HTML = app completa (134 KB) sin `_headers` ni aviso de versión | — | `_headers` con `no-store` para `/index.html`; opcional `version.json` y toast “Recargar” | S |
| **F-19** | P3 | Apagado | Solo `SIGINT`; Docker envía `SIGTERM`: Chrome huérfano y debounce sin flush | `server.js:1337-1341`; `Dockerfile` | Handler `SIGTERM` + flush + `cerrarSesion()` con timeout | S |
| **F-20** | P3 | Seguridad | `BOT_TOKEN` vacío (hoy) + CORS `*` + JSON 12 MB: cualquiera en la red usa el proxy de `service_role` | `server.js:19,682-695`; `bot/.env`; `index.html:1328-1333` | Token obligatorio fuera de localhost, allowlist de origen, bajar límite y servir imágenes aparte | S |
| **H-14** | P3 | Script SQL | CSV sin columna `activo` deja **todo el catálogo inactivo**; precios `S/` → `null`; duplicados por `codigo` | `scripts/build-productos-sql.mjs:32-95` | Defaults explícitos, limpiar moneda, `on conflict (codigo)`, regenerar 01a–01d | S |
| **H-17** | P3 | Docs | Docs contradictorios (modelo IA, pestañas, cooldown, “sin claves en el navegador” vs publishable en HTML) | `TRASPASO.md:31-37`; `DISENO_PANEL.md:197`; `README.md` | Actualizar los 3 docs en el mismo commit del cambio | S |
| **H-21** | P3 | Higiene | `.gitignore` no cubre `index.bak.html` que exige el propio traspaso | `TRASPASO.md:191`; `.gitignore` | Añadir `*.bak.html`, `*.bak` | S |

> **Nota de severidad:** H-03/H-04/H-05/H-07 suben a P0 si (a) el registro público de Supabase está habilitado, (b) el bot está publicado a Internet sin `BOT_TOKEN`, o (c) se ejecutó `06` y luego `05`. Hoy el repo local tiene `BOT_TOKEN` vacío: si el bot sale de `localhost`, la API es un proxy abierto al `service_role`.

---

## 4. Arquitectura objetivo (y por qué)

Regla de oro: **una sola fuente de verdad por vista; el render es función del estado; el transporte es push con fallback pull; la UI nunca se destruye para actualizarse.**

```
WhatsApp ──eventos──► Bot ──(1) persiste ──► SQLite/Postgres   (fuente histórica)
                        │
                        ├──(2) bus de eventos (in-process)
                        │        └── SSE /api/stream ──► Panel (append delta)
                        │
                        └──(3) Supabase (campañas/clientes; fuente de negocio)
Panel: store por vista ─► render por nodos (sin innerHTML del contenedor)
       scheduler único  ─► 1 request "estado" cacheado + delta de mensajes
       snapshot cache   ─► si el bot/red cae, sigo mostrando lo último con badge
```

Tres opciones, en orden de riesgo/beneficio:

| Opción | Qué implica | Coste | Cuándo |
|---|---|---|---|
| **A. Bot céntrico + SSE** (recomendada primero) | El bot sigue siendo dueño de mensajes; añade `/api/stream`, deltas y caché. El panel deja de scrapear WhatsApp | 3–5 días | Ahora: elimina el 90 % de la sensación de “no está vivo” sin tocar Supabase |
| **B. Supabase como fuente única** | `mensajes` + vista `conversaciones`, publicación realtime, claims de campaña por RPC | 1–2 semanas | Después de A: da durabilidad, auditoría y multi-instancia |
| **C. Reescritura a framework** | React/Next + build + tests | 1–2 meses | **No** ahora: el contrato del proyecto es un solo `index.html` y el riesgo/beneficio no cierra |

---

## 5. Parches concretos (copiables)

### 5.1 SSE en el bot (la pieza que cambia la sensación de “vivo”)

`bot/src/eventos.js` — añadir suscriptores al bus existente (no persistente, igual que hoy):

```js
const oyentes = new Set();
export function suscribir(fn) { oyentes.add(fn); return () => oyentes.delete(fn); }

export function emitir(tipo, datos = {}) {
  const evento = { id: ++seq, tipo: String(tipo), en: new Date().toISOString(), ...datos };
  lista.push(evento);
  if (lista.length > MAX) lista.shift();
  for (const fn of oyentes) { try { fn(evento); } catch {} }
  return evento;
}
```

`bot/src/server.js` — endpoint (el `auth` ya acepta `?token=`, imprescindible porque `EventSource` no manda headers):

```js
app.get('/api/stream', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'          // evita buffering si hay proxy
  });
  res.write('retry: 3000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const quitar = suscribir(ev => res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`));
  req.on('close', () => { clearInterval(ping); quitar(); });
});
```

Emisores mínimos (uno por cambio real, no por poll):
- `conversaciones.js → registrar()` y `actualizarAck()` / `marcarLeido()`: `emitir('mensaje', { telefono, mensaje, noLeidos, ultimoEn })` y `emitir('ack', …)` (importar `eventos.js` no crea ciclo).
- `server.js → manejarMensaje()/manejarMensajePropio()`: `emitir('chat', { telefono, ultimoTexto, ultimoEn, noLeidos })` (lista sin recargar).
- `enviarCampana()`: `emitir('campana', { campanaId, estado, enviados, total })`.
- `POST /api/ia`, `/api/ia/pausar`, `/api/sesion/*`: `emitir('estado', …)`.
- Los eventos `derivacion/comprobante/pedido` ya existen: el panel los sigue manejando con sonido/notificación.

### 5.2 Cliente SSE en el panel (con fallback)

```js
let es = null, sseVivo = false;
function conectarSSE() {
  if (!botURL) return;
  es?.close();
  es = new EventSource(botURL + '/api/stream?token=' + encodeURIComponent(botToken));
  es.onopen = () => { sseVivo = true; programarRespaldo(false); };
  es.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    aplicarEventoSSE(d);
  };
  es.onerror = () => {                 // EventSource reintenta solo; además reactivamos el pull
    sseVivo = false;
    programarRespaldo(true);           // pull cada 15 s mientras no haya push
    es.close();
    setTimeout(conectarSSE, 5000);
  };
}
function aplicarEventoSSE(d) {
  if (d.tipo === 'mensaje' || d.tipo === 'chat') aplicarDeltaChat(d);
  else if (d.tipo === 'ack') actualizarAckUI(d);
  else if (d.tipo === 'campana') refrescarProgresoCampana(d);
  else if (d.tipo === 'estado') refrescarChipCon(d);
  else manejarEvento(d);               // derivacion/comprobante/pedido existentes
}
```

**Requisito de despliegue:** SSE hereda las reglas de mixed content. Si el panel vive en `https://…` y el bot en `http://IP`, el navegador puede bloquearlo. Necesitas el bot en HTTPS (Cloudflare Tunnel, Railway, Render o Nginx con TLS) o servirlo detrás del mismo dominio (`/bot/*` proxy) — recomiendo **mismo origen por proxy inverso**, que además permite cookies HttpOnly en vez de token en `localStorage`.

### 5.3 Un solo scheduler (elimina UI-01/UI-08/UI-10)

```js
const tareas = new Map();   // nombre → { fn, ms, at, corriendo, activa }
const tarea = (nombre, fn, ms) => tareas.set(nombre, { fn, ms, at: 0, corriendo: null, activa: false });
const activar = (nombre, on = true) => { const t = tareas.get(nombre); if (t) t.activa = on; };

setInterval(() => {
  if (document.hidden) return;                       // pestaña de fondo: cero requests
  const ahora = Date.now();
  for (const [nombre, t] of tareas) {
    if (!t.activa || t.corriendo || ahora - t.at < t.ms) continue;
    t.at = ahora;
    t.corriendo = t.fn().catch(e => console.warn(nombre, e)).finally(() => { t.corriendo = null; });
  }
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) for (const t of tareas.values()) t.at = 0;   // refresco inmediato al volver
});

// arranque: tarea('estado', refrescarChip, 20000); tarea('bandeja', cargarBandeja, 15000);
// tarea('eventos', pollEventos, 15000); tarea('hilo', refrescarHiloAbierto, 30000);
// irTab: parar todas y activar las de la vista (sin crear/borrar timers).
```

Efecto: de ~25,5 req/min en Bandeja y ~44,5 en Ajustes a **≤ 6 req/min** idle, sin doble poller ni ráfagas al volver a la pestaña.

### 5.4 Hilo: append por nodo, sin re-animación, sin secuestrar el scroll (UI-02)

```js
let hiloTel = null, hiloIds = new Set();

function nodoMensaje(m) {
  const out = m.direccion !== 'entrante';
  const div = document.createElement('div');
  div.className = 'msg ' + (m.origen === 'sistema' ? 'sys' : out ? 'out' : 'in');
  div.dataset.k = m.waId || m.id || `${m.en}|${m.direccion}|${m.texto}`;
  /* mismo markup que hoy: who, texto escapado, tick, time */
  return div;
}

function agregarMensajes(msgs) {
  const c = $('#in-msgs');
  const alFinal = c.scrollHeight - c.scrollTop - c.clientHeight < 48;
  const frag = document.createDocumentFragment();
  for (const m of msgs) {
    const k = m.waId || m.id || `${m.en}|${m.direccion}|${m.texto}`;
    if (hiloIds.has(k)) continue;
    hiloIds.add(k);
    frag.appendChild(nodoMensaje(m));
  }
  if (frag.childNodes.length) c.appendChild(frag);
  if (alFinal) c.scrollTop = c.scrollHeight;    // ← solo si el usuario ya estaba abajo
}
```

Reglas de acompañamiento:
- **Quitar** `animation:fade` de `.msg` (`index.html:305`); si quieres conservar la entrada, `.msg.nuevo{animation:fade .18s}` aplicada solo a nodos nuevos.
- **Nunca** `innerHTML='Cargando…'` si ya hay mensajes: un `<div class="skeleton">` superpuesto o un badge “actualizando”.
- Al abrir otro chat: `hiloIds.clear()` y reemplazo **una vez**; dentro del mismo chat, solo append/diff.
- `ack`: actualizar el nodo por `data-k` (cambiar clase/texto del tick), no re-render.

### 5.5 Lista de chats y “ghost v2” (UI-03)

`fantasma()` está bien para contenido de solo lectura, pero para listas con estado (chat activo, no leídos, timestamps) conviene clave por `telefono` y actualización por fila:

```js
function pintarLista() {
  const cont = $('#in-list');
  const vistos = new Set();
  for (const c of listaFiltrada()) {
    vistos.add(c.telefono);
    let row = cont.querySelector(`[data-tel="${CSS.escape(c.telefono)}"]`);
    if (!row) { row = crearFila(c); cont.appendChild(row); row.classList.add('nuevo'); }
    actualizarFila(row, c);          // texto, hora, badge, "IA off", "Seg"
  }
  cont.querySelectorAll('[data-tel]').forEach(el => {
    if (!vistos.has(el.dataset.tel)) el.remove();
  });
}
```

Y en `fantasma()`, sustituir la animación del contenedor por un `data-rev` que solo marque el cambio; animar `.nuevo` (una fila) en lugar de 40.

### 5.6 Stale-while-revalidate + errores visibles (UI-06)

```js
const snap = (k, v) => {
  try { v === undefined ? localStorage.getItem('pf:' + k) : localStorage.setItem('pf:' + k, JSON.stringify(v)); }
  catch {}
};
async function cargarBandeja() {
  try {
    const j = await botFetch('/api/conversaciones?limite=80');
    inChats = j.conversaciones || [];
    snap('bandeja', { t: Date.now(), j });
    pintarLista(); actualizarPausa(); actualizarBadge(j.resumen?.noLeidos || 0);
    marcarConexion(true);
  } catch (e) {
    const prev = JSON.parse(snap('bandeja') || 'null');
    if (prev?.j) { inChats = prev.j.conversaciones || []; pintarLista(); marcarConexion(false, prev.t); }
    else if (!inChats.length) $('#in-list').innerHTML = '<p class="empty">No se pudo cargar…</p>';
    // si ya había datos: NO tocar el DOM, solo badge "sin conexión"
  }
}
```

Regla: **nunca sustituir datos buenos por un mensaje de error**; el error va a un banner/badge, no al contenedor de datos.

### 5.7 Campañas: claim atómico y cierre garantizado (F-01, P0)

```js
async function reclamarEnvio(id) {
  const { data, error } = await sb.from('envios')
    .update({ estado: 'enviando', fecha_envio: new Date().toISOString() })
    .eq('id', id).eq('estado', 'pendiente')
    .select('id');
  if (error) throw error;
  return data?.length === 1;          // false = ya enviado o lo tomó otro proceso
}

// dentro del for:
if (!(await reclamarEnvio(e.id))) continue;
try {
  const r = await conTimeout(enviar(c.telefono, texto, emisor), 60000, 'enviar campaña');
  const { error } = await sb.from('envios').update({ estado: 'enviado', wa_id: r?.waId || null })
    .eq('id', e.id).eq('estado', 'enviando');
  if (error) log(`[envio ${e.id}] enviado pero no confirmado: ${error.message}`);
  contarEnvio();
  await dormir(esperaEntreEnvios(config.delayMin, config.delayMax));
} catch (err) {
  await sb.from('envios').update({ estado: 'error', nota: String(err.message).slice(0, 200) })
    .eq('id', e.id).eq('estado', 'enviando');
  if (++errores >= 3) break;
}
// al salir del bucle SIEMPRE:
await sb.from('campanas').update({ estado: 'enviada' }).eq('id', id);
```

Migración necesaria: `envios.estado` debe aceptar `'enviando'` y conviene `envios.wa_id`. Al arrancar, barrer `enviando` con más de 10 min:

```js
await sb.from('envios').update({ estado: 'error', nota: 'proceso interrumpido' })
  .eq('estado', 'enviando').lt('fecha_envio', new Date(Date.now() - 10 * 60 * 1000).toISOString());
```

### 5.8 `/api/estado` cacheado, sin QR y sin I/O en el camino (F-05/UI-08)

```js
let cacheEstado = { t: 0, cuerpo: null }, programadas = 0;
async function refrescarProgramadas() {
  if (!sb) return;
  try { const { count, error } = await sb.from('campanas').select('id', { count: 'exact', head: true }).eq('estado', 'programada');
        if (!error) programadas = count || 0; } catch {}
}
setInterval(refrescarProgramadas, 30000); refrescarProgramadas();

app.get('/api/estado', auth, (req, res) => {
  if (Date.now() - cacheEstado.t < 2000 && cacheEstado.cuerpo) return res.json(cacheEstado.cuerpo);
  cacheEstado = { t: Date.now(), cuerpo: {
    sesiones: estadoWa().map(({ qr, ...s }) => s),      // el QR va por /api/qr (binario, cacheable 1 s)
    conectado: hayConexion(), cola: cola.size, programadas,
    enviadosHoy: dia.n, maxPorDia: config.maxPorDia, /* …resto igual… */
  }};
  res.json(cacheEstado.cuerpo);
});
```

Panel: `img.src = botURL + '/api/qr?sesion=1&token=' + encodeURIComponent(botToken) + '&t=' + Date.now()` cada 15–20 s (no 2,5 s), y chip cada 20–30 s.

### 5.9 Escritura atómica y flush (F-04)

```js
function guardarAtomico(archivo, datos) {
  const tmp = `${archivo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos));
  fs.renameSync(tmp, archivo);          // rename es atómico en el mismo volumen
}
function cargar(archivo) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); }
  catch { try { return JSON.parse(fs.readFileSync(archivo + '.bak', 'utf8')); } catch { return {}; } }
}
function flush() { if (guardando) { clearTimeout(guardando); guardando = null; guardarAtomico(archivo, chats); } }
process.on('SIGTERM', () => { flush(); /* + cerrarSesion con timeout */ process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });
```

### 5.10 Timeout en WhatsApp (F-02)

```js
const conTimeout = (p, ms, etiqueta) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout ${etiqueta} (${ms} ms)`)), ms))
]);
// enviar(): await conTimeout(s.client.sendMessage(id._serialized, texto), 60000, 'sendMessage')
// historialWa(): await conTimeout(s.client.pupPage.evaluate(...), 20000, 'evaluate historial')
// listarChatsWa(): await conTimeout(s.client.getChats(), 45000, 'getChats')
```

Nota: `Promise.race` **no cancela** la operación de Puppeteer; desbloquea el pipeline y deja el error visible. Con el watchdog de la cola + el barrido de `enviando` evitas el estado inconsistente. Idealmente, además, cerrar la página/`client` corrupto tras timeout.

### 5.11 Sesión: un solo `load()` y eventos de auth filtrados (UI-05)

```js
let cargando = null, yaMostrado = false;
const cargarUnaVez = () => cargando || (cargando = load().finally(() => { cargando = null; }));

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  await show(!!session); yaMostrado = true;
  sb.auth.onAuthStateChange((evento, s) => {
    if (evento === 'INITIAL_SESSION' || evento === 'TOKEN_REFRESHED') return;  // no recargar
    if (evento === 'SIGNED_IN') { if (!yaMostrado) show(true); return; }
    show(!!s);
  });
}
// show(): await cargarUnaVez() en lugar de await load()
```

### 5.12 Versión / actualización del panel (UI-12)

- Añadir `_headers` en la raíz de Pages:
  ```
  /index.html
    Cache-Control: no-store
  /
    Cache-Control: no-store
  ```
- Opcional (recomendado): `functions/api/version.js` que devuelva `{commit: env.CF_PAGES_COMMIT_SHA}`; el panel guarda el último visto en `localStorage` y, si cambió, muestra toast **“Nueva versión disponible · Recargar”** (no recargar solo: el dueño puede estar escribiendo una campaña).
- No añadir service worker para el HTML: cachear la app entera empeora exactamente este problema.

---

## 6. Plan en 3 sprints (orden, criterio de salida, medición)

### Sprint 0 — “Parar el daño” (2–3 días)
1. **F-01** claim de envíos + `{error}` + cierre garantizado + barrido al arrancar (P0, dinero/reputación).
2. **UI-01/UI-02/UI-06** frontend: un solo poller de Bandeja, hilo con append + scroll solo si estabas abajo, stale-while-revalidate para listas.
3. **UI-05** auth: dejar de recargar la app en `TOKEN_REFRESHED`.
4. **F-05/UI-08** caché de `/api/estado` y QR por `/api/qr` (baja 27 req/min a ~4).
5. **F-04** escritura atómica + `flush()` + `SIGTERM`.

**Criterio de salida:** fallo de Supabase inyectado a mitad de campaña → 0 reenvíos; navegar Bandeja/Inicio 10 min → 0 re-render completo, scroll del hilo intacto, ≤ 8 req/min idle; cerrar sesión/doble reinicio → 1 Chrome; matar el proceso → JSON válido y últimos mensajes presentes.

### Sprint 1 — “Vivo de verdad” (1 semana)
1. **SSE** (`/api/stream`, emisores, cliente con fallback) y **quitar** el scrape de 20 s; import de historial solo al abrir/a demanda (UI-09).
2. Scheduler único (UI-01/10) + `document.hidden`.
3. Timeouts de WhatsApp (F-02) + watchdog de cola; `must()` y logs con contexto (F-13).
4. API delta: `/api/conversaciones/:tel?desde=`, `/api/clientes` con campos justos, `/api/pagos` sin base64 (F-10); caché de analíticas (F-09).
5. Instrumentación: longtasks, marcas de render, contador de requests, `/api/metrics` (ver §7).

**Criterio de salida:** mensaje entrante → UI en **< 1,5 s p95**; 0 scrapes periódicos; `/api/estado` p95 < 80 ms; tab oculta = 0 requests; 200 mensajes en 30 s sin long task > 150 ms.

### Sprint 2 — “Arquitectura y datos” (1–2 semanas)
1. Campaña atómica (RPC `crear_campana`), cola sin `sleep` en el job (F-07), seguimiento reclamado antes de enviar (F-06), idempotencia de envío manual (F-16), contador diario persistido (F-15).
2. IA serializada por chat con deadline total (F-08) y N+1 corregido (F-12).
3. Datos: `pg_dump` → DDL versionado (H-01), RLS por usuario/allowlist (H-03), migraciones atómicas (H-07), paginación >1000 (H-06), índices (H-09), commit de 04–06 y regeneración de `00` (H-16), decisión `05` vs `06` (H-05).
4. Persistencia: SQLite (`node:sqlite`) o Postgres para conversaciones/pedidos/seguimiento (F-04 fase L) + backup diario.
5. Seguridad de despliegue: `BOT_TOKEN` obligatorio, CORS allowlist, bot por HTTPS/mismo origen, límite de body (F-20/H-04).
6. Observabilidad y CI: test de humo de campaña/claims, Playwright con `MutationObserver` para “cero re-render completo”, presupuestos de performance en PR.

---

## 7. Cómo medirlo (para no discutir opiniones)

Antes de tocar nada, capturar una **línea base** (30 min):

| Métrica | Cómo | Objetivo |
|---|---|---|
| Requests/min idle por pantalla | contador en `botFetch` (`console.count`) o `performance.getEntriesByType('resource')` | ≤ 6/min |
| p95 por endpoint | `performance.now()` alrededor de `botFetch` + `sendBeacon`/log | `/api/estado` ≤ 80 ms; `/api/conversaciones` ≤ 120 ms |
| Long tasks | `new PerformanceObserver(l => …).observe({type:'longtask', buffered:true})` | 0 en reposo; < 5 y < 150 ms en ráfaga de 200 msgs |
| CLS | `PerformanceObserver({type:'layout-shift'})` | < 0,1 carga / < 0,05 updates |
| Re-render completo | `MutationObserver` sobre `#in-list`/`#in-msgs`: contar nodos reemplazados | 0 por actualización rutinaria |
| Scroll anclado | e2e: subir el hilo, esperar 30 s, medir `scrollTop` | no cambia |
| Latencia mensaje→UI | log del bot (`Date.now()` al recibir) vs `performance.now()` al pintar (evento SSE) | p95 < 1,5 s |
| Duplicados de campaña | prueba con Supabase fallando a mitad | 0 reenvíos |
| Memoria bot | `process.memoryUsage()` cada 5 min a `/api/metrics` | estable 7 días (< +10 %) |
| Analíticas | cronometrar `/api/analiticas` con 20 k mensajes | p95 < 500 ms y el bot sigue enviando |

Snippet de instrumentación mínima (panel):

```js
addEventListener('load', () => {
  const obs = new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.duration > 50) console.warn('[longtask]', e.duration.toFixed(0), e.name);
  });
  obs.observe({ type: 'longtask', buffered: true });
});
```

Y un e2e de parpadeo (Playwright) que abre la Bandeja, espera 60 s y falla si `#in-list` tuvo más de N mutaciones de children o si el `scrollTop` del hilo cambió sin interacción.

---

## 8. Lo que NO haría (y por qué)

- **No migrar a React/Next ahora.** El coste (build, router, tests, 134 KB de lógica repartida) y el riesgo de romper el contrato `index.html` no se justifican para arreglar polling y render. Más adelante, si el equipo crece, se puede extraer el store/render a módulos ES sin build.
- **No añadir WebSockets/`socket.io`.** SSE es unidireccional, usa HTTP normal, reconecta solo y pasa por proxies; el panel solo necesita recibir.
- **No “optimizar” subiendo la frecuencia de polling.** Bajar de 12 s a 3 s empeora el problema (más carga, más parpadeo). El camino es push + delta.
- **No cachear el HTML en service worker.** Un panel con la app vieja y el contrato nuevo es peor que una recarga.
- **No tocar `fantasma()` a medias.** O se anima el nodo nuevo, o no se anima: animar el contenedor es justo lo que se percibe como parpadeo.
- **No mover todo a Supabase Realtime antes de unificar la fuente de mensajes.** Realtime sobre una tabla que el panel no lee no cambia nada.
- **No apagar todas las animaciones.** El diseño (wacrm/Apple-like) pide movimiento; la regla debe ser *“animar la transición de estado, nunca el repintado de datos”*.

---

## 9. Riesgos y decisiones abiertas

1. **Dónde vive el bot en producción** (PC de la tienda vs VPS/Railway/Render) define HTTPS, SSE, CORS y el modelo de token. Si es la PC, hoy se accede por LAN y `BOT_TOKEN` vacío es aceptable *solo* si el puerto no sale a Internet; si es VPS, es P0 de seguridad.
2. **WhatsApp Web + Puppeteer seguirá rompiéndose** con cada cambio de la web. Con timeouts y reconexión controlada el fallo es visible; sin ellos, es un cuelgue. No hay plan B sin API oficial (y eso implica otro coste/contrato).
3. **Supabase free**: 1000 filas por consulta, 500 MB, Realtime limitado. La paginación y el delta no son opcionales si el negocio crece.
4. **Cuota de Gemini** (20 req/día por modelo gratis): ya hay fallback, pero un `deadline` total evita que el panel espere 60 s.
5. **Ventana de cambio**: el Sprint 0 se puede hacer sin tocar la lógica de negocio (0 riesgo de envíos) y es el que más se nota.

---

## 10. Qué haría en las próximas 48 horas (si me das luz verde)

1. Backup/commit antes de tocar (`index.bak.html` + `git commit`). Ya hay cambios SQL sin commitear: primero commitear el estado actual.
2. **F-01** con migración mínima de `envios` (claim + cierre + barrido). Es el único riesgo de daño real a clientes.
3. **UI-01/02/05/06** en `index.html` (un poller, hilo sin re-render, scroll respetado, auth sin recarga, errores sin borrar datos).
4. **F-05/UI-08** caché de `/api/estado` + QR por `/api/qr`.
5. Medición antes/después con el script de §7 y un video de 2 min del mismo flujo (antes/después) para verificar el “parpadeo” con evidencia, no con percepción.

**Criterio de “listo” del Sprint 0:** los 5 checks de §6 pasan + `/api/logs` sin errores silenciados + el dueño puede abrir Bandeja, leer historial y responder sin que la vista salte.

---

## Anexos

- [`bot-flujos.md`](./bot-flujos.md) — 1.218 líneas: mapa de 44 rutas, 17 timers, 6 escrituras a disco, 15 operaciones Supabase, 20 hallazgos (F-01…F-20) con parche y plan.
- [`datos-api.md`](./datos-api.md) — 445 líneas: mapa de fuentes de verdad, 21 hallazgos (H-01…H-21), 8 consultas reales verificadas contra el esquema, plan y checklist de migración segura.
- Contratos del proyecto que no se deben romper: [`../TRASPASO.md`](../TRASPASO.md) y [`../DISENO_PANEL.md`](../DISENO_PANEL.md).

---

## 11. Estado de implementación (2026-11-08)

Implementado y probado en esta sesión (detalle de entrega en [`ENTREGA-2026-11-08.md`](./ENTREGA-2026-11-08.md)):

| Hallazgo | Estado | Dónde |
| --- | --- | --- |
| F-01 campaña reenviada (P0) | **Hecho** (claim atómico + cierre garantizado + barrido; requiere `sql/07`) | `bot/src/server.js`, `bot/src/campanas.js`, `sql/07_envios_claim.sql` |
| F-05/UI-08 `/api/estado` hot path | **Hecho** (caché 2 s, count en background, QR fuera) | `bot/src/server.js`, `index.html` |
| UI-01 doble poller | **Hecho** (scheduler único por vista, single-flight, `document.hidden`) | `index.html` |
| UI-02 hilo re-render + scroll forzado | **Hecho** (append por nodo, ack por nodo, scroll solo si estabas abajo) | `index.html` |
| UI-03 `fantasma()` animando contenedor | **Hecho** (sin animación de contenedor) | `index.html` |
| UI-04 `load()` global + gráfico re-animado | **Hecho** (firma de gráfico + render condicionado) | `index.html` |
| UI-05 recarga por auth | **Hecho** (`appVisible` + eventos ignorados) | `index.html` |
| UI-06 errores que borran datos | **Hecho** (último dato bueno + aviso stale) | `index.html` |
| UI-09 scrape WhatsApp cada 20 s | **Hecho** (SSE + import solo al abrir) | `index.html`, `bot/src/server.js` |
| F-02 timeouts WhatsApp / cola | **Hecho** (`conTimeout` + watchdog) | `bot/src/whatsapp.js`, `bot/src/queue.js` |
| F-04 persistencia JSON | **Hecho** (atómica, `.bak`, `flush`) | `bot/src/conversaciones.js` |
| F-19 SIGTERM | **Hecho** | `bot/src/server.js` |
| IA: campañas estilo WhatsApp de referencia | **Hecho** (formato fijo + respaldo + filtro de promesas no autorizadas) | `bot/src/mensajes.js`, `bot/src/ai.js` |
| IA: 3 opciones por familia en viñetas | **Hecho** (prompt + inyección de candidatos + respuesta determinística) | `bot/src/ai.js`, `bot/src/mensajes.js` |
| Pagos: solo efectivo cierra; digital deriva | **Hecho** (corrección de estado + aviso + pausa de IA) | `bot/src/politicas.js`, `bot/src/server.js` |

**Pendiente inmediato (bloqueante para campañas reales):** aplicar `sql/07_envios_claim.sql` en Supabase y probar el flujo completo con un número de WhatsApp real. El resto del plan (F-07 cola sin `sleep` en el job, F-08 IA serializada, H-01 DDL versionado, H-03 RLS por usuario, migrar mensajes a Supabase) queda para los siguientes sprints y sigue documentado arriba.

**Pruebas de esta implementación:** `43/43` unitarias en `bot/test`; `11/11` casos del arnés e2e del panel real (`scripts/e2e-panel.mjs`, Chromium headless contra bot simulado y Supabase interceptada, 0 errores de consola); humo del bot en `MODO_PRUEBA` con backup/restore de `bot/data`. Detalle en [`ENTREGA-2026-11-08.md`](./ENTREGA-2026-11-08.md) y [`E2E-PANEL.md`](./E2E-PANEL.md).
