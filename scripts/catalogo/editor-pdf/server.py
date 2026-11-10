#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
server.py — Editor de PDF local (texto, color y fotos).

Abre el PDF del catálogo (o uno subido), lo muestra por páginas y permite:
  · clic en un texto  -> editarlo (mismo tamaño, color y tipografía)
  · clic en una foto  -> reemplazarla
  · guardar -> genera un PDF nuevo con los parches

Uso:
    python scripts/catalogo/editor-pdf/server.py
    → http://127.0.0.1:4322
"""

import base64
import http.server
import json
import os
import re
import socketserver
import sys
import tempfile
import urllib.parse

import pymupdf as fitz

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PDF_ORIGEN = os.path.join(REPO, "docs", "catalogo", "catalogo-navidad-2026.pdf")
PDF_SALIDA = os.path.join(REPO, "docs", "catalogo", "catalogo-editado.pdf")
AQUI = os.path.dirname(os.path.abspath(__file__))
PUERTO = int(os.environ.get("PUERTO", 4322))

SESION = {"doc": None, "ruta": None, "tmp": None}
FUENTES_CACHE = {}

DIR_FUENTES = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")

# Tipografías reales que usa el PDF, por familia y estilo.
FAMILIAS = {
    "georgia": {"normal": "georgia.ttf", "bold": "georgiab.ttf", "italic": "georgiai.ttf", "bolditalic": "georgiaz.ttf"},
    "arial": {"normal": "arial.ttf", "bold": "arialbd.ttf", "italic": "ariali.ttf", "bolditalic": "arialbi.ttf"},
    "times": {"normal": "times.ttf", "bold": "timesbd.ttf", "italic": "timesi.ttf", "bolditalic": "timesbi.ttf"},
    "courier": {"normal": "cour.ttf", "bold": "courbd.ttf", "italic": "couri.ttf", "bolditalic": "courbi.ttf"},
    "calibri": {"normal": "calibri.ttf", "bold": "calibrib.ttf", "italic": "calibrii.ttf", "bolditalic": "calibriz.ttf"},
    "verdana": {"normal": "verdana.ttf", "bold": "verdanab.ttf", "italic": "verdanai.ttf", "bolditalic": "verdanaz.ttf"},
    "tahoma": {"normal": "tahoma.ttf", "bold": "tahomabd.ttf", "italic": "tahoma.ttf", "bolditalic": "tahomabd.ttf"},
    "segoe": {"normal": "segoeui.ttf", "bold": "segoeuib.ttf", "italic": "segoeuii.ttf", "bolditalic": "segoeuiz.ttf"},
    "trebuchet": {"normal": "trebuc.ttf", "bold": "trebucbd.ttf", "italic": "trebucit.ttf", "bolditalic": "trebucbi.ttf"},
}


def abrir_pdf(datos=None):
    """Carga el PDF de trabajo (subido o el del catálogo)."""
    if SESION["doc"] is not None:
        try:
            SESION["doc"].close()
        except Exception:
            pass
    if datos:
        fd, ruta = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        with open(ruta, "wb") as f:
            f.write(datos)
        SESION["tmp"] = ruta
    else:
        ruta = PDF_ORIGEN
    doc = fitz.open(ruta)
    SESION["doc"] = doc
    SESION["ruta"] = ruta
    return doc


def color_a_hex(c):
    if c is None:
        return "#000000"
    valor = int(c) if isinstance(c, (int, float)) else 0
    return "#%06x" % (valor & 0xFFFFFF)


def hex_a_color(texto):
    texto = (texto or "#000000").lstrip("#")
    if len(texto) == 3:
        texto = "".join(ch * 2 for ch in texto)
    try:
        r, g, b = (int(texto[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        r = g = b = 0
    return (r / 255, g / 255, b / 255)


def textos_de_pagina(page):
    """Devuelve los textos con su caja, tamaño, color y fuente."""
    salida = []
    datos = page.get_text("rawdict")
    for bloque in datos.get("blocks", []):
        if bloque.get("type") != 0:
            continue
        for linea in bloque.get("lines", []):
            for tramo in linea.get("spans", []):
                texto = "".join(ch.get("c", "") for ch in tramo.get("chars", []))
                if not texto.strip():
                    continue
                origen = tramo.get("origin") or (tramo["bbox"][0], tramo["bbox"][3])
                salida.append({
                    "texto": texto,
                    "bbox": [round(v, 2) for v in tramo["bbox"]],
                    "origen": [round(origen[0], 2), round(origen[1], 2)],
                    "tamano": round(tramo.get("size", 10), 2),
                    "fuente": tramo.get("font", ""),
                    "color": color_a_hex(tramo.get("color")),
                })
    return salida


def imagenes_de_pagina(page):
    """Devuelve las imágenes colocadas en la página (con xref y caja)."""
    salida = []
    for info in page.get_image_info(xrefs=True):
        if info["width"] < 60 or info["height"] < 60:
            continue
        salida.append({
            "xref": info.get("xref"),
            "bbox": [round(v, 2) for v in info["bbox"]],
            "w": info["width"],
            "h": info["height"],
        })
    return salida


def archivo_fuente(nombre_span):
    """
    TTF de Windows que corresponde a la fuente del texto.
    Se prefiere la del sistema porque la incrustada en el PDF suele ser un
    subconjunto y no tiene todas las letras.
    """
    bajo = (nombre_span or "").lower().replace("+", "")
    for familia, estilos in FAMILIAS.items():
        if familia not in bajo:
            continue
        estilo = "normal"
        if "bold" in bajo and ("italic" in bajo or "oblique" in bajo):
            estilo = "bolditalic"
        elif "bold" in bajo:
            estilo = "bold"
        elif "italic" in bajo or "oblique" in bajo:
            estilo = "italic"
        ruta = os.path.join(DIR_FUENTES, estilos[estilo])
        if os.path.exists(ruta):
            return ruta
        ruta = os.path.join(DIR_FUENTES, estilos["normal"])
        if os.path.exists(ruta):
            return ruta
    return None


def fuente_incrustada(doc, page, nombre_span):
    """Respaldo: extrae la fuente incrustada del PDF (puede ser subconjunto)."""
    objetivo = (nombre_span or "").lower().replace("+", "")
    for entrada in page.get_fonts(full=True):
        xref, ext, tipo, basefont, nombre, encoding = entrada[:6]
        base = (basefont or "").lower().replace("+", "")
        if not base or (base not in objetivo and objetivo not in base):
            continue
        clave = (doc.name, xref)
        if clave in FUENTES_CACHE:
            return FUENTES_CACHE[clave]
        try:
            _nombre, _ext, _tipo, buffer = doc.extract_font(xref)
        except Exception:
            continue
        if not buffer:
            continue
        fd, ruta = tempfile.mkstemp(suffix="." + (_ext or "ttf"))
        os.close(fd)
        with open(ruta, "wb") as f:
            f.write(buffer)
        FUENTES_CACHE[clave] = ruta
        return ruta
    return None


def parchear_texto(doc, page, dato):
    """Reemplaza un texto: borra el original e inserta el nuevo igual ubicado."""
    rect = fitz.Rect(dato["bbox"])
    texto = dato["texto"]
    tamano = float(dato.get("tamano") or 10)
    color = hex_a_color(dato.get("color"))
    fuente_span = dato.get("fuente") or ""

    page.add_redact_annot(rect)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    origen = dato.get("origen") or [rect.x0, rect.y1]
    punto = fitz.Point(float(origen[0]), float(origen[1]))

    candidatas = []
    ruta_sistema = archivo_fuente(fuente_span)
    if ruta_sistema:
        candidatas.append(ruta_sistema)
    ruta_pdf = fuente_incrustada(doc, page, fuente_span)
    if ruta_pdf:
        candidatas.append(ruta_pdf)

    for indice, ruta in enumerate(candidatas):
        alias = "FUENTE%d" % indice
        try:
            page.insert_font(fontname=alias, fontfile=ruta)
            page.insert_text(punto, texto, fontsize=tamano, color=color, fontname=alias)
            return
        except Exception:
            continue

    bajo = fuente_span.lower()
    if any(k in bajo for k in ("times", "georgia", "serif", "cormorant", "garamond", "cinzel", "playfair")):
        nombre = "tiro"
    elif any(k in bajo for k in ("courier", "mono")):
        nombre = "cour"
    else:
        nombre = "helv"
    page.insert_text(punto, texto, fontsize=tamano, color=color, fontname=nombre)


def parchear_imagen(doc, page, dato):
    """Reemplaza una foto por otra, conservando su posición."""
    data_url = dato["dataUrl"]
    m = re.match(r"^data:image/(\w+);base64,(.+)$", data_url, re.S)
    if not m:
        raise ValueError("Formato de imagen no válido")
    bruto = base64.b64decode(m[2])
    xref = dato.get("xref")
    if not xref:
        raise ValueError("La imagen no tiene referencia")
    doc.replace_image(xref, stream=bruto)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, codigo, dato):
        cuerpo = json.dumps(dato).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def _leer(self):
        largo = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(largo) if largo else b""

    def do_GET(self):
        ruta = urllib.parse.urlparse(self.path)
        if ruta.path in ("/", "/index.html"):
            html = open(os.path.join(AQUI, "index.html"), "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return

        if ruta.path == "/api/estado":
            doc = SESION["doc"] or abrir_pdf()
            return self._json(200, {
                "paginas": doc.page_count,
                "archivo": os.path.basename(SESION["ruta"] or ""),
                "salida": PDF_SALIDA,
            })

        if ruta.path == "/api/pagina":
            n = int(urllib.parse.parse_qs(ruta.query).get("n", ["1"])[0])
            doc = SESION["doc"] or abrir_pdf()
            if n < 1 or n > doc.page_count:
                return self._json(400, {"error": "Página fuera de rango"})
            page = doc[n - 1]
            pix = page.get_pixmap(matrix=fitz.Matrix(2.2, 2.2), alpha=False)
            datos = pix.tobytes("png")
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(datos)))
            self.end_headers()
            self.wfile.write(datos)
            return

        if ruta.path == "/api/capa":
            n = int(urllib.parse.parse_qs(ruta.query).get("n", ["1"])[0])
            doc = SESION["doc"] or abrir_pdf()
            page = doc[n - 1]
            return self._json(200, {
                "textos": textos_de_pagina(page),
                "imagenes": imagenes_de_pagina(page),
                "ancho": round(page.rect.width, 2),
                "alto": round(page.rect.height, 2),
            })

        if ruta.path == "/pdf":
            ruta_pdf = PDF_SALIDA if os.path.exists(PDF_SALIDA) else (SESION["ruta"] or PDF_ORIGEN)
            datos = open(ruta_pdf, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(datos)))
            self.send_header("Content-Disposition", 'attachment; filename="catalogo-editado.pdf"')
            self.end_headers()
            self.wfile.write(datos)
            return

        return self._json(404, {"error": "Ruta no encontrada"})

    def do_POST(self):
        ruta = urllib.parse.urlparse(self.path).path
        try:
            cuerpo = self._leer()
            if ruta == "/api/abrir":
                dato = json.loads(cuerpo)
                if dato.get("dataUrl"):
                    m = re.match(r"^data:application/pdf;base64,(.+)$", dato["dataUrl"], re.S)
                    if not m:
                        return self._json(400, {"error": "PDF no válido"})
                    doc = abrir_pdf(base64.b64decode(m[1]))
                else:
                    doc = abrir_pdf()
                return self._json(200, {"paginas": doc.page_count, "archivo": os.path.basename(SESION["ruta"] or "")})

            if ruta == "/api/texto":
                dato = json.loads(cuerpo)
                doc = SESION["doc"] or abrir_pdf()
                page = doc[int(dato["pagina"]) - 1]
                parchear_texto(doc, page, dato)
                return self._json(200, {"ok": True})

            if ruta == "/api/imagen":
                dato = json.loads(cuerpo)
                doc = SESION["doc"] or abrir_pdf()
                page = doc[int(dato["pagina"]) - 1]
                parchear_imagen(doc, page, dato)
                return self._json(200, {"ok": True})

            if ruta == "/api/guardar":
                doc = SESION["doc"] or abrir_pdf()
                doc.save(PDF_SALIDA, garbage=3, deflate=True)
                return self._json(200, {"ok": True, "ruta": PDF_SALIDA, "bytes": os.path.getsize(PDF_SALIDA)})

            return self._json(404, {"error": "Ruta no encontrada"})
        except Exception as e:
            return self._json(500, {"error": str(e)})


class Servidor(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    if os.path.exists(PDF_ORIGEN):
        abrir_pdf()
    print(f"Editor de PDF: http://127.0.0.1:{PUERTO}")
    print(f"Sale en: {PDF_SALIDA}")
    Servidor(("127.0.0.1", PUERTO), Handler).serve_forever()
