#!/usr/bin/env node
/**
 * cosechar-fragrantica.js — Descarga la foto real de cada perfume desde
 * Fragrantica y la guarda en docs/catalogo/_imagenes-nuevas/.
 *
 * Cómo funciona:
 *   1. Abre Fragrantica con Edge (con ventana) para pasar Cloudflare.
 *   2. Busca "<nombre> <casa>" en /search/?q=...
 *   3. Elige la ficha cuyo nombre y marca coinciden mejor con el producto.
 *   4. Descarga la foto oficial: https://fimgs.net/mdimg/perfume/o.<id>.jpg
 *      (descarga directa, sin navegador: fimgs.net no está protegido).
 *
 * Garantías:
 *   - No repite imagen: si el hash ya está usado, pasa a la siguiente candidata.
 *   - Reanudable: guarda el informe y salta los productos ya resueltos.
 *   - Pausas largas y reintentos cuando Cloudflare muestra el reto.
 *
 * Uso:
 *   node cosechar-fragrantica.js [--limite N] [--solo id1,id2]
 */

const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CATALOGO = "C:\\Users\\Juan Pablo\\Documents\\WEB PROJECTS\\Crm Perfumeriafina\\docs\\catalogo";
const PRODUCTOS = path.join(CATALOGO, "productos.json");
const DESTINO = path.join(CATALOGO, "_imagenes-nuevas");
const INFORME = path.join(DESTINO, "informe-fragrantica.json");

const PAUSA_MIN = 12000;
const PAUSA_MAX = 22000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const alAzar = (min, max) => min + Math.floor(Math.random() * (max - min));

function puntuar(producto, candidato) {
  const nProd = norm(producto.nombre);
  const nCand = norm(candidato.slug.replace(/-/g, " "));
  let score = 0;
  if (nProd === nCand) score = 100;
  else if (nCand.includes(nProd)) score = 85;
  else if (nProd.includes(nCand)) score = 70;
  else {
    const a = new Set(nProd.split(" "));
    const b = new Set(nCand.split(" "));
    let comunes = 0;
    a.forEach((w) => b.has(w) && w.length > 2 && comunes++);
    score = comunes * 12;
  }
  const casa = norm(producto.casa_inspirada);
  const marca = norm(candidato.brand);
  if (casa && marca) {
    if (casa === marca) score += 40;
    else if (casa.includes(marca) || marca.includes(casa)) score += 20;
    else {
      const a = new Set(casa.split(" "));
      const b = new Set(marca.split(" "));
      let c = 0;
      a.forEach((w) => b.has(w) && w.length > 2 && c++);
      score += c * 10;
    }
  }
  return score;
}

async function esperarLibre(page) {
  for (let i = 0; i < 20; i++) {
    const titulo = await page.title().catch(() => "");
    if (!/just a moment|attention required|checking your browser/i.test(titulo)) return true;
    await dormir(3000);
  }
  return false;
}

async function buscar(page, consulta) {
  await page.goto("https://www.fragrantica.com/search/?q=" + encodeURIComponent(consulta), {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await esperarLibre(page);
  await dormir(2500);
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href*="/perfume/"]').forEach((a) => {
      const m = a.getAttribute("href").match(/\/perfume\/([^/]+)\/([^/]+)-(\d+)\.html/);
      if (m) out.push({ brand: m[1], slug: m[2], id: m[3] });
    });
    const vistos = new Set();
    return out.filter((r) => (vistos.has(r.id) ? false : (vistos.add(r.id), true)));
  });
}

async function descargarImagen(id) {
  const url = `https://fimgs.net/mdimg/perfume/o.${id}.jpg`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 15000) throw new Error(`imagen muy pequeña (${buf.length}b)`);
  return { buf, url };
}

