"""Reproduz o intervalo entre dois cliques do mesmo botão (o do duplo clique)."""

import asyncio
import time
from collections.abc import Awaitable, Callable


class ClickPacer:
    """Guarda quando o último clique saiu, para o seguinte reproduzir o intervalo que o app mediu.

    O Windows só vê um duplo clique quando os dois apertos chegam a menos de ~500 ms um do outro, e
    a rede não garante isso: o app manda o intervalo que mediu entre os dois toques (`gapMs`) e o
    agente espera o que faltar desde o último clique que executou. Nunca espera mais que `gapMs`;
    se o pedido chegou mais tarde que isso, sai na hora. A espera é assíncrona (só a faixa dos
    comandos do PC espera por ela) e a ordem entre os comandos se mantém.
    """

    def __init__(
        self,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._monotonic = monotonic
        self._sleep = sleep
        self._last: tuple[str, float] | None = None

    def mark(self, button: str) -> None:
        """Um clique deste botão está saindo agora."""
        self._last = (button, self._monotonic())

    async def wait(self, button: str, gap_seconds: float) -> None:
        """Espera o que falta para completar `gap_seconds` desde o último clique do mesmo botão."""
        last = self._last
        if last is None or last[0] != button or gap_seconds <= 0:
            return
        remaining = gap_seconds - (self._monotonic() - last[1])
        if remaining > 0:
            await self._sleep(min(remaining, gap_seconds))
