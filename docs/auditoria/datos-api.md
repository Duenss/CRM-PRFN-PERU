# Auditoría de datos y API — CRM Perfumería Fina

**Fecha:** 2026-11-08 · **Alcance:** `functions/api/borradores.js`, `sql/*.sql` (00, 01a–01d, 01, 02, 03, 04, 05, 06), `docs/TRASPASO.md`, `docs/DISENO_PANEL.md`, `.dev.vars.example`, `.gitignore`, `scripts/build-productos-sql.mjs`. Se leyó `index.html` y `bot/src/*.js` **solo para verificar el contrato** (endpoints, tablas, columnas), no se auditaron como código de negocio.

**Método:** auditoría estática de solo lectura; `grep`/`read` de cada consulta del panel y del bot contra las declaraciones SQL; `git ls-files`, `git status` y `git diff` para verificar versionado. **No se ejecutó SQL contra Supabase ni se levantaron servidores.**

**Limitación estructural (condiciona toda la auditoría):** el repositorio **no contiene el DDL de las 6 tablas base** (`clientes`, `productos`, `campanas`, `plantillas`, `envios`, `configuracion_tienda`) en ninguno de sus 10 archivos SQL. Por eso las columnas de esas tablas se reconstruyeron a partir de los `INSERT`/`ALTER` de 01–03 y de las consultas del panel/bot; los tipos reales (`uuid` vs `bigint`, `text[]` vs `jsonb`, `date` vs `timestamptz`) **no se pueden verificar sin acceso a la base o a un `pg_dump`**. Esto es en sí mismo el hallazgo H-01.

---

## 1. Resumen ejecutivo

1. **La falta de “vivo” no es caché.** La Bandeja, los KPIs y el avance de campañas **no se leen de Supabase**: el panel los pide al bot (`/api/conversaciones`, `/api/estadisticas`) y el bot los guarda en memoria/JSON (`bot/data/conversaciones.json`), no en la tabla `mensajes`. Además, ninguna tabla está en la publicación `supabase_realtime` y el panel no tiene ningún `sb.channel(...)`: **Realtime no podría funcionar ni con suscripción**. El polling (12 s, 15 s, 20 s, 8 s, 6 s, 2,5 s) es la única vía. → H-02, H-13.
2. **El esquema real del CRM no está versionado.** Ninguno de los 10 archivos SQL crea `clientes`, `productos`, `campanas`, `plantillas`, `envios` ni `configuracion_tienda`; `00_instalar_todo.sql` falla en la línea 13 en un proyecto limpio y `02`/`03` asumen esas tablas ya creadas a mano. Solo son verificables `mensajes`, `testimonios`/`testimonios_contacto` y la lista de columnas de `productos` (por los `INSERT` de 01a–01d). No hay FKs declaradas, ni defaults verificables, ni tipos conocidos. → H-01.
3. **RLS demasiado abierta y migración peligrosa.** Las 7 políticas del panel son `for all to authenticated using (true) with check (true)`: cualquier cuenta autenticada lee/escribe datos personales y mensajes. Y como `03` mezcla en un mismo `BEGIN` el `enable row level security` con `set not null` y un `CHECK` que valida datos existentes, **si un solo cliente tiene teléfono nulo o no peruano, la transacción revierte y deja RLS desactivado** (el peor estado). → H-03, H-07.
4. **Hay dos backends de IA que ya divergieron.** La Pages Function autentica con JWT de Supabase (Bearer), no tiene CORS/OPTIONS y limita en memoria por isolate; el bot autentica con `x-bot-token`. El panel usa el bot; la función quedó como código muerto que además no reintenta modelos si la respuesta viene vacía. → H-10, H-11.
5. **Parches 04/05/06 contradictorios y fuera de git.** La “reversión” documentada de 06 (ejecutar 05) **no elimina `web_inserta_auto`**, así que la web sigue pudiendo publicar `aprobado = true` sin moderación; `05` introduce una columna `correo` que compite con la tabla `testimonios_contacto` de `04`; y `04`/`05`/`06` están *untracked* (sin commit). A eso se suma el límite de 1000 filas de PostgREST, que hoy trunca `clientes`/`envios` sin error y hace que el bot marque “omitido” a clientes que sí existen. → H-05, H-06, H-15, H-16.

**No se encontró `service_role` en archivos versionados** (`git ls-files` + grep): solo aparece en documentación y en `bot/.env.example` vacío. El riesgo real con esa clave es indirecto: la API del bot la usa como proxy y **por defecto no exige token** (H-04).

---

## 2. Mapa de fuentes de verdad (lo que el panel realmente lee)

| UI / función | Fuente real | Tabla Supabase | Evidencia |
| --- | --- | --- | --- |
| Clientes, Catálogo, Campañas, Plantillas | Supabase directo con `sb.from(...)` | `clientes`, `productos`, `campanas`, `plantillas` | `index.html:903-906` |
| Catálogo / fichas | Supabase `productos` (filtro `activo` en JS) | `productos` | `index.html:914,1064-1066` |
| Bandeja, hilos, no leídos, pausas IA | **Bot en memoria/JSON** (`/api/conversaciones`) | `mensajes` **no se lee** | `index.html:1484,1506,1522`; `bot/src/conversaciones.js:5-12` |
| KPIs, gráfico de mensajes, enviados hoy | **Contadores en memoria del bot** | — | `bot/src/server.js:1017-1032`; `index.html:1217-1219` |
| Avance de campaña (enviados/pendientes) | Supabase `envios` | `envios` | `index.html:1145,1189` |
| Estado de campaña que envía el bot | Supabase `campanas` (solo lo ve el dueño al recargar) | `campanas` | `bot/src/server.js:246-318` |
| Testimonios web | Fuera de este repo (sitio público, clave anón) | `testimonios` / `testimonios_contacto` | `sql/04`, `sql/05`, `sql/06` |
| Borradores IA | **Bot** `/api/borradores` (no la Pages Function) | `productos`, `configuracion_tienda` (lectura) | `index.html:1095`; `bot/src/server.js:798-813`; `docs/TRASPASO.md:56-59` |

