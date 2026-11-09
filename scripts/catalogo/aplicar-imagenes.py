#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
aplicar-imagenes.py — Reemplaza las imágenes del catálogo por las cosechadas.

Toma docs/catalogo/_imagenes-nuevas/informe-fragrantica.json y, para cada
producto resuelto, sobrescribe la misma ruta de imagen:

    docs/catalogo/img-opt/<imagen_ruta>        (usada por el PDF del CRM)
    ..\\..\\perfumeria-fina-peru\\<imagen_ruta>   (usada por la web)

Las rutas no cambian, así que ni el PDF ni la web necesitan tocar sus datos.

Uso:
    python aplicar-imagenes.py            # aplica (hace copia de seguridad)
    python aplicar-imagenes.py --dry-run  # solo simula
    python aplicar-imagenes.py --revertir # restaura desde la copia
"""

import argparse
import json
import os
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATALOGO = os.path.join(REPO, "docs", "catalogo")
NUEVAS = os.path.join(CATALOGO, "_imagenes-nuevas")
INFORME = os.path.join(NUEVAS, "informe-fragrantica.json")
IMG_OPT = os.path.join(CATALOGO, "img-opt")
WEB = os.path.join(REPO, "..", "..", "EXTRAS", "perfumeria-fina-peru")
BACKUP = os.path.join(NUEVAS, "_respaldo")


def principal():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--revertir", action="store_true")
    args = ap.parse_args()

    productos = {p["id"]: p for p in json.load(open(os.path.join(CATALOGO, "productos.json"), encoding="utf-8"))}

    if args.revertir:
        if not os.path.isdir(BACKUP):
            print("No hay respaldo para restaurar.")
            return 1
        n = 0
        for archivo in os.listdir(BACKUP):
            origen = os.path.join(BACKUP, archivo)
            for destino in (os.path.join(IMG_OPT, archivo), os.path.join(WEB, archivo)):
                if os.path.isdir(os.path.dirname(destino)):
                    shutil.copy2(origen, destino)
                    n += 1
        print(f"Restauradas {n} imágenes desde el respaldo.")
        return 0

    if not os.path.exists(INFORME):
        print(f"Falta el informe: {INFORME}")
        return 1

    informe = json.load(open(INFORME, encoding="utf-8"))
    resueltos = [r for r in informe if r.get("estado") == "ok"]

    print(f"Productos resueltos en el informe: {len(resueltos)}/{len(productos)}")
    if not resueltos:
        return 1

    os.makedirs(BACKUP, exist_ok=True)
    aplicados = 0
    faltantes = []

    for r in resueltos:
        producto = productos.get(r["id"])
        if not producto:
            faltantes.append((r["id"], "no está en productos.json"))
            continue
        ruta_rel = producto.get("imagen_ruta") or ""
        if not ruta_rel:
            faltantes.append((r["id"], "sin imagen_ruta"))
            continue

        origen = os.path.join(NUEVAS, f"{r['id']}.jpg")
        if not os.path.exists(origen):
            faltantes.append((r["id"], "falta el archivo cosechado"))
            continue

        destinos = []
        destino_catalogo = os.path.join(IMG_OPT, ruta_rel.replace("/", os.sep))
        if os.path.isdir(os.path.dirname(destino_catalogo)):
            destinos.append(destino_catalogo)
        destino_web = os.path.join(WEB, ruta_rel.replace("/", os.sep))
        if os.path.isdir(os.path.dirname(destino_web)):
            destinos.append(destino_web)

        if not destinos:
            faltantes.append((r["id"], f"no existen las carpetas para {ruta_rel}"))
            continue

        if args.dry_run:
            aplicados += 1
            continue

        nombre_backup = ruta_rel.replace("/", "__")
        respaldo = os.path.join(BACKUP, nombre_backup)
        if not os.path.exists(respaldo) and os.path.exists(destinos[0]):
            shutil.copy2(destinos[0], respaldo)

        for destino in destinos:
            shutil.copy2(origen, destino)
        aplicados += 1

    modo = "SIMULACIÓN" if args.dry_run else "APLICADO"
    print(f"\n{modo}: {aplicados} imágenes reemplazadas en el catálogo + web")
    if faltantes:
        print(f"Con problemas: {len(faltantes)}")
        for pid, motivo in faltantes[:20]:
            print(f"   - {pid}: {motivo}")
    if not args.dry_run and aplicados:
        print(f"Respaldo de las originales: {BACKUP}")
        print("Para volver atrás:  python aplicar-imagenes.py --revertir")
    return 0


if __name__ == "__main__":
    sys.exit(principal())
