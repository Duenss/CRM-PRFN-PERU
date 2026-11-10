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
import io
import json
import os
import re
import socketserver
import sys
import tempfile
import urllib.parse
import urllib.request

import pymupdf as fitz
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PDF_ORIGEN = os.path.join(REPO, "docs", "catalogo", "catalogo-navidad-2026.pdf")
PDF_SALIDA = os.path.join(REPO, "docs", "catalogo", "catalogo-editado.pdf")
AQUI = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("HOST", "127.0.0.1")
PUERTO = int(os.environ.get("PORT") or os.environ.get("PUERTO") or 4322)

SESION = {
    "doc": None,
    "ruta": None,
    "tmp": None,
    "pila": [],      # fotos del PDF para deshacer
    "rehacer": [],   # fotos para rehacer
}
MAX_HISTORIAL = 20
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
    SESION["pila"] = []
    SESION["rehacer"] = []
    return doc


def foto_actual():
    """Copia binaria del PDF de trabajo, para deshacer."""
    return SESION["doc"].tobytes(garbage=1, deflate=True)


def apilar():
    """Guarda el estado antes de un cambio."""
    try:
        SESION["pila"].append(foto_actual())
        if len(SESION["pila"]) > MAX_HISTORIAL:
            SESION["pila"].pop(0)
        SESION["rehacer"] = []
    except Exception:
        pass


def restaurar(foto):
    if SESION["doc"] is not None:
        try:
            SESION["doc"].close()
        except Exception:
            pass
    SESION["doc"] = fitz.open(stream=foto, filetype="pdf")


def deshacer():
    if not SESION["pila"]:
        return False
    SESION["rehacer"].append(foto_actual())
    restaurar(SESION["pila"].pop())
    return True


def rehacer():
    if not SESION["rehacer"]:
        return False
    SESION["pila"].append(foto_actual())
    restaurar(SESION["rehacer"].pop())
    return True


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
    area_pagina = abs(page.rect.width * page.rect.height) or 1
    for info in page.get_image_info(xrefs=True):
        if info["width"] < 60 or info["height"] < 60:
            continue
        bbox = info["bbox"]
        area_imagen = abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
        salida.append({
            "xref": info.get("xref"),
            "bbox": [round(v, 2) for v in bbox],
            "w": info["width"],
            "h": info["height"],
            "fondo": area_imagen > area_pagina * 0.75,
        })
    # Las imágenes de fondo van al final (el cliente las pone detrás).
    salida.sort(key=lambda i: i["fondo"])
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
        clave = (getattr(doc, "name", None) or id(doc), xref)
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


def insertar_texto(doc, page, punto, texto, tamano, color, fuente_span):
    """Inserta texto con la tipografía correcta (sistema > incrustada > base)."""
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

    bajo = (fuente_span or "").lower()
    if any(k in bajo for k in ("times", "georgia", "serif", "cormorant", "garamond", "cinzel", "playfair")):
        nombre = "tiro"
    elif any(k in bajo for k in ("courier", "mono")):
        nombre = "cour"
    else:
        nombre = "helv"
    page.insert_text(punto, texto, fontsize=tamano, color=color, fontname=nombre)


def parchear_texto(doc, page, dato):
    """Reemplaza un texto: borra el original e inserta el nuevo igual ubicado."""
    rect = fitz.Rect(dato["bbox"])
    texto = dato["texto"]
    tamano = float(dato.get("tamano") or 10)
    color = hex_a_color(dato.get("color"))
    fuente_span = dato.get("fuente") or ""

    apilar()
    page.add_redact_annot(rect)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    origen = dato.get("origen") or [rect.x0, rect.y1]
    insertar_texto(doc, page, fitz.Point(float(origen[0]), float(origen[1])), texto, tamano, color, fuente_span)


def mover_texto(doc, page, dato):
    """Mueve un texto (dx, dy en puntos) conservando su estilo."""
    rect = fitz.Rect(dato["bbox"])
    dx = float(dato.get("dx") or 0)
    dy = float(dato.get("dy") or 0)
    texto = dato.get("texto") or ""
    tamano = float(dato.get("tamano") or 10)
    color = hex_a_color(dato.get("color"))
    fuente_span = dato.get("fuente") or ""

    apilar()
    page.add_redact_annot(rect)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    origen = dato.get("origen") or [rect.x0, rect.y1]
    destino = fitz.Point(float(origen[0]) + dx, float(origen[1]) + dy)
    insertar_texto(doc, page, destino, texto, tamano, color, fuente_span)


