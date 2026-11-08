"""O relógio de "alguém usou o controle do PC há pouco".

A atualização do agente reinicia o processo e derruba o controle por alguns segundos: ela precisa
saber se alguém está no meio de uma sessão do touchpad. Cada comando `pc.*` que chega ao adaptador
do sistema anota o instante aqui; a marca em disco (`adapters.tv_use_marker`) leva essa idade para o
processo da atualização.
"""

import time
from collections.abc import Callable

from uniover_agent.core.domain import Command, CommandResult
from uniover_agent.core.handle_command import Handler


class PcUseTracker:
    """Guarda o instante (monotônico) do último comando do PC executado."""

    def __init__(self, monotonic: Callable[[], float] = time.monotonic) -> None:
        self._monotonic = monotonic
        self._last: float | None = None

    def note(self) -> None:
        self._last = self._monotonic()

    def seconds_since_use(self) -> float | None:
        """Há quantos segundos o PC foi controlado por aqui; `None` se não foi desde que subiu."""
        return None if self._last is None else max(0.0, self._monotonic() - self._last)

    def noting(self, handler: Handler) -> Handler:
        """O mesmo handler, anotando o uso antes de executar."""

        async def run(command: Command) -> CommandResult:
            self.note()
            return await handler(command)

        return run
