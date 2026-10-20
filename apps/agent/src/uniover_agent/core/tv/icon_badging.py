"""Leitura da saída de `aapt2 dump badging` e conferência da imagem candidata a ícone.

Tudo aqui é puro (sem processo, sem disco). Fatos medidos na TV que moldam este módulo:

* os caminhos dentro do APK costumam ser ofuscados (`res/BW.xml`, `res/Ec.png`): nunca se assume
  `mipmap-*` nem nome de arquivo;
* ícones adaptativos modernos são XML e não servem a uma tela web: só PNG e WebP entram. Há apps
  (o CineVS e o Spotify, por exemplo) em que **todo** `application-icon-*` é XML; a imagem quadrada
  de reserva desses apps só aparece na tabela de recursos (`icon_resources`), nunca no `badging`;
* o `banner` (16:9) é a arte do lançador da TV, não o ícone do app: ele nunca é candidato. A tela só
  mostra ícone quadrado, então o que se publica precisa ter largura igual à altura;
* a densidade `65534` (e `65535`) é "qualquer densidade" e vai por último entre os ícones;
* o tipo e as dimensões da imagem não se deduzem do nome: quem decide é o cabeçalho do conteúdo
  (`image_info`).
"""

import re
import struct
from dataclasses import dataclass
from typing import Final

# Mesmo teto do contrato: 32768 bytes viram até 43692 caracteres de base64.
MAX_ICON_BYTES: Final = 32 * 1024
# Lado máximo aceito numa imagem. Ícone de app é pequeno; algo maior é arquivo errado.
MAX_IMAGE_SIDE: Final = 4096
# Lado preferido: o ícone de lançador de maior densidade (48 dp x 4) tem 192 px, o que sobra para um
# azulejo de 56 px numa tela 3x. Sem biblioteca de imagem não dá para reduzir, então isto só
# escolhe entre as imagens que o APK já traz.
PREFERRED_MAX_SIDE: Final = 192

_ANY_DENSITIES: Final = frozenset({65534, 65535})
_PACKAGE_LINE: Final = re.compile(
    r"^package: name='(?P<name>[^']*)'(?:.*?\bversionCode='(?P<version>\d+)')?"
)
_APP_ICON_LINE: Final = re.compile(r"^application-icon-(?P<density>\d+):'(?P<path>[^']*)'\s*$")
_ATTRIBUTE: Final = r"\b{name}='(?P<value>(?:[^'\\]|\\.)*)'"
_PNG_SIGNATURE: Final = b"\x89PNG\r\n\x1a\n"
_PNG_HEADER_END: Final = 24
_WEBP_HEADER_END: Final = 30
_VP8_START_CODE: Final = b"\x9d\x01\x2a"
_VP8L_SIGNATURE: Final = 0x2F
_VP8X_ANIMATION_FLAG: Final = 0x02


@dataclass(frozen=True, slots=True)
class BadgingInfo:
    """Do `badging`: pacote, `versionCode`, candidatos a ícone (do melhor ao pior) e ícones XML.

    `adaptive` guarda os caminhos dos ícones em XML (ícone adaptativo): são a chave para achar a
    imagem quadrada de reserva do mesmo recurso na tabela de recursos.
    """

    package: str | None
    version_code: int | None
    candidates: tuple[str, ...]
    adaptive: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ImageInfo:
    """O que o cabeçalho de uma imagem PNG ou WebP diz dela."""

    mime: str
    width: int
    height: int

    @property
    def is_square(self) -> bool:
        return self.width == self.height


def _attribute(line: str, name: str) -> str | None:
    match = re.search(_ATTRIBUTE.format(name=name), line)
    return match.group("value") if match else None


def _is_safe_entry(path: str) -> bool:
    """Caminho seguro dentro do APK: sem `/` inicial, `\\`, `..` nem caracteres de controle.

    O nome só é usado para abrir um arquivo dentro do ZIP, mas vem de uma ferramenta lendo um APK
    de terceiros.
    """
    if not path or path.startswith(("/", "\\")) or "\\" in path:
        return False
    if any(not char.isprintable() for char in path):
        return False
    return ".." not in path.split("/")


