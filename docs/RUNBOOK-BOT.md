# Runbook del bot — Perfumería Fina Perú (1 página)

> Contabo + Coolify · Docker Compose · Supabase · Cloudflare Pages.
> Documento largo: `docs/DESPLIEGUE-COOLIFY-CONTABO.md`.

## 1 · Desplegar

1. Merge a `master` y push → Coolify hace **deploy automático** (GitHub App).
2. Ver logs del contenedor (`pf-bot`). Arranque sano:
   - `Chromium: /root/.cache/puppeteer/...` (Chrome for Testing de Puppeteer)
   - `Backup diario programado a las 03:00 (America/Lima)`
   - `WhatsApp conectado como +51…` (si la sesión persiste) o `QR generado…`
3. Si pide QR: panel → **Ajustes → Conectar WhatsApp** y escanear con el celular de la tienda.
4. Verificar: `curl -s https://bot.perfumeriafinaperu.com/api/health` → `{"ok":true,"zombi":false}`
   (siempre 200; `zombi:true` = conectado >10 min sin mensajes).
   Detalle con token: `curl -H "x-bot-token: $BOT_TOKEN" …/api/estado` → `salud` y `problemas`.

## 2 · Restaurar datos

1. Ver respaldos: `node --env-file=bot/.env scripts/restore-bot.mjs --list`
2. Restaurar (pide confirmación; `--si` para automatizar):
   `node --env-file=bot/.env scripts/restore-bot.mjs --from YYYY-MM-DD`
   - Valida JSON, guarda lo actual en `bot/data/.pre-restore-*` y escribe atómico.
   - `data/*.json` y `comprobantes/` salen de la carpeta elegida; `archivos/`
     (PDF, video, foto) se reconstruye con la **versión más reciente entre todas
     las carpetas**, para no perder una subida nueva hecha después del día elegido.
3. Reiniciar el bot (Coolify → Restart/Redeploy del servicio `bot`).
4. **La sesión de WhatsApp NO se respalda** (`.wwebjs_auth`, volumen `bot-auth-v3`).
   Si el bot pide QR tras restaurar/reinstalar: escanear de nuevo. Por eso el volumen
   `bot-auth-v3` no se debe borrar ni renombrar.
5. Respaldo manual: `node --env-file=bot/.env scripts/backup-bot.mjs` (el job diario del
   bot lo hace solo a las 03:00; bucket privado `bot-backups`, retención 14 días).

## 3 · Qué mirar en los logs

| Patrón en el log | Qué significa | Acción |
|---|---|---|
| `WhatsApp conectado como +51…` | Sesión OK | Nada |
| `Reintentando conexión en 15 s… 5 min (intento N)` | Caída de red; backoff infinito | Esperar; si dura horas, revisar red/VPS |
| `LOGOUT… / Fallo de autenticación` | Sesión desvinculada/corrupta | Se borró la sesión local y hay **un** QR nuevo: escanear |
| `QR generado` | Esperando vínculo | Escanear desde el panel |
| `Sesión de WhatsApp cerrada` | Logout manual o apagado ordenado | Nada |
| `El Chrome anterior no cerró a tiempo` | Chrome viejo forzado a morir | Nada (autocuración) |
| `Backup YYYY-MM-DD: N archivos subidos` | Respaldo diario OK | Nada |
| `El bucket "bot-backups" no existe` | Falta el bucket privado en Supabase Storage | Crearlo (privado); el bot sigue vivo |
| `no se pudo guardar (escritura atómica falló)` | Disco lleno/permisos en `bot/data` | Revisar disco del volumen `bot-data-v2` |
| `zombi:true` en `/api/health` o `sesion_zombi` en `problemas` del panel | Socket muerto sin `disconnected` | Reiniciar sesión en Ajustes (no se reinicia solo) |

## 4 · Emergencias rápidas

- **Bot no responde, pero health OK**: revisar `zombi` y `problemas` en `/api/estado`; reiniciar
  sesión: panel → Ajustes → Conectar WhatsApp → Reiniciar (o `POST /api/sesion/reiniciar` con token).
- **Desvincular/volver a vincular**: `POST /api/logout` (o el botón del panel) → borra y genera QR.
- **Revertir una restauración**: copiar de `bot/data/.pre-restore-<fecha>/` y reiniciar.
- **Cambiar Chrome del contenedor**: NO tocar; la migración a chromium de apt está pendiente
  (`docs/PENDIENTES.md`) y puede invalidar la sesión de `bot-auth-v3`.

## 5 · Validación anti-bloqueo de contactos (2026-11-12)

`POST /api/validar-contactos` (con token) corre como trabajo de prioridad **baja**
en la cola: cede ante mensajes de clientes. Requiere `sql/13_wa_estado_clientes.sql`
(o `sql/EJECUTAR_ESTO.sql`). Variables (todas opcionales):

