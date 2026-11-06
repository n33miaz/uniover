"""Quando alguém está diante da tela da TV no app: a hora de o agente abrir ADB sozinho.

Uma conexão ADB nova a uma TV que perdeu a permissão (reset de fábrica, revogação) faz aparecer o
aviso "Permitir depuração USB". Sem ninguém diante da tela da TV no app ninguém o veria, então a
partida, o vigia e as tarefas de fundo só usam um transporte que já está aberto.

O sinal é **explícito**: `tv.presence.v1`, que a tela da TV manda quando alguém **toca nela** (nunca
por tempo: uma aba esquecida aberta não manda nada). O tipo de
um comando não prova ninguém (o atalho do iPhone e o desligamento agendado mandam teclas e abrem
apps sem pessoa na tela), então tecla, texto e afins não contam. Dentro de `WINDOW_SECONDS` depois
de um sinal, abrir a conexão é parte do uso. Os pedidos da pessoa que já levam a marca de
`user_initiated_adb` (Atualizar lista, TV Livre) não dependem deste sinal.
"""

from collections.abc import Callable
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler

WINDOW_SECONDS: Final = 60.0
# Declarada no `agent.hello.v1`: a API só manda `tv.presence.v1` a quem a tem.
PRESENCE_CAPABILITY: Final = "tv.presence.v1"
PRESENCE_TYPE: Final = "tv.presence.v1"


class UserActivity:
    """O último sinal de presença que chegou do app para esta TV."""

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


def tv_presence_handler(activity: UserActivity) -> Handler:
    """`tv.presence.v1`: alguém está na tela da TV. Sem resposta (a API não a espera)."""

    async def handle(command: Command) -> CommandResult:
        activity.touch()
        return CommandResult(command.id, ResultStatus.OK)

    return handle
