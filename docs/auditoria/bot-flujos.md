# Auditoría de flujos del bot WhatsApp — CRM Perfumería Fina

**Proyecto:** `C:\Users\Juan Pablo\Documents\WEB PROJECTS\Crm Perfumeriafina`
**Fecha:** 2026-11-08
**Auditor:** bot-audit (subagente de solo lectura)
**Alcance:** `bot/src/*.js` (server, whatsapp, conversaciones, seguimiento, pedidos, pagos, queue, ai, ia, eventos, supabase, config) + `bot/src/panel.html`; apoyo en `bot/package.json`, `bot/README.md`, `bot/.env.example`, `bot/data/*.json`, `index.html` (solo para trazar el síntoma del panel) y `docs/TRASPASO.md`.
**Modo:** auditoría estática de solo lectura. No se ejecutó el bot, no se enviaron mensajes ni se instalaron dependencias. El único archivo escrito es este informe.

**Corpus revisado (completo):** `server.js` 1.341 líneas, `whatsapp.js` 877, `ai.js` 426, `conversaciones.js` 379, `pedidos.js` 295, `seguimiento.js` 190, `pagos.js` 124, `ia.js` 106, `supabase.js` 84, `config.js` 69, `queue.js` 43, `eventos.js` 34, `panel.html` 207 (~173 KB en total).

**Estado persistido observado:** `bot/data/conversaciones.json` = 27 chats / 328 mensajes / 100 KB (tope de diseño: 400 chats × 500 mensajes por chat); `ia.json` con `activa:false`; `seguimiento.json` con 1 chat desactivado y 0 tareas. No existían todavía `pedidos.json`, `pagos.json` ni `comprobantes/`.

**Config operativa observada en `bot/.env` (sin transcribir secretos):** `SESIONES=1`, `MODO_PRUEBA=false`, `AUTO_RESPUESTA=true`, `HEADLESS=false`, `DELAY_MIN/MAX=25/40`, `MAX_POR_DIA=80`, `HORARIO=9-20`, `SEGUIMIENTO_DIAS_1/2=3/180`, `BOT_TOKEN` vacío.

**Semáforo usado:** P0 = daño real en producción (duplicados masivos, cuelgues, pérdida de datos); P1 = degrada gravemente la operación o la percepción de "en vivo"; P2 = deuda que se convierte en P1 al crecer; P3 = higiene/robustez.

---

## 1. Resumen ejecutivo (5 bullets)

1. **P0 — una campaña puede reenviarse completa cada 60 s si falla el guardado del estado de cada envío.** `enviarCampana()` ignora el `{ error }` que devuelve Supabase (`bot/src/server.js:293` y `:302`), deja los `envios` en `pendiente`, no marca la campaña como `enviada` (`:313-317`) y el `setInterval` de 60 s (`:1297`) la vuelve a encolar. El dueño ve "Campaña programada" y los clientes reciben el mismo mensaje N veces. Es el hallazgo más urgente.
2. **P1 — no hay timeout en ninguna operación de Puppeteer/WhatsApp.** `enviar()` / `enviarImagen()` (`bot/src/whatsapp.js:300-320`, `:326-360`), `listarChatsWa()` (`:442`) e `historialWa()` (`:664`) pueden quedar colgados indefinidamente; la `Cola` nunca libera `actual`, la campaña queda "en proceso" sin estado y `/api/sincronizar` deja el panel en "Sincronizando…" para siempre.
3. **P1 — los reinicios de sesión dejan timers huérfanos y clientes duplicados.** El `setTimeout` de reconexión de 15 s (`bot/src/whatsapp.js:204-208`), el `setTimeout(tick, 3000)` del vigilante (`:288`) y el `crearSesion()` sin lock de `reiniciarSesion()` (`:737-764`) no se cancelan ni serializan: tras "Cerrar sesión" o doble clic en "Reiniciar" puede resucitar la sesión, quedar un Chrome huérfano y aparecer un QR fantasma.
4. **P1 — el estado se persiste con `JSON.stringify` + `writeFileSync` completos por cada mensaje/ack.** `bot/src/conversaciones.js:24-35` serializa todo el mapa de chats (hasta 400 × 500 mensajes) en el hilo principal y sin escritura atómica; en ráfagas el panel se congela ("parpadeos"), y un corte a mitad de escritura deja el JSON corrupto y —como `cargar()` devuelve `{}` en silencio— la bandeja aparece vacía. El mismo patrón está en `pedidos.js:42-53`, `seguimiento.js:41-48`, `pagos.js:28-35` e `ia.js:30-37`.
5. **P1/P2 — el panel no "se siente en vivo" por cómo el backend sirve el estado.** `/api/estado` hace una consulta a Supabase en el camino caliente (`server.js:754`) y recalcula sobre todos los mensajes (`:770`, `conversaciones.js:371-379`) en cada poll; el panel del bot lo llama cada 3,5 s (`panel.html:204`) y el dashboard cada 2,5–20 s, sin caché ni timeout, con payloads que incluyen el QR en base64 y listas sin paginar (`/api/clientes`, `/api/pagos` con imágenes, conversación completa cada 20 s). Si Supabase tarda, las peticiones se apilan y la UI pinta respuestas viejas.

La buena noticia: el camino feliz tiene protecciones correctas (guardas `revisando`/`revisandoSeg`, deduplicación de la cola por id, `yaRespondidos`, dedupe por `waId`, topes de memoria en logs/eventos/cachés). El problema está concentrado en **caminos de error, concurrencia y hot path**, no en la lógica de negocio.

---

## 2. Metodología y límites

- Lectura estática completa de los módulos listados con `read` por bloques; números de línea y citas verificados con `grep`/`read`. No se citan líneas no comprobadas.
- No se pudo verificar el estado real de Supabase (`campanas`, `envios`, `mensajes`), la sesión de WhatsApp ni reproducir los bugs en vivo. Las conclusiones sobre Supabase derivan del código y de la semántica de `@supabase/supabase-js` v2: **las escrituras no lanzan, devuelven `{ error }`**, y el código casi nunca lo revisa.
- El síntoma del panel se traza también por `index.html` (consumidor), pero **los arreglos propuestos son del backend**.

---

## 3. Mapa del backend

### 3.1 Rutas Express (`bot/src/server.js`)

Todas llevan `auth` salvo `/`, `/panel`, `/qr` y los estáticos. Con `BOT_TOKEN` vacío (estado actual), `auth` deja pasar todo (`server.js:683`).

| Método | Ruta | Línea | Notas de flujo / riesgo |
| --- | --- | --- | --- |
| GET | `/` → `/panel` | 697 | redirección |
| GET | `/panel` | 698 | panel de respaldo del bot |
| GET | `/qr` | 703 | HTML con poll propio cada 2,5 s (línea 746) |
| GET | `/api/estado` | 750 | **hot path**: count a Supabase + `resumenChats()` + QR base64 |
| GET | `/api/qr` | 775 | PNG binario del QR |
| GET | `/api/campanas` | 784 | 25 campañas |
| GET | `/api/logs` | 795 | últimas 120 líneas |
| POST | `/api/borradores` | 798 | llama a Gemini (puede tardar 60 s) |
| GET/POST | `/api/pedidos` | 816 / 835 | 200 pedidos por defecto, sin paginación real |
| GET/PATCH | `/api/pedidos/:id` | 829 / 853 | PATCH dispara/cancela seguimiento |
| POST | `/api/pedidos/:id/comprobante` | 872 | escribe imagen con `writeFileSync` (línea 96) |
| GET/POST/PATCH/DELETE | `/api/pagos` y `/api/pagos/:id` | 895–919 | `/api/pagos` devuelve imágenes base64 de hasta 6 MB |
| GET/POST | `/api/seguimiento` y `/:telefono` | 922–939 | resumen / activar |
| GET | `/api/analiticas` | 944 | recorre 20.000 mensajes × 202 productos (ver F-09) |
| GET | `/api/eventos` | 988 | 300 eventos en memoria |
| GET/POST | `/api/ia` | 994 / 996 | estado / configuración |
| POST | `/api/ia/pausar` | 1004 | pausa por chat |
| GET | `/api/estadisticas` | 1017 | agrega por día (O(mensajes)) |
| POST | `/api/sincronizar` | 1036 | scrape completo de WhatsApp, sin lock ni timeout |
| POST | `/api/conversaciones/:telefono/importar` | 1109 | rescrape del hilo (el panel lo llama cada 20 s si hay chat abierto) |
| GET | `/api/clientes` | 1125 | **toda** la tabla de clientes |
| GET | `/api/conversaciones` | 1133 | 40 chats + etiquetas por chat |
| GET | `/api/conversaciones/:telefono` | 1149 | hasta 500 mensajes completos |
| POST | `/api/conversaciones/:telefono/leido` | 1163 | marca leído |
| POST | `/api/conversaciones/:telefono/enviar` | 1168 | envío manual, sin idempotencia |
| POST | `/api/revisar` | 1196 | fuerza revisión de campañas; no-op silencioso si ya está revisando |
| POST | `/api/enviar/:id` | 1201 | encola campaña sin validar estado |
| POST | `/api/prueba` | 1207 | envío de prueba |
| POST | `/api/prueba-foto` | 1225 | envío de foto de prueba |
| POST | `/api/logout` | 1247 | cierra sesión(es) |
| POST | `/api/sesion/reiniciar` | 1252 | reinicia sesión(es) sin lock |
| POST | `/api/simular-entrante` | 1263 | solo si `SIMULAR_ENTRANTES=true` |

### 3.2 Timers y bucles

No hay cron, ni paquetes de scheduler, ni workers: **todo vive en el proceso Node**. Cualquier cuelgue o bloqueo de CPU afecta a todo (envíos, IA y panel a la vez).

| Archivo:línea | Qué | Período | Guarda | Riesgo |
| --- | --- | --- | --- | --- |
| `server.js:1297` | `revisarProgramadas()` | 60 s | flag `revisando` | si falla el estado del envío, reencola (F-01) |
| `server.js:1298` | primera revisión | 8 s | — | — |
| `server.js:1334` | `revisarSeguimientos()` | 60 s | flag `revisandoSeg` | envío fuera de la cola, reenvío si falla el log (F-06) |
| `server.js:1335` | primer seguimiento | 15 s | — | — |
| `server.js:310` | `dormir(25-40 s)` dentro del job de campaña | por mensaje | — | bloquea la cola entera (F-07) |
| `server.js:1328` | `dormir(25-40 s)` en el loop de seguimiento | por mensaje | — | idem |
| `server.js:636` | espera fija de 1.200 ms entre los 2 mensajes de la IA | por respuesta | — | latencia artificial (F-18) |
| `whatsapp.js:73` | escalonado de sesiones (12 s) | una vez por sesión | — | timer no rastreado |
| `whatsapp.js:207` | reintento de conexión (15 s, máx. 5) | evento `disconnected` | solo `s.reintentos` | **no se cancela nunca** (F-03) |
| `whatsapp.js:287` | vigilante de conexión | 8 s por sesión | `s.vigilante` | puede quedar huérfano si hay dos `crearSesion` (F-03) |
| `whatsapp.js:288` | tick inicial del vigilante | 3 s | no rastreado | huérfano tras reiniciar |
| `conversaciones.js:26` | guardado diferido | 1,2 s | `guardando` | snapshot completo sincrónico (F-04) |
| `pedidos.js:44` | guardado diferido | 0,5 s | `guardando` | idem |
| `panel.html:204` | `cargar()` del panel del bot | 3,5 s | flag `cargando` | 3 requests por ciclo, sin timeout |
| `server.js:746` | poll de la página `/qr` | 2,5 s | — | 2 requests por ciclo |
| `index.html:930` / `:1952` | carga de bandeja | 12 s / 15 s | — | **dos pollers superpuestos** del mismo endpoint |
| `index.html:1534` | reimportar hilo abierto | 20 s | — | scrape Puppeteer cada 20 s |
| `index.html:1791` / `:1951` | eventos / chip de estado | 8 s / 20 s | — | requests al bot |