Consecuencia: hay **dos verdades para los mensajes** (JSON del bot vs tabla `mensajes`) y **tres relojes** para el estado de campaña (memoria del bot, Supabase, panel). Eso explica “flujos raros”: el dueño ve en pantalla un estado que ya cambió en la base o al revés.

---

## 3. Hallazgos priorizados (P0–P3)

| ID | Sev | Título | Evidencia (archivo:línea) | Síntoma | Causa raíz | Fix | Esf. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H-01 | **P0** | Esquema base sin DDL: el CRM no se puede reconstruir ni auditar | `sql/00_instalar_todo.sql:13,15`; `sql/02_datos_y_esquema.sql:9,52,63`; `sql/03_seguridad_rls.sql:13-19`; grep sin `create table` para esas 6 tablas; `docs/TRASPASO.md:186` | En proyecto limpio `00` falla en la línea 13 y `02` en la 9; en prod no se pueden verificar tipos/FKs/defaults → errores intermitentes 42703/`PGRST204`; `envios` huérfanos o duplicados sin constraint | El esquema se creó a mano en el dashboard y nunca se versionó; 01–06 solo insertan/alteran | `pg_dump --schema-only` → `sql/00_esquema_base.sql`; incluir en 00; `sql/99_verificar_contrato.sql` | M |
| H-02 | **P0** | Bandeja/KPIs viven en la memoria del bot; `mensajes` no se lee y no hay Realtime | `index.html:1484,1217-1219`; `bot/src/server.js:1017-1032`; `bot/src/conversaciones.js:5-12,8-9`; `bot/src/supabase.js:34-45`; sin `postgres_changes` ni `alter publication` en `sql/` | “No se siente en vivo”; si se reinicia el bot desaparecen KPIs y la Bandeja; mensajes duplicados o invisibles; el panel depende de que el bot esté encendido hasta para leer | Doble fuente de verdad (JSON vs `mensajes`) y polling porque Supabase no publica cambios | Unificar en `mensajes` + vista `conversaciones`; publicar tablas; suscribir panel; mientras tanto, un solo poll de 5–10 s | L |
| H-03 | **P1** | RLS `for all to authenticated using (true)`: cualquier cuenta tiene acceso total | `sql/03_seguridad_rls.sql:36-49`; `:72-74`; `index.html:777-779` | Si el registro público queda abierto o se crea una cuenta, se leen/escriben clientes, mensajes, configuración y campañas sin rol de dueño | Política por rol `authenticated`, no por usuario (`auth.uid()`/allowlist) | Policy con `app_admins` o claim de email; desactivar signups; auditar `auth.users` | S |
| H-04 | **P1** | API del bot sin token por defecto + CORS `*` (proxy de `service_role`) | `bot/src/server.js:682-687,689-695`; `bot/.env.example:19`; `bot/README.md:117-119,128-151`; `index.html:1328-1333` | Quien alcance el puerto puede leer chats/clientes, enviar WhatsApp (`/api/conversaciones/:tel/enviar`) y ver el QR; en Railway/Render el puerto queda público | `BOT_TOKEN` opcional pensado para localhost, pero el panel en Pages necesita URL pública | `BOT_TOKEN` obligatorio (503 si falta), allowlist de CORS, HTTPS/túnel, rate limit | S |
| H-05 | **P1** | `05` no revierte `06`: `web_inserta_auto` sobrevive y permite autopublicar | `sql/06_testimonios_auto_publicar.sql:7,14-21`; `sql/05_arreglar_rls_testimonios.sql:31-41` | Tras volver al modo revisión, anónimo sigue insertando `aprobado = true` (spam/inyección publicada e indexable) | Reversión incompleta: no dropea la política permisiva; políticas permisivas se combinan con OR | `drop policy if exists "web_inserta_auto"` en 05 (o nuevo 07) + test con `set role anon` | S |
| H-06 | **P1** | Límite 1000 filas de PostgREST trunca `clientes`/`envios` sin aviso | `bot/src/supabase.js:22-26`; `index.html:903,1145`; `bot/src/server.js:270-287,1086` | Con >1000 clientes: campañas alcanzan solo a 1000 y el resto pasa a “omitido”; el panel muestra menos clientes; % de campaña incompleto | Sin paginación (`.range()`) y Supabase corta en 1000 filas por defecto | Helper `allRows()` con `.range(from,from+999)` en panel y bot; test de 1.200 filas | M |
| H-07 | **P1** | Migraciones 03–06 no atómicas y `03` destructivo: fallo parcial deja RLS apagado o a medias | `sql/03_seguridad_rls.sql:11,13-19,22-33,52,56-59,70`; `sql/04` (sin `begin/commit`); `sql/05` (sin `begin/commit`); `sql/06` (sin `begin/commit`) | Ante un teléfono nulo/no peruano o un error de permisos, el `BEGIN` revierte: RLS desactivado y tablas abiertas con la clave publishable; en 04/05/06 queda medio aplicado (lecturas `[]` sin error) | Scripts idempotentes pero no atómicos; `03` borra todas las políticas y recién después crea las nuevas | Preflight de datos; `begin/commit` en 04–06; separar RLS de constraints (`NOT VALID` + `validate`); no usar el loop genérico de `drop policy` en prod | S |
| H-08 | **P1** | Errores de RLS/sesión silenciados: listas vacías sin aviso y respaldo que oculta el fallo | `index.html:907-908,909-913,1489` | Catálogo/Campañas/Clientes vacíos con la app “funcionando”; el dueño cree que perdió datos; el fallback al bot oculta que RLS está mal | Solo `productos` propaga error; `clientes`/`plantillas`/`campanas` hacen `console.warn` y el panel pinta el estado vacío | Propagar los 4 errores, banner “sin permiso/sin sesión” y quitar el fallback silencioso (o marcarlo visible) | S |
| H-09 | **P2** | Índices faltantes para `where`/`order` reales | Consultas: `index.html:1145,1189`; `bot/src/server.js:220-226,264,313,754`; `index.html:906`; `sql/` sin índices para `envios`, `creado_en`, `nombre`, `activo` | Escaneos secuenciales al crecer `envios` (clientes×campañas); panel más lento y campañas que “tardan” | Índices solo para `mensajes`, `campanas.fecha_programada`, `clientes.telefono/cumpleaños`, `productos.codigo` | Ver SQL en §5.1 | S |
| H-10 | **P2** | Pages Function de borradores duplicada y con contrato incompatible con el panel | `functions/api/borradores.js:41-51,29-38`; `index.html:1095,1332-1333`; `README.md:12`; `bot/README.md:156`; `docs/TRASPASO.md:56-59` | Si alguien sigue el README y apunta el panel a la función: 401 (el panel manda `x-bot-token`, no `Bearer` de Supabase); si se sirve desde otro origen: bloqueo CORS; rate limit evadible por isolate | Dos implementaciones de IA mantenidas en paralelo con auth, prompts, modelos y límites distintos | **Eliminar** `functions/api/borradores.js` (el panel ya usa el bot) o alinearla (CORS/OPTIONS, aceptar `x-bot-token`, validar JWT) y actualizar los 3 docs | S |
| H-11 | **P2** | Worker IA: 502 sin reintentar modelos y fallos de Supabase enmascarados | `functions/api/borradores.js:136-139,172-187,70-71,105-111,119-121`; `bot/src/ai.js:251-254` | “La IA no devolvió borradores” aunque el siguiente modelo funcionaría; borradores genéricos generados con `[COMPLETAR]` cuando falla la lectura de `configuracion_tienda`/`productos` | `return parseDrafts(txt)` incluso si devuelve `[]`; `cfgRes.ok`/`prodRes.ok` se ignoran; cadena de modelos distinta a la del bot | Si `drafts.length === 0` continuar con el siguiente modelo; devolver 502 si falla Supabase; alinear modelos con el bot | S |
| H-12 | **P2** | Campaña se crea en 2 `INSERT` sin transacción: puede quedar sin destinatarios | `index.html:1123-1126` | Campaña “aprobada” con 0 envíos; el dueño la abre y no hay a quién enviar | Sin RPC transaccional; si el 2.º `INSERT` falla se lanza el error pero la campaña ya existe | RPC `crear_campana(...)` que inserte campaña + envíos en una transacción (o borrar la campaña en el `catch`) | S |
| H-13 | **P2** | Doble polling y re-render directo del hilo provocan parpadeos | `index.html:930,1952,1534,1546-1556,1365,1408,1791`; `bot/src/server.js:750-756` | Bandeja se pide 2 veces (12 s y 15 s); el hilo se reemplaza con `innerHTML` + `scrollTop` cada 20 s; el QR consulta `/api/estado` cada 2,5 s y cada llamada hace un `count` a Supabase | Dos temporizadores solapados + `pintarHilo()` sin `fantasma()` + `/api/estado` con consulta a BD | Un solo scheduler por vista, `fantasma()` en el hilo, pausar en `document.hidden`, cachear `/api/estado` 10 s | S |
| H-14 | **P2** | Generador SQL frágil: deja todo el catálogo inactivo, precios `null`, sin `on conflict` por código | `scripts/build-productos-sql.mjs:32-42,50,54-65,67-87,94-95` | CSV sin columna `activo` → todos `activo=false` (panel filtra `activo!==false` → catálogo vacío); precios con “S/” → `null`; `codigo` duplicado rompe el script; los archivos 01a–01d no se regeneran | Defaults posicionales (`?? 'si'` no cubre string vacío), `Number()` sobre texto con moneda, único índice por `codigo` sin conflicto, split manual | Defaults explícitos (`activo` true salvo “no/0”), limpiar moneda antes de `Number`, `on conflict (codigo)`, generar 01a–01d desde el mismo script y validar 202 | S |
| H-15 | **P2** | Doble diseño del correo de testimonios (columna `correo` vs tabla `testimonios_contacto`) | `sql/04_testimonios_web.sql:62-67`; `sql/05_arreglar_rls_testimonios.sql:23-24` | Si el sitio escribe la columna, `testimonios_contacto` queda vacía (y el dueño no ve correos); si escribe la tabla, la columna queda `null` y se salta el `check` de largo | `05` se escribió para un esquema distinto del que creó `04`; nadie decidió cuál es el contrato | Decidir uno (recomendado: columna `correo` con `check` o tabla con FK, no ambos), migrar datos y dejar un solo contrato documentado | S |
| H-16 | **P2** | Drift `00` vs 01–06 y migraciones sin versionar | `sql/00_instalar_todo.sql:238,308,451` (3 transacciones, no incluye 05/06); `git status` (04/05/06 untracked; 00/01*/02 modificados); `README.md:34-41` (no menciona 04–06) | Quien ejecuta `00` no obtiene el estado documentado; un `git checkout` revierte precios 56/78 a 58/82; un fallo en el 3.er bloque deja 02 aplicado y 04 no | `00` es una copia manual; los parches nuevos no se commitearon | Generar `00` desde 01–06 en CI (o eliminarlo), commitear todo, una sola secuencia documentada | S |
| H-17 | **P2** | Contratos documentales divergentes (docs vs código) | `docs/TRASPASO.md:31-37 vs .dev.vars.example:5`; `TRASPASO:49-50,314 vs index.html:1938`; `DISENO_PANEL.md:197 vs index.html:777-779`; `DISENO_PANEL.md:222 vs index.html:922`; `bot/README.md:85 vs bot/src/config.js:37` | Decisiones contradictorias (¿modelo 3.6 o 3 flash?, ¿6 u 10 pestañas?, ¿90 s o 10 s de cooldown?, “sin claves en el navegador” con la publishable en el HTML) | Docs actualizados en commits distintos y sin checklist de contrato | Actualizar los 3 docs en el mismo commit del cambio; añadir sección “contrato de datos” generada desde el dump | S |
| H-18 | **P3** | Rate limit del Worker en memoria por isolate | `functions/api/borradores.js:29-38` | El límite de 20/h se evade repartiendo requests entre isolates; el `Map` no se purga | Estado en memoria de un entorno efímero | KV/Durable Object o rate limit en el bot (que sí tiene proceso estable) | S |
| H-19 | **P3** | Persistencia frágil de la Bandeja: JSON reescrito cada 1,2 s y tope de 400 chats | `bot/src/conversaciones.js:5-12,24-35` | Si el archivo se corrompe o se borra `bot/data/`, la Bandeja queda vacía aunque `mensajes` tenga todo; chats >400 se descartan | Almacén JSON sin transacción ni backup, límites silenciosos | Migrar a `mensajes` (H-02); mientras tanto, backup diario y escritura atómica (`tmp` + rename) | S |
| H-20 | **P3** | `mensajes` sin `check` de `origen`/`estado` y sin índice temporal | `sql/02_datos_y_esquema.sql:47-56`; orígenes usados en `bot/src/server.js:198,294,367,407,474,484,582,1218` | Valores nuevos/typos se guardan igual; consultas por fecha (futuros KPIs) escanean | DDL mínima; no hay `enum`/check ni índice por `creado_en` | `check (origen in (...))` o tabla de catálogo; `index on mensajes (creado_en desc)` | S |
| H-21 | **P3** | `.gitignore` no cubre los backups que exige el propio traspaso | `docs/TRASPASO.md:191` (`index.bak.html`); `.gitignore:1-20` | Un `index.bak.html` con JS viejo puede terminar commiteado/desplegado por error | Regla de backup sin regla de ignore | Añadir `*.bak.html`, `index.bak.html`, `*.bak`; validar en CI | S |

