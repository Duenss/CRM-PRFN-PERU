# Bot de WhatsApp — Perfumería Fina Perú

Bot con escaneo de QR, uno o dos números, cola de envíos con retraso y auto-respuesta con IA.

## Requisitos

- Node.js 22 o superior.
- Un Chromium para el bot. **No necesitas instalar Chrome**: basta con
  `npx puppeteer browsers install chrome` (instala el Chrome de pruebas de Puppeteer
  en `%USERPROFILE%\.cache\puppeteer`). Deja `CHROME_PATH=` vacío en `.env`.
  Tu navegador personal (Brave, Edge, etc.) no se usa ni se toca.
- El bot corre **sin ventana de Chrome** (`HEADLESS=true` en `.env`): el QR se escanea
  desde el panel del CRM (Ajustes → Conectar WhatsApp), no en una ventana aparte.
  `HEADLESS=false` queda solo para depurar un problema de vinculación.
- Una cuenta de Supabase con las tablas del proyecto.
- Una clave de Gemini o Anthropic (opcional; sin IA responde mensajes básicos).

## Instalación en Windows

```powershell
cd bot
copy .env.example .env
notepad .env
npm install
npm start
```

Abre <http://localhost:3000/panel>.

### Variables mínimas

```env
SUPABASE_URL=https://pcesvmsewfpvmqmfmswn.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # Project Settings > API > service_role
OWNER_NUMBER=51910418951
GEMINI_API_KEY=...
SESIONES=1,2
MODO_PRUEBA=true
```

`SUPABASE_SERVICE_ROLE_KEY` es secreta: solo vive en `.env`, nunca en el panel.

## Primer arranque

1. Abre el panel del bot.
2. Verás una tarjeta por cada número (`Número 1` y `Número 2`).
3. Escanea el QR de la primera con el WhatsApp de ese número:
   WhatsApp → Dispositivos vinculados → Vincular dispositivo.
4. Repite con la segunda.
5. El QR cambia cada ~20 segundos; si expira, el panel lo actualiza solo.

La sesión queda guardada en `bot/.wwebjs_auth/sesion-1` y `sesion-2`.
No borres esa carpeta: si la borras, tendrás que escanear otra vez.

## Modo prueba

Empieza con:

```env
MODO_PRUEBA=true
NUMEROS_PRUEBA=51910418951
```

En este modo no se envía nada real: todo se escribe en el registro.
Cuando ya probaste, cambia a `MODO_PRUEBA=false` y reinicia.

## Cómo se envían las campañas

1. En el CRM, crea la campaña.
2. Elige **Enviar desde** (Número 1 o Número 2).
3. Elige fecha y pulsa **Programar con el bot**.
4. El bot revisa cada minuto si hay campañas vencidas y las envía.
5. Cada cliente sale con un retraso aleatorio de 25 a 40 segundos.
6. Solo se envía a clientes con consentimiento, activos y sin baja.
7. Si el bot está fuera de horario o llega al límite diario, reprograma solo.

Límites por defecto:

| Variable | Valor |
| --- | --- |
| `DELAY_MIN` / `DELAY_MAX` | 25 / 40 segundos |
| `MAX_POR_DIA` | 80 mensajes |
| `HORA_INICIO` / `HORA_FIN` | 9:00 / 20:00 (Lima) |
| `LUNES_A_SABADO` | true |

## Estado de un envío (claim atómico) y migración 07

Cada fila de `envios` de una campaña pasa por este ciclo:

```
pendiente → enviando → enviado
                    ↘ error / omitido
```

Antes de mandar el WhatsApp, el bot **reclama** la fila con un update atómico
`pendiente → enviando` (filtrado por `id` y `estado`). Si el update falla (red,
RLS, constraint), **no se envía nada** y la campaña queda programada: se prefiere
un envío perdido visible a un mensaje duplicado. Al terminar el bucle la campaña
se cierra **siempre** (`finally`): si ya no quedan pendientes pasa a `enviada`.
Al arrancar, los envíos que quedaron en `enviando` hace más de 10 minutos pasan a
`error` con nota `proceso interrumpido`.

Esto requiere la migración [`sql/07_envios_claim.sql`](../sql/07_envios_claim.sql)
(idempotente): añade `envios.wa_id`, `envios.nota`, permite el estado `enviando`
y crea el índice `(campana_id, estado)`. **Sin esa migración las campañas no se
envían** (fail-safe) y el log muestra `❌ Falta aplicar sql/07_envios_claim.sql`.

## API del bot (novedades)

- `GET /api/stream?token=…` — **SSE** en vivo para el panel (`Content-Type:
  text/event-stream`, `retry: 3000`, ping `: ping` cada 15 s). Cada evento llega
  como `id: <n>\ndata: <json>\n\n` con `{id, tipo, en, …}`. Tipos emitidos:
  - `mensaje` — `{telefono, nombre, nombreWa, mensaje:{…}, noLeidos, ultimoTexto, ultimoEn}`
  - `ack` — mismo payload, con el mensaje actualizado y su `ack`
  - `leido` — `{telefono, nombre, nombreWa, mensaje:null, noLeidos:0, ultimoTexto, ultimoEn}`
  - `campana` — `{campanaId, estado, enviados, total, errores}` (+ `pendientes`,
    `pausada`, `motivo` cuando se pausa)
  - `ia` — `{accion:'config'|'pausar'|'reanudar', activa, autoRespuesta,
    pausadas}` (+ `telefono`, `pausado`, `motivo` al pausar/reanudar)
  - `pedido` — `{telefono, nombre, pedidoId, estado, total, metodo, detalle}`
  - `derivacion` / `comprobante` / `seguimiento` — se emiten como antes.
  `GET /api/eventos?desde=<id>` sigue existiendo como respaldo por polling.
