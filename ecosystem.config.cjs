// PM2 · alternativa sin Docker (VPS con Node + Chromium instalado).
// Uso:  pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
//
// Requiere Chromium del sistema; si no está en la ruta por defecto,
// define CHROME_PATH en bot/.env.
module.exports = {
  apps: [
    {
      name: 'pf-bot',
      cwd: './bot',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: '900M',
      env: {
        NODE_ENV: 'production',
        HEADLESS: 'true',
        PORT: 3000
      },
      out_file: './logs/bot-out.log',
      error_file: './logs/bot-error.log',
      merge_logs: true,
      time: true
    }
  ]
};