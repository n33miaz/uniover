"""Gera as ilustrações de exercício em WebP leve e de tamanho único a partir dos originais do Everkinetic.

Os originais ficam intactos em assets-third-party/everkinetic (ADR 0012). Aqui nasce a adaptação publicada em
/exercise-art/. Cada par de poses recebe o MESMO recorte (a caixa que une os dois quadros, para a figura não "pular"
ao trocar de pose), é centralizado sobre fundo branco na proporção 268:275 e sai em 536x550 como WebP com perda leve,
com no máximo 20 KB (a qualidade desce de 85 até caber).

Duas origens, uma saída padronizada:
- png/NOME-1.png e NOME-2.png (os exercícios que só têm PNG) viram NOME-1.webp e NOME-2.webp;
- os SVG (NNNN-relaxation e NNNN-tension), já rasterizados por scripts/render-exercise-svg.mjs numa pasta de apoio,
  viram NNNN-relaxation.webp e NNNN-tension.webp.

Uso (a partir de apps/web), com Pillow instalado:
    node scripts/render-exercise-svg.mjs <pasta de apoio>
    python -I scripts/optimize-exercise-art.py <pasta de apoio>
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
PNG_SOURCE = ROOT / "assets-third-party" / "everkinetic" / "png"
TARGET = ROOT / "assets-derived" / "everkinetic"

CANVAS = (536, 550)  # 2x de 268x275, a proporção única das figuras
MARGIN = 0.06
QUALITY = 85
MIN_QUALITY = 50
MAX_BYTES = 20_000
INK_THRESHOLD = 24

# Figuras em que a barra é bem mais larga que o corpo (a figura ficaria pequena no quadro): corta a largura da caixa do
# par para esta faixa (frações da largura, da esquerda para a direita), mantendo o corpo inteiro e um trecho da barra.
CROP_X = {"0090": (0.2, 0.92)}


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


def convert_pair(sources: tuple[Path, Path], outputs: tuple[Path, Path]) -> None:
    frames = [Image.open(path).convert("RGB") for path in sources]
    if frames[0].size != frames[1].size:
        # Poucos pares têm pranchetas de alturas diferentes (mesma escala, mesma origem no canto superior esquerdo):
        # as duas vão para uma prancheta comum, com o branco do fundo completando a menor.
        common = (max(f.size[0] for f in frames), max(f.size[1] for f in frames))
        padded = []
        for frame in frames:
            board = Image.new("RGB", common, "white")
            board.paste(frame, (0, 0))
            padded.append(board)
        frames = padded
    boxes = [ink_box(frame) for frame in frames]
    union = (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )
    stem = outputs[0].name[:4]
    if stem in CROP_X:
        left, right = CROP_X[stem]
        span = union[2] - union[0]
        union = (union[0] + round(span * left), union[1], union[0] + round(span * right), union[3])
    width, height = union[2] - union[0], union[3] - union[1]
    inner = (CANVAS[0] * (1 - 2 * MARGIN), CANVAS[1] * (1 - 2 * MARGIN))
    scale = min(inner[0] / width, inner[1] / height)
    size = (round(width * scale), round(height * scale))
    offset = ((CANVAS[0] - size[0]) // 2, (CANVAS[1] - size[1]) // 2)
    for frame, out in zip(frames, outputs):
        canvas = Image.new("RGB", CANVAS, "white")
        canvas.paste(frame.crop(union).resize(size, Image.LANCZOS), offset)
        save_light(canvas, out)


def main() -> None:
    TARGET.mkdir(parents=True, exist_ok=True)
    for stem in sorted({path.name.rsplit("-", 1)[0] for path in PNG_SOURCE.glob("*-[12].png")}):
        convert_pair(
            (PNG_SOURCE / f"{stem}-1.png", PNG_SOURCE / f"{stem}-2.png"),
            (TARGET / f"{stem}-1.webp", TARGET / f"{stem}-2.webp"),
        )
    if len(sys.argv) > 1:
        rendered = Path(sys.argv[1])
        for stem in sorted({path.name.split("-", 1)[0] for path in rendered.glob("*-relaxation.png")}):
            convert_pair(
                (rendered / f"{stem}-relaxation.png", rendered / f"{stem}-tension.png"),
                (TARGET / f"{stem}-relaxation.webp", TARGET / f"{stem}-tension.webp"),
            )


if __name__ == "__main__":
    main()