(async () => {
  const args = process.argv.slice(2);
  const idxLimite = args.indexOf("--limite");
  const idxSolo = args.indexOf("--solo");

  let productos = JSON.parse(fs.readFileSync(PRODUCTOS, "utf8"));
  if (idxSolo >= 0) {
    const ids = new Set(args[idxSolo + 1].split(",").map((s) => s.trim()));
    productos = productos.filter((p) => ids.has(p.id));
  } else if (idxLimite >= 0) {
    productos = productos.slice(0, Number(args[idxLimite + 1]));
  }

  fs.mkdirSync(DESTINO, { recursive: true });
  const informe = fs.existsSync(INFORME) ? JSON.parse(fs.readFileSync(INFORME, "utf8")) : [];
  const porId = new Map(informe.map((r) => [r.id, r]));
  const hashesUsados = new Map();
  informe.forEach((r) => r.hash && hashesUsados.set(r.hash, r.id));

  const browser = await chromium.launch({ executablePath: EDGE, headless: false, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "en-US", userAgent: UA });
  const page = await context.newPage();

  let ok = 0;
  let fallos = 0;

  for (let i = 0; i < productos.length; i++) {
    const p = productos[i];
    const previo = porId.get(p.id);
    if (previo && previo.estado === "ok") {
      console.log(`[${i + 1}/${productos.length}] ${p.id}: ya listo`);
      continue;
    }

    const etiqueta = `[${i + 1}/${productos.length}] ${p.id}`;
    const registro = { id: p.id, nombre: p.nombre, casa: p.casa_inspirada, estado: "sin_resultado" };

    const consultas = [
      `${p.nombre} ${p.casa_inspirada || ""}`.trim(),
      `${p.nombre}`.trim(),
    ];

    let candidatos = [];
    for (const consulta of consultas) {
      try {
        const filas = await buscar(page, consulta);
        candidatos = filas
          .map((f) => ({ ...f, score: puntuar(p, f) }))
          .filter((f) => f.score >= 45)
          .sort((a, b) => b.score - a.score);
        if (candidatos.length) break;
      } catch (e) {
        registro.detalle = "error búsqueda: " + e.message;
      }
      await dormir(alAzar(6000, 10000));
    }

    if (!candidatos.length) {
      registro.estado = "sin_resultado";
      porId.set(p.id, registro);
      fallos++;
      console.log(`${etiqueta}: sin resultado`);
      await dormir(alAzar(PAUSA_MIN, PAUSA_MAX));
      continue;
    }

    for (const cand of candidatos.slice(0, 4)) {
      try {
        const { buf, url } = await descargarImagen(cand.id);
        const hash = crypto.createHash("md5").update(buf).digest("hex");
        if (hashesUsados.has(hash)) {
          registro.detalle = `imagen repetida con ${hashesUsados.get(hash)}`;
          continue;
        }
        fs.writeFileSync(path.join(DESTINO, `${p.id}.jpg`), buf);
        hashesUsados.set(hash, p.id);
        Object.assign(registro, {
          estado: "ok",
          fragId: cand.id,
          fragUrl: `https://www.fragrantica.com/perfume/${cand.brand}/${cand.slug}-${cand.id}.html`,
          imagen: `https://fimgs.net/mdimg/perfume/o.${cand.id}.jpg`,
          slug: cand.slug,
          score: cand.score,
          bytes: buf.length,
          hash,
        });
        break;
      } catch (e) {
        registro.detalle = `descarga fallida (${cand.id}): ${e.message}`;
      }
    }

    if (registro.estado !== "ok") registro.estado = registro.estado || "sin_candidata";
    porId.set(p.id, registro);
    if (registro.estado === "ok") ok++;
    else fallos++;

    console.log(`${etiqueta}: ${registro.estado}${registro.fragId ? " · id " + registro.fragId + " · score " + registro.score : ""}`);

    fs.writeFileSync(INFORME, JSON.stringify([...porId.values()], null, 2), "utf8");
    await dormir(alAzar(PAUSA_MIN, PAUSA_MAX));
  }

  fs.writeFileSync(INFORME, JSON.stringify([...porId.values()], null, 2), "utf8");
  await browser.close();
  console.log(`\nResumen: ${ok} nuevas · ${fallos} sin resolver`);
  console.log(`Informe: ${INFORME}`);
})().catch((e) => {
  console.error("FALLO:", e.message);
  process.exit(1);
});
