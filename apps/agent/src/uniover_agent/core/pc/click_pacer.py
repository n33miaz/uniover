"""Reproduz o intervalo entre dois cliques do mesmo botão (o do duplo clique)."""

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Final

# O maior intervalo que o contrato aceita em `gapMs` (400 ms): nenhuma espera passa disto.
MAX_PACE_SECONDS: Final = 0.4


class ClickPacer:
    """Guarda quando o último clique saiu, para o seguinte reproduzir o intervalo que o app mediu.

    O Windows só vê um duplo clique quando os dois apertos chegam a menos de ~500 ms um do outro, e
    a rede não garante isso: o app manda o intervalo que mediu entre os dois toques (`gapMs`) e o
    agente espera o que faltar desde o último clique que executou. Nunca espera mais que `gapMs`
    (nem mais que `MAX_PACE_SECONDS`), e cada clique conta a espera a partir do último que saiu: as
    esperas de cliques seguidos não se acumulam. Se o pedido chegou mais tarde, sai na hora.

    A espera é assíncrona (só a faixa dos comandos do PC espera por ela) e NUNCA segura uma soltura:
    quando um `UP` entra na faixa, a espera em curso termina na hora e as seguintes nem começam
    enquanto houver soltura esperando (ver `bind` e `hurry`). O clique sai um pouco mais cedo; o
    botão ou o modificador nunca fica preso esperando um duplo clique.
    """

    def __init__(
        self,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._monotonic = monotonic
        self._sleep = sleep
        self._last: tuple[str, float] | None = None
        self._urgent: Callable[[], bool] = lambda: False
        self._waiting: set[asyncio.Future[None]] = set()

    def bind(self, urgent: Callable[[], bool]) -> None:
        """Liga à faixa: `urgent()` diz se há uma soltura esperando (e então ninguém espera)."""
        self._urgent = urgent

    def hurry(self) -> None:
        """Uma soltura entrou na faixa: a espera em curso termina agora."""
        for future in tuple(self._waiting):
            if not future.done():
                future.set_result(None)

    def mark(self, button: str) -> None:
        """Um clique deste botão está saindo agora."""
        self._last = (button, self._monotonic())

    async def wait(self, button: str, gap_seconds: float) -> None:
        """Espera o que falta para completar `gap_seconds` desde o último clique do mesmo botão."""
        last = self._last
        if last is None or last[0] != button or gap_seconds <= 0 or self._urgent():
            return
        elapsed = self._monotonic() - last[1]
        remaining = min(gap_seconds - elapsed, gap_seconds, MAX_PACE_SECONDS)
        if remaining <= 0:
            return
        woken: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiting.add(woken)
        sleeper = asyncio.ensure_future(self._sleep(remaining))
        try:
            await asyncio.wait({sleeper, woken}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self._waiting.discard(woken)
            woken.cancel()
            sleeper.cancel()
