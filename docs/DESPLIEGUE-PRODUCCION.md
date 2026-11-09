# Despliegue en producción · CRM Perfumería Fina

Guía para dejar el backend (bot WhatsApp + API) y el panel funcionando en un
servidor real. Tres caminos, de más recomendado a más especial:

| Camino | Cuándo usarlo | Dificultad |
|---|---|---|
| **A. Docker Compose en el VPS** (recomendado) | Tienes VPS con Docker. Trae Chromium dentro del contenedor y no depende de nada del host. | Baja |
| **B. PM2 en el VPS** | Prefieres Node directo, sin Docker. Necesitas instalar Chromium en el sistema. | Media |
| **C. Pterodactyl** | Quieres gestionarlo desde tu panel Sakura Host. | Alta (ver avisos) |

> **Aviso importante sobre Pterodactyl:** el bot usa `whatsapp-web.js` →
> Puppeteer → **Chromium**. Los eggs estándar de Node.js **no incluyen Chromium**,
> así que el bot no arranca con ellos. Necesitas una imagen Docker que sí lo
> traiga (por ejemplo `mcr.microsoft.com/playwright:v1.49.0-jammy`) y un egg que
> permita elegir imagen. En `deploy/pterodactyl/egg-pf-bot.json` está el egg
> listo para importar. Si tu panel tiene **reCAPTCHA** en el login, no se puede
> automatizar: hay que crearlo desde el panel (o darme una *Application API key*
> de Admin → Application API y lo creo por API).

---

## 0. Antes de desplegar

1. **Repositorio:** el código está en el repo privado `CRM-PRFN-PERU`.
2. **Variables de entorno:** copia `bot/.env.production.example` a `bot/.env` en
   el servidor y completa:
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OWNER_NUMBER` (el número real del dueño)
   - `BOT_TOKEN` (genera uno: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`)
   - `GEMINI_API_KEY` (API con facturación) y/o `GROQ_API_KEY`
   - `PAGO_YAPE_*`, `PAGO_PLIN_*`, `PAGO_TRANSFERENCIA_*`
3. **Nunca subas `bot/.env` al repo.** Ya está en `.gitignore`.

---

## A. Docker Compose (recomendado)

```bash
git clone https://github.com/Duenss/CRM-PRFN-PERU.git
cd CRM-PRFN-PERU
cp bot/.env.production.example bot/.env
nano bot/.env                     # completa los valores reales
docker compose up -d --build
docker compose logs -f bot
```

- La API/panel del bot queda en `http://IP_DEL_VPS:3000`
  y el panel interno en `http://IP_DEL_VPS:3000/panel`.
- **Escanea el QR** desde `http://IP_DEL_VPS:3000/panel` con el WhatsApp de la
  tienda (Dispositivos vinculados → Vincular dispositivo).
- Persistencia: `bot/data` (chats, pedidos, anuncios) y `bot/.wwebjs_auth`
  (sesión de WhatsApp). **Respalda esas dos carpetas**: si borras la sesión,
  hay que escanear el QR otra vez.
- Actualizar: `git pull && docker compose up -d --build`.

### Recomendado además: HTTPS con Nginx + dominio

```
server {
    listen 80;
    server_name bot.tudominio.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";   # SSE del CRM
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        client_max_body_size 20m;
    }
}
```

Luego en el CRM (Ajustes → Conexión) pon la URL del bot (`https://bot.tudominio.com`),
el token y vuelve a vincular.

---

## B. PM2 (VPS con Node 22)

```bash
# Chromium del sistema
sudo apt-get update && sudo apt-get install -y chromium fonts-liberation

cd CRM-PRFN-PERU
cp bot/.env.production.example bot/.env && nano bot/.env
# CHROME_PATH=/usr/bin/chromium   (si no está en la ruta por defecto)

cd bot && npm ci --omit=dev && cd ..
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

---

## C. Pterodactyl (panel Sakura Host)

1. **Importa el egg** `deploy/pterodactyl/egg-pf-bot.json`
   (Admin → Nests → Import Egg). Si el panel no acepta importar, crea un egg
   nuevo copiando sus valores.
2. **Imagen Docker:** el egg propone `mcr.microsoft.com/playwright:v1.49.0-jammy`
   porque **incluye Chromium y Node**. Verifica la ruta del binario dentro de la
   imagen y ajusta `CHROME_PATH`:
   ```bash
   ls /ms-playwright/            # verás chromium-XXXX
   ```
   Ruta típica: `/ms-playwright/chromium-1148/chrome-linux/chrome`.
3. **Crea el servidor**: Node 22, egg importado, puerto 3000 asignado por el panel.
4. **Sube los archivos** (SFTP del servidor): el contenido del repo con la carpeta
   `bot/` y `docs/catalogo/`.
5. **Variables de entorno**: todas las del egg y/o un archivo `bot/.env`.
6. **Arranca** el servidor y abre `http://IP:PUERTO/panel` para escanear el QR.

### Alternativa más sólida que Pterodactyl

Si el bot te da problemas en Pterodactyl (Chromium dentro de contenedores
gestionados suele requerir ajustes de `shm`, seccomp y permisos), lo más estable
es **Docker Compose en el mismo VPS** (camino A) y dejar Pterodactyl para tus
servidores de juego. El bot solo necesita ~1 GB de RAM y 1 vCPU.

---

## Verificación post-despliegue

```bash
curl http://127.0.0.1:3000/api/estado     # {"sesiones":[{"estado":"conectado"...}]}
curl http://127.0.0.1:3000/api/pedidos    # con BOT_TOKEN: -H "x-bot-token: ..."
```

En el CRM → **Ajustes → Conexión**:
- URL del bot: `https://bot.tudominio.com` (o `http://IP:3000`)
- Token: el mismo `BOT_TOKEN`
- **Probar conexión** → deben salir tus sesiones en verde.

Luego:
1. Escanea el QR con el WhatsApp de la tienda.
2. Envía un mensaje de prueba desde otro celular: debe llegar la **bienvenida**
   (saludo + agradecimiento) y luego la respuesta.
3. Escribe **“catálogo”**: debe enviar el PDF con los rangos de páginas.
4. Crea un **Anuncio** de prueba limitado a tu propio número antes de lanzarlo a
   toda la base.

---

## Checklist de producción

- [ ] `bot/.env` con valores reales y sin placeholders.
- [ ] `MODO_PRUEBA=false`, `SIMULAR_ENTRANTES=false`, `NUMEROS_PRUEBA` vacío.
- [ ] `BOT_TOKEN` largo y distinto de vacío.
- [ ] Base de clientes limpia (se hizo antes de la entrega).
- [ ] Sesiones de WhatsApp antiguas cerradas y QR escaneado con el número real.
- [ ] Respaldo de `bot/data` y `bot/.wwebjs_auth` programado (cron/rsync).
- [ ] HTTPS activo si el panel se abre fuera de la red local.
- [ ] Panel del CRM publicado (Cloudflare Pages) apuntando a la URL del bot.
