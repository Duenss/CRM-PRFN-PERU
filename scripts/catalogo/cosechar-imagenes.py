#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
cosechar-imagenes.py — Busca la foto real de cada perfume del catálogo.

Flujo por producto:
  1. Bing Imágenes con el nombre + casa inspirada.
  2. Se prefieren las imágenes del CDN de Fragrantica (fimgs.net), de donde
     se deriva la foto oficial del frasco: https://fimgs.net/mdimg/perfume/o.<id>.jpg
  3. Si no hay, se usa la mejor imagen de tienda cuyo título mencione el perfume.
  4. Se descarga, se valida y se guarda en _imagenes-nuevas/.
  5. Se evita repetir la misma imagen en dos perfumes (hash MD5).

Salida: _imagenes-nuevas/<id>.jpg + _imagenes-nuevas/informe.json

Uso:  python scripts/catalogo/cosechar-imagenes.py [--limite N] [--solo id1,id2]
"""

import argparse
import hashlib
import html as html_mod
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATALOGO = os.path.join(REPO, "docs", "catalogo")
PRODUCTOS = os.path.join(CATALOGO, "productos.json")
DESTINO = os.path.join(CATALOGO, "_imagenes-nuevas")
INFORME = os.path.join(DESTINO, "informe.json")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
CABECERAS = {"User-Agent": UA, "Accept-Language": "es-PE,es;q=0.9,en;q=0.8"}

PAUSA = 2.0
MIN_BYTES = 12 * 1024
MIN_LADO = 280

FIMGS_ID = re.compile(r"fimgs\.net/mdimg/perfume/(?:o|social)\.(\d+)\.", re.I)
FIMGS_ANY = re.compile(r"https://fimgs\.net/mdimg/perfume/o\.(\d+)\.jpg", re.I)


def norm(texto):
    texto = unicodedata.normalize("NFD", str(texto or "").lower())
    texto = "".join(c for c in texto if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", texto).strip()


def descargar(url, timeout=30):
    req = urllib.request.Request(url, headers=CABECERAS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def buscar_imagenes(consulta, timeout=30):
    """Devuelve [(murl, titulo)] de Bing Imágenes."""
    url = "https://www.bing.com/images/search?q=" + urllib.parse.quote(consulta) + "&setlang=en"
    req = urllib.request.Request(url, headers=CABECERAS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        crudo = r.read().decode("utf-8", "replace")

    salida = []
    for bloque in re.findall(r'\sm="(\{[^"]+\})"', crudo):
        try:
            dato = json.loads(html_mod.unescape(bloque))
        except Exception:
            continue
        murl = dato.get("murl") or dato.get("mediaurl") or ""
        titulo = dato.get("t") or ""
        if murl:
            salida.append((murl, titulo))
    return salida


def candidatos(producto):
    """Consulta Bing y devuelve la lista ordenada de imágenes candidatas."""
    nombre = producto.get("nombre") or ""
    casa = (producto.get("casa_inspirada") or "").strip()
    consultas = [
        f'"{nombre}" {casa} perfume'.strip(),
        f'{nombre} {casa} perfume bottle'.strip(),
        f'{nombre} perfume fragrantica'.strip(),
    ]

    vistas = []
    for consulta in consultas:
        try:
            filas = buscar_imagenes(consulta)
        except Exception:
            time.sleep(PAUSA)
            continue
        for murl, titulo in filas:
            if murl not in [v[0] for v in vistas]:
                vistas.append((murl, titulo))
        # Con una ficha de Fragrantica ya tenemos la foto oficial: no seguir buscando.
        if any(FIMGS_ID.search(m[0]) for m in vistas):
            break
        time.sleep(PAUSA)

    # 1º las de Fragrantica (foto oficial del frasco).
    oficiales = []
    for murl, titulo in vistas:
        m = FIMGS_ID.search(murl)
        if m:
            oficiales.append((f"https://fimgs.net/mdimg/perfume/o.{m.group(1)}.jpg", titulo))
    # 2º las de tiendas cuyo título mencione el perfume.
    palabras = [p for p in norm(nombre).split() if len(p) > 2]
    tiendas = []
    for murl, titulo in vistas:
        if FIMGS_ID.search(murl):
            continue
        if not re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", murl, re.I):
            continue
        t = norm(titulo)
        aciertos = sum(1 for p in palabras if p in t)
        if palabras and aciertos == 0:
            continue
        tiendas.append((aciertos, murl, titulo))
    tiendas.sort(key=lambda x: -x[0])

    orden = oficiales + [(u, t) for _, u, t in tiendas]
    # Sin duplicados de URL y sin la propia imagen vieja.
    vistos = set()
    limpio = []
    for u, t in orden:
        if u in vistos:
            continue
        vistos.add(u)
        limpio.append((u, t))
    return limpio


def validar(datos):
    """Comprueba que sea una imagen usable y devuelve (ancho, alto)."""
    if len(datos) < MIN_BYTES:
        raise ValueError(f"archivo muy pequeño ({len(datos)} bytes)")
    imagen = Image.open(io.BytesIO(datos))
    imagen.load()
    ancho, alto = imagen.size
    if min(ancho, alto) < MIN_LADO:
        raise ValueError(f"resolución baja ({ancho}x{alto})")
    return ancho, alto


def principal():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limite", type=int, default=0, help="procesar solo N productos")
    ap.add_argument("--solo", default="", help="ids separados por coma")
    args = ap.parse_args()

    productos = json.load(open(PRODUCTOS, encoding="utf-8"))
    if args.solo:
        ids = {x.strip() for x in args.solo.split(",") if x.strip()}
        productos = [p for p in productos if p.get("id") in ids]
    elif args.limite:
        productos = productos[: args.limite]

    os.makedirs(DESTINO, exist_ok=True)
    usados = {}          # md5 -> id que ya lo usa
    informe = []

    for i, p in enumerate(productos, 1):
        pid = p.get("id")
        etiqueta = f"[{i}/{len(productos)}] {pid}"
        registro = {
            "id": pid,
            "nombre": p.get("nombre"),
            "casa": p.get("casa_inspirada"),
            "estado": "sin_resultado",
            "fuente": None,
            "archivo": None,
            "dimensiones": None,
            "hash": None,
        }
        try:
            lista = candidatos(p)
        except Exception as e:
            registro["estado"] = "error_busqueda"
            registro["detalle"] = str(e)
            informe.append(registro)
            print(f"{etiqueta}: error de búsqueda ({e})", flush=True)
            continue

        if not lista:
            informe.append(registro)
            print(f"{etiqueta}: sin resultados", flush=True)
            continue

        for url, titulo in lista[:6]:
            try:
                datos = descargar(url)
                ancho, alto = validar(datos)
            except Exception:
                continue
            md5 = hashlib.md5(datos).hexdigest()
            if md5 in usados:
                registro["detalle"] = f"imagen ya usada por {usados[md5]}"
                continue
            destino = os.path.join(DESTINO, f"{pid}.jpg")
            imagen = Image.open(io.BytesIO(datos)).convert("RGB")
            imagen.save(destino, "JPEG", quality=92, optimize=True)
            usados[md5] = pid
            registro.update(
                estado="ok",
                fuente=url,
                archivo=f"{pid}.jpg",
                dimensiones=f"{ancho}x{alto}",
                hash=md5,
                titulo=titulo,
            )
            break

        if registro["estado"] != "ok":
            registro["estado"] = registro.get("detalle", "sin_candidata_valida")
        informe.append(registro)
        print(f"{etiqueta}: {registro['estado']} · {registro.get('fuente') or '-'}", flush=True)

    with open(INFORME, "w", encoding="utf-8") as f:
        json.dump(informe, f, ensure_ascii=False, indent=2)

    ok = sum(1 for r in informe if r["estado"] == "ok")
    print(f"\nResumen: {ok}/{len(informe)} imágenes nuevas")
    print(f"Informe: {INFORME}")
    return 0


if __name__ == "__main__":
    sys.exit(principal())
