"""Portas da bandeja: o registro de ícones do Windows 11 e a lembrança de que já foi promovido."""

from dataclasses import dataclass
from typing import Final, Protocol

# Identificador do ícone junto ao Windows (`hID`): fixo, para ele reconhecer sempre o mesmo ícone.
ICON_ID: Final = 1


@dataclass(frozen=True, slots=True)
class NotifyIconEntry:
    r"""Uma linha de `HKCU\Control Panel\NotifyIconSettings`: o Windows cria uma por ícone de
    bandeja."""

    key: str
    executable_path: str
    tooltip: str
    uid: int | None = None


class NotifyIconSettings(Protocol):
    def entries(self) -> list[NotifyIconEntry]:
        """Os ícones que o Windows conhece. Nunca levanta: sem acesso ao registro, lista vazia."""
        ...

    def promote(self, key: str) -> bool:
        """Põe o ícone na área visível da barra (`IsPromoted=1`). `False` se não foi possível."""
        ...


class PromotionMarker(Protocol):
    """Lembra, por executável, que o ícone já foi promovido uma vez (e nunca mais é mexido)."""

    def done(self, executable: str) -> bool:
        """Já promovido? Na dúvida (marca ilegível ou inválida) responde que sim: melhor não
        promover do que desfazer a escolha de quem escondeu o ícone."""
        ...

    def mark(self, executable: str) -> bool:
        """Grava a marca. `False` se não foi possível gravar (aí o ícone não deve ser promovido)."""
        ...

    def forget(self, executable: str) -> None:
        """Desfaz a marca de uma promoção que não aconteceu, para tentar de novo depois."""
        ...