- `GET /api/estado` — cacheado 2 s, sin el campo `qr` en `sesiones` y con
  `programadas` actualizado en segundo plano cada 30 s. El QR se pide a
  `GET /api/qr?sesion=1` (binario PNG).
- Timeouts: los envíos, lecturas de historial/chats/contactos y la sincronización
  tienen techo de tiempo (`conTimeout`); la cola tiene watchdog de 2 minutos, así
  que un cuelgue de WhatsApp no deja el bot "enviando…" para siempre.
- Apagado ordenado con `SIGINT` y `SIGTERM`: cierra SSE, hace `flush()` de
  conversaciones y cierra la sesión de WhatsApp con timeout.

Pruebas del backend (sin dependencias nuevas):

```powershell
node --test --test-isolation=none bot/test/politicas.test.mjs bot/test/eventos.test.mjs bot/test/campanas.test.mjs
```

## Auto-respuesta con IA

- Responde solo dentro del horario y con un enfriamiento de 90 s por contacto.
- Nunca inventa precios, stock, promociones ni pedidos.
- Si el cliente pide un humano, tiene un reclamo o pregunta por su pedido, deriva al dueño.
- **Pagos digitales (Yape/Plin/transferencia): la IA nunca confirma el pago.** El pedido queda en `esperando_pago` (o `comprobante_recibido`), se avisa al dueño y además **se pausa la IA de ese chat** hasta que el dueño verifique y la reanude desde el panel. Solo el efectivo cierra la venta (`por_entregar`, se cobra al entregar).
- Si el cliente escribe **BAJA**, lo marca en Supabase y no le vuelve a escribir.
- Los mensajes entrantes y salientes se guardan en la tabla `mensajes`.
- Si no hay clave de IA, usa respuestas básicas para saludo, precios, envíos y pagos.

Variables:

```env
AUTO_RESPUESTA=true
RESPONDER_DESCONOCIDOS=true
```

## Dos números

`SESIONES=1,2` crea dos sesiones independientes. Cada una tiene su QR, su sesión
guardada y su número. En el CRM eliges desde cuál sale cada campaña.
Las respuestas automáticas salen siempre por el mismo número que recibió el mensaje.

Si solo quieres un número, usa `SESIONES=1`.

## Panel del bot

`http://localhost:3000/panel` muestra:

- Estado y número de cada sesión.
- QR cuando hace falta.
- Cola de envíos y campañas programadas.
- Mensaje de prueba.
- Registro de actividad.

Si configuras `BOT_TOKEN`, el panel lo pedirá y el CRM lo enviará en la cabecera
`x-bot-token`. Sin token, cualquiera que abra el puerto podría ver el QR. No expongas
el puerto a Internet sin token o sin una VPN.

## Despliegue

### Opción A: PC de la tienda (más simple)

Deja la PC encendida y el bot corriendo. Si se apaga, no se envían campañas
ni se responden mensajes hasta que vuelva a iniciar.

### Opción B: Docker / VPS

```bash
docker build -t perfumeria-bot ./bot
docker run -d --name perfumeria-bot --restart unless-stopped \
  -p 3000:3000 --env-file bot/.env \
  -v perfumeria_data:/data \
  perfumeria-bot
```

En el `.env` del servidor usa:

```env
SESSION_PATH=/data/wwebjs_auth
```

El volumen `/data` conserva la sesión entre reinicios.

### Opción C: Railway / Render

- Sube `bot/` como servicio Docker.
- Agrega un disco persistente montado en `/data`.
- Configura las variables de entorno.
- Usa `SESSION_PATH=/data/wwebjs_auth`.

### Cloudflare Pages

No puede ejecutar el bot: no corre Chromium ni procesos persistentes.
Cloudflare Pages solo sirve el panel (`index.html`) y la función de IA.

## Problemas comunes

| Problema | Solución |
| --- | --- |
| `Could not find Chrome` | Corre `npx puppeteer browsers install chrome` o define `CHROME_PATH` con la ruta a `chrome.exe` |
| El QR no aparece | Revisa los logs; puede faltar Chromium o el puerto estar ocupado |
| Se vinculó pero sigue en "QR" | Ya está cubierto por el vigilante de `src/whatsapp.js`; si igual pasa, reinicia el bot (la sesión queda guardada) |
| "No se pudo vincular el dispositivo" | Usa Chrome (no Edge) y libera un cupo en WhatsApp → Dispositivos vinculados (máx. 4) |
| Se desconectó solo | Reinicia el bot; si sigue, cierra sesión desde el panel y escanea otra vez |
| No envía campañas | Verifica que esté `programada`, dentro del horario, con sesión conectada y sin límite diario |
| `Número no tiene WhatsApp` | El teléfono está mal o el cliente no usa WhatsApp |
| La IA no responde | Falta `GEMINI_API_KEY`; revisa los logs |

## Riesgo

Este bot usa `whatsapp-web.js`, una librería no oficial. WhatsApp puede bloquear
el número por automatización. El cliente asumió el riesgo. Para reducirlo:

- Usa primero un número secundario.
- Mantén el retraso de 25-40 s y el límite diario.
- No envíes a quien no dio consentimiento.
- Atiende las bajas de inmediato.
- No uses el bot para grupos ni mensajes masivos fríos.

La alternativa oficial es la WhatsApp Cloud API de Meta (requiere verificación,
plantillas aprobadas y costo por mensaje).