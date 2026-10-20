"""Leitura da saída de `aapt2 dump badging` e escolha dos arquivos de imagem candidatos a ícone.

Tudo aqui é puro (sem processo, sem disco). Fatos medidos na TV que moldam este módulo:

* os caminhos dentro do APK costumam ser ofuscados (`res/BW.xml`, `res/Ec.png`): nunca se assume
  `mipmap-*` nem nome de arquivo;
* ícones adaptativos modernos são XML e não servem a uma tela web: só PNG e WebP entram. Há apps
  (o CineVS, por exemplo) em que **todo** `application-icon-*` é XML e só o `banner` é PNG;
* a densidade `65534` (e `65535`) é "qualquer densidade" e vai por último entre os ícones;
* o tipo da imagem não se deduz da extensão: quem decide é o conteúdo (`detect_mime`).
"""

import re
import struct
from dataclasses import dataclass
from typing import Final

# Mesmo teto do contrato: 32768 bytes viram até 43692 caracteres de base64.
MAX_ICON_BYTES: Final = 32 * 1024
# Dimensão máxima aceita num PNG. Ícone de app é pequeno; algo maior é arquivo errado.
MAX_PNG_SIDE: Final = 4096

_ANY_DENSITY: Final = frozenset({65534, 65535})
_PACKAGE_LINE: Final = re.compile(
    r"^package: name='(?P<name>[^']*)'(?:.*?\bversionCode='(?P<version>\d+)')?"
)
_APP_ICON_LINE: Final = re.compile(r"^application-icon-(?P<density>\d+):'(?P<path>[^']*)'\s*$")
_ATTRIBUTE: Final = r"\b{name}='(?P<value>(?:[^'\\]|\\.)*)'"
_PNG_SIGNATURE: Final = b"\x89PNG\r\n\x1a\n"
_PNG_HEADER_END: Final = 24


@dataclass(frozen=True, slots=True)
class BadgingInfo:
    """Do `badging`: pacote, `versionCode` e os candidatos a ícone, do melhor ao pior."""

    package: str | None
    version_code: int | None
    candidates: tuple[str, ...]


def _attribute(line: str, name: str) -> str | None:
    match = re.search(_ATTRIBUTE.format(name=name), line)
    return match.group("value") if match else None


def is_raster_entry(path: str) -> bool:
    """Caminho seguro dentro do APK que termina em imagem que a tela aceita (PNG ou WebP).

    Recusa XML (ícone adaptativo), caminho absoluto, `..` e caracteres de controle: o nome só é
    usado para abrir um arquivo dentro do ZIP, mas vem de uma ferramenta lendo um APK de terceiros.
    """
    if not path or path.startswith(("/", "\\")) or "\\" in path:
        return False
    if any(not char.isprintable() for char in path):
        return False
    if ".." in path.split("/"):
        return False
    return path.lower().endswith((".png", ".webp"))


def _package_and_version(line: str) -> tuple[str | None, int | None]:
    found = _PACKAGE_LINE.match(line)
    if not found:
        return None, None
    version = found.group("version")
    return found.group("name") or None, int(version) if version else None


def _ordered_candidates(
    icons: list[tuple[int, str]],
    application_icon: str | None,
    banners: list[str],
    activity_icons: list[str],
) -> tuple[str, ...]:
    # Maior densidade primeiro; "qualquer densidade" (65534) vira a última escolha entre os ícones.
    icons.sort(key=lambda item: (item[0] in _ANY_DENSITY, -item[0]))
    ordered = [path for _, path in icons]
    if application_icon:
        ordered.append(application_icon)
    ordered.extend(banners)
    ordered.extend(activity_icons)
    candidates: list[str] = []
    for path in ordered:
        if is_raster_entry(path) and path not in candidates:
            candidates.append(path)
    return tuple(candidates)


def parse_badging(text: str) -> BadgingInfo:
    """Extrai pacote, versão e candidatos. Ordem dos candidatos:

    1. `application-icon-<dpi>` em PNG/WebP, do maior `dpi` para o menor (qualquer densidade por
       último), e o `icon` da linha `application:` se ainda não apareceu;
    2. banners (`leanback-launchable-activity` e `application`), úteis quando todo ícone é XML;
    3. o `icon` da atividade de entrada.

    Texto sem nada útil devolve candidatos vazios (nunca levanta).
    """
    package: str | None = None
    version: int | None = None
    icons: list[tuple[int, str]] = []
    application_icon: str | None = None
    banners: list[str] = []
    activity_icons: list[str] = []

    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("package:"):
            if package is None:
                package, version = _package_and_version(line)
            continue
        icon_line = _APP_ICON_LINE.match(line)
        if icon_line:
            icons.append((int(icon_line.group("density")), icon_line.group("path")))
        elif line.startswith("application:"):
            application_icon = _attribute(line, "icon")
            banner = _attribute(line, "banner")
            if banner:
                banners.append(banner)
        elif line.startswith("leanback-launchable-activity:"):
            banner = _attribute(line, "banner")
            if banner:
                banners.insert(0, banner)
        elif line.startswith("launchable-activity:"):
            icon = _attribute(line, "icon")
            if icon:
                activity_icons.append(icon)

    candidates = _ordered_candidates(icons, application_icon, banners, activity_icons)
    return BadgingInfo(package, version, candidates)


def detect_mime(data: bytes) -> str | None:
    """`image/png` ou `image/webp` pelo conteúdo; `None` para qualquer outra coisa.

    PNG: assinatura mais um `IHDR` com largura e altura plausíveis. WebP: `RIFF....WEBP`.
    """
    if data.startswith(_PNG_SIGNATURE):
        if len(data) < _PNG_HEADER_END or data[12:16] != b"IHDR":
            return None
        width, height = struct.unpack(">II", data[16:_PNG_HEADER_END])
        if 0 < width <= MAX_PNG_SIDE and 0 < height <= MAX_PNG_SIDE:
            return "image/png"
        return None
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None
