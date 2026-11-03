"""Apps favoritos do PC: o que o dono listou na configuração e o que o app pode pedir para abrir."""

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

MAX_FAVORITES: Final = 24
_ID_MAX: Final = 40
_LABEL_MAX: Final = 60


@dataclass(frozen=True, slots=True)
class PcApp:
    """Um favorito. `target` (caminho ou endereço) nunca sai do PC; o app só vê `id` e `label`."""

    id: str
    label: str
    target: str


def slugify(label: str) -> str:
    """`Navegador Web` vira `navegador-web`: sem acento, minúsculas, só letras, dígitos e hífen."""
    plain = unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")[:_ID_MAX].strip("-")
    return slug or "app"


def parse_favorites(entries: Sequence[str]) -> list[PcApp]:
    """`Nome=destino` por linha. Entrada sem `=`, sem nome ou sem destino é ignorada; ids repetidos
    ganham sufixo numérico, e a lista para no limite do contrato."""
    apps: list[PcApp] = []
    used: set[str] = set()
    for entry in entries:
        label, separator, target = entry.partition("=")
        label, target = label.strip()[:_LABEL_MAX], target.strip()
        if not separator or not label or not target:
            continue
        base = slugify(label)
        app_id, number = base, 2
        while app_id in used:
            suffix = f"-{number}"
            app_id = f"{base[: _ID_MAX - len(suffix)]}{suffix}"
            number += 1
        used.add(app_id)
        apps.append(PcApp(app_id, label, target))
        if len(apps) == MAX_FAVORITES:
            break
    return apps