def mover_imagen(doc, page, dato):
    """Mueve una foto a una nueva posición."""
    rect = fitz.Rect(dato["bbox"])
    dx = float(dato.get("dx") or 0)
    dy = float(dato.get("dy") or 0)
    xref = dato.get("xref")
    if not xref:
        raise ValueError("La imagen no tiene referencia")
    try:
        datos = doc.extract_image(xref)["image"]
    except Exception:
        raise ValueError("No se pudo leer la imagen original")

    apilar()
    page.add_redact_annot(rect, fill=False)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE)

    destino = fitz.Rect(rect.x0 + dx, rect.y0 + dy, rect.x1 + dx, rect.y1 + dy)
    page.insert_image(destino, stream=datos, keep_proportion=True)


def eliminar_elemento(page, dato):
    """Borra un texto o una foto de la página."""
    rect = fitz.Rect(dato["bbox"])
    clase = dato.get("clase") or "texto"
    apilar()
    page.add_redact_annot(rect, fill=False)
    if clase == "imagen":
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE)
    else:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)


def dibujar_etiqueta(doc, page, dato):
    """
    Redibuja la cápsula (CABALLERO/DAMA) con el ancho justo para el texto
    nuevo, centrado. Sirve para cambiar de género sin que quede descuadrada.
    """
    rect = fitz.Rect(dato["bbox"])
    texto = (dato.get("texto") or "").strip()
    if not texto:
        raise ValueError("La etiqueta no puede quedar vacía")

    tamano = float(dato.get("tamano") or 6)
    color_texto = hex_a_color(dato.get("color") or "#8A6F18")
    fondo = hex_a_color(dato.get("fondo") or "#F4EFE4")
    borde = hex_a_color(dato.get("borde") or "#C2A05C")
    relleno = float(dato.get("relleno") or 7)
    alto = float(dato.get("alto") or (rect.height or tamano * 1.9))

    centro_y = (rect.y0 + rect.y1) / 2
    ancho_texto = fitz.get_text_length(texto, fontname="helv", fontsize=tamano)
    ancho = max(rect.width, ancho_texto + relleno * 2)
    caja = fitz.Rect(rect.x0, centro_y - alto / 2, rect.x0 + ancho, centro_y + alto / 2)

    apilar()
    page.add_redact_annot(rect)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    page.draw_rect(caja, color=borde, fill=fondo, width=0.6)
    punto = fitz.Point(caja.x0 + (caja.width - ancho_texto) / 2, centro_y + tamano * 0.36)
    insertar_texto(doc, page, punto, texto, tamano, color_texto, dato.get("fuente") or "helv")


UA_IMAGEN = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
MAX_IMAGEN = 15 * 1024 * 1024


def descargar_imagen(url):
    """Descarga una imagen desde una URL y valida que sea usable."""
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("La URL debe empezar con http:// o https://")
    peticion = urllib.request.Request(url, headers={"User-Agent": UA_IMAGEN, "Accept": "image/*,*/*"})
    try:
        with urllib.request.urlopen(peticion, timeout=30) as r:
            tipo = (r.headers.get("Content-Type") or "").lower()
            datos = r.read(MAX_IMAGEN + 1)
    except Exception as e:
        raise ValueError("No se pudo descargar la imagen: %s" % e)
    if len(datos) > MAX_IMAGEN:
        raise ValueError("La imagen supera 15 MB")
    if len(datos) < 3000:
        raise ValueError("La imagen es demasiado pequeña (%d bytes)" % len(datos))
    if not tipo.startswith("image/"):
        raise ValueError("La URL no devuelve una imagen (Content-Type: %s)" % (tipo or "desconocido"))
    return datos


def normalizar_imagen(bruto):
    """
    Convierte cualquier imagen (AVIF, WebP, PNG con transparencia…) a JPEG.
    PyMuPDF no entiende AVIF; Pillow sí, así que se normaliza antes de incrustar.
    """
    try:
        imagen = Image.open(io.BytesIO(bruto))
        imagen.load()
    except Exception:
        raise ValueError("El archivo no es una imagen válida")

    if imagen.mode in ("RGBA", "LA") or (imagen.mode == "P" and "transparency" in imagen.info):
        fondo = Image.new("RGB", imagen.size, (255, 255, 255))
        rgba = imagen.convert("RGBA")
        fondo.paste(rgba, mask=rgba.split()[-1])
        imagen = fondo
    else:
        imagen = imagen.convert("RGB")

    # Limitar el lado mayor para no inflar el PDF.
    lado = 1400
    if max(imagen.size) > lado:
        escala = lado / max(imagen.size)
        imagen = imagen.resize((max(1, round(imagen.size[0] * escala)), max(1, round(imagen.size[1] * escala))), Image.LANCZOS)

    salida = io.BytesIO()
    imagen.save(salida, "JPEG", quality=92, optimize=True)
    return salida.getvalue()


