// Capturas de la maqueta local (sin tocar el panel real).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('../bot/node_modules/puppeteer');
const raiz = path.resolve(import.meta.dirname, '..');
const salida = path.join(raiz, 'docs', 'demo', 'capturas');
const url = process.env.DEMO_URL || 'http://127.0.0.1:8090/docs/demo/index.html';
fs.mkdirSync(salida, { recursive: true });

const navegador = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const errores = [];
try {
  const page = await navegador.newPage();
  page.on('pageerror', e => errores.push(e.message));
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 500));
  const vistas = [
    ['inicio', null],
    ['metricas', '[data-view="metricas"]'],
    ['bandeja', '[data-view="bandeja"]'],
    ['promos', '[data-view="promos"]'],
    ['bienvenida', '[data-view="bienvenida"]'],
    ['rapidas', '[data-view="rapidas"]'],
    ['campanas', '[data-view="campanas"]'],
    ['anuncios', '[data-view="anuncios"]'],
    ['ia', '[data-view="ia"]'],
    ['pedidos', '[data-view="pedidos"]'],
    ['clientes', '[data-view="clientes"]'],
    ['catalogo', '[data-view="catalogo"]'],
    ['calendario', '[data-view="calendario"]'],
    ['ajustes', '[data-view="ajustes"]'],
  ];
  for (const [nombre, selector] of vistas) {
    if (selector) {
      await page.click(selector);
      await new Promise(r => setTimeout(r, 400));
      if (nombre === 'bandeja') { await page.evaluate(() => { const m = document.getElementById('msgs'); if (m) m.scrollTop = m.scrollHeight; }); await new Promise(r => setTimeout(r, 300)); }
    }
    await page.screenshot({ path: path.join(salida, `${nombre}-1440.png`), fullPage: false });
    if (nombre === 'promos') {
      await page.click('#promoList [data-act="edit"]');
      await new Promise(r => setTimeout(r, 450));
      await page.screenshot({ path: path.join(salida, 'promo-editor-1440.png'), fullPage: false });
      await page.click('#promoCancel');
    }
    if (nombre === 'pedidos') {
      await page.click('[data-estado-toggle]');
      await new Promise(r => setTimeout(r, 250));
      await page.screenshot({ path: path.join(salida, 'pedidos-estado-1440.png'), fullPage: false });
      await page.click('#v-pedidos h2');
      await page.click('[data-pfactura]');
      await new Promise(r => setTimeout(r, 300));
      await page.screenshot({ path: path.join(salida, 'factura-1440.png'), fullPage: false });
      await page.click('#facturaClose');
    }
    if (nombre === 'clientes') {
      await page.click('#clienteNew');
      await new Promise(r => setTimeout(r, 300));
      await page.screenshot({ path: path.join(salida, 'recabar-contacto-1440.png'), fullPage: false });
      await page.click('#clienteCancel');
    }
    if (nombre === 'campanas') {
      await page.type('#campNombre', 'Campaña semana');
      await page.click('#campSend');
      await new Promise(r => setTimeout(r, 300));
      await page.screenshot({ path: path.join(salida, 'campana-programar-1440.png'), fullPage: false });
      await page.click('#cpCancel');
    }
  }
  // Modo oscuro funcional
  await page.click('[data-view="inicio"]');
  await new Promise(r => setTimeout(r, 300));
  await page.click('#themeBtn');
  await new Promise(r => setTimeout(r, 450));
  await page.screenshot({ path: path.join(salida, 'inicio-oscuro-1440.png'), fullPage: false });
  await page.click('[data-view="bandeja"]');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(salida, 'bandeja-oscuro-1440.png'), fullPage: false });
  await page.click('#themeBtn');
  await new Promise(r => setTimeout(r, 300));
  // Móvil
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.click('#menuBtn');
  await new Promise(r => setTimeout(r, 300));
  await page.click('[data-view="inicio"]');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(salida, 'inicio-390.png'), fullPage: false });
  await page.click('#menuBtn');
  await new Promise(r => setTimeout(r, 300));
  await page.click('[data-view="bandeja"]');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(salida, 'bandeja-390.png'), fullPage: false });
  console.log('capturas OK:', fs.readdirSync(salida).join(', '));
  if (errores.length) console.log('pageerrors:', errores.slice(0, 3));
} finally {
  await navegador.close();
}