### 3.3 Escrituras a disco

Todas son `writeFileSync` de un snapshot JSON completo, sin `tmp + rename` (no atómicas) y con errores solo a `console.warn`.

| Archivo | Línea | Disparador | Tamaño del snapshot | Atómica |
| --- | --- | --- | --- | --- |
| `conversaciones.js` | 30 | cada mensaje, ack, cabecera, importación, leído (debounce 1,2 s) | 400 chats × 500 msgs (hoy 100 KB; a futuro decenas de MB) | No |
| `pedidos.js` | 48 | crear/actualizar/comprobante/pago enviado (debounce 0,5 s) | hasta 1.200 pedidos | No |
| `seguimiento.js` | 44 | activar/omitir/programar/marcar (sincrónico en cada cambio) | hasta 3.000 tareas | No |
| `pagos.js` | 31 | crear/actualizar/eliminar | hasta 20 plantillas **con imagen base64 de hasta 6 MB** | No |
| `ia.js` | 33 | cambiar activa/auto/límite/prompt/pausar | objeto pequeño + `pausados` sin tope | No |
| `server.js` | 96 | comprobante recibido o subido desde el panel | imagen completa, dentro del handler HTTP | No |

### 3.4 Llamadas a Supabase

| Operación | Archivo:línea | Frecuencia | ¿Revisa `{ error }`? |
| --- | --- | --- | --- |
| `campanas` count programadas | `server.js:754` | **cada `/api/estado`** | No |
| `campanas` select vencidas | `server.js:220-226` | 60 s | Sí (`error` lanzado) |
| `campanas` select por id | `server.js:247` | por campaña | Sí |
| `envios` select pendientes | `server.js:264` | por campaña | No |
| `envios` update estado | `server.js:285`, `:293`, `:302` | 1–2 por mensaje de campaña | **No** |
| `campanas` update fecha/estado | `server.js:242`, `:266`, `:315` | por campaña | **No** |
| `envios` count final | `server.js:313` | por campaña | No |
| `campanas` listado | `server.js:786-790` | cada `/api/campanas` | Sí (HTTP 500) |
| `clientes` select por teléfono | `supabase.js:18` | **cada mensaje entrante** | No |
| `clientes` select all | `supabase.js:24` | campaña, sync, `/api/clientes`, respaldo del panel | No |
| `productos` select | `supabase.js:30` | caché 10 min; analíticas; borradores | No |
| `configuracion_tienda` | `supabase.js:12` | **cada respuesta de IA** | No |
| `mensajes` insert | `supabase.js:36` | cada mensaje/aviso (varios por mensaje) | Solo `console.warn` |
| `mensajes` select historial | `supabase.js:49-54` | cada mensaje entrante | No |
| `clientes` upsert por lotes | `supabase.js:71-83` | sincronización de contactos | Sí (lanza) |

### 3.5 Estado mutable en memoria

- `server.js`: `logs` (250, `:27-33`), `dia` (contador diario, `:67`), `cola` (`:210`), `revisando` (`:211`), `yaRespondidos` Set 1.200 (`:323`, `:436`), `cooldown` Map **sin tope** (`:325`), `revisandoSeg` (`:1301`).
- `whatsapp.js`: `sesiones` Map (`:8`), `enviadosPorBot` Set 800 (`:11`, `:317`), `enviosRecientes` 120 (`:17`, `:23`).
- `conversaciones.js`: `chats` (`:12`) + `guardando` (`:23`).
- `pedidos.js`: `pedidos` tope 1.200 (`:40`). `pagos.js`: `plantillas` tope 20 (`:26`). `seguimiento.js`: `estado` (`:39`, tareas 3.000). `ia.js`: `estado` (`:28`). `eventos.js`: lista 300 (`:6-7`). `ai.js`: caché de catálogo 10 min (`:4`).
- Nada se comparte entre procesos: **no se puede correr el bot en 2 instancias** sin duplicar envíos y corromper los JSON (nota de arquitectura para el plan de 3 fases).

### 3.6 Flujo real de un mensaje entrante (dónde se va el tiempo)

1. `whatsapp-web.js` emite `message`; el handler es `async` y el `EventEmitter` **no espera** la promesa (`whatsapp.js:211-214`), así que dos mensajes del mismo contacto se procesan en paralelo.
2. Dedupe por `yaRespondidos` (`server.js:432-437`).
3. Si es audio: descarga vía Puppeteer + hasta 4 modelos Gemini × 30 s (`server.js:450-469`, `ai.js:322-347`).
4. `getCliente()` (Supabase) → `historial()` (Supabase) → `logMensaje()` (insert Supabase) → `registrar()` (mutación + guardado JSON diferido): 4 esperas secuenciales antes de decidir (`server.js:471-475`).
5. Filtros de IA/horario/cooldown (`:539-555`); el cooldown se marca **antes** de llamar a la IA.
6. `redactarRespuesta()` → `getConfiguracion()` (Supabase, sin caché) + catálogo (caché 10 min) + Gemini con hasta 5 modelos × 2 variantes × 20 s (`ai.js:247-296`).
7. Posible `procesarPedidoIA` + `notificarDueno` (envío real de WhatsApp al dueño, esperado) (`server.js:592-598`, `:163-176`).
8. Envío al cliente: foto + texto, espera 1,2 s, segundo mensaje con precios (`:611-644`).
9. Registro del saliente: `logMensaje` + `registrar` (`:624-626`).

En el mejor caso son ~6–10 operaciones de red/serialización antes del primer byte al cliente; en el peor, minutos (cadena de reintentos de IA). Nada de esto tiene un deadline global.

---

## 4. Hallazgos

### 4.1 Tabla resumen (ordenada por severidad)

| ID | Sev | Título | Evidencia (archivo:línea) | Síntoma observable desde el panel | Causa raíz | Fix | Esf. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F-01 | **P0** | Campaña reenviada en masa al fallar el guardado del envío | `server.js:291-303`, `:313-317`, `:228-230`, `:1297` | Campaña sigue "programada"; clientes reciben el mismo WhatsApp cada minuto; tras reiniciar se repite a quienes ya recibieron | Errores de update de Supabase ignorados + envío no reclamado antes de mandar + campaña solo se cierra si el count da 0 | Claim atómico `pendiente→enviando` + check de `{error}` + barrido de arranque + cierre garantizado | M |
| F-02 | **P1** | Sin timeout en envíos y scrapes de Puppeteer | `whatsapp.js:300-320`, `:326-360`, `:442`, `:664`; `queue.js:27` | "Enviando…" para siempre, cola clavada, `/api/sincronizar` en "Sincronizando…" eterno, campaña sin avanzar | `await` sin deadline sobre `sendMessage/getChats/evaluate`; un cuelgue de WhatsApp Web congela todo el pipeline | `conTimeout()` en cada operación + watchdog en la cola | S |
| F-03 | **P1** | Timers de reconexión huérfanos y clientes de sesión duplicados | `whatsapp.js:198-209`, `:287-288`, `:715-731`, `:737-764` | Tras "Cerrar sesión" reaparece QR/sesión sola; doble clic en "Reiniciar" deja Chrome zombie; estado salta entre `qr`/`conectado` (parpadeo) | `setTimeout` de reintento y tick del vigilante no rastreados; `reiniciarSesion` sin lock; `initialize()` sobre cliente inconsistente | Cancelar timers por sesión + lock por id + destroy antes de recrear | M |
| F-04 | **P1** | Guardado JSON completo y sincrónico por mensaje, sin escritura atómica | `conversaciones.js:8-9`, `:23-35`; `pedidos.js:42-53`; `seguimiento.js:41-48`; `pagos.js:28-35`; `ia.js:30-37`; `server.js:95-96` | El panel se congela/parpadea en ráfagas; tras un corte la bandeja aparece vacía o pierde los últimos mensajes/pedidos | `JSON.stringify` + `writeFileSync` de todo el snapshot en el hilo principal, sin `tmp+rename` ni flush; `cargar()` devuelve `{}` si el archivo está corrupto | Escritura atómica + debounce que no se cancele sin guardar + flush en shutdown; luego append-only/SQLite | M |
| F-05 | **P1** | `/api/estado` como hot path con I/O a Supabase y cálculo O(mensajes), sin caché ni timeout | `server.js:750-773` (754, 770); `conversaciones.js:371-379`; `panel.html:128-169`, `:204`; `index.html:1468`, `:1951` | Chips y bandeja atrasados; el panel "no se siente en vivo"; si Supabase tarda, el panel del bot deja de refrescar y el dashboard apila requests | Polling agresivo + count a Supabase + `resumen()` O(mensajes) + payload con QR base64 + sin cache/timeout | Caché 1–2 s, timeout del count, quitar QR del estado, endpoints delta | S/M |
| F-06 | **P1** | Seguimiento post-venta fuera de la cola: reenvío y concurrencia de envíos | `server.js:1300-1335` (1303, 1317-1321, 1328); `seguimiento.js:139-153` | Cliente recibe dos veces "¿cómo te fue con el perfume?" si falla el registro posterior al envío; mensajes de seguimiento se cruzan con campaña; se envía a clientes dados de baja | `marcarEnviada()` dentro del `try` después de awaits que pueden fallar; loop no reclamado; no usa la `Cola`; no verifica baja/consentimiento | Reclamar tarea antes de enviar, marcar estado antes de logs best-effort, validar `puede(cliente)` | M |
| F-07 | **P1** | Cola única con `sleep` de 25–40 s dentro del job: bloqueo de cabeza de fila | `queue.js:13-35`; `server.js:276-311`, `:1196-1205`, `:228-230` | "Enviar ahora" de otra campaña responde OK pero no se envía en horas; cola fija en 1; parece que el bot está colgado | Un solo worker secuencial que duerme dentro del trabajo; una campaña de 80 destinatarios ocupa ~45–50 min | Un envío por paso y reprogramación con `setTimeout`; o colas por tipo con pacer | M |
| F-08 | **P1** | IA duplicada/fuera de orden y cadena de reintentos sin deadline | `whatsapp.js:211-214`; `server.js:551-559`, `:624`; `ai.js:247-296`, `:298-316`, `:322-347` | Dos respuestas al mismo mensaje, o respuesta vieja llega después de la nueva; "Pensando respuesta..." por minutos; se quema cuota Gemini | Handlers por contacto en paralelo; cooldown se marca antes de la IA; hasta 10 requests × 20 s; Anthropic sin timeout | Serializar por chat, deadline total, cooldown al terminar, `AbortSignal` en Anthropic | M |
| F-09 | **P2** | `/api/analiticas` bloquea el event loop | `server.js:944-985` (947, 960-969); `conversaciones.js:358-369`; `sql/01_productos.sql` (202 productos) | Al abrir Analíticas, el bot entero se congela varios segundos: no responde WhatsApp ni envía | Bucle sincrónico de 20.000 mensajes × 202 regex + normalización en el hilo principal | Índice incremental de menciones al registrar + caché/snapshot | M |
| F-10 | **P2** | Payloads grandes sin paginar (pagos base64, clientes, conversación completa) | `server.js:895`, `:1125-1131`, `:1149-1161`; `pagos.js:55-60`, `:71-81`; `index.html:1534`, `:1695` | Pestañas lentas al abrir; cada 20 s se descargan cientos de KB al abrir un chat; en red lenta parece que no carga | Respuestas con colecciones completas e imágenes base64 incrustadas; sin delta ni ETag | Campos selectivos, imagen por endpoint binario, `?desde=` en mensajes | M |
| F-11 | **P2** | `/api/sincronizar` sin lock ni timeout; un chat = una escritura | `server.js:1036-1107` (1063-1078); `conversaciones.js:160-206` (203-204); `whatsapp.js:442,467,472-598` | Dos clics/paneles lanzan dos scrapes; "Sincronizando…" eterno; chats que aparecen y desaparecen; el orden de la bandeja se mueve solo | Sin mutex, sin timeout, `recortar()+guardar()` por cada chat, `catch` vacío en `listarChatsWa` | Mutex `syncEnCurso`, timeout de 45 s, `registrarCabeceras()` en lote, log del error real | M |
| F-12 | **P2** | N+1 a Supabase por mensaje entrante y por respuesta de IA | `server.js:471-475`; `supabase.js:12,18,34-45,47-56`; `ai.js:128-129` | Primera respuesta tarda 1–3 s+; con Supabase intermitente los mensajes entran con retraso y el panel "no se entera" | Consultas secuenciales por mensaje; `configuracion_tienda` sin caché en cada respuesta; un insert por registro | `Promise.all`, caché de configuración 5 min, inserts diferidos/batch | S |
| F-13 | **P2** | Errores silenciados en I/O crítico | `server.js:242,264,266,285,293,302,313,315`, `:357,364,367`; `supabase.js:12,18,24,30`; `whatsapp.js:164,467,594-596`; `ai.js:237` | Estados que "no avanzan" sin razón visible; chats que no aparecen; QR que no sale; el log no da pista para diagnosticar | Updates/selects de Supabase sin revisar `{error}`; `catch {}` vacíos; solo `console.warn` | Helper `must()` que lance + log central con contexto | S |
| F-14 | **P2** | Fugas de memoria/estado sin límite | `server.js:325`, `:555`; `ia.js:70-85`; `seguimiento.js:58-78` | RAM crece con los meses; `/api/ia` y `/api/estado` cada vez más lentos; "pausadas" crece con clientes que derivaron alguna vez | `cooldown` Map nunca se purga; `ia.pausados` y `seguimiento.chats` solo crecen | TTL/LRU (cooldown 15 min) y poda de pausados/chats antiguos | S |
| F-15 | **P2** | Contador diario solo en memoria, TOCTOU y sin contar todos los orígenes | `server.js:67-77`, `:295`, `:1321`, `:1303`, `:277` | Al reiniciar, el límite "se resetea" y puede mandar más de 80; el contador del panel no refleja IA/panel/pruebas | Estado en RAM + dos loops que leen y luego envían (carrera) + solo cuenta campaña/seguimiento | Persistir el contador y contar en un único embudo de envío | S/M |
| F-16 | **P2** | Falta de idempotencia en envío manual y filas duplicadas en `mensajes` | `server.js:1168-1194`, `:304-368` (367), `:474`; `index.html:1591` | Doble clic o reintento del navegador → 2 mensajes iguales; historial de IA y analíticas con filas repetidas | Sin `idempotencyKey`; dos caminos que insertan en `mensajes` sin dedupe | Clave de idempotencia TTL + insert con dedupe por `waId` | S |
| F-17 | **P3** | Respuestas OK sin efecto; campaña desde un número no configurado se reprograma en silencio | `server.js:216`, `:249`, `:251-256`, `:238-243`, `:1196-1205`; `config.js:55-59`; `index.html:630-633` | "Revisar campañas" responde "0 en cola" y no hizo nada; campaña "desde Número 2" queda programada para siempre (con `SESIONES=1`) | Guard devuelve sin señal; `/api/revisar` no distingue "en curso"; no se valida que el emisor exista | Devolver 409/estado `enCurso`; marcar campaña `error` con motivo visible | S |
| F-18 | **P3** | Latencia artificial fija y notificación al dueño bloqueante en el pipeline | `server.js:636`, `:519-526`, `:163-176`, `:399-411` | El cliente recibe intro y precio separados >1,2 s; si el aviso al dueño es lento, la respuesta al cliente se retrasa aún más | `setTimeout(1200)` fijo + `await notificarDueno()` antes de responder al cliente | Avisos con `void ... .catch()`; conservar el gap solo cuando hay dos mensajes | S |
| F-19 | **P3** | Sin SIGTERM ni apagado ordenado; debounce sin flush | `server.js:1337-1341`; `Dockerfile:24`; `conversaciones.js:26`; `pedidos.js:44` | Al detener el servicio quedan Chrome huérfanos, la sesión puede quedar bloqueada y se pierden los últimos 0,5–1,2 s de mensajes/pedidos | Solo maneja `SIGINT`; no cancela timers, no hace flush ni `destroy` | Handler `SIGTERM` + flush + `cerrarSesion()` con timeout | S |
| F-20 | **P3** | Higiene/seguridad colateral: token vacío, CORS `*`, JSON 12 MB, base64 en JSON | `server.js:19`, `:682-695`; `bot/.env` (`BOT_TOKEN` vacío); `pagos.js:45-53` | Cualquiera en la LAN puede abrir la API, ver el QR, enviar o cerrar sesión; imágenes grandes bloquean el parseo | `BOT_TOKEN` opcional, CORS abierto, imágenes dentro de JSON | Exigir token fuera de localhost, bajar límite JSON, guardar imágenes como archivo | S |

