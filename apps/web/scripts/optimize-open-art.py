"""Gera as ilustrações do Open Exercise Art no mesmo padrão das do Everkinetic: WebP leve, 536x550.

Os SVG originais ficam intactos em assets-third-party/open-exercise-art (ADR 0012). Aqui nasce a adaptação publicada em
/exercise-art/. Cada figura (uma pose só) é recortada pela caixa do desenho, centralizada sobre fundo branco com a
mesma margem das figuras do Everkinetic (6%) e sai em 536x550 como WebP com perda leve, com no máximo 20 KB (a
qualidade desce de 85 até caber). O nome do arquivo ganha o prefixo "oea-".

Enquadramento: a caixa do desenho é sempre levada à mesma área útil do quadro, com a mesma margem e a mesma proporção
das figuras do Everkinetic. O desenho em si não é redesenhado nem retocado.

Uso (a partir de apps/web), com Pillow instalado:
    node scripts/render-open-art.mjs <pasta de apoio>
    python -I scripts/optimize-open-art.py <pasta de apoio>
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "assets-derived" / "open-exercise-art"
PREFIX = "oea-"

CANVAS = (536, 550)  # a proporção única das figuras (2x de 268x275)
MARGIN = 0.06
QUALITY = 85
MIN_QUALITY = 30
MAX_BYTES = 20_000
INK_THRESHOLD = 24


def ink_box(image: Image.Image) -> tuple[int, int, int, int]:
    """Caixa do desenho (tudo que não é o branco do fundo)."""
    white = Image.new("RGB", image.size, "white")
    mask = ImageChops.difference(image, white).convert("L").point(lambda v: 255 if v > INK_THRESHOLD else 0)
    box = mask.getbbox()
    if box is None:
        raise SystemExit("imagem sem desenho")
    return box


def save_light(canvas: Image.Image, out: Path) -> None:
    """Grava o WebP na melhor qualidade que ainda cabe no limite de peso."""
    quality = QUALITY
    while True:
        canvas.save(out, "WEBP", quality=quality, method=6)
        if out.stat().st_size <= MAX_BYTES or quality <= MIN_QUALITY:
            break
        quality -= 5
    if out.stat().st_size > MAX_BYTES:
        raise SystemExit(f"{out.name}: {out.stat().st_size} bytes mesmo na qualidade mínima")
    print(out.name, out.stat().st_size, f"q{quality}")


def convert(source: Path, output: Path) -> None:
    frame = Image.open(source).convert("RGB")
    box = ink_box(frame)
    width, height = box[2] - box[0], box[3] - box[1]
    inner = (CANVAS[0] * (1 - 2 * MARGIN), CANVAS[1] * (1 - 2 * MARGIN))
    scale = min(inner[0] / width, inner[1] / height)
    size = (round(width * scale), round(height * scale))
    offset = ((CANVAS[0] - size[0]) // 2, (CANVAS[1] - size[1]) // 2)
    canvas = Image.new("RGB", CANVAS, "white")
    canvas.paste(frame.crop(box).resize(size, Image.LANCZOS), offset)
    save_light(canvas, output)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("uso: python -I scripts/optimize-open-art.py <pasta com os PNG rasterizados>")
    rendered = Path(sys.argv[1])
    TARGET.mkdir(parents=True, exist_ok=True)
    for source in sorted(rendered.glob("*.png")):
        convert(source, TARGET / f"{PREFIX}{source.stem}.webp")


if __name__ == "__main__":
    main()