def is_raster_entry(path: str) -> bool:
    """Caminho seguro que termina em imagem que a tela aceita (PNG ou WebP). Recusa XML."""
    return _is_safe_entry(path) and path.lower().endswith((".png", ".webp"))


def is_xml_entry(path: str) -> bool:
    """Caminho seguro que termina em XML (ícone adaptativo)."""
    return _is_safe_entry(path) and path.lower().endswith(".xml")


def _package_and_version(line: str) -> tuple[str | None, int | None]:
    found = _PACKAGE_LINE.match(line)
    if not found:
        return None, None
    version = found.group("version")
    return found.group("name") or None, int(version) if version else None


def parse_badging(text: str) -> BadgingInfo:
    """Extrai pacote, versão, candidatos e ícones XML. Ordem dos candidatos (só PNG/WebP):

    1. `application-icon-<dpi>`, do maior `dpi` para o menor (qualquer densidade por último);
    2. o `icon` da linha `application:`, se ainda não apareceu;
    3. o `icon` da atividade de entrada.

    O `banner` (do `application:` e da atividade do lançador) **não** entra: é arte 16:9 da TV.
    Texto sem nada útil devolve candidatos vazios (nunca levanta).
    """
    package: str | None = None
    version: int | None = None
    icons: list[tuple[int, str]] = []
    application_icon: str | None = None
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
        elif line.startswith(("launchable-activity:", "leanback-launchable-activity:")):
            icon = _attribute(line, "icon")
            if icon:
                activity_icons.append(icon)

    # Maior densidade primeiro; "qualquer densidade" (65534) vira a última escolha entre os ícones.
    icons.sort(key=lambda item: (item[0] in _ANY_DENSITIES, -item[0]))
    ordered = [path for _, path in icons]
    if application_icon:
        ordered.append(application_icon)
    ordered.extend(activity_icons)
    unique = list(dict.fromkeys(ordered))
    candidates = tuple(path for path in unique if is_raster_entry(path))
    adaptive = tuple(path for path in unique if is_xml_entry(path))
    return BadgingInfo(package, version, candidates, adaptive)


def _png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < _PNG_HEADER_END or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:_PNG_HEADER_END])
    return width, height


def _webp_size(data: bytes) -> tuple[int, int] | None:
    """Largura e altura dos três tipos de WebP (com perda, sem perda e estendido); senão `None`.

    WebP animado não serve de ícone (a tela mostraria só o primeiro quadro, ou nada).
    """
    if len(data) < _WEBP_HEADER_END:
        return None
    kind = data[12:16]
    if kind == b"VP8 " and data[23:26] == _VP8_START_CODE:
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if kind == b"VP8L" and data[20] == _VP8L_SIGNATURE:
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if kind == b"VP8X" and not data[20] & _VP8X_ANIMATION_FLAG:
        return (
            int.from_bytes(data[24:27], "little") + 1,
            int.from_bytes(data[27:30], "little") + 1,
        )
    return None


def image_info(data: bytes) -> ImageInfo | None:
    """Tipo e dimensões de um PNG ou WebP pelo cabeçalho; `None` para qualquer outra coisa.

    Cabeçalho truncado, dimensão zero ou acima de `MAX_IMAGE_SIDE` também devolvem `None`: não dá
    para conferir que a imagem é quadrada, então ela não é publicada.
    """
    if data.startswith(_PNG_SIGNATURE):
        mime, size = "image/png", _png_size(data)
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        mime, size = "image/webp", _webp_size(data)
    else:
        return None
    if size is None:
        return None
    width, height = size
    if 0 < width <= MAX_IMAGE_SIDE and 0 < height <= MAX_IMAGE_SIDE:
        return ImageInfo(mime, width, height)
    return None
