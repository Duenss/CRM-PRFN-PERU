#!/usr/bin/env node
/**
 * build.mjs — Genera el catálogo PDF navideño de Perfumería Fina Perú.
 *
 * Entrada : docs/catalogo/productos.json           (202 productos)
 * Salidas : docs/catalogo/catalogo.html            (HTML de depuración)
 *           docs/catalogo/catalogo-navidad-2026.pdf (PDF final, A4 vertical)
 *           docs/catalogo/catalogo-info.json       (metadatos para el bot)
 *           docs/catalogo/preview-portada.png
 *           docs/catalogo/preview-productos.png
 *
 * Uso:  node scripts/catalogo/build.mjs [--html-only]
 *
 * Maquetación (predecible): portada + bienvenida + por cada sección una
 * portadilla + páginas de 6 productos (2 columnas x 3 filas).
 *
 * Escritura permitida únicamente en scripts/catalogo/** y docs/catalogo/**.
 * Las imágenes se leen (nunca se escriben) desde el checkout del sitio:
 *   <repo>/assets/img/products/...            (si existiera dentro del repo)
 *   <repo>/../perfumeria-fina-peru/<ruta>     (checkout del sitio, actual)
 *   https://perfumeriafinaperu.com/<ruta>     (último recurso)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..', '..');

const OUT_DIR = path.join(REPO, 'docs', 'catalogo');
const DATA_FILE = path.join(OUT_DIR, 'productos.json');
const HTML_FILE = path.join(OUT_DIR, 'catalogo.html');
const PDF_FILE = path.join(OUT_DIR, 'catalogo-navidad-2026.pdf');
const INFO_FILE = path.join(OUT_DIR, 'catalogo-info.json');
const PREVIEW_COVER = path.join(OUT_DIR, 'preview-portada.png');
const PREVIEW_PRODUCTS = path.join(OUT_DIR, 'preview-productos.png');

const PDF_REL = 'docs/catalogo/catalogo-navidad-2026.pdf';
const TITULO = 'Catálogo Navidad 2026 · Perfumería Fina Perú';
const WHATSAPP = '+51 933 221 690';
const FOOTER_TXT = `Perfumería Fina Perú · WhatsApp ${WHATSAPP} · JV`;

const PER_PAGE = 6;                 // 2 columnas x 3 filas
const REMOTE_BASE = 'https://perfumeriafinaperu.com/';
const HTML_ONLY = process.argv.includes('--html-only');

/* ------------------------------------------------------------------ */
/* Secciones (orden fijo)                                             */
/* ------------------------------------------------------------------ */
const SECCIONES = [
  {
    key: 'disenador',
    nombre: 'Diseñador',
    etiqueta: 'Fragancias equivalentes de diseñador',
    acento: '#a2801c',
    acentoOscuro: '#8a6f18',
  },
  {
    key: 'arabe',
    nombre: 'Árabes',
    etiqueta: 'Fragancias equivalentes árabes',
    acento: '#6d1f2c',
    acentoOscuro: '#5a1823',
  },
  {
    key: 'nicho',
    nombre: 'Nicho',
    etiqueta: 'Fragancias equivalentes de nicho',
    acento: '#14503a',
    acentoOscuro: '#0f3d2c',
  },
];

/* ------------------------------------------------------------------ */
/* Utilidades                                                         */
/* ------------------------------------------------------------------ */
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** PRNG determinista: el catálogo se ve igual en cada compilación. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Notas recortadas a ~2 líneas: máx. 6 notas y ~68 caracteres. */
function notasCortas(notas, maxNotas = 6, maxChars = 68) {
  const partes = String(notas || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!partes.length) return 'Notas florales y amaderadas';
  const out = [];
  for (const p of partes) {
    const cand = [...out, p].join(' · ');
    if (out.length >= maxNotas || cand.length > maxChars) break;
    out.push(p);
  }
  if (!out.length) out.push(partes[0]);
  return out.join(' · ');
}

/** Copos de nieve dibujados con CSS (3 barras + centro), sin emojis. */
function copos(cantidad, seed, { color = '#c9a227', min = 10, max = 26, op = [0.1, 0.3] } = {}) {
  const rnd = mulberry32(seed);
  let html = '<div class="snow" aria-hidden="true">';
  for (let i = 0; i < cantidad; i++) {
    const size = (min + rnd() * (max - min)).toFixed(1);
    const top = (rnd() * 96).toFixed(2);
    const left = (rnd() * 96).toFixed(2);
    const rot = Math.round(rnd() * 60);
    const opv = (op[0] + rnd() * (op[1] - op[0])).toFixed(2);
    html +=
      `<span class="flake" style="--s:${size}px;--c:${color};--o:${opv};` +
      `top:${top}%;left:${left}%;transform:rotate(${rot}deg)">` +
      '<i></i><i style="transform:rotate(60deg)"></i><i style="transform:rotate(120deg)"></i>' +
      '</span>';
  }
  return html + '</div>';
}