**Nota de severidad:** H-03, H-04, H-05 y H-07 se elevan a **P0** si (a) el registro público de Supabase está habilitado, (b) el bot está publicado a Internet sin `BOT_TOKEN`, o (c) se ejecutó `06` y luego `05`. Verificar en el checklist §7.1/§7.3.

---

## 4. Detalle de los hallazgos P0/P1 (evidencia y parche)

### H-01 — No existe DDL de las tablas base

Evidencia dura (no hay `create table` para esas 6 tablas en `sql/`):

- `sql/00_instalar_todo.sql:13` → `create unique index ... on public.productos (codigo)` y `:15` → `insert into public.productos ...` **antes** de que algo cree `productos`.
- `sql/02_datos_y_esquema.sql:9` → `insert into public.configuracion_tienda (...)`; `:24` → `insert into public.plantillas`; `:52` → `alter table public.clientes alter column telefono set not null`; `:63-66` → `alter table public.campanas` + índices sobre `clientes`.
- `sql/03_seguridad_rls.sql:13-19` → `alter table ... enable row level security` sobre tablas que el repo nunca crea.
- `docs/TRASPASO.md:186` → “No se tocan las tablas/columnas de Supabase ya creadas”: el repo renuncia explícitamente a ser dueño del esquema.
- Columnas usadas por el panel y **ausentes de todo `sql/`**: `clientes.consentimiento`, `ultima_compra`, `etiquetas`, `activo`, `fecha_consentimiento`, `fecha_baja` (`index.html:876,943-945,966-971`); `campanas.titulo`, `mensaje_final`, `segmento`, `creado_en` (`index.html:1123,1136-1138`); `envios.campana_id`, `cliente_id`, `fecha_envio` (`index.html:1125,1187-1189`). Solo `clientes.telefono`, `clientes.fecha_cumpleanos`, `campanas.fecha_programada`, `campanas.numero_emisor` aparecen declarados (`sql/02:63-66`).

