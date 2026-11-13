#!/usr/bin/env python3
"""Importa las fotos de producto de la web local (EXTRAS) al bot.

Uso:
  python scripts/importar-imagenes-web.py --web "C:/ruta/a/perfumeria-fina-peru"

- Lee el mapeo id → imagen de `assets/js/data.js` (la web del dueño).
- Copia/normaliza cada foto a `bot/media/products/<id>.jpg` (JPEG para que
  WhatsApp la envíe como imagen; las .webp se convierten).
- Genera `bot/media/products/manifest.json` con hash/tamaño/origen.
- No modifica la carpeta de la web (solo lee).
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Falta Pillow: instala pillow para convertir .webp a .jpg")

# Consola de Windows (cp1252) no soporta flechas/acentos raros: forzar UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def parse_data_js(texto: str) -> dict[str, str]:
    """Extrae id → ruta de imagen de PRODUCTS en assets/js/data.js."""
    mapa: dict[str, str] = {}
    for bloque in re.split(r"\n\s{2}\{", texto):
        mid = re.search(r'\bid:\s*"([^"]+)"', bloque)
        mimg = re.search(r'\bimage:\s*"([^"]+)"', bloque)
        if mid and mimg and "/products/" in mimg.group(1):
            mapa[mid.group(1)] = mimg.group(1).split("?")[0]
    return mapa


def resolver_fuente(products_dir: pathlib.Path, ruta: str) -> pathlib.Path | None:
    nombre = pathlib.Path(ruta).name
    candidato = products_dir / nombre
    if candidato.is_file():
        return candidato
    # La web mezcla .jpg/.webp: se prueba el mismo nombre con otra extensión.
    base = pathlib.Path(nombre)
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        alt = products_dir / (base.stem + ext)
        if alt.is_file():
            return alt
    return None


def normalizar_a_jpg(origen: pathlib.Path, destino: pathlib.Path) -> None:
    if origen.suffix.lower() in (".jpg", ".jpeg"):
        shutil.copy2(origen, destino)
        return
    with Image.open(origen) as im:
        im = im.convert("RGBA")
        fondo = Image.new("RGB", im.size, (255, 255, 255))
        fondo.paste(im, mask=im.split()[3])
        fondo.save(destino, "JPEG", quality=92, optimize=True, progressive=True)


def main() -> int:
    raiz_repo = pathlib.Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--web", required=True, help="Carpeta raíz de la web (contiene assets/js/data.js)")
    ap.add_argument("--destino", default=str(raiz_repo / "bot" / "media" / "products"))
    ap.add_argument("--catalogo", default=str(raiz_repo / "docs" / "catalogo" / "productos.json"))
    args = ap.parse_args()

    web = pathlib.Path(args.web).resolve()
    data_js = web / "assets" / "js" / "data.js"
    products_dir = web / "assets" / "img" / "products"
    destino = pathlib.Path(args.destino).resolve()
    if not data_js.is_file() or not products_dir.is_dir():
        print(f"No encuentro data.js/products en {web}", file=sys.stderr)
        return 1

    mapa = parse_data_js(data_js.read_text(encoding="utf-8"))
    catalogo = json.loads(pathlib.Path(args.catalogo).read_text(encoding="utf-8"))
    ids = [p["id"] for p in catalogo]
    print(f"Productos catálogo: {len(ids)} · imágenes mapeadas en la web: {len(mapa)}")

    destino.mkdir(parents=True, exist_ok=True)
    manifest = []
    faltan: list[tuple[str, str]] = []
    convertidas = []
    for pid in ids:
        ruta = mapa.get(pid)
        if not ruta:
            faltan.append((pid, "sin entrada en data.js"))
            continue
        fuente = resolver_fuente(products_dir, ruta)
        if not fuente:
            faltan.append((pid, ruta))
            continue
        archivo = destino / f"{pid}.jpg"
        if fuente.suffix.lower() in (".webp", ".png"):
            convertidas.append(pid)
        normalizar_a_jpg(fuente, archivo)
        with Image.open(archivo) as im:
            im.verify()
        with Image.open(archivo) as im:
            ancho, alto = im.size
        raw = archivo.read_bytes()
        manifest.append({
            "id": pid,
            "archivo": archivo.name,
            "origen": fuente.name,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
            "ancho": ancho,
            "alto": alto,
        })

    manifest.sort(key=lambda x: x["id"])
    salida = {
        "generado": "2026-11-13",
        "origen": web.name,
        "total": len(manifest),
        "convertidas_desde_webp": sorted(convertidas),
        "items": manifest,
    }
    (destino / "manifest.json").write_text(json.dumps(salida, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Imágenes listas en {destino}: {len(manifest)}/{len(ids)}")
    if convertidas:
        print(f"Convertidas de .webp/.png a .jpg: {len(convertidas)} → {', '.join(sorted(convertidas))}")
    if faltan:
        print(f"FALTAN {len(faltan)} imágenes (pídelas al dueño):")
        for pid, ruta in faltan:
            print(f"  - {pid} ({ruta})")
        return 2

    # Duplicados exactos: dos perfumes con la misma foto (posible error del catálogo).
    por_hash: dict[str, list[str]] = {}
    for it in manifest:
        por_hash.setdefault(it["sha256"], []).append(it["id"])
    dup = {h: v for h, v in por_hash.items() if len(v) > 1}
    if dup:
        print(f"AVISO: {len(dup)} imagen(es) repetidas entre productos:")
        for v in dup.values():
            print("  - " + ", ".join(v))
    else:
        print("Sin imágenes duplicadas entre productos.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