| Variable | Por defecto | Qué hace |
|---|---|---|
| `VALIDACION_POR_DIA` | `0` | `0` = **sin tope diario**; >0 recorta el día |
| `VALIDACION_MIN_MS` / `VALIDACION_MAX_MS` | `4000` / `10000` | Ritmo entre números (4-10 s, ~7 s). **No bajarlo** |
| `VALIDACION_HORA_INICIO` / `VALIDACION_HORA_FIN` | `9` / `22` | Ventana de Lima; fuera no consulta y retoma al abrir |
| `VALIDACION_LOTE_MIN` / `VALIDACION_LOTE_MAX` | `80` / `120` | Pausa larga cada N números consultados |
| `VALIDACION_PAUSA_LARGA_MIN_MS` / `MAX_MS` | `180000` / `360000` | Duración de la pausa larga (3-6 min) |
| `VALIDACION_ERRORES_PAUSA` / `VALIDACION_PAUSA_MS` | `3` / `900000` | Pausa automática tras 3 errores de infra (15 min) |
| `VALIDACION_UMBRAL_ENTRE_FALLOS_MS` | `600000` | 2 fallos limpios separados ≥10 min confirman "sin WhatsApp" |

Un timeout o una sesión caída **nunca** marca un número: solo 2 respuestas
limpias `no existe` en momentos distintos.

## 6 · IA: ejemplos curados (2026-11-12)

1. `node scripts/extraer-ejemplos.mjs` (lee `bot/data/conversaciones.json` y pedidos;
   `--supabase` añade la tabla `mensajes`). Anonimiza teléfonos, nombres,
   direcciones, correos y links y escribe `bot/data/ejemplos-ia.json`.
2. Revisa el JSON y marca `"aprobado": true` en los ejemplos que quieras usar.
3. Actívalo en el panel: **Ajustes → Asistente IA → Usar ejemplos curados**
   (ajuste `ejemplosIAActivos`, **apagado por defecto**).
4. Los ejemplos que mencionan precios, stock o promociones se descartan; precios
   y promos salen siempre del catálogo y de Ajustes.
5. Si el LLM falla por completo: el cliente recibe un mensaje de respaldo (nunca
   queda en visto) y el dueño recibe un aviso por WhatsApp (máx. 1 cada 30 min
   por chat). Orden de proveedores: Gemini → Groq → Anthropic.
6. Evaluación de 30 casos: `node --env-file=bot/.env scripts/probar-chat.mjs --local --reporte docs/EVALUACION-IA.md`.

## 7 · Cambios operativos 2026-11-12 (final/todo-en-uno)

- **Backups**: la retención lista objetos y borra **por ruta**; antes de borrar
  una carpeta antigua conserva la última copia de `archivos/` resubiéndola al
  backup del día. El restore reconstruye `archivos/` con la versión más reciente
  entre todas las carpetas.
- **409**: `/api/revisar` y `/api/sincronizar` responden 409 si ya hay una
  operación en curso (antes 200). Una campaña con emisor no configurado pasa a
  `estado='error'` visible (requiere `sql/11`; ver `sql/EJECUTAR_ESTO.sql`).
- **Envío manual**: acepta `idempotencyKey` (TTL 15 s) para no duplicar envíos.
- **Contador diario** persistido en `bot/data/contador.json` (sobrevive reinicios).
- **Podas**: IA pausada >90 días y chats de seguimiento >180 días se limpian solos.
- **Panel**: filtros de Bandeja (no leídos, sin responder, con pedido, etiqueta,
  fechas) y de Pedidos (estado, entrega, fechas), con búsqueda persistente.

## 8 · Chats duplicados (WhatsApp LID) y multimedia (2026-11-12)

### Chats duplicados (mismo cliente con nombre y con número)

- Causa: WhatsApp migró a **LID**; el mismo contacto puede quedar bajo dos claves
  (teléfono `51...@c.us` y un `@lid` opaco). El bot ya **no** crea nuevos duplicados:
  un LID nunca se guarda como teléfono y los ecos/mensajes propios sin número
  resuelto se ignoran.
- Al arrancar, el bot fusiona automáticamente duplicados de **confianza alta**
  (mismo `chat.waId` o ≥2 mensajes con el mismo `waId`) y lo deja en el log
  (`Conversaciones: duplicado fusionado …`).
- Para los históricos o de confianza media:
  1. Copia `bot/data/conversaciones.json` del volumen `bot-data-v2` (o ejecuta el
     script dentro del contenedor).
  2. `node scripts/dedupe-conversaciones.mjs` → informe **dry-run** (no escribe).
  3. `node scripts/dedupe-conversaciones.mjs --aplicar` → guarda backup
     `.bak-pre-dedupe-<fecha>` y fusiona.
  4. Coolify → Restart/Redeploy del bot.
- El script prefiere conservar la clave del teléfono y el nombre real del contacto.

### Multimedia de los chats (ver imágenes/videos en la Bandeja)

- Al recibir multimedia se guardan solo **metadatos + miniatura** en el mensaje
  (no se descarga el archivo). En el hilo aparece la miniatura y un botón.
- Al pulsar, el bot descarga el original desde WhatsApp **bajo demanda**, lo guarda
  en `bot/data/chats/` (volumen `bot-data-v2`) y lo sirve por ruta autenticada
  (`/api/media/chats/...`; nunca público). Video/audio/documento se abren igual.
