"""Genera copias optimizadas (peso bajo) de las fotos del catálogo.

Uso:
    python scripts/catalogo/optimizar-imagenes.py

Lee `docs/catalogo/productos.json` y busca cada `imagen_ruta` en el repo o en el
checkout hermano del sitio. Las copias se guardan en
`docs/catalogo/img-opt/<misma ruta>` con ancho máximo 640 px y JPEG calidad 74,
que es de sobra para las tarjetas del PDF (6 por página A4).

Así el PDF final baja de ~10 MB a ~3 MB y el envío por WhatsApp es mucho más
rápido, sin que se note pérdida de calidad a tamaño de lectura.
"""

import json
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[2]
DESTINO = REPO / "docs" / "catalogo" / "img-opt"
RAICES = [
    REPO,
    REPO.parent / "perfumeria-fina-peru",
]
ANCHO_MAX = 640
CALIDAD = 74


def resolver(ruta_rel: str):
    rel = str(ruta_rel or "").replace("\\", "/").lstrip("/")
    for raiz in RAICES:
        cand = raiz / rel
        if cand.exists():
            return cand
    return None


def main() -> int:
    datos = json.loads((REPO / "docs" / "catalogo" / "productos.json").read_text(encoding="utf-8"))
    ok = fallos = 0
    for p in datos:
        origen = resolver(p.get("imagen_ruta"))
        if not origen:
            fallos += 1
            continue
        destino = DESTINO / str(p["imagen_ruta"]).replace("\\", "/")
        destino.parent.mkdir(parents=True, exist_ok=True)
        try:
            with Image.open(origen) as im:
                im = im.convert("RGB")
                if im.width > ANCHO_MAX:
                    alto = round(im.height * ANCHO_MAX / im.width)
                    im = im.resize((ANCHO_MAX, alto), Image.LANCZOS)
                im.save(destino, "JPEG", quality=CALIDAD, optimize=True, progressive=True)
            ok += 1
        except Exception as e:  # noqa: BLE001
            fallos += 1
            print(f"[aviso] {origen.name}: {e}")
    total = sum(f.stat().st_size for f in DESTINO.rglob("*.jpg"))
    print(f"Optimizadas {ok} imágenes ({fallos} fallos) · {total / 1024 / 1024:.2f} MB en {DESTINO}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
