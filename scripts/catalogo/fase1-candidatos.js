#!/usr/bin/env node
/**
 * fase1-candidatos.js — Recolecta candidatos de imagen para cada perfume.
 *
 * Usa Bing Imágenes desde Edge (con ventana) porque Fragrantica bloquea
 * el scraping directo. Guarda hasta 8 candidatos por producto en
 * docs/catalogo/_imagenes-nuevas/candidatos.json.
 *
 * Uso:
 *   node fase1-candidatos.js [--limite N] [--solo id1,id2]
 */

const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CATALOGO = "C:\\Users\\Juan Pablo\\Documents\\WEB PROJECTS\\Crm Perfumeriafina\\docs\\catalogo";
const PRODUCTOS = path.join(CATALOGO, "productos.json");
const DESTINO = path.join(CATALOGO, "_imagenes-nuevas");
const SALIDA = path.join(DESTINO, "candidatos.json");

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const alAzar = (a, b) => a + Math.floor(Math.random() * (b - a));

(async () => {
  const args = process.argv.slice(2);
  const iLimite = args.indexOf("--limite");
  const iSolo = args.indexOf("--solo");

  let productos = JSON.parse(fs.readFileSync(PRODUCTOS, "utf8"));
  if (iSolo >= 0) {
    const ids = new Set(args[iSolo + 1].split(",").map((s) => s.trim()));
    productos = productos.filter((p) => ids.has(p.id));
  } else if (iLimite >= 0) {
    productos = productos.slice(0, Number(args[iLimite + 1]));
  }

  fs.mkdirSync(DESTINO, { recursive: true });
  const previo = fs.existsSync(SALIDA) ? JSON.parse(fs.readFileSync(SALIDA, "utf8")) : {};
  const hecho = new Set(Object.keys(previo));

  const pendientes = productos.filter((p) => !hecho.has(p.id));
  console.log(`Pendientes: ${pendientes.length} de ${productos.length}`);

  const browser = await chromium.launch({ executablePath: EDGE, headless: false, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "es-PE" });
  const page = await context.newPage();
  await page.goto("https://www.bing.com/images/search?q=perfume", { waitUntil: "domcontentloaded", timeout: 60000 });
  await dormir(2000);

  let n = 0;
  for (const p of pendientes) {
    n++;
    const consultas = [
      `"${p.nombre}" ${p.casa_inspirada || ""} perfume`.trim(),
      `"${p.nombre}" ${p.casa_inspirada || ""} eau de parfum`.trim(),
    ];
    let candidatos = [];

    for (const q of consultas) {
      try {
        await page.goto("https://www.bing.com/images/search?q=" + encodeURIComponent(q), {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await dormir(2200);
        const filas = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll("a.iusc").forEach((a) => {
            const m = a.getAttribute("m");
            if (!m) return;
            try {
              const j = JSON.parse(m);
              if (j.murl) out.push({ murl: j.murl, titulo: j.t || "", pagina: j.purl || "" });
            } catch (e) {}
          });
          return out;
        });
        if (filas.length > candidatos.length) candidatos = filas;
        if (candidatos.length >= 10) break;
      } catch (e) {
        /* reintenta con la siguiente consulta */
      }
      await dormir(alAzar(3000, 5000));
    }

    const limpio = [];
    const vistos = new Set();
    for (const c of candidatos) {
      if (vistos.has(c.murl)) continue;
      if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(c.murl)) continue;
      if (/logo|icon|sprite|banner|placeholder/i.test(c.murl)) continue;
      vistos.add(c.murl);
      limpio.push(c);
      if (limpio.length >= 8) break;
    }

    previo[p.id] = { id: p.id, nombre: p.nombre, casa: p.casa_inspirada, candidatos: limpio };
    fs.writeFileSync(SALIDA, JSON.stringify(previo, null, 1), "utf8");
    console.log(`[${n}/${pendientes.length}] ${p.id}: ${limpio.length} candidatos`);

    await dormir(alAzar(4000, 7000));
  }

  await browser.close();
  console.log(`\nListo: ${SALIDA}`);
})().catch((e) => {
  console.error("FALLO:", e.message);
  process.exit(1);
});