Riesgo derivado: al no haber FK ni `unique (campana_id, cliente_id)` en `envios`, dos clics (o dos pestañas) pueden crear envíos duplicados; al no conocerse los tipos, la comparación estricta `clientes.find(x => x.id === v.cliente_id)` (`index.html:1158,1181`) puede fallar en silencio si `clientes.id` es `bigint` (número en JSON) y `envios.cliente_id` es `text` (string) → la campaña se ve sin nombres.

**Fix (paso 1, imprescindible):** generar el DDL real desde el proyecto y versionarlo.

```powershell
# Con la connection string de Supabase (Settings > Database) y pg_dump instalado:
pg_dump "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" `
  --schema=public --schema-only --no-owner --no-privileges -f sql/00_esquema_base.sql
```

Luego: revisar que `00_esquema_base.sql` tenga `create table`, PK, FKs, defaults y constraints; incluirlo como primer bloque de `00_instalar_todo.sql`; añadir `sql/99_verificar_contrato.sql` con las consultas de §7.4. **No** ejecutar `00` en producción hasta que este archivo exista.

### H-02 — La Bandeja/KPIs no están en Supabase y no hay Realtime

- Panel: `cargarBandeja()` pide `botFetch('/api/conversaciones?limite=80')` (`index.html:1484`), el hilo `GET /api/conversaciones/:tel` (`:1506,1522`), KPIs `/api/estadisticas` (`:1217-1219`) y el chip `/api/estado` (`:1468,1907`). **No hay ninguna consulta `sb.from('mensajes')` en `index.html`**.
- Bot: la bandeja sale de `conversaciones.js`, que persiste un **JSON** (`bot/src/conversaciones.js:5-12`) con `MAX_CHATS = 400` y `MAX_MENSAJES = 500` (`:8-9`), reescrito con debounce de 1,2 s (`:24-35`). La tabla `mensajes` solo se escribe como log (`bot/src/supabase.js:34-45`) y se lee para el contexto de la IA (`:47-55`; `server.js:472`).
- KPIs: `/api/estadisticas` responde con `porDia(nDias)` y `resumenChats()` en memoria (`bot/src/server.js:1017-1032`); al reiniciar el bot, el gráfico y “enviados hoy” vuelven a cero aunque `mensajes` tenga los datos.
- Realtime: `grep` de `postgres_changes|supabase_realtime|alter publication` en todo el repo → **0 resultados** (solo la dependencia transitiva `@supabase/realtime-js` en `package-lock.json`). El panel no usa `sb.channel(...)`. Supabase exige agregar la tabla a la publicación `supabase_realtime` para que `postgres_changes` emita: [Postgres Changes — Supabase Docs](https://supabase.com/docs/guides/realtime/postgres-changes).

**Por qué hoy se justifica el polling y por qué no alcanza:** el panel no puede suscribirse a `mensajes` porque (a) la tabla no está publicada, (b) el panel no lee esa tabla y (c) el estado de la bandeja ni siquiera se escribe por completo en ella (falta `waId`, `ack`, `noLeidos`, `pausado`, `nombreWa`). Sin cambiar el origen de datos, cualquier Realtime que se agregue queda vacío.

**Fix (fase 2, resumido):**

```sql
-- 1) publicar cambios (esto es lo que hoy falta)
alter table public.mensajes replica identity full;
alter publication supabase_realtime add table public.mensajes;
alter publication supabase_realtime add table public.campanas;
alter publication supabase_realtime add table public.envios;
alter publication supabase_realtime add table public.clientes;
```

```js
// 2) en el panel: una sola suscripción en boot()
sb.channel('crm-datos')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'mensajes' }, () => cargarBandeja())
  .on('postgres_changes', { event: '*', schema: 'public', table: 'campanas' }, () => load())
  .on('postgres_changes', { event: '*', schema: 'public', table: 'envios' }, () => { if (openK) abrirCampana(openK.id); })
  .subscribe();
