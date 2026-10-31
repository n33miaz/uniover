"""Portas da bandeja: o registro de ícones do Windows 11 e a lembrança de que já foi promovido."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class NotifyIconEntry:
    r"""Uma linha de `HKCU\Control Panel\NotifyIconSettings`: o Windows cria uma por ícone de
    bandeja."""

    key: str
    executable_path: str
    tooltip: str


class NotifyIconSettings(Protocol):
    def entries(self) -> list[NotifyIconEntry]:
        """Os ícones que o Windows conhece. Nunca levanta: sem acesso ao registro, lista vazia."""
        ...

    def promote(self, key: str) -> bool:
        """Põe o ícone na área visível da barra (`IsPromoted=1`). `False` se não foi possível."""
        ...


class PromotionMarker(Protocol):
    """Lembra, por executável, que o ícone já foi promovido uma vez (e nunca mais é mexido)."""

    def done(self, executable: str) -> bool: ...

    def mark(self, executable: str) -> None: ...