/* ------------------------------------------------------------------ */
/* Imágenes: resolución local -> sitio hermano -> remoto              */
/* ------------------------------------------------------------------ */
const IMG_ROOTS = [
  // Copias optimizadas (peso bajo) que genera scripts/catalogo/optimizar-imagenes.py
  { root: path.join(REPO, 'docs', 'catalogo', 'img-opt'), mode: 'file' },
  { root: REPO, mode: 'file' },
  { root: path.resolve(REPO, '..', 'perfumeria-fina-peru'), mode: 'file' },
];

function resolverImagen(rutaRel) {
  const rel = String(rutaRel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^https?:\/\//i.test(rel)) return { url: rel, origen: 'remoto' };
  for (const { root } of IMG_ROOTS) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) return { url: pathToFileURL(abs).href, origen: path.basename(root), abs };
  }
  return { url: REMOTE_BASE + rel, origen: 'remoto', faltante: true };
}

/* ------------------------------------------------------------------ */
/* Utilidades de maquetación                                          */
/* ------------------------------------------------------------------ */
function pie(numero, total) {
  return (
    '<footer class="foot">' +
    `<span class="foot-txt">${esc(FOOTER_TXT)}</span>` +
    `<span class="foot-num">Página ${numero} de ${total}</span>` +
    '</footer>'
  );
}

function tarjeta(p, seccion) {
  const img = p._img;
  const genero = cap(String(p.genero || '').trim());
  return `
      <article class="card">
        <div class="ph"><img src="${esc(img.url)}" alt="${esc(p.nombre)}" loading="eager"></div>
        <div class="tx">
          <h3 class="pname">${esc(p.nombre)}${genero ? `<span class="gen">${esc(genero)}</span>` : ''}</h3>
          <p class="ins">Inspirado en: <b>${esc(p.casa_inspirada)}</b></p>
          <p class="fam">Familia olfativa: ${esc(p.familia_olfativa)}</p>
          <p class="notas">${esc(notasCortas(p.notas))}</p>
          <p class="precio">
            <span>50 ml <b>S/ ${esc(p.precio_50ml)}</b></span>
            <em>·</em>
            <span>100 ml <b>S/ ${esc(p.precio_100ml)}</b></span>
          </p>
        </div>
      </article>`;
}

function paginaProductos(items, seccion, numero, total) {
  const celdas = items.map((p) => tarjeta(p, seccion)).join('');
  return `
  <section class="page page-product sec-${seccion.key}" style="--accent:${seccion.acento};--accent-dark:${seccion.acentoOscuro}">
    <header class="phead">
      <span class="psec">${esc(seccion.nombre)}</span>
      <span class="pbrand">Catálogo Navidad 2026</span>
    </header>
    <div class="grid">${celdas}
    </div>
    ${pie(numero, total)}
  </section>`;
}

function paginaPortadilla(seccion, seccionIdx, info, numero, total) {
  return `
  <section class="page page-section sec-${seccion.key}" style="--accent:${seccion.acento};--accent-dark:${seccion.acentoOscuro}">
    ${copos(9, 700 + seccionIdx * 31, { color: seccion.acento, min: 12, max: 30, op: [0.08, 0.2] })}
    <div class="sec-bar sec-bar-top"></div>
    <div class="sec-bar sec-bar-bottom"></div>
    <div class="sec-inner">
      <p class="sec-eyebrow">Sección ${seccionIdx + 1} de ${SECCIONES.length}</p>
      <h2 class="sec-title">${esc(seccion.nombre)}</h2>
      <div class="orn orn-accent">
        <span class="orn-line"></span><span class="orn-gem"></span><span class="orn-line"></span>
      </div>
      <p class="sec-etiqueta">${esc(seccion.etiqueta)}</p>
      <p class="sec-count">${info.total} fragancias</p>
      <p class="sec-range">Páginas ${info.desde} – ${info.hasta}</p>
    </div>
    ${pie(numero, total)}
  </section>`;
}

function paginaPortada(totalProductos, total) {
  return `
  <section class="page page-cover">
    ${copos(22, 20261109, { color: '#c9a227', min: 9, max: 30, op: [0.08, 0.26] })}
    <div class="cover-frame"></div>
    <div class="cover-inner">
      <p class="eyebrow">Nueva colección</p>
      <h1 class="cover-title">Catálogo<br>Navidad 2026</h1>
      <div class="orn">
        <span class="orn-line"></span><span class="orn-gem"></span><span class="orn-line"></span>
      </div>
      <p class="cover-sub">Perfumería Fina Perú</p>
      <p class="cover-tag">“Fragancias equivalentes con 50% de esencia”</p>
    </div>
    <div class="cover-foot">
      <span class="cover-year">Edición 2026</span>
      <span class="cover-dot">·</span>
      <span>${totalProductos} fragancias</span>
      <span class="cover-dot">·</span>
      <span>50 ml y 100 ml</span>
    </div>
  </section>`;
}