> Esfuerzo: **S** ≤ 1 día, **M** 2–4 días, **L** ≥ 1 semana (incluye migración de datos/pruebas).

---

### 4.2 P0

#### F-01 — Campaña reenviada en masa cuando falla el guardado del estado del envío

**Síntoma observable desde el panel.** En *Campañas*, una campaña sigue en "programada" y el contador "X de Y procesados" no avanza; los clientes reciben el mismo mensaje una y otra vez, una tanda por minuto. Al reiniciar el bot, la campaña se retoma y repite a quienes ya recibieron. No hay forma de detenerla salvo apagar el bot.

**Evidencia.**

`bot/src/server.js:291-303`:
```js
try {
  await enviar(c.telefono, texto, emisor);
  await sb.from('envios').update({ estado: 'enviado', fecha_envio: new Date().toISOString() }).eq('id', e.id);
  await logMensaje({ clienteId: c.id, telefono: c.telefono, direccion: 'saliente', texto, origen: 'campana' });
  contarEnvio();
  ...
} catch (err) {
  errores++;
  ...
  await sb.from('envios').update({ estado: 'error', fecha_envio: new Date().toISOString() }).eq('id', e.id);
```
`bot/src/server.js:313-317`:
```js
const { count } = await sb.from('envios').select('id', { count: 'exact', head: true }).eq('campana_id', id).eq('estado', 'pendiente');
if (count === 0) {
  await sb.from('campanas').update({ estado: 'enviada' }).eq('id', id);
```
`bot/src/server.js:228-229` (reencolado cada minuto, `:1297`):
```js
for (const c of data || []) {
  if (cola.add('camp:' + c.id, () => enviarCampana(c.id))) log(`Campaña en cola: ${c.titulo}`);
}
```

**Causa raíz.** En `@supabase/supabase-js` v2 un `update()` **no lanza**: resuelve `{ error }`. El código desestructura solo `{ data }` en `select` y ni siquiera desestructura en los `update` (`:285`, `:293`, `:302`, `:242`, `:266`, `:315`). Si el update falla (RLS, timeout, red, fila bloqueada), el `envio` queda `pendiente`; al terminar el bucle el `count` de pendientes es > 0, la campaña **nunca** pasa a `enviada` y el siguiente tick de 60 s la vuelve a encolar. La `Cola` solo dedupe mientras el job está vivo (`queue.js:14`), no entre ejecuciones. Un crash a mitad de campaña produce el mismo efecto con los mensajes ya enviados. Además, sin `wa_id` persistido no hay forma de distinguir "enviado" de "pendiente" después de un fallo.

**Fix (esfuerzo M).** Reclamar el envío en la base **antes** de mandar, verificar el error y cerrar la campaña siempre. Requiere migración: `envios.estado` debe aceptar `'enviando'` y conviene añadir `envios.wa_id`.

```js
// server.js — un envío solo se manda si ESTE proceso logró reclamarlo
async function reclamarEnvio(id) {
  const { data, error } = await sb.from('envios')
    .update({ estado: 'enviando', fecha_envio: new Date().toISOString() })
    .eq('id', id).eq('estado', 'pendiente')
    .select('id');
  if (error) throw error;
  return data?.length === 1;                 // false = ya enviado o lo tomó otro
}

// dentro del for de enviarCampana, reemplazando el try actual:
if (!(await reclamarEnvio(e.id))) continue;
try {
  const r = await enviar(c.telefono, texto, emisor);
  const { error } = await sb.from('envios')
    .update({ estado: 'enviado', wa_id: r?.waId || null })
    .eq('id', e.id).eq('estado', 'enviando');
  if (error) log(`[envio ${e.id}] enviado pero no confirmado: ${error.message}`);
  ...
} catch (err) {
  await sb.from('envios').update({ estado: 'error', nota: String(err.message).slice(0, 200) })
    .eq('id', e.id).eq('estado', 'enviando');
  ...
}
// al salir del bucle, SIEMPRE:
await sb.from('campanas').update({ estado: 'enviada' }).eq('id', id);
```

Barrido al arrancar (antes de `iniciarWhatsApp`, `server.js:1295`), para reparar procesos muertos sin reenviar:
```js
const hace10 = new Date(Date.now() - 10 * 60 * 1000).toISOString();
await sb.from('envios').update({ estado: 'error', nota: 'proceso interrumpido' })
  .eq('estado', 'enviando').lt('fecha_envio', hace10);
```
Trade-off explícito: se prefiere **perder un envío** (visible como `error`, reintentable a mano) antes que duplicarlo. La operación `update ... eq(estado)` es atómica por fila; con una sola instancia del bot es suficiente. Si algún día hay dos instancias, mover el claim a una función RPC con `FOR UPDATE SKIP LOCKED`.

**Aceptación.** Simular error de Supabase (RLS o red) a mitad de campaña: los `envios` afectados deben quedar en `error` o `enviando`, la campaña debe cerrar una sola vez y no debe reenviarse ningún mensaje en los siguientes 5 minutos.

---

### 4.3 P1

#### F-02 — Sin timeout en envíos y scrapes de Puppeteer

**Síntoma.** Logs se detienen después de "Enviando…"; `/api/estado` muestra `cola` clavada; la campaña no avanza ni falla; el panel de Ajustes queda en "Sincronizando…" para siempre y el botón de sincronizar ya no se puede reutilizar sin recargar.

**Evidencia.** `bot/src/whatsapp.js:310-313`:
```js
const id = await s.client.getNumberId(limpio);
if (!id) throw new Error(`El número +${limpio} no tiene WhatsApp`);
recordarEnvio(texto);
const enviado = await s.client.sendMessage(id._serialized, texto);
```
`bot/src/whatsapp.js:442` / `:664`:
```js
const chats = await s.client.getChats();
...
const msgs = await s.client.pupPage.evaluate(async ({ chatId, limite }) => {
```
`bot/src/queue.js:23-33`:
```js
while (this.items.length) {
  const job = this.items.shift();
  this.actual = job.id;
  try {
    await job.fn();
```
**Causa raíz.** Ninguna operación que cruza WhatsApp Web tiene deadline. `whatsapp-web.js` puede quedarse esperando si la página se congela, si WhatsApp Web cambia el DOM o si hay reconexión a medias. Un `await` colgado deja `cola.actual` fijado para siempre: `/api/enviar/:id` responderá `true` y nada más se ejecutará. En HTTP, `/api/sincronizar` y `/api/conversaciones/:tel/enviar` quedan pendientes indefinidamente (el navegador no cancela del lado servidor).