```

Mientras no se migre: reducir el polling a **un** intervalo de 5–10 s por vista visible y pausarlo con `document.hidden`.

### H-03 — RLS por rol, no por usuario

`sql/03_seguridad_rls.sql:36-49` crea siete políticas idénticas `for all to authenticated using (true) with check (true)` (clientes, productos, plantillas, campañas, envíos, configuración y mensajes). No hay verificación de que el `authenticated` sea el dueño: cualquier usuario creado en `auth.users` obtiene acceso total. La única defensa es un paso manual (`sql/03:72-74`: “desactiva Allow new users to sign up”), que no está automatizado ni verificable desde SQL. La URL y la clave publishable están en el HTML (`index.html:777-779`), por lo que cualquier visitante conoce el proyecto.

**Fix (mínimo, una sola cuenta):**

```sql
create table if not exists public.app_admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.app_admins enable row level security;
create policy admin_self on public.app_admins for select to authenticated using (user_id = auth.uid());
insert into public.app_admins (user_id) values ('<uuid-del-dueno>') on conflict do nothing;

-- repetir el patrón por tabla:
drop policy if exists panel_clientes on public.clientes;
create policy panel_clientes on public.clientes
  for all to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));
```

Y en el dashboard: **Authentication → Providers → desactivar signup**; comprobar `select id, email, created_at from auth.users;`.

### H-04 — Bot sin token por defecto

`bot/src/server.js:682-687`:

```js
function auth(req, res, next) {
  if (!config.botToken) return next();          // ← sin BOT_TOKEN, todo abierto
  const t = req.get('x-bot-token') || req.query.token || '';
  if (t === config.botToken) return next();
  res.status(401).json({ error: 'Token del bot inválido' });
}
```

`bot/.env.example:19` deja `BOT_TOKEN=` vacío; `bot/README.md:117-119` reconoce el riesgo (“No expongas el puerto a Internet sin token o sin una VPN”), pero las opciones de despliegue `:128-151` (Docker, Railway/Render) publican el puerto 3000 sin exigir token. Las rutas con `auth` incluyen `/api/clientes`, `/api/conversaciones`, `/api/conversaciones/:tel/enviar`, `/api/sincronizar`, `/api/pedidos` (con service_role detrás). CORS es `*` (`server.js:689-695`).

**Fix:**

```js
// server.js
if (!config.botToken) { console.error('FATAL: BOT_TOKEN requerido'); process.exit(1); }
const ORIGENES = new Set([
  'https://perfumeriafinaperu.com',
  'https://<proyecto>.pages.dev',
  'http://localhost:8080',
  'http://localhost:3000'
]);
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ORIGENES.has(o)) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
```

Y en `bot/.env.example` quitar `BOT_TOKEN=` vacío de la sección “Servidor” y moverlo a “obligatorio”.

### H-05 — La reversión de 06 no revierte

`sql/06_testimonios_auto_publicar.sql:7` dice “Para volver al modo con revisión, ejecutá 05”. Pero `05` (`:31-41`) solo dropea `web_lee_aprobados`, `web_inserta_pendiente` y `panel_administra`; **no** dropea `web_inserta_auto`, que es la que creó `06` con `with check (true)` (`:19-21`). En PostgreSQL las políticas permisivas se combinan con OR: el insert queda permitido por `web_inserta_auto` aunque `web_inserta_pendiente` exija `aprobado = false`.

**Fix (en `sql/05`, y también si se crea un `07`):**

```sql
drop policy if exists "web_inserta_auto" on public.testimonios;
drop policy if exists "web_inserta_pendiente" on public.testimonios;
create policy "web_inserta_pendiente" on public.testimonios
  for insert to anon, authenticated
  with check (coalesce(aprobado, false) = false);