function paginaBienvenida(secciones, totalProductos, total, precios) {
  const filas = secciones
    .map(
      (s) => `
        <li class="ix-row">
          <span class="ix-name">${esc(s.nombre)}</span>
          <span class="ix-dots"></span>
          <span class="ix-pages">págs. ${s.desde} – ${s.hasta}</span>
          <span class="ix-total">${s.total} fragancias</span>
        </li>`
    )
    .join('');

  const precio = (ml, valor) => `
      <div class="price-box">
        <span class="pb-ml">${ml}</span>
        <span class="pb-val">S/ ${valor}</span>
      </div>`;

  return `
  <section class="page page-welcome">
    <div class="wl-frame"></div>
    <div class="wl-inner">
      <p class="eyebrow eyebrow-dark">Bienvenida</p>
      <h2 class="wl-title">Una Navidad con aroma propio</h2>
      <div class="orn orn-dark">
        <span class="orn-line"></span><span class="orn-gem"></span><span class="orn-line"></span>
      </div>
      <p class="wl-letter">
        Esta Navidad queremos acompañarte con <b>${totalProductos} fragancias</b> seleccionadas:
        equivalentes de alta concentración, con <b>50% de esencia</b>, para que regales —o te regales—
        un aroma que dura todo el día. Cada frasco se inspira en las casas más queridas del mundo,
        elaborado y embotellado para Perfumería Fina Perú. Elige tu favorito, pide por WhatsApp
        y recíbelo listo para envolver.
      </p>

      <h3 class="wl-h3">Índice del catálogo</h3>
      <ul class="index">${filas}
      </ul>

      <div class="price-legend">
        <h3 class="wl-h3">Precios</h3>
        <div class="price-row">${precio('50 ml', precios.p50)}${precio('100 ml', precios.p100)}</div>
        <p class="price-note">Precios en soles (S/), válidos para toda la colección navideña 2026.</p>
      </div>

      <p class="legal">
        <b>Importante:</b> nuestras fragancias son <b>equivalentes inspirados en marcas reconocidas</b>;
        no son productos originales ni tienen vínculo con las casas mencionadas. Las marcas citadas
        pertenecen a sus respectivos titulares.
      </p>
    </div>
    ${pie(2, total)}
  </section>`;
}

/* ------------------------------------------------------------------ */
/* CSS                                                               */
/* ------------------------------------------------------------------ */
const CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; }
body {
  font-family: Arial, Helvetica, sans-serif;
  color: #231d15;
  background: #ffffff;
  font-size: 10pt;
}
.page {
  position: relative;
  width: 210mm;
  height: 297mm;
  overflow: hidden;
  page-break-after: always;
  break-after: page;
  page-break-inside: avoid;
  break-inside: avoid;
  background: #fbf7ef;
}
.page:last-child { page-break-after: auto; break-after: auto; }