**Fix (S).** Un helper de timeout y watchdog en la cola.

```js
// whatsapp.js — techo de tiempo para todo lo que cruza Puppeteer
export function conTimeout(promesa, ms, que) {
  let t;
  const reloj = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${que}: sin respuesta en ${ms} ms`)), ms);
    t.unref?.();
  });
  return Promise.race([promesa, reloj]).finally(() => clearTimeout(t));
}

// enviar():
const enviado = await conTimeout(s.client.sendMessage(id._serialized, texto), 45000, 'sendMessage');
// enviarImagen(): idem para sendMessage; historialWa(): conTimeout(evaluate, 30000, 'historialWa')
// listarChatsWa(): conTimeout(getChats, 45000, 'getChats') y lo mismo para el evaluate de respaldo

// queue.js — ningún job puede bloquear la cola indefinidamente
try {
  await conTimeout(job.fn(), 120000, `job ${job.id}`);
} catch (e) {
  this.log(`Error en trabajo ${job.id}: ${e.message}`);
} finally {
  this.actual = null;
}
```
Nota: los `evaluate` de `parcharMsgKey`, `resolverTelefonoWa` y `descargarMediaWa` también deben pasar por el helper (mismo patrón).

**Aceptación.** Simular cuelgue (matar la pestaña de Chromium o cortar red) durante un envío: el job debe fallar en ≤ 2 min, la cola debe seguir procesando y `/api/sincronizar` debe devolver 500 con error visible.

#### F-03 — Timers de reconexión huérfanos y clientes de sesión duplicados

**Síntoma.** Después de "Cerrar sesión" el QR reaparece solo o el estado vuelve a "conectado"; tras un doble clic en "Reiniciar sesión" quedan dos Chrome (RAM disparada) y la sesión de WhatsApp se cae por conflicto; el chip del panel oscila entre `qr` e `iniciando` (parpadeo).

**Evidencia.** `bot/src/whatsapp.js:198-209`:
```js
client.on('disconnected', motivo => {
  s.estado = 'desconectado';
  ...
  if (s.reintentos < 5) {
    s.reintentos++;
    log(`[${id}] Reintentando conexión en 15 segundos (intento ${s.reintentos}/5)…`);
    setTimeout(() => client.initialize().catch(e => log(`[${id}] Error al reconectar: ${e.message}`)), 15000);
  }
});
```
`bot/src/whatsapp.js:287-288`:
```js
s.vigilante = setInterval(tick, 8000);
setTimeout(tick, 3000);
```
`bot/src/whatsapp.js:737-760`:
```js
export async function reiniciarSesion(sesionId = null) {
  ...
  if (s.vigilante) { clearInterval(s.vigilante); s.vigilante = null; }
  try { await s.client?.destroy(); } catch {}
  s.client = null;
  ...
  crearSesion(id, { onMensaje: s.onMensaje, ... }).catch(e => { ... });
```
**Causa raíz.** (1) El `setTimeout` de reintento no se guarda en ningún sitio: `cerrarSesion()` (`:715-731`) y `reiniciarSesion()` lo desconocen y no pueden cancelarlo; al dispararse llama `client.initialize()` sobre un cliente ya destruido/logout, lo que puede reabrir la sesión o lanzar errores repetidos. (2) El `setTimeout(tick, 3000)` tampoco se rastrea; tras reiniciar, su closure apunta al cliente viejo. (3) `reiniciarSesion()` no tiene lock: dos llamadas concurrentes (doble clic, o `POST /api/logout` seguido de `POST /api/sesion/reiniciar` como hace `index.html:1415`) crean dos `Client` sobre el mismo `LocalAuth`; el segundo pisa `s.client` y el primero queda vivo sin nadie que lo destruya. (4) cada evento `disconnected` programa un timer nuevo sin comprobar si ya hay uno pendiente (no existe flag `reconectando`): dos eventos seguidos = dos `client.initialize()` sobre el mismo cliente.
**Fix (M).** Un runner único por sesión: cancelar timers por sesión y serializar reinicios con un lock por id.

```js
// whatsapp.js
const locks = new Map();
function conLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (locks.get(id) === next) locks.delete(id); });
  locks.set(id, next);
  return next;
}
function cancelarTimers(s) {
  for (const t of [s.vigilante, s.retryTimer, s.tickInicial]) {
    if (t) { clearInterval(t); clearTimeout(t); }
  }
  s.vigilante = s.retryTimer = s.tickInicial = null;
}
// vigilarConexion: s.tickInicial = setTimeout(tick, 3000);
// disconnected: cancelarTimers(s); if (s.reconectando) return; s.reconectando = true;
//   s.retryTimer = setTimeout(() => conLock(id, async () => {
//     try { await s.client?.destroy(); s.client = null; await crearSesion(id, callbacks); }
//     finally { s.reconectando = false; } }), 15000);
// reiniciarSesion(id): return conLock(String(id), async () => {
//   cancelarTimers(s); await s.client?.destroy().catch(() => {}); s.client = null;
//   ...reset de flags...; await crearSesion(id, callbacks); });
// cerrarSesion(id): cancelarTimers(s); s.cerradaPorUsuario = true; ...
```
Además, en `disconnected` no reintentar si `s.cerradaPorUsuario` está activo, y resetear `reintentos` al iniciar una sesión nueva.

**Aceptación.** Doble clic en "Reiniciar": una sola sesión `iniciando` y un solo Chromium (verificar procesos). Cerrar sesión y esperar 60 s: no debe aparecer QR ni estado "conectado" sin acción del usuario.

#### F-04 — Guardado JSON completo y sincrónico por mensaje, sin escritura atómica

**Síntoma.** En ráfagas (campaña saliente + mensajes entrantes + acks) la interfaz del bot se congela y "parpadea"; tras un corte de luz/proceso, el panel aparece con la bandeja vacía (el JSON quedó truncado y `cargar()` devuelve `{}` en silencio) o pierde los últimos mensajes, pedidos o tareas de seguimiento.

**Evidencia.** `bot/src/conversaciones.js:8-9`, `:23-35`:
```js
const MAX_CHATS = 400;
const MAX_MENSAJES = 500;
...
let guardando = null;
function guardar() {
  if (guardando) clearTimeout(guardando);
  guardando = setTimeout(() => {
    guardando = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(archivo, JSON.stringify(chats), 'utf8');
    } catch (e) {
      console.warn('[conversaciones] no se pudo guardar:', e.message);
    }
  }, 1200);
}
```
`bot/src/server.js:95-96` (síncrono dentro del handler HTTP):
```js
fs.mkdirSync(comprobantesDir, { recursive: true });
fs.writeFileSync(path.join(comprobantesDir, nombre), Buffer.from(String(media.data || ''), 'base64'));
```
El mismo patrón en `pedidos.js:42-53` (snapshot de hasta 1.200 pedidos), `seguimiento.js:41-48`, `pagos.js:28-35` (hasta 20 plantillas con base64 de 6 MB) e `ia.js:30-37`.

**Causa raíz.** Cada mensaje, ack y cabecera programa un `JSON.stringify` + `writeFileSync` del **snapshot completo** en el hilo principal. El debounce evita ráfagas de escrituras, pero: (a) el `clearTimeout` descarta la escritura pendiente anterior sin guardar (si el proceso muere en la ventana, se pierde); (b) cuando dispara, el snapshot puede ser de decenas de MB (400 × 500 mensajes) y bloquea el event loop durante cientos de ms; (c) no hay `tmp + rename`, así que un corte a mitad de escritura deja el archivo inválido; (d) `cargar()` (`:14-21`) devuelve `{}` sin avisar, por lo que el panel simplemente muestra "sin conversaciones".

**Fix (M).** Corto plazo: escritura atómica, debounce que no pierda turnos y `flush()` en shutdown.

```js
// conversaciones.js — atómico y sin perder la última escritura
let guardando = null;
let pendiente = false;
function guardar() {
  pendiente = true;
  if (guardando) return;                       // no cancelar: agrupa
  guardando = setTimeout(async () => {
    guardando = null;
    if (!pendiente) return;
    pendiente = false;
    const tmp = archivo + '.tmp';
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(chats), 'utf8');
      await fs.promises.rename(tmp, archivo);  // atómico en NTFS y ext4
    } catch (e) {
      console.warn('[conversaciones] no se pudo guardar:', e.message);
    }
  }, 1200);
}
export function flush() {
  if (guardando) { clearTimeout(guardando); guardando = null; }
  try { fs.writeFileSync(archivo + '.tmp', JSON.stringify(chats)); fs.renameSync(archivo + '.tmp', archivo); } catch {}
}
```
Mediano plazo (L): pasar a **NDJSON append-only** para los mensajes (`fs.appendFile` de una línea por mensaje) y mantener el índice de chats en un archivo pequeño; o directamente SQLite (`node:sqlite` en Node 22), que además resuelve búsquedas y concurrencia. Migración: leer el JSON actual, escribir NDJSON, conservar backup.

**Aceptación.** Enviar 200 mensajes en 30 s: pico de event loop < 200 ms (medir con `perf_hooks.monitorEventLoopDelay`). Matar el proceso con `Stop-Process -Force` en mitad de una ráfaga: el archivo debe abrir con `JSON.parse` sin errores o no existir `.tmp` huérfano.

#### F-05 — `/api/estado` como hot path con I/O a Supabase y cálculo O(mensajes)

**Síntoma.** El chip de conexión y la bandeja van atrasados; el panel "no se siente en vivo" aunque los mensajes ya llegaron; si Supabase está lento o caído, el panel del bot deja de refrescar (el flag `cargando` bloquea los siguientes ticks) y el dashboard dispara peticiones superpuestas que pintan datos viejos (parpadeo/reordenamiento de la lista).

**Evidencia.** `bot/src/server.js:750-773`:
```js
app.get('/api/estado', auth, async (_req, res) => {
  const sesiones = estadoWa();
  let programadas = 0;
  if (sb) {
    const { count } = await sb.from('campanas').select('id', { count: 'exact', head: true }).eq('estado', 'programada');
    programadas = count || 0;
  }
  res.json({ sesiones, ..., chats: resumenChats(), ... });
```
`bot/src/conversaciones.js:371-379` (se ejecuta en **cada** `/api/estado`):
```js
export function resumen() {
  const lista = Object.values(chats);
  const hoy = ahora().slice(0, 10);
  return {
    chats: lista.length,
    noLeidos: totalNoLeidos(),
    mensajesHoy: lista.reduce((n, c) => n + c.mensajes.filter(m => String(m.en).startsWith(hoy)).length, 0)
  };
}
```
`bot/src/panel.html:128-131` y `:204`:
```js
async function cargar(){
  if(cargando)return;cargando=true;
  try{
    const j=await api('/api/estado');
...
setInterval(cargar,3500);
```
`index.html:1951-1952` (dos pollers simultáneos de la bandeja) y `index.html:1468` (chip cada 20 s).

**Causa raíz.** El endpoint más llamado del bot hace: (1) un round-trip a Supabase (sin timeout y con `supabase-js`, que no tiene timeout por defecto); (2) un recorrido de todos los chats y mensajes (`resumen()`); (3) serializa el QR en base64 (`estadoWa()` devuelve `qrDataUrl`, `whatsapp.js:774`) cuando hay QR. No hay caché, ni `AbortSignal`, ni separación entre "estado core" y "detalle". Los consumidores lo llaman desde 4 sitios con frecuencias distintas (2,5 s / 3,5 s / 20 s) y sin cancelar peticiones anteriores.

**Fix (S/M).** Caché corta, timeout del count y payload sin QR.

```js
// server.js
const CON_TIMEOUT = (p, ms, que) => { let t; const r = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(que)), ms); t.unref?.(); }); return Promise.race([p, r]).finally(() => clearTimeout(t)); };
let cacheProgramadas = { at: 0, n: 0 };
async function contarProgramadas() {
  if (Date.now() - cacheProgramadas.at < 30000) return cacheProgramadas.n;
  try {
    const { count, error } = await CON_TIMEOUT(
      sb.from('campanas').select('id', { count: 'exact', head: true }).eq('estado', 'programada'), 1500, 'count');
    if (error) throw error;
    cacheProgramadas = { at: Date.now(), n: count || 0 };
  } catch { cacheProgramadas = { at: Date.now(), n: cacheProgramadas.n }; }
  return cacheProgramadas.n;
}
let cacheEstado = { at: 0, json: null };
app.get('/api/estado', auth, async (_req, res) => {
  if (Date.now() - cacheEstado.at < 1500 && cacheEstado.json) return res.json(cacheEstado.json);
  const sesiones = estadoWa().map(({ qr, ...s }) => s);   // sin QR
  const json = { sesiones, cola: cola.size, programadas: await contarProgramadas(), ... };
  cacheEstado = { at: Date.now(), json };
  res.json(json);
});
```
Complementos: el panel usa `/api/qr` (ya existe) cuando `estado==='qr'`; `resumen()` se calcula una vez por minuto y se cachea; los consumidores agregan `AbortController` con timeout de 5 s para no apilar requests. A mediano plazo, un endpoint delta (`/api/estado?desde=`) o SSE para que el panel no repinte todo.

**Aceptación.** Con el panel del bot abierto y el dashboard abierto: `/api/estado` p95 < 150 ms y estable aunque Supabase tarde 5 s (simular bloqueando el host o usando un mock); el chip no se queda "pegado" al cortar la red.

#### F-06 — Seguimiento post-venta fuera de la cola: reenvío y concurrencia de envíos

**Síntoma.** Un cliente recibe dos veces "¿cómo te fue con el perfume?"; mensajes de seguimiento aparecen intercalados con los de una campaña o con una respuesta de la IA; clientes que pidieron la baja siguen recibiendo el aviso de recompra.

**Evidencia.** `bot/src/server.js:1316-1327`:
```js
try {
  const env = await enviar(t.telefono, texto);
  await logMensaje({ clienteId: p.clienteId, telefono: t.telefono, direccion: 'saliente', texto, origen: 'seguimiento' });
  registrar({ telefono: t.telefono, texto, direccion: 'saliente', nombre: p.nombre, clienteId: p.clienteId, origen: 'seguimiento', waId: env?.waId || '' });
  seguimiento.marcarEnviada(t.id);
  contarEnvio();
  emitir('seguimiento', { ... });
} catch (e) {
  log(`No se pudo enviar el seguimiento a +${t.telefono}: ${e.message}`);
  break;
}
```
`bot/src/server.js:1303` (las guardas del planificador):
```js
if (revisandoSeg || !hayConexion() || !dentroHorario() || limiteAlcanzado()) return;
```
**Causa raíz.** `marcarEnviada()` está **después** de `logMensaje()` y `registrar()`. Si cualquiera de esos pasos falla (Supabase caído, disco lleno en el JSON), el `catch` corta el bucle y la tarea sigue `pendiente`; al minuto siguiente se reintenta y el cliente recibe el mensaje otra vez. Además el bucle no corre dentro de la `Cola` (`queue.js`), así que compite con el job de campaña y con las respuestas de la IA por el mismo cliente de WhatsApp (envíos concurrentes, orden no garantizado). Y nunca consulta `clientes.baja`/`consentimiento`: `puede()` se usa en campañas (`server.js:79`, `:284`) pero no aquí.

**Fix (M).** Reclamar la tarea, marcar estado antes de los logs best-effort y validar baja.

```js
// seguimiento.js — claim atómico en memoria
export function reclamar(id) {
  const t = estado.tareas.find(x => String(x.id) === String(id) && x.estado === 'pendiente');
  if (!t) return false;
  t.estado = 'enviando'; t.intentos = (t.intentos || 0) + 1; guardar();
  return true;
}
export function reintentar(id, motivo) {
  const t = estado.tareas.find(x => String(x.id) === String(id));
  if (!t) return;
  t.estado = (t.intentos || 0) >= 3 ? 'error' : 'pendiente';
  t.motivo = String(motivo || '').slice(0, 120); guardar();
}