```

Test de regresión (con el rol anon, debe fallar):

```sql
set role anon;
insert into public.testimonios (nombre, estrellas, mensaje, aprobado)
values ('Prueba', 5, 'texto suficientemente largo para pasar el check', true); -- debe fallar
reset role;
```

### H-06 — 1000 filas por defecto

Supabase (PostgREST) devuelve como máximo 1000 filas por `select` si no se pagina; el límite se configura en Settings → API → Max rows. El código no pagina en ningún lado:

- `bot/src/supabase.js:22-26` `getClientes()` → `select('*')` sin rango.
- `index.html:903` `from('clientes').select('*')` sin rango.
- `index.html:1145` `from('envios').select('id,estado,cliente_id').eq('campana_id', id)` sin rango.
- `bot/src/server.js:270-287` arma el mapa de clientes con `getClientes()`; si un `envio.cliente_id` no está en el mapa, `puede(undefined) === false` y lo marca `omitido` (`:284-287`) **sin enviarlo**.
- `bot/src/server.js:1086-1097` compara contactos contra `getClientes()` truncado → intenta reinsertar existentes (el `upsert` con `ignoreDuplicates` evita el daño, pero el resumen “nuevos” miente).

**Fix (helper único en panel y bot):**

```js
async function allRows(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}
// uso: const clientes = await allRows(() => sb.from('clientes').select('*').order('nombre'));
```

En el bot, `getClientes()` y los `select` de `envios` deben usar el mismo patrón.

### H-07 — Migraciones no atómicas y `03` destructivo

- `03` abre `begin` en `:11`, habilita RLS en `:13-19`, **borra todas las políticas** de esas 7 tablas con un `do` dinámico en `:22-33`, crea las nuevas en `:36-49`, y recién en `:52` hace `alter column ... set not null` y en `:56-59` agrega `CHECK` que **valida filas existentes**. Si cualquier fila viola el formato `^51[0-9]{9}$` o hay un `telefono` nulo, el `commit` de `:70` nunca se alcanza y **todo revierte, incluido el `enable row level security`**. El resultado: tablas sin RLS y con la clave publishable pública.
- `04`, `05` y `06` no tienen `begin/commit` (archivos completos): un error a mitad deja políticas a medias; como RLS sin política = denegado silencioso, el sitio/panel devuelve `[]` sin error visible.

**Fix:**

1. Preflight antes de `03`:

```sql
select count(*) as nulos from public.clientes where telefono is null;
select count(*) as no_peru from public.clientes where telefono is null or telefono !~ '^51[0-9]{9}$';
select telefono, count(*) from public.clientes group by 1 having count(*) > 1;
-- si hay filas, corregirlas ANTES (o usar constraint NOT VALID y validar aparte)
```

2. Envolver `04`/`05`/`06` en `begin; ... commit;`.
3. En `03`, reemplazar el loop genérico por `drop policy if exists` explícitos (así un error no arrastra todo) y separar: (a) `enable rls` + políticas en una migración, (b) constraints con `not valid` + `validate constraint` en otra.

### H-08 — Errores silenciados en el panel

```js
// index.html:907-908
if(p.error)throw new Error(p.error.message);
if(c.error||t.error||k.error)console.warn('Aviso al cargar:',(c.error||t.error||k.error).message);
// index.html:911-913: si clientes vino vacío, se pide al bot (service_role) y el fallo de RLS queda oculto
```

**Fix:** tratar los 4 errores igual (`if (c.error || t.error || k.error) throw ...`), quitar el fallback silencioso o mostrar un aviso “modo degradado (datos del bot)” y un banner persistente con `error.message`.

---

## 5. Verificación de consultas reales contra el esquema

Se verificaron 8 consultas representativas del panel y del bot. “Esquema declarado” = lo que el repo permite comprobar; si la columna no aparece en ningún SQL, se marca **NO VERIFICABLE** (no significa que no exista en Supabase, sino que el contrato no está en el repo).

| # | Consulta (archivo:línea) | Qué usa | Esquema declarado en el repo | Veredicto |
| --- | --- | --- | --- | --- |
| Q1 | `index.html:903` `from('clientes').select('*').order('nombre')` + campos `876,943-945,966-971` | `id`, `nombre`, `telefono`, `etiquetas`, `consentimiento`, `baja`, `fecha_cumpleanos`, `ultima_compra`, `notas`, `activo`, `fecha_consentimiento`, `fecha_baja` | Solo `telefono` (`sql/02:66`, `sql/03:52`), `fecha_cumpleanos` (`sql/02:65`); el resto **no aparece** | **DESALINEADO / NO VERIFICABLE**: 10 de 12 columnas sin DDL (incluida `id`); `order by nombre` sin índice (`H-01`, `H-09`) |
| Q2 | `index.html:904` `from('productos').select('*').order('codigo')` + `914,1064-1066` | 19 columnas del catálogo | `sql/01a:7` lista las 19 + `sql/01a:5` índice único `codigo` | **ALINEADO** (19/19); falta índice en `activo` para el filtro server-side (`H-09`) |
| Q3 | `index.html:906` `from('campanas').select('*').order('creado_en',{ascending:false}).limit(200)` + `1123,1136-1138,1152,1182` | `titulo`, `mensaje_final`, `segmento`, `fecha_programada`, `estado`, `numero_emisor`, `creado_en` | `numero_emisor` (`sql/02:63`), `fecha_programada` (`sql/02:64`), `estado` con check (`sql/03:64-67`); `titulo`/`mensaje_final`/`segmento`/`creado_en` **sin DDL** | **PARCIAL**: 3/7 declaradas; `order by creado_en` sin índice (`H-01`, `H-09`); si `segmento` es `text[]`/`jsonb` no verificable |
| Q4 | `index.html:1145` `from('envios').select(...).eq('campana_id',id)` + `1187-1189` | `id`, `campana_id`, `cliente_id`, `estado`, `fecha_envio` | Solo `estado` con check (`sql/03:60-63`); sin tabla, sin índice por `campana_id` | **NO VERIFICABLE** + **sin índice** (`H-09`); sin `unique(campana_id, cliente_id)` → duplicados posibles (`H-01`) |
| Q5 | `bot/src/supabase.js:36-43` `insert into mensajes` | `cliente_id`, `telefono`, `direccion`, `texto`, `origen`, `estado` | `sql/02:47-56` (DDL completa), check `direccion in ('entrante','saliente')`; valores usados `saliente`/`entrante` (`bot/src/server.js:198,474`) | **ALINEADO** (6/6 + check). No existen columnas `waId`/`ack` → esa parte vive solo en el JSON (`H-02`) |
| Q6 | `bot/src/supabase.js:49-55` `select direccion,texto,creado_en ... eq(telefono) order(creado_en desc) limit(8)` | Historial para la IA | `sql/02:58` `index (telefono, creado_en desc)` | **ALINEADO** (índice exacto) |
| Q7 | `index.html:1055` y `bot/src/supabase.js:76-79` `upsert(..., {onConflict:'telefono'})` | Telefono como clave natural | `sql/02:66`/`sql/00:306` `unique index clientes_telefono_key (telefono)` | **ALINEADO** *si* se ejecutó 02/00; sin ese índice PostgREST devuelve `42P10` y la importación falla |
| Q8 | `bot/src/server.js:220-226` `from('campanas').select('*').eq('estado','programada').lte('fecha_programada',now).order('fecha_programada')` | Programadas vencidas | `sql/03:64-67` check de estado; `sql/02:64` índice `fecha_programada` | **ALINEADO**; conviene índice compuesto `(estado, fecha_programada)` (`H-09`) |

**Consultas no verificables por falta de esquema (queda como deuda del H-01):** crear campaña (`index.html:1123`), lista de envíos de una campaña (`:1145`), importar clientes desde WhatsApp (`server.js:1086-1099`), campaña del bot (`server.js:247-318`), `/api/clientes` (`server.js:1125-1131`).

### 5.1 Índices faltantes (fix de H-09)

```sql
-- En producción, crear con CONCURRENTLY y fuera de transacción:
create index if not exists envios_campana_estado_idx on public.envios (campana_id, estado);
create index if not exists campanas_creado_en_idx   on public.campanas (creado_en desc);
create index if not exists campanas_estado_fecha_idx on public.campanas (estado, fecha_programada);
create index if not exists clientes_nombre_idx      on public.clientes (lower(nombre));
create index if not exists productos_activo_idx     on public.productos (activo) where activo;
```

---

## 6. Plan de 3 fases

### Fase 1 — Congelar el contrato y hacer segura la migración (1–2 días)

Objetivo: que el esquema sea reproducible y que ninguna migración pueda dejar RLS apagado.

1. `pg_dump --schema-only` → `sql/00_esquema_base.sql`; incluirlo en `00_instalar_todo.sql`; commit.
2. Commitear `sql/04`, `05`, `06` y los cambios pendientes de `00`/`01*`/`02` (hoy untracked/modificados).
3. Arreglar la reversión de `06` (drop de `web_inserta_auto` en `05` o nuevo `07`).
4. Envolver `04/05/06` en `begin; ... commit;`; reemplazar el loop de `03` por `drop policy` explícitos; separar constraints con `NOT VALID` + `VALIDATE`.
5. Añadir `sql/99_verificar_contrato.sql` (consultas de §7.4) y ejecutarlo después de cada migración.
6. Índices de §5.1 con `CONCURRENTLY`.
7. **Criterio de aceptación:** `00` corre de cero en un proyecto Supabase de prueba; `99` devuelve 0 filas de error; el panel existente sigue funcionando sin cambios.

### Fase 2 — Un solo origen de datos y “vivo” real (2–4 días)

Objetivo: que el panel lea los mensajes de Supabase y que los cambios aparezcan sin recargar ni polling agresivo.

1. Añadir a `mensajes` lo que hoy solo existe en el JSON (`wa_id text unique`, `ack smallint`, `origen`/`estado` checks) y una vista `conversaciones` (último mensaje, no leídos, pausas en tabla `ia_pausas`).
2. Publicar tablas en `supabase_realtime` (SQL de H-02), `replica identity full`.
3. Panel: suscribirse una sola vez en `boot()`, refrescar bandeja/campañas/envíos con debounce de 300 ms; eliminar el doble poll (`index.html:930` y `:1952`).
4. Bot: dejar de mantener el JSON como fuente; escribir/leer `mensajes` y `conversaciones`; paginar (`allRows`) `clientes` y `envios`.
5. KPIs: calcular “enviados hoy” y el gráfico desde `mensajes`, no desde memoria (`server.js:1017-1032`).
6. **Criterio de aceptación:** dos pestañas abiertas; un mensaje entrante aparece en <2 s sin recargar; apagar el bot no vacía la Bandeja; reiniciar el bot no resetea KPIs.

### Fase 3 — Seguridad, campañas atómicas y documentación (2–3 días)

Objetivo: cerrar los P1 restantes y evitar que el contrato vuelva a divergir.

1. RLS por usuario (`app_admins`) + signup desactivado; auditar `auth.users`.
2. `BOT_TOKEN` obligatorio + allowlist CORS + HTTPS; borrar el fallback de clave publishable del Worker (`functions/api/borradores.js:41-42`) y **eliminar la función duplicada** (o alinearla con el bot).
3. RPC `crear_campana(...)` transaccional; `unique (campana_id, cliente_id)` en `envios`.
4. Endurecer `scripts/build-productos-sql.mjs` (defaults, moneda, `on conflict (codigo)`, regenerar 01a–01d, validar 202).
5. Actualizar `TRASPASO`/`DISENO_PANEL`/`README`/`bot/README` en el mismo commit; CI que verifique que `00` es la concatenación de 01–06 (o eliminar `00`).
6. **Criterio de aceptación:** checklist §7 completo + prueba de roles (`anon` no lee nada del CRM, `authenticated` solo el dueño) + campaña de 1.200 clientes enviada completa.

---

## 7. Checklist de migración segura

### 7.1 Antes (obligatorio)

- [ ] Backup: Supabase → Database → Backups, **y** `pg_dump` completo (esquema + datos) fuera del repo.
- [ ] Congelar el panel y el bot (ventana sin envíos; `MODO_PRUEBA=true` o `MAX_POR_DIA=0`).
- [ ] Capturar el estado actual como evidencia:

```sql
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public'
  and table_name in ('clientes','productos','campanas','plantillas','envios','configuracion_tienda','mensajes','testimonios','testimonios_contacto')
