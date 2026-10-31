r"""Promove o ícone para a área visível da barra do Windows 11, uma única vez.

O Windows 11 esconde por padrão os ícones novos no menu "^" da bandeja. A escolha de cada ícone mora
em `HKCU\Control Panel\NotifyIconSettings\<id>` (valor `IsPromoted`: 1 visível, 0 no menu), e o
Windows cria a linha só depois de o ícone aparecer. Por isso a promoção roda no próprio processo da
bandeja, depois do primeiro registro. Ela vale uma vez por executável: se a pessoa esconder o ícone
depois, nada o traz de volta.
"""

import re
from typing import Final, Literal

from uniover_agent.ports.tray import NotifyIconEntry, NotifyIconSettings, PromotionMarker

PromotionResult = Literal["promoted", "already_done", "not_found", "failed"]

TOOLTIP_PREFIX: Final = "UniOver"
# O Windows troca pastas conhecidas por um GUID no começo do caminho (`{GUID}\Programs\...`).
_KNOWN_FOLDER = re.compile(r"^\{[0-9A-Fa-f-]{36}\}[\\/]")


def _normal(path: str) -> str:
    return path.replace("/", "\\").strip().lower()


def same_executable(entry_path: str, own_path: str) -> bool:
    """O caminho do registro é o do nosso processo (aceitando o prefixo de pasta conhecida)."""
    stored, own = _normal(entry_path), _normal(own_path)
    if not stored or not own:
        return False
    if stored == own:
        return True
    if _KNOWN_FOLDER.match(entry_path.strip()):
        rest = stored.split("\\", 1)[1]
        return own.endswith("\\" + rest)
    return False


def find_entry(entries: list[NotifyIconEntry], own_path: str) -> NotifyIconEntry | None:
    """A linha do nosso ícone: o executável é o mesmo e a dica começa com UniOver (ou ainda está
    vazia).

    O executável é, em geral, o `python.exe` do ambiente, que outros programas Python também usam; a
    dica separa."""
    for entry in entries:
        if not same_executable(entry.executable_path, own_path):
            continue
        if entry.tooltip == "" or entry.tooltip.startswith(TOOLTIP_PREFIX):
            return entry
    return None


def promote_once(
    settings: NotifyIconSettings, marker: PromotionMarker, own_executable: str
) -> PromotionResult:
    """Promove o ícone se ainda não foi feito. `not_found` quer dizer "o Windows ainda não criou a
    linha"; vale tentar de novo."""
    if marker.done(own_executable):
        return "already_done"
    entry = find_entry(settings.entries(), own_executable)
    if entry is None:
        return "not_found"
    if not settings.promote(entry.key):
        return "failed"
    marker.mark(own_executable)
    return "promoted"
