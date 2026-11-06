# CRM Perfumería Fina Perú

Panel privado para clientes, catálogo, campañas y envío semi-manual por WhatsApp.
Incluye un bot con QR para programar envíos, una **bandeja de entrada** en vivo y un
**Asistente IA** que responde consultas (nunca envía campañas solo).

## Estructura

```
index.html                 Panel del dueño (Cloudflare Pages). Inicio, Bandeja,
                           Campañas, Clientes, Catálogo, Calendario, Asistente IA, Ajustes.
functions/api/borradores.js Generador de borradores con IA (Pages Function)
sql/01a_productos_1-51.sql    Perfumes 1 a 51
sql/01b_productos_52-102.sql  Perfumes 52 a 102
sql/01c_productos_103-152.sql Perfumes 103 a 152
sql/01d_productos_153-202.sql Perfumes 153 a 202
sql/01_productos.sql          Catálogo completo en un solo archivo (referencia)
sql/02_datos_y_esquema.sql    Tienda, plantillas, calendario y tabla de mensajes
sql/03_seguridad_rls.sql      Políticas de acceso (RLS)
sql/00_instalar_todo.sql      Todo en un solo archivo (opción rápida)
bot/                       Bot de WhatsApp con QR, cola de envíos, bandeja e IA
docs/                      Contratos de diseño y traspaso técnico (leer antes de tocar)
scripts/                   Generador del SQL del catálogo
```

Documentos clave antes de modificar el panel:

- `docs/DISENO_PANEL.md` — contrato visual (tokens, componentes, pantallas).
- `docs/TRASPASO.md` — arquitectura, API, fases y errores ya resueltos.
- `docs/CREDITOS.md` — atribución de la inspiración visual (wacrm, MIT).

## 1. Base de datos (una sola vez)

En Supabase → **SQL Editor**, ejecuta los archivos **uno por uno**, en este orden:

1. `sql/01a_productos_1-51.sql` → perfumes 1 a 51.
2. `sql/01b_productos_52-102.sql` → perfumes 52 a 102.
3. `sql/01c_productos_103-152.sql` → perfumes 103 a 152.
4. `sql/01d_productos_153-202.sql` → perfumes 153 a 202.
5. `sql/02_datos_y_esquema.sql` → datos de la tienda, plantillas y columnas nuevas.
6. `sql/03_seguridad_rls.sql` → deja el acceso solo para el dueño con sesión iniciada.

> **Importante:** antes de pulsar **Run**, haz clic dentro del editor y presiona `Ctrl+A`
> (o asegúrate de no tener texto seleccionado). Si hay una selección parcial, Supabase
> ejecuta solo esa parte y aparece `syntax error at end of input`.
>
> El catálogo está partido en 4 archivos pequeños (~25 KB cada uno) justamente para
> evitar que el editor corte un pegado grande. Si prefieres hacerlo de una sola vez,
> usa `sql/00_instalar_todo.sql`, pero es más propenso a ese problema.

Después, en **Authentication → Providers**, desactiva *Allow new users to sign up* y crea el usuario del dueño en **Authentication → Users**.

## 2. Panel (Cloudflare Pages)

Sube el proyecto a un repositorio y conéctalo a Cloudflare Pages:

- Build command: *(vacío)*
- Output directory: `/`
- Variables de entorno:
  - `GEMINI_API_KEY` (o `ANTHROPIC_API_KEY`)
  - `AI_MODEL` (opcional, por defecto `gemini-2.5-flash`)
  - `SUPABASE_URL`
  - `SUPABASE_PUBLISHABLE_KEY`

Para probar en tu PC:

```bash
npx wrangler pages dev .
```

Copia `.dev.vars.example` a `.dev.vars` y completa las claves.

> La clave `service_role` **nunca** va en el panel ni en Cloudflare Pages.
> El panel solo usa la clave `publishable` y el login del dueño.

## 3. Bot de WhatsApp (QR)

El bot no puede vivir en Cloudflare Pages: necesita un proceso Node con Chromium.
Puede correr en la PC de la tienda, en un VPS o en Railway/Render.

```bash
cd bot
copy .env.example .env
npm install
npm start
```

Abre <http://localhost:3000/qr> y escanea el QR con el celular.
En `bot/README.md` está la guía completa, el modo prueba y el despliegue con Docker.

### Sobre Chrome

No hace falta tener Chrome instalado para tu uso diario (puedes seguir con Brave).
El bot usa su **propio Chrome de pruebas** (Chromium de Puppeteer), que se instala una vez:

```bash
cd bot
npx puppeteer browsers install chrome
```

Queda en `C:\Users\<usuario>\.cache\puppeteer\...` y no interfiere con tu navegador.
Deja `CHROME_PATH=` vacío en `bot/.env` para que use ese binario.

