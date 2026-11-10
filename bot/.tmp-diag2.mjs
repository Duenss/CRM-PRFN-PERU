import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true });
await page.goto('https://crm-prfn-peru.pages.dev/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('#l-mail', { visible: true, timeout: 30000 });
await page.type('#l-mail', 'perfumeriafinaperu@gmail.com');
await page.type('#l-pass', 'admperfumeriafinaperu');
await page.click('#l-btn');
await page.waitForFunction(() => !document.getElementById('app')?.hidden, { timeout: 45000 });

for (const tab of ['campanas', 'inicio', 'analiticas']) {
  await page.evaluate(t => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
  await new Promise(r => setTimeout(r, 800));
  const info = await page.evaluate(() => {
    const out = [];
    const seccion = [...document.querySelectorAll('section.tab')].find(s => !s.hidden);
    if (!seccion) return out;
    const walk = (el, prof) => {
      if (prof > 6) return;
      const st = getComputedStyle(el);
      const desborda = el.scrollWidth > el.clientWidth + 2;
      if (desborda) {
        out.push({
          prof,
          tag: el.tagName,
          id: el.id || '',
          cls: String(el.className || '').slice(0, 40),
          sw: el.scrollWidth,
          cw: el.clientWidth,
          w: st.width,
          minW: st.minWidth,
          disp: st.display,
          gtc: st.gridTemplateColumns,
          ws: st.whiteSpace,
          hijos: [...el.children].slice(0, 4).map(c => ({ tag: c.tagName, id: c.id, cls: String(c.className).slice(0, 24), w: Math.round(c.getBoundingClientRect().width) }))
        });
      }
      for (const c of el.children) walk(c, prof + 1);
    };
    walk(seccion, 0);
    return out.slice(0, 12);
  });
  console.log('== ' + tab);
  for (const i of info) console.log(JSON.stringify(i));
}
await browser.close();