order by table_name, ordinal_position;

select tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname='public' order by 1,2;

select * from pg_publication_tables where pubname='supabase_realtime';

select conrelid::regclass as tabla, conname, pg_get_constraintdef(oid)
from pg_constraint where connamespace='public'::regnamespace order by 1,2;

select count(*) as clientes from public.clientes;
select count(*) as campanas from public.campanas;
select count(*) as envios from public.envios;
select count(*) as mensajes from public.mensajes;
```

- [ ] Preflight de datos para `03`:

```sql
select count(*) filter (where telefono is null) as nulos,
       count(*) filter (where telefono !~ '^51[0-9]{9}$') as no_peru
from public.clientes;
select telefono, count(*) from public.clientes group by 1 having count(*) > 1;
select count(*) from public.envios e
  left join public.campanas c on c.id = e.campana_id
  left join public.clientes cl on cl.id = e.cliente_id
  where c.id is null or cl.id is null;
```

- [ ] Confirmar `BOT_TOKEN`, `MODO_PRUEBA` y URL del bot; anotar los IDs de campañas programadas (pueden quedar en vuelo).

### 7.2 Durante (orden estricto, un archivo por vez)

- [ ] **No ejecutar `00_instalar_todo.sql` en producción** (tiene 3 transacciones separadas que cierran en las líneas 238, 308 y 451; un fallo en la tercera deja 02 aplicado y 04 no). Ejecutar archivo por archivo.
- [ ] `00_esquema_base.sql` solo si es un proyecto nuevo.
- [ ] Índices con `CONCURRENTLY` (no dentro de `begin`).
- [ ] Constraints nuevas con `add constraint ... not valid` y luego `validate constraint` (no bloquea escrituras).
- [ ] `04` → `05` → `06` (o `07`): decidir **un solo** diseño de correo (H-15) y no volver a `06` sin el drop de `web_inserta_auto`.
- [ ] Publicación Realtime después de confirmar RLS y `replica identity`.
- [ ] Deploy del bot antes que el panel si el panel espera columnas nuevas; si no, panel primero es seguro (solo lee).

### 7.3 Después (verificación y rollback)

- [ ] RLS activo y políticas correctas:

```sql
select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname in
('clientes','productos','campanas','plantillas','envios','configuracion_tienda','mensajes','testimonios');
select tablename, policyname, roles, cmd from pg_policies where schemaname='public' order by 1,2;
```

- [ ] `anon` no ve datos del CRM (probar con la clave publishable desde un cliente limpio: `select * from clientes limit 1` debe devolver `[]` o error de permiso).
- [ ] `authenticated` solo el dueño: entrar con una cuenta de prueba creada a mano → debe devolver vacío/denegado.
- [ ] Smoke test del panel: login, Clientes (alta + import), Catálogo, Campaña manual con 1 cliente, “Programar” y “Cancelar”, Bandeja (abrir chat, enviar, pausar IA), Ajustes/QR, Pedidos, Analíticas.
- [ ] Campaña de prueba de 1.200 filas (si se aplicó H-06): confirmar 1.200 `envios` y 0 `omitido` por cliente inexistente.
- [ ] Rollbacks: cada migración debe tener su `down` (drop índice, drop política nueva + recrear la Vieja, `alter publication drop table`). Si un paso falla: restaurar backup, no “seguir ejecutando”.

### 7.4 SQL de verificación continua (`sql/99_verificar_contrato.sql`)

```sql
-- Debe devolver 0 filas: columnas que el panel usa y no existen
with esperado(tabla, columna) as (values
  ('clientes','consentimiento'),('clientes','baja'),('clientes','activo'),
  ('clientes','etiquetas'),('clientes','fecha_cumpleanos'),('clientes','ultima_compra'),
  ('clientes','fecha_consentimiento'),('clientes','fecha_baja'),
  ('campanas','titulo'),('campanas','mensaje_final'),('campanas','segmento'),
  ('campanas','fecha_programada'),('campanas','estado'),('campanas','numero_emisor'),('campanas','creado_en'),
  ('envios','campana_id'),('envios','cliente_id'),('envios','estado'),('envios','fecha_envio'))
