"""Gera as ilustrações de exercício em WebP leve a partir dos PNG originais do Everkinetic.

Os originais ficam intactos em assets-third-party/everkinetic/png (ADR 0012). Aqui nasce a adaptação publicada em
/exercise-art/: cada par de poses (NOME-1.png e NOME-2.png) recebe o MESMO recorte (a caixa que une os dois quadros,
para a figura não "pular" ao trocar de pose), é centralizado sobre fundo branco na proporção 268:275 dos SVG e sai em
536x550 (duas vezes o tamanho de uso) como WebP com perda leve.

Uso (a partir de apps/web), com Pillow instalado:
    python -I scripts/optimize-exercise-art.py
"""

from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets-third-party" / "everkinetic" / "png"
TARGET = ROOT / "assets-derived" / "everkinetic"

CANVAS = (536, 550)  # 2x de 268x275, a proporção dos SVG
MARGIN = 0.06
QUALITY = 85
INK_THRESHOLD = 24


def ink_box(image: Image.Image) -> tuple[int, int, int, int]:
    """Caixa do desenho (tudo que não é o branco do fundo)."""
    white = Image.new("RGB", image.size, "white")
    mask = ImageChops.difference(image, white).convert("L").point(lambda v: 255 if v > INK_THRESHOLD else 0)
    box = mask.getbbox()
    if box is None:
        raise SystemExit("imagem sem desenho")
    return box


def main() -> None:
    TARGET.mkdir(parents=True, exist_ok=True)
    stems = sorted({path.name.rsplit("-", 1)[0] for path in SOURCE.glob("*-[12].png")})
    for stem in stems:
        frames = [Image.open(SOURCE / f"{stem}-{pose}.png").convert("RGB") for pose in (1, 2)]
        if frames[0].size != frames[1].size:
            raise SystemExit(f"{stem}: as duas poses têm tamanhos diferentes")
        boxes = [ink_box(frame) for frame in frames]
        union = (
            min(b[0] for b in boxes),
            min(b[1] for b in boxes),
            max(b[2] for b in boxes),
            max(b[3] for b in boxes),
        )
        width, height = union[2] - union[0], union[3] - union[1]
        inner = (CANVAS[0] * (1 - 2 * MARGIN), CANVAS[1] * (1 - 2 * MARGIN))
        scale = min(inner[0] / width, inner[1] / height)
        size = (round(width * scale), round(height * scale))
        offset = ((CANVAS[0] - size[0]) // 2, (CANVAS[1] - size[1]) // 2)
        for pose, frame in zip((1, 2), frames):
            canvas = Image.new("RGB", CANVAS, "white")
            canvas.paste(frame.crop(union).resize(size, Image.LANCZOS), offset)
            out = TARGET / f"{stem}-{pose}.webp"
            canvas.save(out, "WEBP", quality=QUALITY, method=6)
            print(out.name, out.stat().st_size)


if __name__ == "__main__":
    main()
