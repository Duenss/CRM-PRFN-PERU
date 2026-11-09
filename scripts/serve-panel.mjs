#!/usr/bin/env node
/**
 * Servidor estático mínimo para probar el panel en local.
 * Uso:  node scripts/serve-panel.mjs [puerto]   (por defecto 8080)
 *
 * Sirve el repo (index.html y assets) sin dependencias externas.
 * En producción el panel va en Cloudflare Pages; esto es solo para QA local.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PANEL_PORT || 8080);
const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let ruta = decodeURIComponent(url.pathname);
    if (ruta === '/' || ruta === '') ruta = '/index.html';
    const archivo = path.join(ROOT, ruta);
    if (!archivo.startsWith(ROOT)) { res.writeHead(403); res.end('Prohibido'); return; }
    if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado: ' + ruta);
      return;
    }
    const ext = path.extname(archivo).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(archivo).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Error: ' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Panel local: http://127.0.0.1:${PORT}/index.html`);
  console.log(`Bot esperado en: http://localhost:3000`);
});