select e.* from esperado e
left join information_schema.columns c
  on c.table_schema='public' and c.table_name=e.tabla and c.column_name=e.columna
where c.column_name is null;

-- Debe devolver 0 filas: políticas permisivas inesperadas
select * from pg_policies
where schemaname='public' and tablename like 'testimonios%' and policyname='web_inserta_auto';

-- Debe devolver 0 filas: envíos huérfanos
select e.id from public.envios e
  left join public.campanas c on c.id = e.campana_id
  left join public.clientes cl on cl.id = e.cliente_id
  where c.id is null or cl.id is null limit 20;

-- Debe devolver 0 filas: duplicados de envío en una campaña
select campana_id, cliente_id, count(*) from public.envios
group by 1,2 having count(*) > 1 limit 20;
```

---

## 8. Anexo — archivos revisados y qué NO se pudo verificar

**Revisados a fondo:** [`functions/api/borradores.js`](../../functions/api/borradores.js) (187 líneas), [`sql/00_instalar_todo.sql`](../../sql/00_instalar_todo.sql) (458), [`sql/01a`](../../sql/01a_productos_1-51.sql)/[`01b`](../../sql/01b_productos_52-102.sql)/[`01c`](../../sql/01c_productos_103-152.sql)/[`01d`](../../sql/01d_productos_153-202.sql), [`sql/01_productos.sql`](../../sql/01_productos.sql) (230), [`sql/02_datos_y_esquema.sql`](../../sql/02_datos_y_esquema.sql) (68), [`sql/03_seguridad_rls.sql`](../../sql/03_seguridad_rls.sql) (75), [`sql/04_testimonios_web.sql`](../../sql/04_testimonios_web.sql) (91), [`sql/05_arreglar_rls_testimonios.sql`](../../sql/05_arreglar_rls_testimonios.sql) (69), [`sql/06_testimonios_auto_publicar.sql`](../../sql/06_testimonios_auto_publicar.sql) (43), [`docs/TRASPASO.md`](../../docs/TRASPASO.md), [`docs/DISENO_PANEL.md`](../../docs/DISENO_PANEL.md), [`.dev.vars.example`](../../.dev.vars.example), [`.gitignore`](../../.gitignore), [`scripts/build-productos-sql.mjs`](../../scripts/build-productos-sql.mjs). Contrato verificado contra `index.html` (1.956 líneas) y `bot/src/*.js` (supabase, server, ai, conversaciones, config) sin auditarlos.

**Verificaciones concretas hechas:** 202 IDs de producto únicos en `01_productos.sql` y en la unión de 01a–01d (sin faltantes ni sobrantes; `202/202`); `00` contiene copias idénticas de `02` y `04` y una copia de `03` sin su `commit` final (3 transacciones en total); `00` **no** incluye `05` ni `06`; `grep` sin `create table` para las 6 tablas base; `grep` sin `alter publication`/`postgres_changes` en todo el repo; `git ls-files` sin `service_role` real (solo `.env.example` vacío); `git status`: `04/05/06` **untracked** y `00/01*/02` con cambios de precio 58/82 → 56/78 sin commitear.

**NO se pudo verificar (requiere acceso a la base o al dashboard):** tipos reales y FKs de las 6 tablas base; si `auth` tiene signup deshabilitado; si `06` se ejecutó alguna vez; si el sitio público (`perfumeriafinaperu.com`, fuera de este repo) lee `productos`/`configuracion_tienda` con la clave anónima (si lo hace, `03` lo deja sin acceso porque solo crea políticas `authenticated`); si el bot está expuesto a Internet hoy; configuración real de `Max rows`/Realtime en el proyecto; si el proyecto Supabase tiene las columnas `fecha_consentimiento`/`fecha_baja`/`ultima_compra` (el panel las usa y ninguna migración las crea). Todas estas comprobaciones están incluidas en §7.1/§7.3.