/* ---------- ornamentos ---------- */
.orn { display: flex; align-items: center; justify-content: center; gap: 4mm; margin: 7mm 0; }
.orn-line { display: block; height: 0.5mm; width: 34mm; background: #c9a227; opacity: .85; }
.orn-line:first-child { background: linear-gradient(90deg, rgba(201,162,39,0), #c9a227); }
.orn-line:last-child { background: linear-gradient(90deg, #c9a227, rgba(201,162,39,0)); }
.orn-gem {
  display: block; width: 2.4mm; height: 2.4mm; background: #c9a227;
  transform: rotate(45deg);
}
.orn-accent .orn-line { background: var(--accent); }
.orn-accent .orn-line:first-child { background: linear-gradient(90deg, rgba(0,0,0,0), var(--accent)); }
.orn-accent .orn-line:last-child { background: linear-gradient(90deg, var(--accent), rgba(0,0,0,0)); }
.orn-accent .orn-gem { background: var(--accent); }
.orn-dark .orn-line { background: #c9a227; }
.orn-dark .orn-line:first-child { background: linear-gradient(90deg, rgba(201,162,39,0), #c9a227); }
.orn-dark .orn-line:last-child { background: linear-gradient(90deg, #c9a227, rgba(201,162,39,0)); }
.orn-dark .orn-gem { background: #c9a227; }

/* ---------- copos de nieve (CSS puro) ---------- */
.snow { position: absolute; inset: 0; overflow: hidden; }
.flake {
  position: absolute; width: var(--s); height: var(--s); opacity: var(--o);
  transform-origin: 50% 50%;
}
.flake i {
  position: absolute; left: 50%; top: 0; width: 0.4mm; height: 100%;
  margin-left: -0.2mm; background: var(--c); transform-origin: 50% 50%;
}
.flake::after {
  content: ''; position: absolute; left: 50%; top: 50%; width: 1.1mm; height: 1.1mm;
  margin: -0.55mm 0 0 -0.55mm; border-radius: 50%; background: var(--c);
}

/* ---------- pie de página ---------- */
.foot {
  position: absolute; left: 10mm; right: 10mm; bottom: 8mm;
  display: flex; align-items: baseline; justify-content: space-between;
  border-top: 0.4mm solid rgba(201, 162, 39, .55);
  padding-top: 2mm;
  font-size: 7.2pt; color: #6b6154; letter-spacing: .2px;
}
.foot-txt { text-align: left; }
.foot-num { text-align: right; white-space: nowrap; color: #8a7c66; }

/* ---------- portada ---------- */
.page-cover {
  background: radial-gradient(125% 95% at 50% 0%, #163a28 0%, #0f2a1d 52%, #0a1c13 100%);
  color: #f6efdd;
}
.cover-frame {
  position: absolute; inset: 9mm;
  border: 0.5mm solid rgba(201, 162, 39, .55);
  outline: 0.2mm solid rgba(201, 162, 39, .3);
  outline-offset: 1.6mm;
}
.cover-inner { position: absolute; left: 24mm; right: 24mm; top: 62mm; text-align: center; }
.eyebrow {
  margin: 0 0 8mm; font-size: 9pt; letter-spacing: 4.5px;
  text-transform: uppercase; color: #c9a227;
}
.cover-title {
  margin: 0; font-family: Georgia, 'Times New Roman', serif; font-weight: 400;
  font-size: 47pt; line-height: 1.08; letter-spacing: .5px; color: #f8f2e2;
}
.cover-sub {
  margin: 2mm 0 0; font-family: Georgia, 'Times New Roman', serif;
  font-size: 15pt; letter-spacing: 5px; text-transform: uppercase; color: #d9b95c;
}
.cover-tag {
  margin: 9mm auto 0; max-width: 130mm; font-style: italic;
  font-size: 12pt; line-height: 1.6; color: #e3d8bf;
}
.cover-foot {
  position: absolute; left: 24mm; right: 24mm; bottom: 26mm; text-align: center;
  font-size: 8.6pt; letter-spacing: 2.2px; text-transform: uppercase; color: #cbb877;
}
.cover-dot { color: #c9a227; padding: 0 2mm; }
.cover-year { color: #e9d9a3; }

/* ---------- bienvenida ---------- */
.page-welcome { background: #fbf7ef; }
.wl-frame { position: absolute; inset: 8mm; border: 0.4mm solid rgba(201, 162, 39, .5); }
.wl-inner { position: absolute; left: 20mm; right: 20mm; top: 19mm; bottom: 22mm; }
.eyebrow-dark { color: #a2801c; margin: 0 0 3mm; text-align: center; }
.wl-title {
  margin: 0; text-align: center; font-family: Georgia, 'Times New Roman', serif;
  font-weight: 400; font-size: 24pt; color: #1d1912;
}
.wl-letter {
  margin: 0 auto; max-width: 152mm; text-align: center;
  font-size: 9.6pt; line-height: 1.75; color: #443c31;
}
.wl-letter b { color: #1d1912; }
.wl-h3 {
  margin: 9mm 0 4mm; font-family: Georgia, 'Times New Roman', serif; font-weight: 400;
  font-size: 13pt; color: #1d1912; text-align: center; letter-spacing: .6px;
}
.index { list-style: none; margin: 0; padding: 0; }
.ix-row {
  display: flex; align-items: baseline; gap: 2mm;
  padding: 3.6mm 4mm; border-bottom: 0.2mm solid rgba(201, 162, 39, .35);
}
.ix-row:first-child { border-top: 0.2mm solid rgba(201, 162, 39, .35); }
.ix-name {
  font-family: Georgia, 'Times New Roman', serif; font-size: 13pt; color: #1d1912;
  min-width: 42mm;
}
.ix-dots {
  flex: 1; border-bottom: 0.25mm dotted rgba(140, 120, 70, .55); transform: translateY(-1mm);
}
.ix-pages { font-size: 9.5pt; color: #6d5f18; letter-spacing: .4px; white-space: nowrap; }
.ix-total { font-size: 9pt; color: #6b6154; min-width: 30mm; text-align: right; white-space: nowrap; }
.price-legend { margin-top: 4mm; }
.price-row { display: flex; gap: 6mm; justify-content: center; }
.price-box {
  width: 62mm; text-align: center; padding: 4mm 2mm;
  background: #ffffff; border: 0.35mm solid #cbb072; border-radius: 1.2mm;
}
.pb-ml { display: block; font-size: 8.4pt; letter-spacing: 2.4px; text-transform: uppercase; color: #6b6154; }
.pb-val {
  display: block; margin-top: 1.4mm; font-family: Georgia, 'Times New Roman', serif;
  font-size: 17pt; color: #8a6f18;
}
.price-note { margin: 3mm 0 0; text-align: center; font-size: 8pt; color: #6b6154; }
.legal {
  margin: 8mm auto 0; max-width: 158mm; text-align: center;
  font-size: 7.8pt; line-height: 1.6; color: #6b6154;
  border-top: 0.2mm solid rgba(201, 162, 39, .4); padding-top: 3.5mm;
}
.legal b { color: #4a4238; }

/* ---------- portadilla de sección ---------- */
.page-section { background: #fbf7ef; }
.sec-bar { position: absolute; left: 0; right: 0; height: 7mm; background: var(--accent); }
.sec-bar-top { top: 0; }
.sec-bar-bottom { bottom: 0; }
.sec-inner { position: absolute; left: 24mm; right: 24mm; top: 92mm; text-align: center; }
.sec-eyebrow {
  margin: 0 0 6mm; font-size: 8.6pt; letter-spacing: 4px; text-transform: uppercase;
  color: var(--accent);
}
.sec-title {
  margin: 0; font-family: Georgia, 'Times New Roman', serif; font-weight: 400;
  font-size: 44pt; line-height: 1.1; color: var(--accent-dark); letter-spacing: .5px;
}
.sec-etiqueta {
  margin: 0; font-size: 10pt; font-style: italic; color: #5d564a;
}
.sec-count {
  margin: 8mm 0 0; font-family: Georgia, 'Times New Roman', serif;
  font-size: 16pt; color: #1d1912;
}
.sec-range { margin: 2mm 0 0; font-size: 8.6pt; letter-spacing: 2.6px; text-transform: uppercase; color: #8a7c66; }

/* ---------- páginas de producto ---------- */
.page-product { background: #fbf7ef; }
.phead {
  position: absolute; left: 10mm; right: 10mm; top: 12mm;
  display: flex; align-items: baseline; justify-content: space-between;
  border-bottom: 0.5mm solid var(--accent);
  padding-bottom: 2mm;
}
.psec {
  font-family: Georgia, 'Times New Roman', serif; font-size: 13pt;
  letter-spacing: 2.4px; text-transform: uppercase; color: var(--accent-dark);
}
.pbrand { font-size: 7.6pt; letter-spacing: 2.4px; text-transform: uppercase; color: #8a7c66; }
.grid {
  position: absolute; left: 10mm; right: 10mm; top: 24mm; height: 244mm;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: repeat(3, 78mm);
  gap: 5mm 8mm;
}
.card {
  display: flex; gap: 3.5mm; padding: 3.5mm;
  background: #fffdf8;
  border: 0.35mm solid #cbb072;
  border-radius: 1.2mm;
  overflow: hidden;
}
.ph {
  flex: 0 0 30mm; width: 30mm; height: 40mm; align-self: center;
  border: 0.3mm solid #ddcaa0; border-radius: 0.8mm;
  background: #f4efe3; overflow: hidden;
}
.ph img { display: block; width: 100%; height: 100%; object-fit: cover; }
.tx {
  flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column;
  justify-content: center; gap: 1.2mm;
}
.pname {
  margin: 0; font-family: Georgia, 'Times New Roman', serif; font-weight: 700;
  font-size: 10.6pt; line-height: 1.18; color: #1d1912;
  overflow-wrap: break-word; word-break: break-word;
}
.gen {
  display: inline-block; margin-left: 1.6mm; vertical-align: 1.1mm;
  font-family: Arial, Helvetica, sans-serif; font-weight: 400;
  font-size: 6.2pt; letter-spacing: .6px; text-transform: uppercase;
  color: var(--accent-dark); border: 0.2mm solid #cbb072; border-radius: 4mm;
  padding: 0.3mm 1.3mm; white-space: nowrap;
}
.ins { margin: 0; font-size: 7.6pt; line-height: 1.3; color: #4a4238; }
.ins b { color: #1d1912; }
.fam { margin: 0; font-size: 7.6pt; line-height: 1.3; color: #4a4238; font-style: italic; }
.notas {
  margin: 0; font-size: 7.2pt; line-height: 1.32; color: #5d564a;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.precio {
  margin: 0.6mm 0 0; padding-top: 1.3mm;
  border-top: 0.25mm solid #e3d3aa;
  display: flex; align-items: baseline; gap: 1.6mm;
  font-size: 8.4pt; color: #231d15; white-space: nowrap;
}
.precio b { color: var(--accent-dark); font-size: 9pt; }
.precio em { color: #c0b189; font-style: normal; }
`;

/* ------------------------------------------------------------------ */
/* Generación del HTML                                                */
/* ------------------------------------------------------------------ */
function cargarProductos() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || !arr.length) throw new Error('productos.json vacío o inválido');

  const norm = arr.map((p) => ({
    ...p,
    nombre: String(p.nombre || '').trim() || String(p.id || ''),
    casa_inspirada: String(p.casa_inspirada || 'casa reconocida').trim(),
    familia_olfativa: String(p.familia_olfativa || 'Floral').trim(),
    genero: String(p.genero || '').trim().toLowerCase(),
    notas: String(p.notas || '').trim(),
    precio_50ml: Number(p.precio_50ml) || 56,
    precio_100ml: Number(p.precio_100ml) || 78,
    _img: resolverImagen(p.imagen_ruta),
  }));

  const porSeccion = {};
  let faltantes = 0;
  let remotos = 0;
  for (const s of SECCIONES) {
    porSeccion[s.key] = norm
      .filter((p) => String(p.categoria || '').trim().toLowerCase() === s.key)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true, sensitivity: 'base' }));
  }
  for (const p of norm) {
    if (p._img.faltante) faltantes++;
    else if (p._img.origen === 'remoto') remotos++;
  }
  const sinCategoria = norm.filter(
    (p) => !SECCIONES.some((s) => s.key === String(p.categoria || '').trim().toLowerCase())
  );
  return { productos: norm, porSeccion, faltantes, remotos, sinCategoria };
}

function generarHtml() {
  const { productos, porSeccion, faltantes, remotos, sinCategoria } = cargarProductos();

  // ---- paginación determinista ----
  let cursor = 2; // 1 = portada, 2 = bienvenida
  const infoSecciones = [];
  const plan = [];
  SECCIONES.forEach((s, idx) => {
    const items = porSeccion[s.key] || [];
    const paginasProductos = Math.ceil(items.length / PER_PAGE);
    const desde = cursor + 1; // portadilla
    const hasta = desde + paginasProductos;
    infoSecciones.push({
      nombre: s.nombre,
      desde,
      hasta,
      paginas: hasta - desde + 1, // portadilla + páginas de productos
      total: items.length,
      _paginasProductos: paginasProductos,
    });
    plan.push({ seccion: s, idx, items, desde, hasta, paginasProductos });
    cursor = hasta;
  });
  const totalPaginas = cursor;

  // ---- páginas ----
  const paginas = [];
  paginas.push(paginaPortada(productos.length, totalPaginas));
  paginas.push(paginaBienvenida(infoSecciones, productos.length, totalPaginas, { p50: 56, p100: 78 }));

  let numero = 3;
  for (const { seccion, idx, items, desde, hasta, paginasProductos } of plan) {
    paginas.push(
      paginaPortadilla(seccion, idx, { desde, hasta, total: items.length }, numero, totalPaginas)
    );
    numero++;
    for (let i = 0; i < paginasProductos; i++) {
      paginas.push(
        paginaProductos(items.slice(i * PER_PAGE, i * PER_PAGE + PER_PAGE), seccion, numero, totalPaginas)
      );
      numero++;
    }
  }
  if (numero - 1 !== totalPaginas) {
    throw new Error(`Descuadre de paginación: ${numero - 1} != ${totalPaginas}`);
  }

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${esc(TITULO)}</title>
<style>${CSS}</style>
</head>
<body>
${paginas.join('\n')}
</body>
</html>`;

  fs.writeFileSync(HTML_FILE, html, 'utf8');

  const seccionesInfo = infoSecciones.map(({ nombre, desde, hasta, paginas: pg, total }) => {
    // `desde` es la portadilla de la sección; el bot anuncia el rango de
    // páginas de PRODUCTO (desde+1) para que el cliente no caiga en la portadilla.
    const paginasProductos = Math.max(0, pg - 1);
    return {
      nombre,
      desde,
      hasta,
      productosDesde: paginasProductos > 0 ? desde + 1 : desde,
      productosHasta: hasta,
      paginas: pg,
      paginasProductos,
      total,
    };
  });

  return {
    html,
    totalPaginas,
    seccionesInfo,
    plan,
    productos,
    faltantes,
    remotos,
    sinCategoria,
  };
}

/* ------------------------------------------------------------------ */
/* Puppeteer                                                          */
/* ------------------------------------------------------------------ */
async function cargarPuppeteer() {
  const esmPath = path.join(REPO, 'bot', 'node_modules', 'puppeteer', 'lib', 'esm', 'puppeteer', 'puppeteer.js');
  try {
    const mod = await import(pathToFileURL(esmPath).href);
    const p = mod.default || mod;
    if (p && typeof p.launch === 'function') return p;
  } catch (err) {
    console.warn(`[aviso] import ESM de puppeteer falló (${err.message}); probando createRequire…`);
  }
  const require = createRequire(path.join(REPO, 'bot', 'package.json'));
  return require('puppeteer');
}

function encontrarChrome() {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const cache = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache)) {
      for (const rel of [
        ['chrome-win64', 'chrome.exe'],
        ['chrome-win32', 'chrome.exe'],
        ['chrome-linux64', 'chrome'],
        ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
      ]) {
        const exe = path.join(cache, d, ...rel);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  const alternos = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const a of alternos) if (fs.existsSync(a)) return a;
  return undefined;
}

function contarPaginasPdf(pdfPath) {
  const py = `
import sys, json
try:
    import fitz
except Exception:
    try:
        import pymupdf as fitz
    except Exception:
        print(json.dumps({"ok": False})); sys.exit(0)
d = fitz.open(r"${pdfPath.replace(/\\/g, '\\\\')}")
print(json.dumps({"ok": True, "paginas": d.page_count, "ancho": round(d[0].rect.width, 1), "alto": round(d[0].rect.height, 1)}))
`;
  for (const exe of ['python', 'py', 'python3']) {
    const r = spawnSync(exe, ['-c', py], { encoding: 'utf8' });
    if (r.error || r.status !== 0 || !r.stdout) continue;
    try {
      const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
      if (j.ok) return j;
    } catch {
      /* siguiente intérprete */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { totalPaginas, seccionesInfo, plan, productos, faltantes, remotos, sinCategoria } = generarHtml();

  console.log('── Catálogo Navidad 2026 · Perfumería Fina Perú ──');
  console.log(`Productos: ${productos.length}`);
  console.log(`HTML de depuración: ${path.relative(REPO, HTML_FILE)}`);
  console.log(`Imágenes: ${productos.length - faltantes} resueltas · ${faltantes} faltantes · ${remotos} por URL remota`);
  if (sinCategoria.length) {
    console.warn(`[aviso] ${sinCategoria.length} productos sin categoría conocida: ${sinCategoria.map((p) => p.id).join(', ')}`);
  }
  console.log(`\nPáginas totales: ${totalPaginas}`);
  for (const s of seccionesInfo) {
    const p = plan.find((x) => x.seccion.nombre === s.nombre);
    console.log(
      `  ${s.nombre.padEnd(11)} rango ${String(s.desde).padStart(2)}–${String(s.hasta).padStart(2)}` +
        ` · portadilla p.${s.desde} + ${p.paginasProductos} págs. de productos` +
        ` · ${s.total} fragancias · ${s.paginas} págs. de sección`
    );
  }

  // ---- metadatos para el bot ----
  const info = {
    archivo: PDF_REL,
    titulo: TITULO,
    paginas: totalPaginas,
    generado: new Date().toISOString(),
    secciones: seccionesInfo,
  };
  fs.writeFileSync(INFO_FILE, JSON.stringify(info, null, 2) + '\n', 'utf8');
  console.log(`\nMetadatos: ${path.relative(REPO, INFO_FILE)}`);

  if (faltantes > 0) {
    console.warn(
      `\n[aviso] ${faltantes} imagen(es) no encontradas en disco; se usarán URLs de ${REMOTE_BASE} ` +
        '(requieren red al renderizar).'
    );
  }

  if (HTML_ONLY) {
    console.log('\n--html-only: no se genera PDF ni previsualizaciones.');
    return;
  }

  // ---- PDF con Chrome headless ----
  const puppeteer = await cargarPuppeteer();
  const executablePath = encontrarChrome();
  console.log(`\nChrome: ${executablePath || '(el que resuelva puppeteer por defecto)'}`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files', '--font-render-hinting=none'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 1.6 });
    page.on('pageerror', (e) => console.warn(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => console.warn(`[requestfailed] ${r.url().slice(0, 120)}`));

    await page.goto(pathToFileURL(HTML_FILE).href, { waitUntil: 'load', timeout: 120000 });

    // esperar todas las imágenes
    const imgStats = await page.evaluate(async () => {
      const todas = () => Array.from(document.images);
      await Promise.all(
        todas()
          .filter((i) => !i.complete)
          .map(
            (i) =>
              new Promise((res) => {
                i.onload = i.onerror = res;
              })
          )
      );
      const rotas = todas().filter((i) => !i.naturalWidth);
      return {
        total: todas().length,
        rotas: rotas.length,
        detalle: rotas.slice(0, 10).map((i) => i.getAttribute('src')),
      };
    });
    console.log(`Imágenes en el DOM: ${imgStats.total} · rotas: ${imgStats.rotas}`);
    if (imgStats.detalle.length) console.warn('  ejemplos:', imgStats.detalle.join('\n           '));

    // ---- auditoría geométrica: desbordes, solapes, recortes y distorsión ----
    const layout = await page.evaluate(() => {
      const A4W = 793.7;
      const A4H = 1122.5; // 210x297 mm a 96 dpi
      const info = { paginas: 0, desbordes: [], solapes: [], tarjetas: [], ratioImg: 0, ratioPeor: 0 };

      const inter = (a, b) => {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return w > 1 && h > 1 ? { w, h } : null;
      };
      const clip = (el) => el.scrollHeight - el.clientHeight > 2 || el.scrollWidth - el.clientWidth > 2;

      const paginas = Array.from(document.querySelectorAll('.page'));
      info.paginas = paginas.length;

      paginas.forEach((pg, i) => {
        const n = i + 1;
        const pr = pg.getBoundingClientRect();
        if (pr.height > A4H + 1 || pr.width > A4W + 1) {
          info.desbordes.push(`p${n}: tamaño de página ${pr.width.toFixed(1)}x${pr.height.toFixed(1)}px`);
        }

        // 1) bloques semánticos que nunca deben solaparse entre sí
        const sels = [
          '.card',
          '.cover-inner',
          '.cover-foot',
          '.wl-title',
          '.wl-letter',
          '.index',
          '.price-legend',
          '.legal',
          '.sec-title',
          '.sec-etiqueta',
          '.sec-count',
          '.sec-range',
        ];
        const bloques = [];
        for (const s of sels) {
          pg.querySelectorAll(s).forEach((el) => bloques.push({ el, s, r: el.getBoundingClientRect() }));
        }
        for (let a = 0; a < bloques.length; a++) {
          for (let b = a + 1; b < bloques.length; b++) {
            const A = bloques[a];
            const B = bloques[b];
            if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
            const ov = inter(A.r, B.r);
            if (ov) {
              info.solapes.push(`p${n}: ${A.s} ∩ ${B.s} = ${ov.w.toFixed(0)}x${ov.h.toFixed(0)}px`);
            }
          }
        }

        // 2) el pie no debe invadir contenido
        const foot = pg.querySelector('.foot');
        const fr = foot ? foot.getBoundingClientRect() : null;
        if (fr) {
          for (const bq of bloques) {
            if (inter(fr, bq.r)) info.solapes.push(`p${n}: pie ∩ ${bq.s}`);
          }
        }

        // 3) tarjetas: imagen vs texto, contenido dentro de la tarjeta, sin recortes
        const cards = Array.from(pg.querySelectorAll('.card'));
        if (cards.length) info.tarjetas.push(cards.length);
        cards.forEach((card, ci) => {
          const cr = card.getBoundingClientRect();
          const ph = card.querySelector('.ph');
          const tx = card.querySelector('.tx');
          if (ph && tx) {
            const ov = inter(ph.getBoundingClientRect(), tx.getBoundingClientRect());
            if (ov) info.solapes.push(`p${n} tarjeta ${ci + 1}: imagen ∩ texto`);
          }
          card.querySelectorAll('.tx > *').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.right > cr.right - 1 || r.left < cr.left - 1 || r.bottom > cr.bottom + 0.5) {
              info.desbordes.push(`p${n} tarjeta ${ci + 1}: .${el.className} sale de la tarjeta`);
            }
            if (clip(el)) info.desbordes.push(`p${n} tarjeta ${ci + 1}: .${el.className} recortado`);
          });
          const img = card.querySelector('img');
          if (img && img.naturalWidth) {
            const r = img.getBoundingClientRect();
            const caja = r.width / r.height;
            const natural = img.naturalWidth / img.naturalHeight;
            const desv = Math.abs(caja - natural) / natural;
            if (desv > info.ratioPeor) info.ratioPeor = desv;
            info.ratioImg++;
          }
        });

        // 4) recortes en el resto de bloques de texto
        pg.querySelectorAll('.wl-letter, .legal, .ix-row, .ix-name, .ix-pages, .ix-total, .notas, .cover-title, .sec-title').forEach((el) => {
          if (clip(el)) info.desbordes.push(`p${n} · ${el.className} recortado (${el.scrollHeight}/${el.clientHeight})`);
        });
      });

      return info;
    });

    console.log(`Páginas en el DOM: ${layout.paginas}`);
    console.log(
      `Tarjetas por página: ${layout.tarjetas.length} páginas de producto · min ${Math.min(...layout.tarjetas)} · ` +
        `max ${Math.max(...layout.tarjetas)} · total ${layout.tarjetas.reduce((a, b) => a + b, 0)}`
    );
    console.log(
      `Imágenes con recorte uniforme: ${layout.ratioImg} · desviación máx. de proporción: ` +
        `${(layout.ratioPeor * 100).toFixed(2)}% (0% = sin deformar)`
    );
    if (layout.desbordes.length) {
      console.warn(`[aviso] desbordes/recortes (${layout.desbordes.length}) — revisar:`);
      layout.desbordes.slice(0, 15).forEach((d) => console.warn(`   - ${d}`));
    } else {
      console.log('✔ Sin desbordes ni textos recortados.');
    }
    if (layout.solapes.length) {
      console.warn(`[aviso] solapamientos (${layout.solapes.length}):`);
      layout.solapes.slice(0, 15).forEach((d) => console.warn(`   - ${d}`));
    } else {
      console.log('✔ Sin solapamientos entre tarjetas, textos y pie de página.');
    }

    await page.pdf({
      path: PDF_FILE,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    // ---- previsualizaciones PNG ----
    const shot = async (selector, file) => {
      const el = await page.$(selector);
      if (!el) return false;
      await el.screenshot({ path: file });
      return true;
    };
    await shot('.page-cover', PREVIEW_COVER);
    await shot('.page-product', PREVIEW_PRODUCTS);
    console.log(`Previews: ${path.relative(REPO, PREVIEW_COVER)} · ${path.relative(REPO, PREVIEW_PRODUCTS)}`);
  } finally {
    await browser.close();
  }

  // ---- verificación del PDF real ----
  const size = fs.statSync(PDF_FILE).size;
  const kb = (size / 1024).toFixed(0);
  console.log(`\nPDF: ${path.relative(REPO, PDF_FILE)} (${kb} KB)`);
  if (size < 200 * 1024) console.warn(`[aviso] el PDF pesa menos de 200 KB (${kb} KB).`);

  const real = contarPaginasPdf(PDF_FILE);
  if (real) {
    console.log(`Páginas reales del PDF (PyMuPDF): ${real.paginas} · primera página ${real.ancho}x${real.alto} pt`);
    if (real.paginas !== totalPaginas) {
      console.warn(`[aviso] el PDF tiene ${real.paginas} páginas y el cálculo era ${totalPaginas}.`);
    } else {
      console.log('✔ El número de páginas coincide con la paginación calculada.');
    }
  } else {
    console.log('(PyMuPDF no disponible: se informa el número de páginas calculado.)');
  }
}

main().catch((err) => {
  console.error('\n✖ Error:', err);
  process.exit(1);
});
