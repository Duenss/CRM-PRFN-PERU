# Imagen del bot de WhatsApp CRM (Perfumería Fina Perú)
FROM node:22-bookworm-slim

# Chromium del sistema: evita descargar Chrome dentro de la imagen y funciona
# igual que en la VPS anterior. El bot detecta /usr/bin/chromium.
ENV CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    NODE_ENV=production \
    PORT=25577

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnss3 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      xdg-utils \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencias primero (mejor caché de capas)
COPY package*.json ./
RUN npm ci --omit=dev

# Código del bot
COPY . .

# Datos y sesión de WhatsApp viven en volúmenes (ver docker-compose.yml)
RUN mkdir -p /app/data /app/.wwebjs_auth /app/.wwebjs_cache

EXPOSE 25577

HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||25577)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "rm -f /app/.wwebjs_auth/*/Singleton* /app/.wwebjs_cache/*/Singleton* 2>/dev/null; exec node src/server.js"]
