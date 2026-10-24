"""QR do link de aprovação, desenhado no terminal.

O `segno` só gera a matriz de módulos. O desenho é nosso porque o `terminal()` dele depende de
cores ANSI, que o console do Windows PowerShell 5.1 nem sempre liga, e porque o terminal do
Windows é escuro: aqui os módulos **claros** (e a margem) são os preenchidos, então o código sai
branco sobre o fundo escuro e a câmera lê com a polaridade certa.
"""

import sys
from typing import TextIO

import segno

# Margem em módulos. A norma pede 4; câmeras de celular leem bem com 3, e cada módulo a mais custa
# linhas de um console que costuma ter 30.
_QUIET_ZONE = 3
_FULL, _UPPER, _LOWER, _EMPTY = "█", "▀", "▄", " "


def _grid(link: str) -> list[list[bool]]:
    """Matriz com a margem; `True` é módulo escuro."""
    matrix = segno.make(link, error="m", micro=False).matrix
    width = len(matrix) + 2 * _QUIET_ZONE
    blank = [False] * width
    rows = [blank] * _QUIET_ZONE
    rows += [
        [False] * _QUIET_ZONE + [bool(cell) for cell in row] + [False] * _QUIET_ZONE
        for row in matrix
    ]
    rows += [blank] * _QUIET_ZONE
    return rows


def render_blocks(link: str) -> str:
    """Duas linhas de módulos por linha de texto, com meio-bloco (compacto: ~20 linhas)."""
    rows = _grid(link)
    if len(rows) % 2:
        rows.append([False] * len(rows[0]))
    lines: list[str] = []
    for top, bottom in zip(rows[0::2], rows[1::2], strict=True):
        # Escuro = vazio; claro = preenchido (ver a nota do módulo).
        lines.append(
            "".join(
                _EMPTY if t and b else _LOWER if t else _UPPER if b else _FULL
                for t, b in zip(top, bottom, strict=True)
            )
        )
    return "\n".join(lines)


def render_ascii(link: str) -> str:
    """Alternativa para consoles que não sabem desenhar blocos: dois caracteres por módulo."""
    return "\n".join("".join("  " if dark else "##" for dark in row) for row in _grid(link))


def supports_blocks(stream: TextIO) -> bool:
    """O terminal escreve meios-blocos? (Saída redirecionada em cp1252 não escreve.)"""
    encoding = getattr(stream, "encoding", None) or "ascii"
    try:
        (_FULL + _UPPER + _LOWER).encode(encoding)
    except UnicodeEncodeError, LookupError:
        return False
    return True


def render_for(link: str, stream: TextIO | None = None) -> str:
    """O desenho que cabe no terminal dado (padrão: a saída padrão)."""
    target = stream or sys.stdout
    return render_blocks(link) if supports_blocks(target) else render_ascii(link)
