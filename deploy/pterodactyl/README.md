# Despliegue Pterodactyl · CRM Perfumería Fina (Sakura Host)

Estado: **desplegado y funcionando** en `node.sakurasmp.xyz`.

## Servidor

| Dato | Valor |
|---|---|
| Panel | https://panel.sakurasmp.xyz |
| Servidor | **Perfumeria Fina - BOT produccion** (ID `52`, identificador `1938d04a`) |
| Nodo | Node 1 (`node.sakurasmp.xyz`) |
| Puerto | **25577** (asignación 23) |
| RAM / disco | 2048 MB / 6144 MB · CPU 150 % |
| Imagen | `ghcr.io/duenss/crm-prfn-bot-image:latest` |
| API del bot | http://157.173.192.178:25577/api/estado |
| Panel del bot (QR) | http://157.173.192.178:25577/panel |
| Ruta de archivos | `/home/container/bot` (+ `/home/container/docs/catalogo`) |

## Por qué una imagen propia

Los eggs de Pterodactyl **no ejecutan el comando de arranque** por sí mismos: la
imagen Docker debe tener un `entrypoint` que lea la variable `$STARTUP` (así
funcionan las imágenes *yolks*). La imagen de Playwright trae Chromium pero **no**
ese entrypoint, por eso el contenedor quedaba en una `bash` interactiva sin
arrancar el bot.

Solución: repositorio público **https://github.com/Duenss/crm-prfn-bot-image** con:

- `Dockerfile`: Node 22 slim + Chromium + tini + entrypoint compatible.
- `entrypoint.sh`: mismo comportamiento que los yolks (`eval $STARTUP`).
- GitHub Actions: construye y publica `ghcr.io/duenss/crm-prfn-bot-image:latest`
  en cada push a `main`.

La imagen es pública, así el nodo de Pterodactyl puede descargarla sin credenciales.

## Variables de entorno

Se suben como `/home/container/bot/.env` (archivo generado desde
`deploy/pterodactyl/bot.env.produccion3`). Incluye Supabase, IA, `PORT=25577`,
límites, horario, `MODO_PRUEBA=false`, `SIMULAR_ENTRANTES=false` y `BOT_TOKEN`.

## Arranque

El comando de arranque del servidor es:

```bash
cd /home/container/bot 2>/dev/null || cd /mnt/server/bot; \
if [ ! -d node_modules/express ]; then export PUPPETEER_SKIP_DOWNLOAD=1; npm install --omit=dev --no-audit --no-fund; fi; \
exec node src/server.js
```

La primera vez instala dependencias (~11 s con buen internet) y luego levanta el
bot. Después de eso arranca directo.

## Cómo actualizar el bot

1. Subir los cambios por **SFTP** (`baylyrd.<identificador>@node.sakurasmp.xyz:2022`)
   o por el administrador de archivos del panel.
2. Reiniciar el servidor desde el panel.
3. Verificar: `curl http://157.173.192.178:25577/api/estado`.

## Cómo actualizar la imagen (si cambia el Dockerfile)

```bash
# en el repo crm-prfn-bot-image
git commit -am "cambio en la imagen" && git push
# GitHub Actions publica la nueva :latest; luego reinicia el servidor en el panel
```

## Pendiente/operación

- Escanear el QR con el WhatsApp de la tienda en
  `http://157.173.192.178:25577/panel` (una sola vez; la sesión queda en
  `/home/container/bot/.wwebjs_auth`).
- Para HTTPS propio: apuntar un subdominio al puerto 25577 (el panel del bot y la
  API sirven HTTP plano).
- El bot no tiene consola visible desde el panel del CRM; para logs usar la
  consola del servidor en Pterodactyl.
