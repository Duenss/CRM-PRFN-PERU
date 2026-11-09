#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
aplicar-originales.py — Reemplaza las fotos del catálogo Varón por las
originales del PDF, en orden visual.

Por qué: las fotos actuales se recortaron con un orden interno del PDF que no
es el de lectura (página 1 empieza por abajo-derecha). Eso cruzó perfumes y
repitió frascos. Aquí se empareja:

    producto N de la página  (orden del catálogo)
        ↔  foto N en orden visual del PDF (arriba-izq → abajo-der)

Filtra solo las fotos con perfil de producto (560-600 × 540-560 px), que
coinciden 1:1 con la cantidad de productos de cada página.

Uso:
    python aplicar-originales.py --dry-run
    python aplicar-originales.py
    python aplicar-originales.py --revertir
"""

import argparse
import collections
import hashlib
import json
import os
import re
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATALOGO = os.path.join(REPO, "docs", "catalogo")
IMG_OPT = os.path.join(CATALOGO, "img-opt")
ORIGINALES = os.path.join(REPO, "_catalog_work", "originales") if False else None

PERFIL_W = (560, 600)
PERFIL_H = (540, 560)
BACKUP = os.path.join(CATALOGO, "_respaldo-originales")


def perfil_producto(it):
    return PERFIL_W[0] <= it.get("w", 0) <= PERFIL_W[1] and PERFIL_H[0] <= it.get("h", 0) <= PERFIL_H[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--revertir", action="store_true")
    args = ap.parse_args()

    # Rutas: el índice de originales vive en el checkout del sitio.
    sitio = os.path.join(REPO, "..", "..", "EXTRAS", "perfumeria-fina-peru")
    sitio = os.path.abspath(sitio)
    orig_json = os.path.join(sitio, "_catalog_work", "ocr", "originales.json")
    orig_dir = os.path.join(sitio, "_catalog_work", "originales")

    if not os.path.exists(orig_json):
        print(f"Falta {orig_json}. Ejecutá extraer-originales.py en el sitio.")
        return 1

    if args.revertir:
        if not os.path.isdir(BACKUP):
            print("No hay respaldo.")
            return 1
        n = 0
        for archivo in os.listdir(BACKUP):
            origen = os.path.join(BACKUP, archivo)
            for destino in (os.path.join(CATALOGO, "docs", "catalogo", "img-opt", archivo),
                            os.path.join(IMG_OPT, archivo),
                            os.path.join(sitio, "assets", "img", "products", archivo)):
                pass
        # Reversión simple: recorrer respaldo y copiar a ambos árboles.
        for archivo in os.listdir(BACKUP):
            origen = os.path.join(BACKUP, archivo)
            destinos = [
                os.path.join(IMG_OPT, "assets", "img", "products", archivo),
                os.path.join(sitio, "assets", "img", "products", archivo),
            ]
            for d in destinos:
                if os.path.isdir(os.path.dirname(d)):
                    shutil.copy2(origen, d)
                    n += 1
        print(f"Restauradas {n} imágenes.")
        return 0

    originales = json.load(open(orig_json, encoding="utf-8"))

    # Productos Varón agrupados por página, en el orden del catálogo.
    pagina_productos = collections.defaultdict(list)
    web_dir = os.path.join(sitio, "assets", "img", "products")
    for archivo in os.listdir(web_dir):
        m = re.match(r"v(\d+)_(\d+)\.jpg$", archivo)
        if m:
            pagina_productos[int(m.group(1))].append((int(m.group(2)), archivo))
    for k in pagina_productos:
        pagina_productos[k].sort()

    os.makedirs(BACKUP, exist_ok=True)
    aplicados = 0
    saltados = 0
    repetidas = []
    avisos = []

    for pagina in sorted(pagina_productos):
        clave = f"varon_p{pagina:02d}"
        datos = originales.get(clave)
        if not datos:
            avisos.append(f"v{pagina:02d}: sin datos en el índice")
            continue

        fotos = [it for it in datos["items"] if perfil_producto(it)]
        # Únicas por contenido, manteniendo el orden visual.
        unicas = []
        vistos = set()
        for it in fotos:
            md5 = it.get("md5") or hashlib.md5(open(os.path.join(orig_dir, it["archivo"]), "rb").read()).hexdigest()
            if md5 in vistos:
                repetidas.append((clave, it["archivo"], md5))
                continue
            vistos.add(md5)
            unicas.append(dict(it, md5=md5))

        productos = pagina_productos[pagina]
        if len(unicas) != len(productos):
            avisos.append(f"v{pagina:02d}: {len(productos)} productos vs {len(unicas)} fotos únicas")

        for i, (idx, archivo) in enumerate(productos):
            if i >= len(unicas):
                saltados += 1
                continue
            origen = os.path.join(orig_dir, unicas[i]["archivo"])
            if not os.path.exists(origen):
                saltados += 1
                continue

            if not args.dry_run:
                respaldo = os.path.join(BACKUP, archivo)
                destino_web = os.path.join(web_dir, archivo)
                if not os.path.exists(respaldo) and os.path.exists(destino_web):
                    shutil.copy2(destino_web, respaldo)
                shutil.copy2(origen, destino_web)
                destino_cat = os.path.join(IMG_OPT, "assets", "img", "products", archivo)
                if os.path.isdir(os.path.dirname(destino_cat)):
                    shutil.copy2(origen, destino_cat)
            aplicados += 1

    modo = "SIMULACIÓN" if args.dry_run else "APLICADO"
    print(f"\n{modo}: {aplicados} fotos originales asignadas")
    print(f"Saltadas: {saltados} | fotos repetidas descartadas: {len(repetidas)}")
    if repetidas:
        print("\nFotos repetidas en el PDF (se usan una sola vez):")
        for clave, archivo, md5 in repetidas:
            print(f"   {clave} · {archivo} · {md5[:10]}")
    if avisos:
        print("\nAvisos:")
        for a in avisos:
            print("   -", a)
    if not args.dry_run and aplicados:
        print(f"\nRespaldo: {BACKUP}")
        print("Revertir:  python aplicar-originales.py --revertir")
    return 0


if __name__ == "__main__":
    sys.exit(main())
