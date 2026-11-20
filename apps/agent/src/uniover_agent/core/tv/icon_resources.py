"""Imagem quadrada de reserva de um ícone adaptativo, lida da tabela de recursos do APK.

Um app moderno declara o ícone como XML adaptativo (`res/mipmap-anydpi-v26/ic_launcher.xml`), que a
tela web não desenha. Mas o mesmo recurso costuma trazer, nas outras configurações, o ícone legado
em PNG ou WebP (`mdpi` a `xxxhdpi`). O `aapt2 dump badging` só mostra a melhor configuração de cada
densidade, que é sempre o XML; o legado só aparece em `aapt2 dump resources`, como:

    resource 0x7f0f0000 mipmap/ic_launcher
      (mdpi) (file) res/d2.webp
      (xxxhdpi) (file) res/sK.webp
      (anydpi-v26) (file) res/BW.xml type=XML
    resource 0x7f0f0001 mipmap/ic_launcher_foreground
      (mdpi) (file) res/Nt.webp

Dois cuidados que moldam este módulo:

* só vale o **mesmo** recurso do XML. Logo abaixo dele ficam `ic_launcher_foreground` e
  `ic_launcher_background`, que também são PNG quadrados mas são camadas (a da frente costuma ser
  transparente): no lugar do legado elas mostrariam um desenho solto. Cada recurso é lido como um
  bloco isolado. Só quando o app não traz legado nenhum entra a camada da frente, por último
  (`parse_adaptive_foreground` e `parse_resource_rasters`), achada pela referência do próprio XML;
* as linhas `(file)` ora terminam em `type=PNG`, ora (WebP) não trazem `type=`: o tipo da imagem
  nunca se lê dali, só da extensão aqui e do cabeçalho do conteúdo depois.
"""

import re
from collections.abc import Collection
from typing import Final

from uniover_agent.core.tv.icon_badging import is_raster_entry

_RESOURCE_LINE: Final = re.compile(r"^\s+resource 0x[0-9a-fA-F]+ (?P<type>[a-z]+)/")
_FILE_LINE: Final = re.compile(r"^\s+\((?P<config>[^)]*)\) \(file\) (?P<path>\S+)")
# Só os tipos onde mora ícone: tabelas de recursos têm dezenas de milhares de linhas.
_ICON_TYPES: Final = frozenset({"mipmap", "drawable"})
_DENSITY_DPI: Final = {
    "ldpi": 120,
    "mdpi": 160,
    "tvdpi": 213,
    "hdpi": 240,
    "xhdpi": 320,
    "xxhdpi": 480,
    "xxxhdpi": 640,
}
_ANY: Final = 65534
# Qualificadores que não mudam o desenho (versão da plataforma e densidade "qualquer").
_NEUTRAL_QUALIFIER: Final = re.compile(r"v\d+|anydpi|nodpi")


def _density_of(config: str) -> int | None:
    """Densidade de uma configuração só de densidade/versão; `None` se há outro qualificador.

    `night`, idioma, `ldrtl`, tamanho de tela e semelhantes são variações do desenho, não do
    tamanho: a imagem delas não é "o ícone" do app. Configuração vazia (padrão) vale "qualquer".
    """
    density = _ANY
    for part in filter(None, config.split("-")):
        if part in _DENSITY_DPI:
            density = _DENSITY_DPI[part]
        elif not _NEUTRAL_QUALIFIER.fullmatch(part):
            return None
    return density


def parse_icon_fallbacks(text: str, adaptive: Collection[str]) -> tuple[str, ...]:
    """PNG/WebP dos recursos que têm um dos ícones XML `adaptive`, da maior densidade à menor.

    Só olha o bloco do mesmo recurso (o do XML), nunca os vizinhos. Texto sem nada útil devolve
    vazio (nunca levanta).
    """
    wanted = set(adaptive)
    if not wanted:
        return ()
    found: list[tuple[int, str]] = []
    block: list[tuple[int, str]] = []
    reading = False
    hit = False
    for line in text.splitlines():
        header = _RESOURCE_LINE.match(line)
        if header:
            if hit:
                found.extend(block)
            block, hit = [], False
            reading = header.group("type") in _ICON_TYPES
            continue
        if not reading:
            continue
        entry = _FILE_LINE.match(line)
        if not entry:
            continue
        path = entry.group("path")
        if path in wanted:
            hit = True
            continue
        density = _density_of(entry.group("config"))
        if density is not None and is_raster_entry(path):
            block.append((density, path))
    if hit:
        found.extend(block)
    # Maior densidade primeiro; "qualquer" por último. Ordenação estável: empate segue o texto.
    found.sort(key=lambda item: (item[0] == _ANY, -item[0]))
    return tuple(dict.fromkeys(path for _, path in found))


# Uma linha de atributo do `aapt2 dump xmltree` que aponta para outro recurso, por exemplo:
#   A: http://schemas.android.com/apk/res/android:drawable(0x01010199)=@0x7f0e0001
_ELEMENT_LINE: Final = re.compile(r"^(?P<indent>\s*)E: (?P<name>[\w.-]+)")
_DRAWABLE_REF: Final = re.compile(r"^\s*A: \S*:drawable\([^)]*\)=@0x(?P<id>[0-9a-fA-F]{8})\b")
_RESOURCE_ID: Final = re.compile(r"^\s+resource 0x(?P<id>[0-9a-fA-F]+) (?P<type>[a-z]+)/")


def parse_adaptive_foreground(xmltree: str) -> int | None:
    """Id do recurso da camada da frente (`<foreground android:drawable>`) do ícone adaptativo.

    Lê a saída de `aapt2 dump xmltree --file <xml> <apk>`. Sem `<foreground>` com referência a um
    recurso (uma cor direta, um desenho embutido) devolve `None`; nunca levanta.
    """
    inside: int | None = None
    for line in xmltree.splitlines():
        element = _ELEMENT_LINE.match(line)
        if element:
            depth = len(element.group("indent"))
            if element.group("name") == "foreground":
                inside = depth
            elif inside is not None and depth <= inside:
                inside = None
            continue
        if inside is None:
            continue
        reference = _DRAWABLE_REF.match(line)
        if reference:
            return int(reference.group("id"), 16)
    return None


def parse_resource_rasters(text: str, resource_id: int) -> tuple[str, ...]:
    """PNG/WebP de um recurso (pelo id) de `aapt2 dump resources`, da maior densidade à menor.

    É assim que se acha a imagem da camada da frente de um ícone adaptativo quando o app não traz
    o ícone legado: a camada é um quadrado de 108 dp, com o desenho no meio e o resto transparente
    (a tela apara a margem e, se a tinta for clara, põe um fundo escuro). Recurso que só tem XML
    (vetor, `inset`) devolve vazio; nunca levanta.
    """
    found: list[tuple[int, str]] = []
    reading = False
    for line in text.splitlines():
        header = _RESOURCE_ID.match(line)
        if header:
            if reading:
                break
            reading = (
                int(header.group("id"), 16) == resource_id and header.group("type") in _ICON_TYPES
            )
            continue
        if not reading:
            continue
        entry = _FILE_LINE.match(line)
        if not entry:
            continue
        density = _density_of(entry.group("config"))
        path = entry.group("path")
        if density is not None and is_raster_entry(path):
            found.append((density, path))
    found.sort(key=lambda item: (item[0] == _ANY, -item[0]))
    return tuple(dict.fromkeys(path for _, path in found))
