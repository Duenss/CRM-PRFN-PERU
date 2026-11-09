#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fase2-validar.py — Descarga y elige la mejor foto real de cada perfume.

Lee candidatos.json (fase 1) y para cada producto:
  · descarga hasta 6 candidatas
  · exige: imagen válida, >= 300 px de lado, formato de frasco (0.5–2.0 de
    proporción) y fondo claro (foto de producto sobre blanco)
  · prefiere las que mencionan el nombre del perfume en el título
  · evita repetir la misma imagen (hash MD5 y hash perceptual)

Salida: _imagenes-nuevas/<id>.jpg + informe-fragrantica.json
"""

import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATALOGO = os.path.join(REPO, "docs", "catalogo")
NUEVAS = os.path.join(CATALOGO, "_imagenes-nuevas")
CANDIDATOS = os.path.join(NUEVAS, "candidatos.json")
INFORME = os.path.join(NUEVAS, "informe-fragrantica.json")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
MIN_BYTES = 15_000
MIN_LADO = 300
MAX_DESCARGA = 6

# Dominios de fotos de stock o genéricas: nunca son el frasco del perfume.
DOMINIOS_VETADOS = (
    "dreamstime", "shutterstock", "istockphoto", "gettyimages", "alamy",
    "123rf", "depositphotos", "adobe", "freepik", "vecteezy", "pinterest",
    "geometrica", "blogspot", "blogger", "tumblr", "lookaside", "wikimedia",
    "wikipedia", "ytimg", "youtube", "facebook", "tiktok", "instagram",
)

# Palabras que deben aparecer en el título para considerarlo una ficha del perfume.
PISTAS_PERFUME = ("perfume", "perfum", "eau de parfum", "edp", "edt",
                  "fragancia", "colonia", "parfum", "ml", "spray")


def norm(t):
    t = unicodedata.normalize("NFD", str(t or "").lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def descargar(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fondo_claro(imagen):
    """True si los bordes son claros (foto de producto sobre fondo blanco)."""
    gris = imagen.convert("L")
    w, h = gris.size
    mx, my = max(1, int(w * 0.06)), max(1, int(h * 0.06))
    px = gris.load()
    valores = []
    for x in range(0, w, max(1, w // 24)):
        for y in list(range(0, my)) + list(range(h - my, h)):
            valores.append(px[x, y])
    for y in range(0, h, max(1, h // 24)):
        for x in list(range(0, mx)) + list(range(w - mx, w)):
            valores.append(px[x, y])
    if not valores:
        return False
    return sum(valores) / len(valores) >= 195


def dhash(imagen, lado=16):
    gris = imagen.convert("L").resize((lado + 1, lado), Image.LANCZOS)
    px = list(gris.getdata())
    bits = 0
    i = 0
    for y in range(lado):
        for x in range(lado):
            if px[y * (lado + 1) + x] > px[y * (lado + 1) + x + 1]:
                bits |= 1 << i
            i += 1
    return bits


def distancia(a, b):
    return bin(a ^ b).count("1")


def titulo_valido(producto, titulo, url):
    """El título o la URL deben nombrar el perfume completo, su casa y que sea perfume."""
    texto = norm(titulo) + " " + norm(url)
    nombre = norm(producto.get("nombre"))
    casa = norm(producto.get("casa_inspirada"))
    tokens = [w for w in nombre.split(" ") if len(w) > 2]
    if not tokens:
        return False
    if not all(w in texto for w in tokens):
        return False
    if casa:
        primera_casa = casa.split(" ")[0]
        if len(primera_casa) > 2 and primera_casa not in texto:
            return False
    if not any(p in texto for p in PISTAS_PERFUME):
        return False
    return True


def dominio_vetado(url):
    bajo = url.lower()
    return any(d in bajo for d in DOMINIOS_VETADOS)


def puntuar(imagen, titulo, producto):
    """Más puntos = mejor foto para el catálogo (solo calidad de imagen)."""
    w, h = imagen.size
    puntos = 0
    proporcion = w / h
    if 0.75 <= proporcion <= 1.33:
        puntos += 40          # casi cuadrada: ideal para la tarjeta
    elif 0.6 <= proporcion <= 1.7:
        puntos += 20
    if fondo_claro(imagen):
        puntos += 40
    if min(w, h) >= 800:
        puntos += 20
    elif min(w, h) >= 600:
        puntos += 12
    elif min(w, h) >= 450:
        puntos += 6
    return puntos


def principal():
    if not os.path.exists(CANDIDATOS):
        print(f"Falta {CANDIDATOS}. Ejecutá primero fase1-candidatos.js")
        return 1

    data = json.load(open(CANDIDATOS, encoding="utf-8"))
    informe = json.load(open(INFORME, encoding="utf-8")) if os.path.exists(INFORME) else []
    por_id = {r["id"]: r for r in informe}

    hashes = {}
    perceptuales = []
    for r in informe:
        if r.get("estado") == "ok":
            hashes[r["hash"]] = r["id"]
            if r.get("dhash") is not None:
                perceptuales.append((r["dhash"], r["id"]))

    ok = 0
    sin = 0
    for pid, entrada in data.items():
        previo = por_id.get(pid)
        if previo and previo.get("estado") == "ok":
            continue

        producto = {"id": pid, "nombre": entrada.get("nombre"), "casa_inspirada": entrada.get("casa")}
        mejores = []
        for cand in entrada.get("candidatos", [])[:MAX_DESCARGA]:
            murl = cand.get("murl", "")
            if not murl or dominio_vetado(murl):
                continue
            if not titulo_valido(producto, cand.get("titulo", ""), murl):
                continue
            try:
                bruto = descargar(murl)
            except Exception:
                continue
            if len(bruto) < MIN_BYTES:
                continue
            try:
                imagen = Image.open(io.BytesIO(bruto))
                imagen.load()
            except Exception:
                continue
            w, h = imagen.size
            if min(w, h) < MIN_LADO:
                continue
            proporcion = w / h
            if not (0.5 <= proporcion <= 2.0):
                continue
            import hashlib

            md5 = hashlib.md5(bruto).hexdigest()
            if md5 in hashes:
                continue
            dh = dhash(imagen)
            if any(distancia(dh, otro) <= 6 for otro, _ in perceptuales):
                continue
            mejores.append((puntuar(imagen, cand.get("titulo", ""), producto), md5, dh, imagen, cand, len(bruto)))

        if not mejores:
            por_id[pid] = {
                "id": pid,
                "nombre": producto["nombre"],
                "casa": producto["casa_inspirada"],
                "estado": "sin_candidata_valida",
            }
            sin += 1
            print(f"{pid}: sin candidata válida")
            continue

        mejores.sort(key=lambda x: -x[0])
        puntos, md5, dh, imagen, cand, tam = mejores[0]
        destino = os.path.join(NUEVAS, f"{pid}.jpg")
        imagen.convert("RGB").save(destino, "JPEG", quality=92, optimize=True)
        hashes[md5] = pid
        perceptuales.append((dh, pid))
        por_id[pid] = {
            "id": pid,
            "nombre": producto["nombre"],
            "casa": producto["casa_inspirada"],
            "estado": "ok",
            "fuente": cand["murl"],
            "pagina": cand.get("pagina", ""),
            "titulo": cand.get("titulo", ""),
            "dimensiones": f"{imagen.size[0]}x{imagen.size[1]}",
            "bytes": tam,
            "hash": md5,
            "dhash": dh,
            "puntaje": puntos,
        }
        ok += 1
        print(f"{pid}: ok ({puntos} pts, {imagen.size[0]}x{imagen.size[1]}) <- {cand['murl'][:70]}")

        with open(INFORME, "w", encoding="utf-8") as f:
            json.dump(list(por_id.values()), f, ensure_ascii=False, indent=2)

    with open(INFORME, "w", encoding="utf-8") as f:
        json.dump(list(por_id.values()), f, ensure_ascii=False, indent=2)

    print(f"\nResumen: {ok} nuevas · {sin} sin candidata válida · {len(por_id)} en el informe")
    return 0


if __name__ == "__main__":
    sys.exit(principal())