- Mensajes viejos con `[imagen]`/`[video]`: el panel muestra un botón de carga;
  funciona solo si WhatsApp aún conserva el archivo (si expiró, avisa “No disponible”).
- Limpieza diaria: `MEDIA_CHATS_MAX_MB` (por defecto `1500`) y `MEDIA_CHATS_DIAS`
  (por defecto `90`). `bot/data/chats/` **no se incluye** en el backup diario.
- Ajustes por variable de entorno (opcionales): `MEDIA_CHATS_MAX_MB`, `MEDIA_CHATS_DIAS`.

## 9 · Velocidad de sincronización y chats LID sin número (2026-11-12)

- La sincronización guarda la hora de la última pasada OK en `bot/data/sync-ultimo.json`:
  tras un reinicio o deploy hace una pasada **incremental** (chats con actividad nueva) en
  vez de releer todos los chats. La pasada completa solo ocurre la primera vez o con
  `POST /api/sincronizar {"chats":true,"completo":true}`.
- Tras sincronizar chats nuevos se actualizan **solo esos** historiales (no 250) y con tope
  de tiempo. Variables opcionales: `HISTORIALES_MAX_CHATS` (60), `HISTORIALES_LIMITE` (80),
  `HISTORIALES_MAX_MS` (180000).
- Los `@lid` se resuelven a teléfono **en lote** (una sola lectura de Chrome). Si WhatsApp no
  permite resolverlo, el bot atiende igual con una clave temporal del LID (no deja al cliente
  en visto); si más adelante se resuelve el teléfono, el chat se fusiona por su `waId`.
- La bienvenida ahora es atómica: si el texto no sale, NO se envían PDF/video/foto sueltos y
  no se programa la pregunta de asesoría. Si el texto falla con vista previa de enlace, se
  reintenta sin ella.
- El catálogo (PDF+video) no se reenvía si ya se envió en los últimos 180 minutos: si el
  cliente insiste, recibe solo texto.

### Rendimiento del sync (2026-11-12, ajuste final)

- El listado completo ya NO usa `getChats()` como primera vía: lee la colección de
  chats en **una sola evaluación de página** (lectura ligera) y solo cae al wrapper
  si esa lectura no devuelve nada.
- Topes: scroll de la lista 15 s, lectura ligera 40 s, resolución de LID a teléfono
  6 s/20 chats por pasada, listado completo 110 s como máximo. En cuentas normales
  el sync completo queda en **decenas de segundos** y el incremental en **segundos**.
- Tras sincronizar se cachea `teléfono → waId` (`destinosDirectos`), igual que los
  mensajes entrantes: la respuesta al cliente **no llama `getNumberId`**, así no se
  bloquea si justo hay un sync en curso.
- La Bandeja se refresca sola al terminar (evento SSE `sync`); el aviso del panel
  ahora dice “suele tardar menos de 2 minutos”.
- Variables: `HISTORIALES_MAX_CHATS` (60), `HISTORIALES_LIMITE` (80),
  `HISTORIALES_MAX_MS` (180000); `SYNC_MIN_MS`/`SYNC_MAX_MS` para la sync periódica.

## 10 · Horario 24/7 y multimedia automática (2026-11-12)

- **Horario**: por defecto el bot atiende **24/7** (`horaInicio=0`, `horaFin=24`) porque el
  dueño suele dejar el negocio siempre activo. El panel es la fuente de verdad; las variables
  `HORA_INICIO`/`HORA_FIN` del `.env` quedaron como legado (no pisan el 24/7). Si un
  `data/ajustes.json` viejo tenía exactamente 9-20 se migra una sola vez a 0-24
  (marca `horarioSiempre:true`); un horario elegido a mano se respeta.
- **Multimedia**: ya no hay botón "Ver imagen/video". Al abrir un chat, cada multimedia
  visible se descarga y se muestra sola (imagen, sticker, video con controles, audio y
  documentos) con un máximo de 2 descargas simultáneas. Las miniaturas aparecen al instante
  y el archivo completo se reemplaza al llegar. Si el archivo expiró en WhatsApp se muestra
  “No disponible (archivo expirado)” y un clic reintenta la descarga.

## 11 · Fotos de producto (Web del dueño → bot) 2026-11-13

- Las fotos que envía el bot están **empaquetadas** en `bot/media/products/<id>.jpg`.
  Se generaron desde la web local del dueño (`assets/js/data.js` → `assets/img/products`),
  que es la fuente correcta; **no se depende de Supabase `imagen_ruta` ni de la URL en vivo**.
- Resolución en el bot: primero `bot/media/products/<id>.jpg|jpeg|png|webp` por id
  (`bot/src/productos-media.js`); si no existe, se usa `imagen_ruta`/URL como antes.
- Regenerar cuando el dueño actualice fotos en la web:
  `python scripts/importar-imagenes-web.py --web "C:/ruta/a/perfumeria-fina-peru"`
  (convierte `.webp/.png` a JPEG, verifica las 202 imágenes y deja `manifest.json`).
- Dudas de fotos: el script avisa si falta alguna o si dos productos comparten la misma
  imagen. Todas las fotos deben revisarse visualmente contra el catálogo antes de campañas.
