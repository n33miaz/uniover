"""Onde ficam os `.ico` da bandeja e como pegar um quadro (sem pystray, em qualquer sistema)."""

from pathlib import Path

from PIL import Image


def assets_dir() -> Path:
    """`assets/tray` ao lado do código: na instalação é `app/assets/tray`, no repositório
    `apps/agent/assets/tray`."""
    return Path(__file__).resolve().parents[3] / "assets" / "tray"


def frame(path: Path, size: int) -> Image.Image:
    """O quadro do `.ico` mais próximo de `size`, só para o pystray ter uma imagem (o Windows lê o
    arquivo)."""
    with Image.open(path) as icon:
        sizes = sorted(icon.info.get("sizes") or {icon.size})
        chosen = min(sizes, key=lambda candidate: abs(candidate[0] - size))
        icon.size = chosen  # type: ignore[misc]
        icon.load()
        return icon.convert("RGBA")
