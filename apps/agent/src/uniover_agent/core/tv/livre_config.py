"""A configuração do launcher do TV Livre: escrita estrita, no formato de `contracts/tv-launcher`.

O launcher é tolerante ao ler; quem escreve não pode ser. A API manda a configuração como texto
(`configJson`), que o portão do envelope não olha por dentro, então esta é a única conferência
antes de o arquivo ir para a TV: campo desconhecido, tipo errado ou valor fora da faixa recusam o
pedido inteiro. Os mesmos exemplos do contrato (válidos e inválidos) rodam contra ela nos testes.
"""

import json
import re
from typing import Any, Final

PHOTO_NAME: Final = "wallpaper.jpg"
MAX_ITEMS: Final = 64
MAX_HIDDEN: Final = 256

_COLOR: Final = re.compile(r"#[0-9A-Fa-f]{6}")
_PACKAGE: Final = re.compile(r"[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+")
_MAX_PACKAGE_LENGTH: Final = 255

_ENUMS: Final[dict[str, dict[str, tuple[str, ...]]]] = {
    "clock": {"size": ("small", "medium", "large"), "format": ("24h", "12h", "auto")},
    "wallpaper": {"type": ("gradient", "solid", "photo")},
    "apps": {"mode": ("listed", "all")},
    "icons": {
        "shape": ("circle",),
        "size": ("small", "medium", "large"),
        "labels": ("always", "focus", "never"),
    },
}
_BOOLEANS: Final[dict[str, tuple[str, ...]]] = {
    "clock": ("enabled", "seconds", "date"),
    "apps": ("showFactory",),
    "builtin": ("settings", "sleep"),
}
# Campos de cada seção que não são enum nem booleano (conferidos à mão abaixo).
_OTHER: Final[dict[str, tuple[str, ...]]] = {
    "wallpaper": ("colors", "angle", "dim"),
    "apps": ("items", "hidden"),
    "sleep": ("maxMinutes",),
}


class InvalidConfigError(ValueError):
    """A configuração não segue o contrato; a mensagem diz o campo, nunca o conteúdo."""


def is_valid_package_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= _MAX_PACKAGE_LENGTH
        and _PACKAGE.fullmatch(value) is not None
    )


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _packages(value: object, field: str, limit: int) -> list[str]:
    if not isinstance(value, list) or len(value) > limit:
        raise InvalidConfigError(f"{field}: lista inválida")
    if not all(is_valid_package_name(item) for item in value):
        raise InvalidConfigError(f"{field}: nome de pacote inválido")
    if len(set(value)) != len(value):
        raise InvalidConfigError(f"{field}: pacote repetido")
    return list(value)


def _wallpaper_extras(section: dict[str, Any], clean: dict[str, Any]) -> None:
    if "colors" in section:
        colors = section["colors"]
        if (
            not isinstance(colors, list)
            or not 1 <= len(colors) <= 3  # noqa: PLR2004 - o contrato aceita de 1 a 3 cores
            or not all(isinstance(c, str) and _COLOR.fullmatch(c) for c in colors)
        ):
            raise InvalidConfigError("wallpaper.colors: cores inválidas")
        clean["colors"] = list(colors)
    if "angle" in section:
        angle = section["angle"]
        if not _is_int(angle) or not 0 <= angle <= 315 or angle % 45 != 0:  # noqa: PLR2004
            raise InvalidConfigError("wallpaper.angle: ângulo inválido")
        clean["angle"] = angle
    if "dim" in section:
        dim = section["dim"]
        if isinstance(dim, bool) or not isinstance(dim, int | float) or not 0 <= dim <= 0.8:  # noqa: PLR2004
            raise InvalidConfigError("wallpaper.dim: valor inválido")
        clean["dim"] = dim


def _section(name: str, raw: object) -> dict[str, Any]:  # noqa: PLR0912 - uma seção, vários tipos
    if not isinstance(raw, dict):
        raise InvalidConfigError(f"{name}: objeto esperado")
    allowed = {*_ENUMS.get(name, {}), *_BOOLEANS.get(name, ()), *_OTHER.get(name, ())}
    unknown = set(raw) - allowed
    if unknown:
        raise InvalidConfigError(f"{name}: campo desconhecido")
    clean: dict[str, Any] = {}
    for field, options in _ENUMS.get(name, {}).items():
        if field in raw:
            if raw[field] not in options or not isinstance(raw[field], str):
                raise InvalidConfigError(f"{name}.{field}: valor inválido")
            clean[field] = raw[field]
    for field in _BOOLEANS.get(name, ()):
        if field in raw:
            if not isinstance(raw[field], bool):
                raise InvalidConfigError(f"{name}.{field}: booleano esperado")
            clean[field] = raw[field]
    if name == "wallpaper":
        _wallpaper_extras(raw, clean)
    elif name == "apps":
        for field, limit in (("items", MAX_ITEMS), ("hidden", MAX_HIDDEN)):
            if field in raw:
                clean[field] = _packages(raw[field], f"apps.{field}", limit)
    elif name == "sleep" and "maxMinutes" in raw:
        minutes = raw["maxMinutes"]
        if not _is_int(minutes) or not 0 <= minutes <= 720:  # noqa: PLR2004
            raise InvalidConfigError("sleep.maxMinutes: valor inválido")
        clean["maxMinutes"] = minutes
    return clean


def build_launcher_config(config_json: str, revision: int, *, photo: bool) -> dict[str, Any]:
    """O `config.json` que vai para a TV: o corpo da API conferido, mais `schema` e `revision`.

    `photo` diz que há uma foto enviada para esta aplicação: só então o nome do arquivo entra
    (a API nunca escolhe nome de arquivo) e só no papel de parede do tipo foto.
    """
    try:
        document = json.loads(config_json)
    except ValueError:
        raise InvalidConfigError("configJson: não é JSON") from None
    if not isinstance(document, dict):
        raise InvalidConfigError("configJson: objeto esperado")
    sections = {"clock", "wallpaper", "apps", "icons", "builtin", "sleep"}
    unknown = set(document) - sections
    if unknown:
        raise InvalidConfigError("configJson: campo desconhecido")
    if not _is_int(revision) or not 0 <= revision <= 2147483647:  # noqa: PLR2004
        raise InvalidConfigError("revision: valor inválido")
    result: dict[str, Any] = {"schema": 1, "revision": revision}
    for name in sorted(document):
        result[name] = _section(name, document[name])
    wallpaper = result.get("wallpaper")
    if photo and isinstance(wallpaper, dict) and wallpaper.get("type") == "photo":
        wallpaper["photo"] = PHOTO_NAME
    return result
