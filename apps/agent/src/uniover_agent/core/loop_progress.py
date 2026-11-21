"""Relógio do laço de eventos: quanto tempo o laço andou, sem contar as paradas dele.

Uma tecla da TV que espera mais que o prazo é descartada (não executa um toque de minutos atrás).
Mas quando quem atrasou foi o próprio agente (o laço principal preso numa chamada síncrona, uma
coleta grande do GC, o Windows tirando o processo da memória), a tecla não envelheceu por culpa de
ninguém lá fora: descartá-la só perde o toque. Este relógio separa as duas esperas.

Uma tarefa do laço carimba a hora a cada `interval`. Entre dois carimbos o relógio avança no máximo
`slack`: um intervalo maior é o laço parado, e o excesso não conta. A espera pela sessão da TV (o
laço livre, aguardando a rede) avança o relógio por inteiro, como antes. A consulta (`at`) também
vale para o trecho depois do último carimbo, então a primeira tarefa a rodar depois da parada já a
enxerga, antes de a tarefa do carimbo voltar.
"""

import asyncio
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Final

INTERVAL_SECONDS: Final = 0.1
# Folga entre dois carimbos: o intervalo, o atraso normal de um temporizador do Windows (~16 ms) e
# o trabalho de uma volta do laço. Acima disto o laço esteve parado. Para a idade, uma parada ainda
# conta esta folga como espera; para a junção de toques, não conta nada (`strict`).
SLACK_SECONDS: Final = 0.15
# Carimbos guardados: com um a cada 0,1 s, cerca de 25 s (bem mais que a idade de uma tecla).
HISTORY: Final = 256


class LoopProgress:
    """O instante do relógio monotônico convertido em "tempo andado pelo laço" (`at`)."""

    def __init__(
        self,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        interval: float = INTERVAL_SECONDS,
        slack: float = SLACK_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._monotonic = monotonic
        self._interval = interval
        self._slack = slack
        self._sleep = sleep
        # (instante monotônico, andado com a folga da parada, andado sem parada nenhuma),
        # em ordem.
        self._samples: deque[tuple[float, float, float]] = deque(maxlen=HISTORY)

    def _next(self, sample: tuple[float, float, float], now: float) -> tuple[float, float, float]:
        last, capped, strict = sample
        gap = max(0.0, now - last)
        return now, capped + min(gap, self._slack), strict + (gap if gap <= self._slack else 0.0)

    def observe(self) -> None:
        """Um carimbo (a tarefa chama a cada `interval`; o teste, direto)."""
        now = self._monotonic()
        if not self._samples:
            self._samples.append((now, now, now))
            return
        self._samples.append(self._next(self._samples[-1], now))

    def at(self, moment: float, *, strict: bool = False) -> float:
        """O tempo andado pelo laço até `moment` (relógio monotônico, passado ou agora).

        Sem carimbos, é o próprio instante (sem medida, nada é descontado). Um intervalo com parada
        conta a folga (`slack`) como andada; com `strict`, não conta nada dele. Dentro de um
        intervalo com parada não se sabe em que trecho ela foi: supõe-se que primeiro o laço parou
        e depois andou, o que desconta o MENOS possível de uma espera que comece ali dentro.
        """
        if not self._samples:
            return moment
        column = 2 if strict else 1
        samples = list(self._samples)
        now = self._monotonic()
        if now > samples[-1][0]:
            samples.append(self._next(samples[-1], now))
        first_time, first_progress = samples[0][0], samples[0][column]
        if moment <= first_time:
            return first_progress - (first_time - moment)
        previous_time, previous_progress = first_time, first_progress
        for sample in samples[1:]:
            sample_time, sample_progress = sample[0], sample[column]
            if moment <= sample_time:
                moved = sample_progress - previous_progress
                return sample_progress - min(sample_time - moment, moved)
            previous_time, previous_progress = sample_time, sample_progress
        # Depois do último ponto (só um instante futuro chega aqui): sem parada conhecida.
        return previous_progress + (moment - previous_time)

    def elapsed_since(self, moment: float, *, strict: bool = False) -> float:
        """Quanto o laço andou de `moment` até agora (a espera sem as paradas do agente).

        Sem `strict` a parada ainda conta a folga (o descarte por idade, do lado seguro); com
        `strict` não conta nada (a junção de toques: quem tocou durante a parada não repetiu)."""
        return self.at(self._monotonic(), strict=strict) - self.at(moment, strict=strict)

    async def run(self) -> None:
        while True:
            self.observe()
            await self._sleep(self._interval)
