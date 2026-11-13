// Smoke test de la demo local: comprueba que los módulos nuevos funcionan.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const puppeteer = require('../bot/node_modules/puppeteer');

const url = 'http://127.0.0.1:8090/docs/demo/index.html';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const errores = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', e => { errores.push(e.message); console.log('PAGEERROR:', e.message); });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });

  // Promociones: crear una nueva
  await page.click('[data-view="promos"]');
  await new Promise(r => setTimeout(r, 300));
  const antes = await page.$$eval('#promoList .promo', xs => xs.length);
  assert.ok(antes >= 2, `promos iniciales: ${antes}`);
  await page.click('#promoNew');
  await page.type('#pmTitle', 'Promo Vega');
  await page.type('#pmText', '2×100 ml S/ 140 · ideal regalo');
  await page.type('#pmPrice', 'S/ 140');
  await page.click('#promoSave');
  await new Promise(r => setTimeout(r, 300));
  const despues = await page.$$eval('#promoList .promo', xs => xs.length);
  assert.equal(despues, antes + 1, 'la promoción no se creó');

  // Bienvenida: preview en vivo con tokens y nombre Jordy
  await page.click('[data-view="bienvenida"]');
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => {
    const t = document.getElementById('bwText');
    t.value = '{saludo}, {nombre}. Bienvenido a Perfumería Fina ✨';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const preview = await page.$eval('#bwPreview', el => el.textContent);
  assert.match(preview, /Jordy/);
  assert.doesNotMatch(preview, /\{saludo\}|\{nombre\}/);

  // Respuestas rápidas: agregar una
  await page.click('[data-view="rapidas"]');
  await new Promise(r => setTimeout(r, 300));
  await page.type('#qTitle', 'Horario');
  await page.type('#qText', 'Atendemos 24/7 por WhatsApp');
  await page.click('#qSave');
  await new Promise(r => setTimeout(r, 300));
  const rapida = await page.$eval('#quickList', el => el.textContent);
  assert.match(rapida, /Horario/);

  // Layout fijo: el CRM no scrollea la página; solo el hilo de la bandeja
  await page.click('[data-view="bandeja"]');
  await new Promise(r => setTimeout(r, 300));
  const layout = await page.evaluate(() => {
    const content = document.querySelector('.content');
    const before = {
      sideTop: document.querySelector('.side').getBoundingClientRect().top,
      topTop: document.querySelector('.top').getBoundingClientRect().top,
      scrollY: window.scrollY,
      bodyOverflow: getComputedStyle(document.body).overflow,
      contentOverflow: getComputedStyle(content).overflowY
    };
    const m = document.getElementById('msgs');
    m.scrollTop = m.scrollHeight;
    const after = {
      sideTop: document.querySelector('.side').getBoundingClientRect().top,
      topTop: document.querySelector('.top').getBoundingClientRect().top,
      scrollY: window.scrollY
    };
    return { before, after };
  });
  assert.equal(layout.before.bodyOverflow, 'hidden', 'el body no debe scrollear');
  assert.equal(layout.before.contentOverflow, 'hidden', 'la bandeja no debe scrollear la página');
  assert.equal(layout.before.scrollY, 0);
  assert.equal(layout.after.scrollY, 0, 'el scroll del hilo movió la página');
  assert.equal(layout.after.topTop, layout.before.topTop, 'la cabecera se movió');
  assert.equal(layout.after.sideTop, layout.before.sideTop, 'el menú lateral se movió');

  // Recabar contacto desde la Bandeja con el botón de persona
  await page.click('#chatRecabar');
  await new Promise(r => setTimeout(r, 300));
  const recabar = await page.evaluate(() => ({
    titulo: document.getElementById('clienteModalTitle').textContent,
    nombre: document.getElementById('cmNombre').value,
    telefono: document.getElementById('cmTelefono').value,
    fuente: document.getElementById('cmFuente').value
  }));
  assert.match(recabar.titulo, /Recabar/);
  assert.match(recabar.nombre, /Jordy/);
  assert.ok(recabar.telefono.length >= 8);
  await page.click('#clienteCancel');

  // Pedidos: crear uno nuevo y cambiar estado
  await page.click('[data-view="pedidos"]');
  await new Promise(r => setTimeout(r, 400));
  const pedidosAntes = await page.$$eval('#pedidosBody tr', xs => xs.length);
  assert.ok(pedidosAntes >= 3, 'pedidos iniciales: ' + pedidosAntes);
  await page.click('#pedidoNew');
  await page.select('#pmCliente', 'c1');
  await page.select('#pmProducto', 'asad');
  await page.click('#pedidoSave');
  await new Promise(r => setTimeout(r, 400));
  const pedidosDespues = await page.$$eval('#pedidosBody tr', xs => xs.length);
  assert.equal(pedidosDespues, pedidosAntes + 1, 'el pedido no se creó');
  await page.click('[data-estado-toggle]');
  await new Promise(r => setTimeout(r, 200));
  await page.click('[data-estado="entregado"]');
  await new Promise(r => setTimeout(r, 300));
  const estados = await page.$$eval('.estado-pill', xs => xs.map(x => x.textContent));
  assert.ok(estados.some(e => /Entregado/.test(e)), 'estado no cambió con etiqueta legible');
  await page.click('[data-pfactura]');
  await new Promise(r => setTimeout(r, 300));
  const factura = await page.$eval('#facturaContenido', el => el.textContent);
  assert.match(factura, /Perfumería Fina/);
  assert.match(factura, /S\//);
  await page.click('#facturaClose');

  // Clientes: agregar uno nuevo
  await page.click('[data-view="clientes"]');
  await new Promise(r => setTimeout(r, 400));
  const clientesAntes = await page.$$eval('#clientesBody tr', xs => xs.length);
  await page.click('#clienteNew');
  await page.type('#cmNombre', 'Cliente Nuevo');
  await page.type('#cmTelefono', '+51 999 111 222');
  await page.type('#cmTags', 'prueba');
  await page.click('#clienteSave');
  await new Promise(r => setTimeout(r, 400));
  const clientesDespues = await page.$$eval('#clientesBody tr', xs => xs.length);
  assert.equal(clientesDespues, clientesAntes + 1, 'el cliente no se creó');
  const clientesTxt = await page.$eval('#clientesBody', el => el.textContent);
  assert.match(clientesTxt, /Cliente Nuevo/);

  // Catálogo y calendario
  await page.click('[data-view="catalogo"]');
  await new Promise(r => setTimeout(r, 600));
  const productos = await page.$$eval('#catalogoGrid .card', xs => xs.length);
  assert.ok(productos >= 100, 'catálogo incompleto: ' + productos);
  await page.click('[data-catdetalle]');
  await new Promise(r => setTimeout(r, 300));
  const fichaNotas = await page.$eval('#catNotas', el => el.textContent);
  const fichaOcasiones = await page.$eval('#catOcasiones', el => el.textContent);
  assert.ok(fichaNotas.length > 3, 'ficha sin notas olfativas');
  assert.ok(fichaOcasiones.length > 3, 'ficha sin ocasiones');
  await page.click('#catClose');
  await page.click('[data-view="calendario"]');
  await new Promise(r => setTimeout(r, 300));
  const dias = await page.$$eval('#calGrid .cal-day:not(.empty)', xs => xs.length);
  assert.ok(dias >= 28, 'calendario mensual incompleto: ' + dias);
  const eventosPedido = await page.$$eval('.cal-ev.pedido', xs => xs.length);
  assert.ok(eventosPedido >= 1, 'el calendario no muestra pedidos dentro de los días');
  // Programar campaña de una semana desde el calendario
  await page.click('#calNuevaCampana');
  await new Promise(r => setTimeout(r, 300));
  await page.select('#cpModo', 'semana');
  await page.evaluate(() => { document.getElementById('cpInicio').value = '2026-11-20'; document.getElementById('cpInicio').dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#cpSave');
  await new Promise(r => setTimeout(r, 400));
  const agenda = await page.$eval('#calendarioLista', el => el.textContent);
  assert.match(agenda, /Campaña/);
  const calendario = await page.$eval('#calendarioLista', el => el.textContent);
  assert.ok(calendario.length > 0);

  // Métricas y generación con IA en crecimiento
  await page.click('[data-view="metricas"]');
  await new Promise(r => setTimeout(r, 300));
  const metricas = await page.$eval('#v-metricas', el => el.textContent);
  assert.match(metricas, /Métricas completas/);
  assert.match(metricas, /Cómo vender más/);
  await page.click('[data-view="campanas"]');
  await new Promise(r => setTimeout(r, 300));
  await page.click('[data-ia="campana"]');
  await new Promise(r => setTimeout(r, 700));
  const campTexto = await page.$eval('#campTexto', el => el.value);
  assert.ok(campTexto.length > 20, 'la IA no generó el mensaje de campaña');

  // Compositor: pegar una imagen y enviarla
  await page.click('[data-view="bandeja"]');
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => {
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'producto.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(file);
    const ev = new Event('paste', { bubbles: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    document.getElementById('replyMsg').dispatchEvent(ev);
  });
  await new Promise(r => setTimeout(r, 200));
  const chips = await page.$$eval('#attachPreview .attach-chip', xs => xs.length);
  assert.equal(chips, 1, 'la imagen pegada no apareció como adjunto');
  await page.evaluate(() => {
    const files = [1, 2, 3].map(i => new File([new Uint8Array([37, 80, 68, 70])], `pdf${i}.pdf`, { type: 'application/pdf' }));
    const dt = new DataTransfer(); files.forEach(f => dt.items.add(f));
    const ev = new Event('paste', { bubbles: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    document.getElementById('replyMsg').dispatchEvent(ev);
  });
  await new Promise(r => setTimeout(r, 200));
  const pdfs = await page.$$eval('#attachPreview .attach-chip', xs => xs.filter(x => /pdf/i.test(x.textContent)).length);
  assert.equal(pdfs, 2, 'deben quedar máximo 2 PDF');
  const dep = await page.evaluate(() => { const b = document.getElementById('sendReply').getBoundingClientRect(); const el = document.elementFromPoint(b.x + b.width/2, b.y + b.height/2); return {x:b.x,y:b.y,w:b.width,h:b.height,ih:innerHeight, hit: el ? (el.id||el.className||el.tagName) : null}; });
  console.log('SEND RECT', JSON.stringify(dep));
  await page.click('#sendReply');
  await new Promise(r => setTimeout(r, 300));
  const hilo = await page.$eval('#msgs', el => el.textContent);
  console.log('HILO FINAL:', JSON.stringify(hilo.slice(-200)));
  assert.ok(hilo.includes('pdf'), 'los adjuntos no se enviaron al hilo');

  // Editor de promociones: vista previa y envío embebido
  await page.click('[data-view="promos"]');
  await new Promise(r => setTimeout(r, 300));
  await page.click('#promoNew');
  await page.type('#pmTitle', 'Promo Preview');
  await page.type('#pmText', '2×50 ml S/ 99');
  await page.click('#pmEmbed');
  await new Promise(r => setTimeout(r, 200));
  const modo = await page.$eval('#pmMode', el => el.textContent);
  assert.match(modo, /1 mensaje/);
  const previewPromo = await page.$eval('#pmPreview', el => el.textContent);
  assert.match(previewPromo, /2×50/);
  await page.click('#promoCancel');

  // Campañas: archivo propio + modo embebido
  await page.click('[data-view="campanas"]');
  await new Promise(r => setTimeout(r, 300));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-files-'));
  const png = path.join(tmpDir, 'promo.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  await (await page.$('#campFile')).uploadFile(png);
  await new Promise(r => setTimeout(r, 300));
  const campFileTxt = await page.$eval('#campFileName', el => el.textContent);
  assert.match(campFileTxt, /promo.png/);
  await page.select('#campEmbed', 'embebido');
  await page.type('#campTexto', 'Promo de prueba');
  const campPreview = await page.$eval('#campPreview', el => el.innerHTML);
  assert.match(campPreview, /<img/);

  // Anuncios: varios adjuntos, orden y excluir
  await page.click('[data-view="anuncios"]');
  await new Promise(r => setTimeout(r, 300));
  const pdf = path.join(tmpDir, 'dama.pdf'); fs.writeFileSync(pdf, Buffer.from('%PDF-1.4'));
  const pdf2 = path.join(tmpDir, 'varon.pdf'); fs.writeFileSync(pdf2, Buffer.from('%PDF-1.4'));
  await (await page.$('#anunFile')).uploadFile(png, pdf, pdf2);
  await new Promise(r => setTimeout(r, 400));
  const filas = await page.$$eval('#anunFiles .attach-row', xs => xs.length);
  assert.equal(filas, 3, 'anuncios: se esperaban 3 adjuntos');
  await page.click('[data-anun-down="0"]');
  await new Promise(r => setTimeout(r, 200));
  const primero = await page.$eval('#anunFiles .attach-row .name', el => el.textContent);
  assert.match(primero, /dama/);
  await page.click('[data-anun-incluir="2"]');
  await new Promise(r => setTimeout(r, 200));
  await page.click('#anunSend');

  // Pregunta diferida (IA) y meta de métricas
  await page.click('[data-view="ia"]');
  await new Promise(r => setTimeout(r, 300));
  const pd = await page.$('#pdMinutos');
  assert.ok(pd, 'falta pregunta diferida en IA');
  await page.evaluate(() => { document.getElementById('pdMinutos').value = '3'; document.getElementById('pdSave').click(); });
  await page.click('[data-view="metricas"]');
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => { document.getElementById('metaVentas').value = '5000'; document.getElementById('metaGuardar').click(); });
  const metaTxt = await page.$eval('#metaTexto', el => el.textContent);
  assert.match(metaTxt, /5[.,]?000/);
  assert.ok(await page.$('#qKeyword'), 'falta palabra clave en respuestas rápidas');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Modo oscuro
  await page.click('#themeBtn');
  const tema = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.equal(tema, 'dark');
  const oscuro = await page.evaluate(() => {
    const chip = document.querySelector('.chip');
    const content = document.querySelector('.content');
    return {
      chipBg: chip ? getComputedStyle(chip).backgroundColor : '',
      contentRight: content.getBoundingClientRect().right,
      ancho: innerWidth
    };
  });
  assert.notEqual(oscuro.chipBg, 'rgb(255, 255, 255)', 'los chips del chat deben adaptarse al modo oscuro');
  assert.ok(oscuro.contentRight >= oscuro.ancho - 40, 'el contenido no usa el ancho disponible');
  await page.click('[data-view="ajustes"]');
  const ajustes = await page.$eval('#v-ajustes', el => el.textContent);
  assert.match(ajustes, /Número para alertas/);

  console.log('DEMO SMOKE OK · promos', antes, '→', despues, '· theme', tema);
  assert.deepEqual(errores, [], 'errores JS: ' + errores.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}
