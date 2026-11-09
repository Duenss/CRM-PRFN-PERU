/**
 * server.mjs — Servidor local del editor de catálogo.
 *
 * Sirve una página para editar productos.json (textos, precios, fotos) y
 * regenerar el PDF sin tocar la línea de comandos.
 *
 * Uso:
 *   node scripts/catalogo/editor/server.mjs
 *   → http://127.0.0.1:4321
 *
 * Solo escucha en 127.0.0.1 (tu máquina), no se expone a internet.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const CATALOGO = path.join(REPO, "docs", "catalogo");
const PRODUCTOS = path.join(CATALOGO, "productos.json");
const IMG_OPT = path.join(CATALOGO, "img-opt");
const EDITOR_HTML = path.join(__dirname, "index.html");
const BUILD = path.join(REPO, "scripts", "catalogo", "build.mjs");
const PDF = path.join(CATALOGO, "catalogo-navidad-2026.pdf");
const SITIO_IMGS = path.join(REPO, "..", "..", "EXTRAS", "perfumeria-fina-peru", "assets", "img", "products");

const PUERTO = Number(process.env.PUERTO || 4321);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function json(res, codigo, dato) {
  const cuerpo = JSON.stringify(dato);
  res.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(cuerpo) });
  res.end(cuerpo);
}

function leerCuerpo(req, limite = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on("data", (trozo) => {
      total += trozo.length;
      if (total > limite) {
        reject(new Error("Cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      partes.push(trozo);
    });
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf8")));
    req.on("error", reject);
  });
}

function leerProductos() {
  return JSON.parse(fs.readFileSync(PRODUCTOS, "utf8"));
}

function guardarProductos(lista) {
  fs.writeFileSync(PRODUCTOS, JSON.stringify(lista, null, 2), "utf8");
}

/** Guarda una imagen base64 en el catálogo y, si existe, en el sitio. */
function guardarImagen(dataUrl, rutaRel) {
  const m = /^data:image\/(\w+);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error("Formato de imagen no válido");
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length < 5000) throw new Error("La imagen es demasiado pequeña");
  if (buffer.length > 8 * 1024 * 1024) throw new Error("La imagen supera 8 MB");

  const destinos = [];
  const cat = path.join(IMG_OPT, rutaRel.replace(/\//g, path.sep));
  if (fs.existsSync(path.dirname(cat))) destinos.push(cat);
  const web = path.join(SITIO_IMGS, path.basename(rutaRel));
  if (fs.existsSync(path.dirname(web))) destinos.push(web);
  if (!destinos.length) throw new Error(`No existe la carpeta para ${rutaRel}`);

  for (const d of destinos) fs.writeFileSync(d, buffer);
  return { bytes: buffer.length, destinos: destinos.length };
}

function correrBuild() {
  return new Promise((resolve) => {
    const entorno = { ...process.env };
    if (!entorno.CHROME_PATH) {
      const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
      if (fs.existsSync(edge)) entorno.CHROME_PATH = edge;
    }
    const hijo = spawn(process.execPath, [BUILD], { cwd: REPO, env: entorno });
    let salida = "";
    hijo.stdout.on("data", (d) => (salida += d.toString()));
    hijo.stderr.on("data", (d) => (salida += d.toString()));
    hijo.on("close", (codigo) => {
      const ok = codigo === 0 && fs.existsSync(PDF);
      resolve({ ok, codigo, salida: salida.slice(-4000), pdf: ok ? fs.statSync(PDF).size : null });
    });
  });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PUERTO}`);
  const ruta = decodeURIComponent(url.pathname);

  try {
    // Página del editor
    if (req.method === "GET" && (ruta === "/" || ruta === "/index.html")) {
      const html = fs.readFileSync(EDITOR_HTML);
      res.writeHead(200, { "Content-Type": MIME[".html"], "Content-Length": html.length });
      return res.end(html);
    }

    // Datos del catálogo
    if (req.method === "GET" && ruta === "/api/productos") {
      const lista = leerProductos();
      return json(res, 200, { productos: lista, actualizado: fs.statSync(PRODUCTOS).mtimeMs });
    }

    // Guardar cambios de texto
    if (req.method === "POST" && ruta === "/api/productos") {
      const cuerpo = JSON.parse(await leerCuerpo(req));
      if (!Array.isArray(cuerpo.productos)) return json(res, 400, { error: "Falta el arreglo productos" });
      guardarProductos(cuerpo.productos);
      return json(res, 200, { ok: true, total: cuerpo.productos.length });
    }

    // Cambiar una foto
    if (req.method === "POST" && ruta === "/api/imagen") {
      const cuerpo = JSON.parse(await leerCuerpo(req));
      const resultado = guardarImagen(cuerpo.dataUrl, cuerpo.ruta);
      return json(res, 200, { ok: true, ...resultado });
    }

    // Regenerar el PDF
    if (req.method === "POST" && ruta === "/api/build") {
      const r = await correrBuild();
      return json(res, 200, r);
    }

    // Descargar el PDF
    if (req.method === "GET" && ruta === "/pdf") {
      if (!fs.existsSync(PDF)) return json(res, 404, { error: "Todavía no hay PDF generado" });
      const datos = fs.readFileSync(PDF);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": datos.length,
        "Content-Disposition": 'attachment; filename="catalogo-navidad-2026.pdf"',
      });
      return res.end(datos);
    }

    // Imágenes del catálogo
    if (req.method === "GET" && ruta.startsWith("/img/")) {
      const nombre = path.basename(ruta);
      const archivo = path.join(IMG_OPT, "assets", "img", "products", nombre);
      if (!fs.existsSync(archivo)) return json(res, 404, { error: "Imagen no encontrada" });
      const datos = fs.readFileSync(archivo);
      res.writeHead(200, { "Content-Type": MIME[path.extname(nombre).toLowerCase()] || "application/octet-stream", "Content-Length": datos.length });
      return res.end(datos);
    }

    return json(res, 404, { error: "Ruta no encontrada" });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

servidor.listen(PUERTO, "127.0.0.1", () => {
  console.log(`Editor del catálogo: http://127.0.0.1:${PUERTO}`);
  console.log(`Productos: ${PRODUCTOS}`);
  console.log("Ctrl+C para detener.");
});
