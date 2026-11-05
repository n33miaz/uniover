"""Quando alguém usa a TV pelo app: a única hora em que o agente pode abrir uma conexão ADB nova.

Uma conexão ADB nova a uma TV que perdeu a permissão (reset de fábrica, revogação) faz aparecer o
aviso "Permitir depuração USB". Sem ninguém usando a TV pelo app, ninguém o veria, então a
partida, o vigia e as tarefas de fundo só usam um transporte que já está aberto. Dentro de
`WINDOW_SECONDS` depois de um comando do app que mexe na TV, abrir a conexão é parte do uso.
"""

from collections.abc import Callable
from typing import Final

from uniover_agent.core.domain import Command, CommandResult
from uniover_agent.core.handle_command import Handler

WINDOW_SECONDS: Final = 60.0


class UserActivity:
    """A última vez que um comando de uso chegou do app para esta TV."""

    def __init__(
        self, monotonic: Callable[[], float], window_seconds: float = WINDOW_SECONDS
    ) -> None:
        self._monotonic = monotonic
        self._window = window_seconds
        self._last: float | None = None

    def touch(self) -> None:
        self._last = self._monotonic()

    def recent(self) -> bool:
        return self._last is not None and self._monotonic() - self._last <= self._window


def touching(handler: Handler, activity: UserActivity) -> Handler:
    """Marca o uso da TV antes de atender o comando."""

    async def handle(command: Command) -> CommandResult:
        activity.touch()
        return await handler(command)

    return handle