// server.js — revisarSeguimientos
for (const t of seguimiento.pendientes()) {
  if (limiteAlcanzado()) break;
  const p = pedidos.obtener(t.pedidoId);
  if (!p || p.estado === 'cancelado') { seguimiento.omitir(t.id, 'Pedido cancelado'); continue; }
  if (!seguimiento.estaActivo(t.telefono)) continue;
  const cli = await getCliente(t.telefono);
  if (cli && (!cli.consentimiento || cli.baja || cli.activo === false)) { seguimiento.omitir(t.id, 'baja/consentimiento'); continue; }
  if (!seguimiento.reclamar(t.id)) continue;
  const texto = seguimiento.plantilla(t.tipo, p);
  try {
    const env = await conTimeout(enviar(t.telefono, texto), 45000, 'seguimiento');
    seguimiento.marcarEnviada(t.id, env?.waId);           // primero el estado
    contarEnvio();
    Promise.allSettled([
      logMensaje({ clienteId: p.clienteId, telefono: t.telefono, direccion: 'saliente', texto, origen: 'seguimiento' }),
      // registrar(...) + emitir(...) quedan best-effort
    ]);
  } catch (e) {
    seguimiento.reintentar(t.id, e.message);
    break;
  }
  await dormir(esperaEntreEnvios(config.delayMin, config.delayMax));
}
```
**Aceptación.** Forzar un error en `logMensaje` tras un seguimiento enviado: la tarea debe quedar `enviado` (no reintentarse). Cliente con `baja=true` y tarea pendiente: la tarea debe quedar `omitido` sin enviar.

#### F-07 — Cola única con `sleep` de 25–40 s dentro del job: bloqueo de cabeza de fila

**Síntoma.** Al pulsar "Enviar ahora" en otra campaña, el panel responde "Campaña en cola" pero no se envía nada durante horas; `cola` queda en 1 y el dueño cree que el bot se colgó. El panel no puede mostrar progreso porque no hay endpoint de estado de campaña.

**Evidencia.** `bot/src/queue.js:13-35`:
```js
add(id, fn) {
  if (this.actual === id || this.items.some(x => x.id === id)) return false;
  this.items.push({ id, fn });
  this._run();
  return true;
}
async _run() {
  if (this.corriendo) return;
  this.corriendo = true;
  while (this.items.length) {
    const job = this.items.shift();
    this.actual = job.id;
    try { await job.fn(); }
```
`bot/src/server.js:276-311` (el job de campaña duerme 25–40 s por mensaje):
```js
for (const e of envios) {
  ...
  await dormir(esperaEntreEnvios(config.delayMin, config.delayMax));
}
```
**Causa raíz.** La cola es un único worker secuencial y el job de campaña dura todo el envío (una campaña de 80 destinatarios ≈ 45–50 min a 30–35 s por mensaje). Mientras duerme, ningún otro job avanza: "Enviar ahora" de otra campaña, o cualquier futuro trabajo encolado, esperan al final. El `setInterval` de 60 s sigue encolando (la dedupe por id evita duplicados), pero la percepción es "el bot está colgado".

**Fix (M).** Un envío por paso: el job no duerme; programa el siguiente con `setTimeout` y deja la cola libre entre mensajes.

```js
// server.js — la campaña deja de ser un job largo; es una cadena de pasos cortos
async function pasoCampana(id) {
  const campana = await getCampana(id);
  if (!campana || campana.estado !== 'programada') return;
  if (!dentroHorario() || limiteAlcanzado()) { await reprogramar(campana, 30); return; }
  const envio = await siguientePendiente(id);            // UNA fila
  if (!envio) { await sb.from('campanas').update({ estado: 'enviada' }).eq('id', id); return; }
  await mandarUnEnvio(campana, envio);                   // claim + enviar (F-01)
  if (await quedanPendientes(id)) {
    const espera = esperaEntreEnvios(config.delayMin, config.delayMax);
    setTimeout(() => cola.add('camp:paso:' + id, () => pasoCampana(id)), espera).unref?.();
  } else {
    await sb.from('campanas').update({ estado: 'enviada' }).eq('id', id);
  }
}
// revisarProgramadas: cola.add('camp:' + c.id, () => pasoCampana(c.id))
```
Así la cola queda libre entre mensajes (otra campaña entra en el siguiente hueco) y `/api/estado` puede exponer progreso real leyendo `envios`/`campanas`. Alternativa: dos carriles (`colaCampanas`, `colaAvisos`) con concurrencia 1 cada uno.

**Aceptación.** Con una campaña en curso, "Enviar ahora" a otra debe comenzar en ≤ 2 intervalos de delay (≤ 78 s), no en horas.

#### F-08 — IA duplicada/fuera de orden y cadena de reintentos sin deadline

**Síntoma.** El cliente recibe dos respuestas al mismo mensaje, o una respuesta a un mensaje anterior llega después de la nueva; los logs muestran "Pensando respuesta para +…" durante minutos; el consumo de cuota Gemini se dispara con un solo cliente insistente.

**Evidencia.** `bot/src/whatsapp.js:211-214` (el EventEmitter no espera):
```js
client.on('message', async msg => {
  try { await onMensaje(msg, id); }
  catch (e) { log(`[${id}] Error al procesar mensaje: ${e.message}`); }
});
```
`bot/src/server.js:551-559` (cooldown antes de la IA):
```js
if (!esPrueba && config.cooldownSegundos > 0 && Date.now() - (cooldown.get(tel) || 0) < config.cooldownSegundos * 1000) { ... return; }
cooldown.set(tel, Date.now());
try {
  log(`Pensando respuesta para +${tel}...`);
  const ai = await redactarRespuesta({ ... });
```
`bot/src/ai.js:254-259` (5 modelos × 2 variantes):
```js
const modelos = [...new Set([preferido, 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'])];
...
for (const model of modelos) {
  for (const conThinking of [true, false]) {
```
`bot/src/ai.js:298-299` (Anthropic **sin** timeout):
```js
async function anthropic(prompt) {  const r = await fetch('https://api.anthropic.com/v1/messages', {
```
**Causa raíz.** (1) Cada mensaje entrante lanza un handler asíncrono independiente; dos mensajes seguidos del mismo contacto se procesan en paralelo y ambos pueden llegar a `enviar()`. (2) El cooldown se marca al **empezar** a pensar, no al terminar: si la IA tarda más que `COOLDOWN_SEGUNDOS` (10 s por defecto), el siguiente mensaje entra mientras la primera respuesta sigue en vuelo → dos respuestas. (3) La cadena de fallback de Gemini puede hacer hasta 10 peticiones secuenciales de 20 s (200 s) y `transcribirAudio` hasta 4 × 30 s; no hay deadline total por mensaje. (4) `anthropic()` no tiene `AbortSignal`: una petición puede quedar colgada para siempre.

**Fix (M).** Serializar por chat, deadline total y cooldown al terminar.

```js
// server.js — una sola respuesta "en vuelo" por contacto
const porChat = new Map();
function serializar(tel, tarea) {
  const prev = porChat.get(tel) || Promise.resolve();
  const next = prev.then(tarea, tarea).finally(() => { if (porChat.get(tel) === next) porChat.delete(tel); });
  porChat.set(tel, next);
  return next;
}
// en manejarMensaje, tras dedupe: await serializar(tel, () => responder(tel, texto, ...));
// dentro de responder():
const ai = await conTimeout(redactarRespuesta({ mensaje: textoIA, historial: hist, cliente, contexto: promptIA() }), 25000, 'IA');
...
cooldown.set(tel, Date.now());          // recién cuando terminó de responderse
// ai.js anthropic():
const r = await fetch('https://api.anthropic.com/v1/messages', { ..., signal: AbortSignal.timeout(20000) });
// y un presupuesto total para la cadena de modelos:
const deadline = Date.now() + 35000; for (const model of modelos) { if (Date.now() > deadline) break; ... }
```
**Aceptación.** Enviar 3 mensajes seguidos del mismo contacto en 5 s: una sola respuesta final (o una conversación coherente), sin respuestas cruzadas; logs sin "Pensando" > 40 s.

---

### 4.4 P2

#### F-09 — `/api/analiticas` bloquea el event loop

**Síntoma.** Al abrir la pestaña Analíticas, todo el bot deja de responder unos segundos: los mensajes de WhatsApp entran tarde, el panel se queda en "cargando" y un envío en curso se retrasa. Con más mensajes, el bloqueo crece.

**Evidencia.** `bot/src/server.js:947`, `:960-969`:
```js
const msgs = mensajesEntrantes(20000);
...
for (const m of msgs) {
  const t = sinTildes(m.texto);
  for (const n of nombres) {
    if (!n.re.test(t)) continue;
```
`bot/src/conversaciones.js:358-369` (`mensajesEntrantes` copia y ordena hasta 20.000 objetos). El seed `sql/01_productos.sql` contiene **202 productos** (contados en el archivo), así que una sola llamada hace ~4 millones de tests de regex más normalización Unicode, todo en el hilo principal.

**Causa raíz.** Análisis pesado calculado on-demand sobre datos persistidos, sin caché ni índice. Además `getProductos()` consulta Supabase en cada request (`server.js:946`), fuera de la caché de 10 min de `ai.js`.

**Fix (M).** Mantener un índice incremental al registrar el mensaje y servir un snapshot cacheado.

```js
// conversaciones.js — índice de menciones actualizado por mensaje entrante (O(productos) por 1 mensaje)
import { productosIndice } from './ai.js';           // [{ nombre, clave, re }] cacheado 10 min
const menciones = new Map();                          // clave -> { nombre, menciones, chats:Set }
export function indexarMenciones(telefono, texto) {
  const t = sinTildes(texto);
  for (const n of productosIndice) {
    if (!n.re.test(t)) continue;
    const fila = menciones.get(n.clave) || { nombre: n.nombre, menciones: 0, chats: new Set() };
    fila.menciones++; fila.chats.add(telefono); menciones.set(n.clave, fila);
  }
}
export function topMenciones(n = 12) {
  return [...menciones.values()]
    .map(x => ({ nombre: x.nombre, menciones: x.menciones, chats: x.chats.size }))
    .sort((a, b) => b.menciones - a.menciones || b.chats - a.chats).slice(0, n);
}
// server.js GET /api/analiticas: devolver { masConsultados: topMenciones(), ... } sin recorrer 20k mensajes
// (si se quiere histórico exacto, reconstruir el índice una vez al arrancar con setImmediate y guardarlo)
```
**Aceptación.** Con 20.000 mensajes, `/api/analiticas` < 500 ms y sin picos > 100 ms en el event loop.

#### F-10 — Payloads grandes sin paginar

**Síntoma.** Abrir Ajustes/IA tarda y descarga cientos de KB; con un chat abierto, cada 20 s se vuelve a bajar el hilo completo; en red lenta el panel parece colgado y la memoria del navegador crece.

**Evidencia.** `bot/src/server.js:895`:
```js
app.get('/api/pagos', auth, (_req, res) => res.json({ plantillas: pagos.listar() }));
```
`bot/src/pagos.js:55-60` devuelve cada plantilla con `imagen` incluida (dataURL de hasta 6 MB, `:45-53`). `bot/src/server.js:1127` devuelve **todos** los clientes (`getClientes`, `supabase.js:24`). `bot/src/server.js:1154-1160` devuelve hasta 500 mensajes completos (textos de hasta 4.000 caracteres). `index.html:1534` reimporta y re-descarga el hilo cada 20 s mientras hay un chat abierto.

**Causa raíz.** Endpoints de colección sin paginación, sin proyección de campos y con binarios incrustados en JSON; el frontend no usa delta ni ETag.

**Fix (M).**

```js
// pagos.js — listado liviano por defecto
export function listar({ conImagen = false } = {}) {
  return plantillas.slice().sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)))
    .map(p => conImagen ? { ...p } : { ...p, imagen: undefined });
}
// server.js — binario por endpoint
app.get('/api/pagos/:id/imagen', auth, (req, res) => {
  const p = pagos.obtener(req.params.id);
  const m = p && pagos.partesImagen(p.imagen);
  if (!m) return res.sendStatus(404);
  res.type(m.mimetype).set('Cache-Control', 'private, max-age=3600')
     .send(Buffer.from(m.base64, 'base64'));
});
// conversaciones: GET /api/conversaciones/:tel?desde=<iso> devuelve solo mensajes nuevos
// clientes: GET /api/clientes?limite=500&offset=0 (o proyección de campos)
```
**Aceptación.** Con 3 plantillas con imagen, `/api/pagos` < 20 KB; abrir un chat no debe re-descargar > 50 KB cada 20 s.

#### F-11 — `/api/sincronizar` sin lock ni timeout; un chat = una escritura

**Síntoma.** El botón "Sincronizar WhatsApp" queda en "Sincronizando…" para siempre o se puede lanzar dos veces desde dos pestañas; mientras sincroniza, la bandeja muestra chats que luego desaparecen y el orden se mueve solo.

**Evidencia.** `bot/src/server.js:1036-1107`, en particular `:1063-1078`:
```js
for (const c of lista) {
  ...
  registrarCabecera({ ... });   // y dentro: recortar() + guardar() por cada chat
```
`bot/src/conversaciones.js:150-157` (`recortar` ordena todas las claves en cada llamada) y `:203-204` (`recortar(); guardar();`). `bot/src/whatsapp.js:467` y `:594-596` (catches vacíos que pueden devolver listas vacías sin causa).

**Causa raíz.** Sin mutex ni deadline; `registrarCabecera()` se llama una vez por chat y cada una hace `recortar()` (sort de todas las claves) y programa un snapshot completo. Con la lista real de WhatsApp (cientos de chats) el coste es O(n²) y bloquea el event loop. Si `listarChatsWa` falla, el `catch` externo traga el error y el panel interpreta "0 chats".

**Fix (M).**

```js
// server.js
let syncEnCurso = false;
app.post('/api/sincronizar', auth, async (req, res) => {
  if (syncEnCurso) return res.status(409).json({ error: 'Ya hay una sincronización en curso.' });
  syncEnCurso = true;
  try {
    const lista = await conTimeout(listarChatsWa(req.body?.sesion || null), 45000, 'getChats');
    registrarCabeceras(lista);                    // muta el mapa y guarda UNA vez
    ...
    res.json(salida);
  } catch (e) {
    log('Error al sincronizar: ' + (e?.stack || e.message));   // sin catch vacío
    res.status(500).json({ error: e.message });
  } finally { syncEnCurso = false; }
});
// conversaciones.js — batch
export function registrarCabeceras(lista = []) {
  for (const c of lista) aplicarCabecera(c);      // sin guardar ni recortar
  recortar(); guardar();                          // una sola vez al final
}
```
**Aceptación.** Doble clic en sincronizar: la segunda llamada devuelve 409. Sincronizar 500 chats: la UI responde en < 10 s y no bloquea envíos (medir pausa del event loop).

#### F-12 — N+1 a Supabase por mensaje entrante y por respuesta de IA

**Síntoma.** La primera respuesta a un cliente tarda 1–3 s más de lo necesario; con Supabase intermitente los mensajes entran con retraso, la IA responde sin contexto y el panel "no se entera" a tiempo.

**Evidencia.** `bot/src/server.js:471-475` (secuencial):
```js
const cliente = await getCliente(tel);
const hist = await historial(tel, 8);
...
await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'entrante', texto, origen: 'cliente' });
```
`bot/src/ai.js:128-129` (`getConfiguracion` en cada respuesta):
```js
async function contextoCliente(texto) {
  const [cfg, productos] = await Promise.all([getConfiguracion(), catalogo()]);
```
`bot/src/supabase.js:10-14` no cachea nada y `:34-45` inserta un mensaje por cada evento (entrante, saliente IA, aviso al dueño, comprobante…) sin dedupe.

**Causa raíz.** No hay caché de configuración de tienda ni de cliente; las consultas independientes se hacen secuenciales; cada registro implica un insert propio. Son 4–5 round-trips por mensaje entrante.

**Fix (S).**

```js
// supabase.js — caché de configuración
let cfgCache = { at: 0, valor: {} };
export async function getConfiguracion() {
  if (Date.now() - cfgCache.at < 5 * 60 * 1000 && cfgCache.at) return cfgCache.valor;
  try {
    const { data, error } = await sb.from('configuracion_tienda').select('*').limit(1);
    if (error) throw error;
    cfgCache = { at: Date.now(), valor: data?.[0] || {} };
  } catch { /* mantener el valor previo */ }
  return cfgCache.valor;
}
// server.js — paralelizar lo independiente
const [cliente, hist] = await Promise.all([getCliente(tel), historial(tel, 8)]);
// y registrar el entrante en un buffer que se inserta por lote cada 2 s (o dejar logMensaje best-effort,
// sin bloquear la respuesta al cliente)
```
**Aceptación.** Medir tiempo desde la recepción hasta `enviar()` con Supabase a 100 ms de latencia: debe bajar de ~500 ms a ~200 ms en la fase previa a la IA.

#### F-13 — Errores silenciados en I/O crítico

**Síntoma.** Estados que "no avanzan" sin explicación: la campaña no cambia, el chat no aparece en la bandeja, el QR no se muestra, la IA contesta de forma rara; el registro no da ninguna pista para diagnosticar.

**Evidencia.** `bot/src/server.js:242` (y `:264-266`, `:285`, `:293`, `:302`, `:313-315`):
```js
await sb.from('campanas').update({ fecha_programada: fecha }).eq('id', campana.id);
```
`bot/src/supabase.js:12`, `:18`, `:24`, `:30` desestructuran solo `{ data }` sin tocar `error`. `bot/src/whatsapp.js:164`:
```js
try { s.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 520, errorCorrectionLevel: 'M' }); } catch {}
```
`bot/src/whatsapp.js:467` y `:594-596` (`catch { }` que devuelven lista vacía o datos parciales). `bot/src/server.js:357`, `:364`, `:367` (`catch {}` en `manejarMensajePropio`). `bot/src/ai.js:237` (`catch {}` al resolver producto mencionado).

**Causa raíz.** Patrón sistemático: se ignora el error de Supabase y se usan `catch` vacíos para "que no rompa". El resultado es que el fallo es invisible y el estado queda inconsistente sin traza.

**Fix (S).** Un helper que convierta error en excepción con contexto y un logger central.

```js
// server.js
async function must(promesa, contexto) {
  const { data, error } = await promesa;
  if (error) throw new Error(`${contexto}: ${error.code || ''} ${error.message}`.trim());
  return data;
}
// uso:
const envios = await must(
  sb.from('envios').select('id,cliente_id,estado').eq('campana_id', id).eq('estado', 'pendiente'),
  `envios campaña ${id}`);
// catches vacíos → mínimo logFn:
try { s.qrDataUrl = await QRCode.toDataURL(qr, ...); }
catch (e) { logFn(`[${id}] No se pudo generar el QR en imagen: ${e.message}`); }
// y en el arranque:
process.on('unhandledRejection', e => log('unhandledRejection: ' + (e?.stack || e)));
process.on('uncaughtException', e => log('uncaughtException: ' + (e?.stack || e)));
```
**Aceptación.** Cualquier fallo de Supabase/WhatsApp debe aparecer en `/api/logs` con archivo y contexto; ningún `catch` del path principal queda vacío.

#### F-14 — Fugas de memoria/estado sin límite

**Síntoma.** La RAM del proceso crece con los meses; `/api/ia` y `/api/estado` se vuelven progresivamente más lentos; la lista de "pausadas" crece con clientes que derivaron una sola vez.

**Evidencia.** `bot/src/server.js:325` y `:551-555`:
```js
const cooldown = new Map();
...
cooldown.set(tel, Date.now());
```
Nunca se borra una entrada de `cooldown` (solo se consulta). `bot/src/ia.js:70-85`: `estado.pausados[tel] = {...}` sin poda; `bot/src/seguimiento.js:58-78`: `estado.chats[tel] = {...}` solo crece. `bot/src/server.js:1145` envía todo `pausados` al panel en `/api/conversaciones`.

**Causa raíz.** Mapas/objetos usados como caché sin TTL ni límite; el diseño sí acota `logs` (250), `eventos` (300), `yaRespondidos` (1.200), `enviadosPorBot` (800), `enviosRecientes` (120), pero no estos tres.

**Fix (S).**

```js
// server.js — cooldown con TTL
const cooldown = new Map();
function marcarCooldown(tel) {
  cooldown.set(tel, Date.now());
  if (cooldown.size <= 5000) return;
  for (const [k, v] of cooldown) if (Date.now() - v > 15 * 60 * 1000) cooldown.delete(k);
}
// ia.js — pausados con fecha y poda (en pausarIA o en un intervalo de 1 h)
for (const [tel, v] of Object.entries(estado.pausados)) {
  if (Date.now() - Date.parse(v.desde || 0) > 90 * 24 * 3600 * 1000) delete estado.pausados[tel];
}
// seguimiento.js — chats sin tareas pendientes y sin actividad > 1 año: borrar
```
**Aceptación.** Tras 10.000 mensajes de números distintos, `cooldown.size` ≤ 5.000 y `pausados` no crece sin control.

#### F-15 — Contador diario solo en memoria, TOCTOU y sin contar todos los orígenes

**Síntoma.** Al reiniciar el bot el límite "se resetea" y puede mandar más de 80 ese día (riesgo de bloqueo de WhatsApp); el contador del panel (`enviadosHoy`) no refleja respuestas de IA, mensajes escritos desde el panel ni pruebas; campaña y seguimiento pueden pasarse del límite por 1.

**Evidencia.** `bot/src/server.js:67-77`:
```js
let dia = { fecha: fechaLima(partesLima()), n: 0 };
function contarEnvio() {
  const hoy = fechaLima(partesLima());
  if (dia.fecha !== hoy) dia = { fecha: hoy, n: 0 };
  dia.n++;
}
function limiteAlcanzado() { ... return dia.n >= config.maxPorDia; }
```
Los únicos incrementos están en campaña (`:295`) y seguimiento (`:1321`); la IA, el panel, las pruebas y los avisos al dueño no cuentan. Ambos loops hacen `limiteAlcanzado()` y después envían (TOCTOU entre las dos corrutinas).

**Causa raíz.** Estado en RAM sin persistencia y sin un único punto de conteo; dos bombas de envío independientes.

**Fix (S/M).** Persistir el contador y centralizar el envío con chequeo.

```js
// contador.js
import fs from 'node:fs';
const archivo = new URL('./data/contador.json', import.meta.url);
let dia = { fecha: '', n: 0 };
try { dia = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch {}
export function puedeEnviar(max) {
  const hoy = new Date().toISOString().slice(0, 10);
  if (dia.fecha !== hoy) dia = { fecha: hoy, n: 0 };
  return dia.n < max;
}
export async function contar() {
  dia.n++;
  await fs.promises.writeFile(archivo, JSON.stringify(dia)); // o upsert en Supabase
}
// server.js: envolver TODOS los envíos en enviarContado(): chequea, envía, cuenta.
// y una sola bomba (F-07) elimina la carrera.
```
**Aceptación.** Después de enviar 80 en 1 día y reiniciar, el bot sigue rechazando envíos hasta el día siguiente; `enviadosHoy` coincide con la suma real.

#### F-16 — Falta de idempotencia en envío manual y filas duplicadas en `mensajes`

**Síntoma.** Doble clic o un reintento del navegador manda dos veces el mismo texto; el historial que usa la IA y las analíticas muestran filas repetidas (aunque la bandeja las deduplica localmente).

**Evidencia.** `bot/src/server.js:1168-1194` (sin clave de idempotencia):
```js
app.post('/api/conversaciones/:telefono/enviar', auth, async (req, res) => {
  ...
  const env = await enviar(tel, texto, req.body?.sesion || null);
  await logMensaje({ ... });
  registrar({ ..., waId: env?.waId || '' });
```
Y dos caminos de inserción en `mensajes`: `manejarMensaje` (`:474`) y `manejarMensajePropio` (`:367`), además de los envíos (`:198`, `:625`, etc.), sin dedupe por `waId` en la tabla.

**Causa raíz.** No hay contrato de idempotencia en escrituras (HTTP ni WhatsApp) y `logMensaje` hace `insert` ciego.

**Fix (S).**

```js
// server.js — dedupe de envíos manuales por clave
const enviadosManual = new Map();
app.post('/api/conversaciones/:telefono/enviar', auth, async (req, res) => {
  const clave = String(req.body?.idempotencyKey || `${req.params.telefono}|${req.body?.texto}`);
  const previo = enviadosManual.get(clave);
  if (previo && Date.now() - previo < 15000) return res.json({ ok: true, duplicado: true });
  enviadosManual.set(clave, Date.now());
  ...
});
// supabase.js — insertar con dedupe por wa_id (requiere índice único; sin wa_id, no-op)
await sb.from('mensajes').upsert(fila, { onConflict: 'wa_id', ignoreDuplicates: true });
// y limpiar el mapa periódicamente (mismo patrón TTL de F-14)
```
**Aceptación.** Doble clic en "Enviar": un solo mensaje en WhatsApp y una sola fila en `mensajes` (contando por `wa_id`).

---

### 4.5 P3

#### F-17 — Respuestas OK sin efecto; campaña desde un número no configurado

**Síntoma.** El botón "Revisar campañas programadas" responde "Revisado. 0 en cola" pero no hizo nada (ya había una revisión en curso). Con `SESIONES=1`, una campaña creada "desde Número 2" queda en "programada" para siempre y se reprograma cada 15 minutos sin error visible.

**Evidencia.** `bot/src/server.js:216`:
```js
if (revisando) return;
```
`bot/src/server.js:249-256`:
```js
if (campana.estado !== 'programada') return;
const emisor = campana.numero_emisor ? String(campana.numero_emisor) : null;
if (!sesionDisponible(emisor)) {
  log(`Campaña "${campana.titulo}": el número ${emisor || 'asignado'} no está conectado. Se reintentará en 15 minutos.`);
  await reprogramar(campana, 15);
  return;
}
```
`bot/src/config.js:55-59` limita SESIONES a las configuradas; `index.html:630-633` ofrece siempre "Número 1" y "Número 2".

**Causa raíz.** El guard devuelve sin señal al usuario; `/api/enviar/:id` encola campañas que `enviarCampana` descartará; no se valida `numero_emisor` contra `config.sesiones` ni se marca la campaña como fallida.

**Fix (S).**

```js
// server.js
app.post('/api/revisar', auth, async (_req, res) => {
  if (revisando) return res.status(409).json({ error: 'Revisión en curso', cola: cola.size });
  await revisarProgramadas(true);
  res.json({ ok: true, cola: cola.size });
});
// dentro de enviarCampana, antes de reprogramar:
if (emisor && !config.sesiones.includes(emisor)) {
  await sb.from('campanas').update({ estado: 'error' }).eq('id', id);
  log(`Campaña ${id}: la sesión ${emisor} no está configurada (SESIONES=${config.sesiones.join(',')}).`);
  return;
}
```
**Aceptación.** `/api/revisar` concurrente devuelve 409; campaña con emisor inexistente queda `error` y visible en el panel.

#### F-18 — Latencia artificial fija y notificación al dueño bloqueante

**Síntoma.** El cliente recibe la intro y el precio separados por más de 1,2 s (por diseño); si el aviso al dueño es lento o falla, la respuesta al cliente se retrasa aún más.

**Evidencia.** `bot/src/server.js:636`:
```js
await new Promise(r => setTimeout(r, 1200));
```
`bot/src/server.js:519-526` (comprobante: se avisa al dueño antes de confirmar al cliente):
```js
await notificarDueno(`🧾 Comprobante recibido de ${nombreChat} (+${tel}) ...`, sesionId);
const aviso = 'Recibí tu comprobante ✅ ...';
const env = await enviar(tel, aviso, sesionId);
```
**Causa raíz.** Un `sleep` fijo en el pipeline (aceptable pero no configurable) y `notificarDueno()` awaited en el camino crítico del cliente.

**Fix (S).**

```js
// avisos al dueño fuera del camino crítico del cliente
void notificarDueno(`🛒 Nuevo pedido ${p.id} de ${nombre || '+' + tel}\n...`, null)
  .catch(e => log('No se pudo avisar al dueño: ' + e.message));
// mantener el gap de 1,2 s solo si de verdad hay dos mensajes, y hacerlo configurable:
const gap = Number(process.env.GAP_DOS_MENSAJES_MS) || 1200;
if (prod && preguntaIA && !pedidoIA) await dormir(gap);
```
**Aceptación.** Con el número del dueño bloqueado o sin conexión, el cliente debe recibir su respuesta en el tiempo normal.

#### F-19 — Sin SIGTERM ni apagado ordenado; debounce sin flush

**Síntoma.** Al detener el bot desde el servicio/Docker (no Ctrl+C) quedan procesos Chrome huérfanos, la sesión de WhatsApp puede quedar bloqueada y se pierden los últimos 0,5–1,2 s de mensajes/pedidos.

**Evidencia.** `bot/src/server.js:1337-1341` (solo `SIGINT`):
```js
process.on('SIGINT', async () => {
  log('Cerrando bot…');
  try { await cerrarSesion(); } catch {}
  process.exit(0);
});
```
`Dockerfile` (raíz) arranca con `CMD ["node", "src/server.js"]` (Docker envía `SIGTERM`, no `SIGINT`). Los guards de escritura diferida (`conversaciones.js:26`, `pedidos.js:44`) se pierden al salir.

**Causa raíz.** No hay handler de `SIGTERM`, no se cancelan timers, no se hace `flush()` de los debounces ni `destroy()` de Chrome con timeout.

**Fix (S/M).**

```js
// server.js — apagado ordenado para SIGINT y SIGTERM
const timers = [/* guardar aquí los setInterval de revisarProgramadas/revisarSeguimientos */];
async function apagar(senal) {
  log(`Cerrando bot (${senal})…`);
  for (const t of timers) clearInterval(t);
  try { flushConversaciones(); flushPedidos(); flushSeguimiento(); } catch (e) { log('flush: ' + e.message); }
  try { await conTimeout(cerrarSesion(), 8000, 'cerrarSesion'); } catch (e) { log('logout: ' + e.message); }
  process.exit(0);
}
process.on('SIGINT', () => apagar('SIGINT'));
process.on('SIGTERM', () => apagar('SIGTERM'));
```
**Aceptación.** `Stop-Process`/`docker stop`: no debe quedar ningún `chrome.exe`/`chromium` hijo y los últimos mensajes deben estar en `conversaciones.json`.

#### F-20 — Higiene/seguridad colateral: token vacío, CORS `*`, JSON 12 MB, base64 en JSON

**Síntoma.** Cualquiera en la red local puede abrir `http://<pc>:3000/api/...`, ver el QR, enviar mensajes o cerrar la sesión; un body grande puede bloquear el parseo; `pagos.json` puede volverse gigante por imágenes base64.

**Evidencia.** `bot/src/server.js:19`:
```js
app.use(express.json({ limit: '12mb' }));
```
`bot/src/server.js:682-695` (sin token, `auth` deja pasar; CORS `*` con PATCH/DELETE). `bot/.env` tiene `BOT_TOKEN` vacío. `bot/src/pagos.js:45-53` valida imágenes hasta 6 MB que se guardan dentro del JSON.

**Causa raíz.** Token opcional y CORS abierto por comodidad; binarios dentro de JSON.

**Fix (S).**

```js
// auth: en producción exigir token si no estamos en localhost
function auth(req, res, next) {
  if (!config.botToken && ['127.0.0.1', '::1'].includes(req.ip)) return next();
  if (!config.botToken) return res.status(503).json({ error: 'Configura BOT_TOKEN para usar el bot fuera de localhost.' });
  ...
}
// CORS: permitir solo el origen del panel (config PANEL_URL) en vez de '*'
// imágenes de pago: guardar en data/pagos/<id>.<ext> y servir binario (F-10), no en pagos.json
```
**Aceptación.** Desde otra máquina de la LAN, `/api/estado` sin token devuelve 401/503; `pagos.json` se mantiene pequeño.

---

## 5. Plan de arreglo en 3 fases

> Orden pensado para que cada fase se pueda desplegar y verificar sola, sin reescribir la arquitectura de golpe. Los cambios de `server.js`/`whatsapp.js` de una fase no pisan los de otra si se respeta el orden.

### Fase 1 — Frenar el daño (1–2 días)

**Objetivo:** que ningún fallo produzca duplicados, cuelgues ni sesiones fantasma. Es la fase de menor riesgo y mayor retorno.

| Orden | Hallazgo | Cambios | Criterio de salida |
| --- | --- | --- | --- |
| 1 | F-01 | Claim `pendiente→enviando`, check de `{error}`, cierre garantizado de campaña, barrido de arranque, migración `envios` (`estado` + `wa_id`) | Forzando error de Supabase a mitad de campaña no se reenvía nada |
| 2 | F-02 | `conTimeout()` en `enviar`, `enviarImagen`, `listarChatsWa`, `historialWa`, `descargarMediaWa`, `resolverTelefonoWa`; watchdog de 2 min en `Cola` | Ningún job/http queda > 2 min sin fallar con error visible |
| 3 | F-03 | Lock por sesión, cancelación de timers (`retryTimer`, `vigilante`, `tickInicial`), flag `cerradaPorUsuario`, `destroy()` antes de recrear | Doble clic en reiniciar = 1 Chrome; logout no resucita |
| 4 | F-06 | `reclamar`/`marcarEnviada` antes de los logs, `reintentar` con tope, validar `puede(cliente)` | Un fallo de log no reenvía el seguimiento; baja no recibe |
| 5 | F-13 | Helper `must()` en updates/selects del flujo de campañas y sesión; `unhandledRejection` logueado | Todo error del flujo aparece en `/api/logs` |
| 6 | F-17 | `/api/revisar` devuelve 409 si está en curso; campaña con emisor inexistente → `error` | El panel ya no miente |

**Pruebas manuales de la fase:** (a) campaña con Supabase bloqueado; (b) doble "Reiniciar sesión"; (c) "Cerrar sesión" y esperar 1 min; (d) dos campañas seguidas con "Enviar ahora"; (e) cliente con `baja=true` y seguimiento pendiente.

### Fase 2 — Que el panel viva "en vivo" (3–5 días)

**Objetivo:** eliminar los bloqueos del event loop y los payloads que hacen que la UI se sienta lenta o desincronizada.

| Orden | Hallazgo | Cambios | Criterio de salida |
| --- | --- | --- | --- |
| 1 | F-04 | Escritura atómica `tmp+rename`, debounce que no descarta, `flush()`; backup/validación de JSON al cargar | Ráfaga de 200 mensajes sin picos > 200 ms; archivo siempre parseable |
| 2 | F-05 | Caché 1–2 s de `/api/estado`, count con timeout y caché 30 s, quitar QR del payload, `resumen()` cacheado | `/api/estado` p95 < 150 ms estable |
| 3 | F-10 | `/api/pagos` sin imágenes + `/api/pagos/:id/imagen`, proyección de campos en clientes, delta en mensajes | Ningún endpoint > 100 KB en el flujo normal |
| 4 | F-09 | Índice incremental de menciones + endpoint cacheado | `/api/analiticas` < 500 ms |
| 5 | F-11 | Mutex de sincronización + timeout + `registrarCabeceras()` en lote | Sync 500 chats sin bloquear envíos y sin duplicar |
| 6 | F-12 | `Promise.all` cliente+historial, caché de `configuracion_tienda`, logs en lote | Latencia previa a IA reducida ≥ 50 % |
| 7 | F-15/F-16 | Contador persistido y único punto de conteo; idempotency-key en envío manual; dedupe por `wa_id` | Reinicio no resetea el límite; doble clic = 1 mensaje |

**Pruebas manuales:** panel del bot + dashboard abiertos 1 h midiendo memoria y latencia; burst de 200 mensajes; sync con dos pestañas; abrir Analíticas mientras se envía una campaña.

### Fase 3 — Arquitectura y observabilidad (1–2 semanas)

**Objetivo:** quitar las causas estructurales y dejar el bot operable/diagnosticable.

| Orden | Hallazgo | Cambios | Criterio de salida |
| --- | --- | --- | --- |
| 1 | F-07 | Envío de campaña por pasos (sin `sleep` en el job) o carriles separados; endpoint de progreso | "Enviar ahora" durante otra campaña arranca en ≤ 2 delays |
| 2 | F-08 | Serialización por chat, deadline total de IA, cooldown al terminar, `AbortSignal` en Anthropic | Sin respuestas duplicadas/cruzadas en prueba de ráfaga |
| 3 | F-04 (L) | Migrar `conversaciones`/`pedidos`/`seguimiento` a SQLite (`node:sqlite`) o Postgres; índice por teléfono/fecha | Búsquedas e inserciones O(log n), sin snapshots |
| 4 | F-14 | TTL/LRU en `cooldown`, poda de `pausados` y `seguimiento.chats` | Memoria estable a 30 días de uso |
| 5 | F-19 | SIGTERM + flush + destroy con timeout; `Dockerfile` con `STOPSIGNAL SIGTERM` | `docker stop` limpio, sin Chrome huérfano |
| 6 | F-20 | Token obligatorio fuera de localhost, CORS restringido, imágenes fuera del JSON | API no accesible desde otra máquina sin token |
| 7 | F-18 | Avisos fire-and-forget, gap configurable | Cliente no depende del aviso al dueño |
| 8 | Transversal | `monitorEventLoopDelay`, contadores de cola/errores expuestos en `/api/estado`, logs con request-id; test de humo de concurrencia en CI | Alertas antes de que el dueño note "flujos raros" |

**Riesgos y mitigaciones:** cada fase toca `server.js` y `whatsapp.js`; trabajar con feature flags (`IDEMPOTENCIA_ENVIOS=true`, `ESTADO_CACHE=true`) y desplegar primero en modo prueba (`MODO_PRUEBA=true`) con `NUMEROS_PRUEBA=OWNER_NUMBER`. Antes de migrar persistencia (Fase 3), duplicar `bot/data` y probar la carga/escritura con los 27 chats actuales.

---

## 6. Lo que revisé y NO es el problema (no romper)

- Las guardas `revisando` (`server.js:211`, `:218`) y `revisandoSeg` (`:1301`, `:1304`) funcionan: no hay dos revisiones de campañas/seguimientos en paralelo.
- La deduplicación de la `Cola` por id (`queue.js:14`) evita reencolar el mismo trabajo mientras corre; el problema de F-01 aparece solo entre ejecuciones.
- El dedupe de mensajes entrantes (`yaRespondidos`, `server.js:432-437`) y el de `message_create` (`enviosRecientes`/`enviadosPorBot`, `whatsapp.js:19-33`) están bien resueltos para el camino feliz; no hay que reescribirlos.
- Los topes de memoria existentes (logs 250, eventos 300, `yaRespondidos` 1.200, `enviadosPorBot` 800, `enviosRecientes` 120, chats 400×500, pedidos 1.200, plantillas 20, tareas 3.000) están bien elegidos; solo faltan `cooldown`, `ia.pausados` y `seguimiento.chats`.
- **No hay `sleep` dentro de handlers HTTP**: los `dormir()` están en el job de campaña y en el bucle de seguimiento, y la espera de 1,2 s en el handler de mensaje entrante. Los endpoints solo sufren bloqueos síncronos (F-04, F-09, F-11), no latencias artificiales.
- No hay `setInterval` duplicado del lado servidor: `revisarProgramadas` y `revisarSeguimientos` tienen un periódico + uno de arranque cada uno; el duplicado de polls está en el frontend (`index.html:930` y `:1952`).
- La IA ya tiene timeout de 20 s por intento en Gemini y fallback a respaldo (`ai.js:241-244`); el faltante es el deadline global y el timeout de Anthropic.
- `esNumeroPeru`, `normalizar`, `puede()` y las validaciones de teléfono están bien y no son causa de los síntomas.

---

## 7. Checklist de verificación post-arreglo

- [ ] Simular Supabase caído a mitad de campaña: no se reenvía; los envíos afectados quedan `error`; la campaña cierra una sola vez.
- [ ] Doble clic en "Reiniciar sesión": un solo Chromium, un solo `LocalAuth`, estado estable.
- [ ] "Cerrar sesión" + esperar 60 s: no reaparece QR ni estado conectado sin escanear.
- [ ] Bloquear red durante un envío: el job falla en ≤ 2 min y la cola sigue.
- [ ] 200 mensajes en 30 s con el panel abierto: sin picos de event loop > 200 ms; `/api/estado` p95 < 150 ms.
- [ ] Campaña de 80 con "Enviar ahora" de otra: la segunda arranca en ≤ 2 delays.
- [ ] Cliente manda BAJA con seguimiento pendiente: no recibe seguimiento.
- [ ] "Analíticas" con 20.000 mensajes: < 500 ms y el bot sigue enviando.
- [ ] `docker stop`/`Stop-Process`: sin Chrome huérfano; últimos mensajes persistidos.
- [ ] 3 mensajes seguidos del mismo contacto: una sola respuesta coherente por mensaje, sin cruces.
- [ ] Panel + dashboard abiertos 1 h: memoria estable (proceso Node y Chromium).
