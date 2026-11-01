"""O que a API sabe receber além do básico: o agente só usa o opcional que ela diz aceitar.

Uma API anterior recusa o `hello` que declara uma capacidade que ela não conhece (a lista é fechada
no contrato) e isso tiraria o agente do ar durante um deploy em que o agente chega antes da API. Por
isso a capacidade nova só vai no `hello` depois de a rota pública `devices/info` listá-la em
`features`, e o diagnóstico só é enviado a partir daí. Enquanto a API não diz, o que o agente tem a
contar fica na fila local, que é limitada.
"""

import logging
from collections.abc import Awaitable, Callable
from typing import Final

from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

CHECK_INTERVAL_SECONDS: Final = 300.0


class ApiFeatures:
    def __init__(
        self,
        fetch: Callable[[], Awaitable[frozenset[str] | None]],
        clock: Clock,
        *,
        interval: float = CHECK_INTERVAL_SECONDS,
    ) -> None:
        self._fetch = fetch
        self._clock = clock
        self._interval = interval
        self._known: frozenset[str] = frozenset()

    def supports(self, feature: str) -> bool:
        return feature in self._known

    async def refresh(self) -> None:
        """Pergunta à API; resposta ausente (API dormindo, rede) não apaga o que já se sabia."""
        try:
            found = await self._fetch()
        except Exception:
            _log.warning("não consegui consultar o que a API aceita", exc_info=True)
            return
        if found is not None:
            self._known = found

    async def run(self) -> None:
        """Consulta de tempos em tempos: a resposta de hoje manda no próximo `hello`."""
        while True:
            await self.refresh()
            await self._clock.sleep(self._interval)
