# ─────────────────────────────────────────────────────────────
# Perfumería Fina · Bot WhatsApp (producción)
# Node 22 + Chromium para whatsapp-web.js / Puppeteer
# ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# Chromium y librerías del sistema que necesita WhatsApp Web (Puppeteer).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
      libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    HEADLESS=true \
    PORT=3000

WORKDIR /app

# Dependencias del bot (capa cacheable).
COPY bot/package*.json ./bot/
RUN cd bot && npm ci --omit=dev

# Código + catálogo PDF (el bot lo envía cuando el cliente lo pide).
COPY bot ./bot
COPY docs/catalogo ./docs/catalogo

# Datos persistentes: el bot guarda chats, pedidos, anuncios y la sesión de WhatsApp.
RUN mkdir -p /app/bot/data /app/bot/.wwebjs_auth /app/bot/.wwebjs_cache

WORKDIR /app/bot
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/estado').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]