> Nota: WhatsApp Web a veces no avisa a `whatsapp-web.js` que terminó de sincronizar,
> y el bot se queda en "QR" aunque el celular ya vinculó. `bot/src/whatsapp.js` incluye
> un vigilante que detecta la sesión vinculada y fuerza el evento, así el bot pasa solo
> a "Conectado" en unos segundos.

## 4. Panel nuevo: Inicio, Bandeja y Asistente IA

- **Inicio** — KPIs (clientes, conversaciones, campañas, enviados hoy), gráfico de
  mensajes de 7/30 días, cola de respuestas, campañas, cumpleaños y actividad.
- **Bandeja** — todas las conversaciones de WhatsApp en vivo: leer, responder,
  marcar como leído y **pausar la IA en un chat concreto**.
- **Asistente IA** — interruptor maestro, respuesta automática, máximo de respuestas
  por conversación, indicaciones de tono y lista de chats (pausar/reanudar).
- **Ajustes** — dirección del bot, probar conexión, abrir panel y ver QR.

Todo se controla desde el bot (`/api/ia`), así que los cambios sobreviven al reinicio.

## Flujo de uso

1. **Clientes:** agrega o importa el CSV de WhatsApp.
2. **Catálogo:** revisa los 202 perfumes.
3. **Campañas:** elige plantilla u objetivo, agrega perfumes, genera 3 borradores con IA, edita y aprueba.
4. **Envío manual:** botón por cliente que abre WhatsApp con el mensaje listo.
5. **Envío programado:** elige número, fecha y "Programar con el bot"; el bot envía de a uno cada 25-40 s.
6. **Calendario:** cumpleaños, recompras y fechas especiales.
7. **Bandeja + IA:** responde mensajes con IA, registra BAJA y deriva al dueño cuando hace falta.

## API del bot (resumen)

| Método | Ruta | Para qué |
| --- | --- | --- |
| GET | `/api/estado` | Conexión, cola, enviados hoy, horario, resumen IA |
| GET | `/api/estadisticas?dias=7` | Serie de mensajes por día |
| GET | `/api/conversaciones` | Lista de chats (con no leídos y pausas) |
| GET | `/api/conversaciones/:telefono` | Hilo completo |
| POST | `/api/conversaciones/:telefono/enviar` | Enviar mensaje manual |
| POST | `/api/conversaciones/:telefono/leido` | Marcar como leído |
| GET/POST | `/api/ia` | Leer/guardar estado de la IA |
| POST | `/api/ia/pausar` | Pausar/reanudar IA por teléfono |
| POST | `/api/prueba` | Enviar mensaje de prueba a OWNER_NUMBER/NUMEROS_PRUEBA |
| POST | `/api/simular-entrante` | **Solo pruebas** con `SIMULAR_ENTRANTES=true` |

## Puesta en producción (checklist)

1. **Supabase**
   - [ ] Ejecutar `sql/01a`–`01d`, luego `02` y `03` en el SQL Editor.
   - [ ] Desactivar el registro público y crear el usuario del dueño.
2. **Bot (`bot/.env`)**
   - [ ] Pegar `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Settings → API).
   - [ ] Pegar `GEMINI_API_KEY` (o `ANTHROPIC_API_KEY`) para respuestas con IA real.
   - [ ] Poner `MODO_PRUEBA=false` (envíos reales) al confirmar todo.
   - [ ] `HORA_INICIO=9` y `HORA_FIN=20`, `LUNES_A_SABADO=true`.
   - [ ] `SIMULAR_ENTRANTES=false`.
   - [ ] `SESIONES=1` mientras haya un solo número.
3. **Panel (Cloudflare Pages)**
   - [ ] Variables `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.
   - [ ] En el panel, en **Ajustes**, poner la URL pública del bot y probar conexión.
4. **Bot en línea 24/7**
   - [ ] PC de la tienda con el bot encendido, o VPS. Ver `bot/README.md` (Docker).
5. **Prueba final con un número real** distinto al del dueño.

## Reglas de seguridad incluidas

- Solo clientes con consentimiento, activos y sin baja reciben promociones.
- El mensaje incluye la opción de responder BAJA.
- La IA nunca envía sola: redacta borradores y responde solo consultas informativas.
- La clave de IA vive en el servidor, no en el navegador.
- RLS: sin sesión iniciada no se puede leer ni escribir.
- Modo prueba del bot (`MODO_PRUEBA=true`) para no enviar nada real al principio.

## Costos

| Concepto | Costo |
| --- | --- |
| Cloudflare Pages | 0 |
| Supabase | 0 (capa gratuita) |
| IA (Gemini) | 0 a 10 soles/mes |
| Bot en PC propia | 0 |
| Bot en VPS | ~20-40 soles/mes (opcional) |

## Riesgo del bot

`whatsapp-web.js` no es una librería oficial de WhatsApp. Automatizar WhatsApp Web
va contra sus términos y puede provocar el bloqueo del número. El dueño asumió
el riesgo. Por eso el bot incluye retraso aleatorio, horario, límite diario,
consentimiento y baja. Aun así, pruébalo primero con un número secundario.
