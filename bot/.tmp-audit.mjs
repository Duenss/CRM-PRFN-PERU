import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const TABS = ['inicio', 'bandeja', 'pedidos', 'analiticas', 'campanas', 'anuncios', 'clientes', 'catalogo', 'calendario', 'ia', 'bot'];
const ANCHOS = [360, 768, 1280];
const SALIDA = 'C:/Users/Juan Pablo/Documents/WEB PROJECTS/Crm Perfumeriafina/docs/auditoria/capturas/responsive';
fs.mkdirSync(SALIDA, { recursive: true });

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errores = [];
page.on('pageerror', e => errores.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errores.push('console: ' + m.text()); });

await page.setViewport({ width: 1280, height: 900 });
await page.goto('https://crm-prfn-peru.pages.dev/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('#l-mail', { visible: true, timeout: 30000 });
await page.type('#l-mail', 'perfumeriafinaperu@gmail.com');
await page.type('#l-pass', 'admperfumeriafinaperu');
await page.click('#l-btn');
await page.waitForFunction(() => !document.getElementById('app')?.hidden, { timeout: 45000 });

const reporte = [];
for (const ancho of ANCHOS) {
  await page.setViewport({ width: ancho, height: 800, isMobile: ancho < 500, hasTouch: ancho < 500 });
  for (const tab of TABS) {
    await page.evaluate(t => {
      const b = document.querySelector(`[data-tab="${t}"]`);
      if (b) b.click();
    }, tab);
    await new Promise(r => setTimeout(r, 700));
    const datos = await page.evaluate(() => {
      const doc = document.documentElement;
      const desborde = doc.scrollWidth - window.innerWidth;
      // Elementos interactivos pequeños (menos de 44x44).
      const pequenos = [...document.querySelectorAll('button, a, input[type=checkbox], select, [role=button]')]
        .filter(el => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          const st = getComputedStyle(el);
          if (st.visibility === 'hidden' || st.display === 'none') return false;
          return r.width < 40 || r.height < 40;
        })
        .map(el => ({ tag: el.tagName, txt: (el.textContent || el.id || '').trim().slice(0, 22), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }));
      // Contenedores que desbordan horizontalmente.
      const desbordan = [...document.querySelectorAll('section, div, table')]
        .filter(el => el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0 && getComputedStyle(el).overflowX !== 'auto' && getComputedStyle(el).overflowX !== 'scroll')
        .slice(0, 6)
        .map(el => ({ id: el.id || el.className.toString().slice(0, 24), sw: el.scrollWidth, cw: el.clientWidth }));
      return { desborde, pequenos: pequenos.slice(0, 12), desbordan };
    });
    await page.screenshot({ path: path.join(SALIDA, `${String(ancho)}-${tab}.png`) });
    reporte.push({ ancho, tab, ...datos });
  }
}

fs.writeFileSync(path.join(SALIDA, 'reporte.json'), JSON.stringify(reporte, null, 2), 'utf8');
// Resumen en consola
for (const r of reporte) {
  const flags = [];
  if (r.desborde > 0) flags.push(`desborde ${r.desborde}px`);
  if (r.pequenos.length) flags.push(`${r.pequenos.length} pequeños`);
  if (r.desbordan.length) flags.push(`${r.desbordan.length} contenedores`);
  if (flags.length) console.log(`${r.ancho}px ${r.tab}: ` + flags.join(' · '));
}
console.log('errores JS:', errores.slice(0, 5));
await browser.close();