def parchear_imagen(doc, page, dato):
    """Reemplaza una foto por otra (archivo o URL), conservando su posición."""
    if dato.get("url"):
        bruto = descargar_imagen(dato["url"])
    else:
        data_url = dato.get("dataUrl") or ""
        m = re.match(r"^data:image/(\w+);base64,(.+)$", data_url, re.S)
        if not m:
            raise ValueError("Formato de imagen no válido")
        bruto = base64.b64decode(m[2])
        if len(bruto) < 3000:
            raise ValueError("La imagen es demasiado pequeña")

    bruto = normalizar_imagen(bruto)

    xref = dato.get("xref")
    if not xref:
        raise ValueError("La imagen no tiene referencia")

    apilar()

    # 1) Reemplazo directo del objeto imagen (conserva el marco exacto).
    try:
        page.replace_image(xref, stream=bruto)
        return
    except Exception:
        pass

    # 2) Respaldo: borrar la imagen de esa zona e insertar la nueva.
    rect = None
    for info in page.get_image_info(xrefs=True):
        if info.get("xref") == xref:
            rect = fitz.Rect(info["bbox"])
            break
    if rect is None and dato.get("bbox"):
        rect = fitz.Rect(dato["bbox"])
    if rect is None:
        raise ValueError("No se encontró la imagen en la página")

    page.add_redact_annot(rect, fill=False)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE)
    page.insert_image(rect, stream=bruto, keep_proportion=True)


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
                "deshacer": len(SESION["pila"]),
                "rehacer": len(SESION["rehacer"]),
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
            try:
                self.wfile.write(datos)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass
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
            try:
                self.wfile.write(datos)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass
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
                return self._json(200, self._estado_historial())

            if ruta == "/api/mover":
                dato = json.loads(cuerpo)
                doc = SESION["doc"] or abrir_pdf()
                page = doc[int(dato["pagina"]) - 1]
                if (dato.get("clase") or "texto") == "imagen":
                    mover_imagen(doc, page, dato)
                else:
                    mover_texto(doc, page, dato)
                return self._json(200, self._estado_historial())

            if ruta == "/api/eliminar":
                dato = json.loads(cuerpo)
                doc = SESION["doc"] or abrir_pdf()
                page = doc[int(dato["pagina"]) - 1]
                eliminar_elemento(page, dato)
                return self._json(200, self._estado_historial())

            if ruta == "/api/etiqueta":
                dato = json.loads(cuerpo)
                doc = SESION["doc"] or abrir_pdf()
                page = doc[int(dato["pagina"]) - 1]
                dibujar_etiqueta(doc, page, dato)
                return self._json(200, self._estado_historial())

            if ruta == "/api/imagen":
                dato = json.loads(cuerpo)
                doc = SESION["doc"] or abrir_pdf()
                page = doc[int(dato["pagina"]) - 1]
                parchear_imagen(doc, page, dato)
                return self._json(200, self._estado_historial())

            if ruta == "/api/deshacer":
                return self._json(200, {"ok": deshacer(), **self._estado_historial()})

            if ruta == "/api/rehacer":
                return self._json(200, {"ok": rehacer(), **self._estado_historial()})

            if ruta == "/api/guardar":
                doc = SESION["doc"] or abrir_pdf()
                doc.save(PDF_SALIDA, garbage=3, deflate=True)
                return self._json(200, {"ok": True, "ruta": PDF_SALIDA, "bytes": os.path.getsize(PDF_SALIDA)})

            return self._json(404, {"error": "Ruta no encontrada"})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    @staticmethod
    def _estado_historial():
        return {"ok": True, "deshacer": len(SESION["pila"]), "rehacer": len(SESION["rehacer"])}


class Servidor(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    if os.path.exists(PDF_ORIGEN):
        abrir_pdf()
    print(f"Editor de PDF: http://127.0.0.1:{PUERTO}")
    print(f"Sale en: {PDF_SALIDA}")
    Servidor((HOST, PUERTO), Handler).serve_forever()
