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
# o trabalho de uma volta do laço. Acima disto o laço esteve parado. Uma parada ainda conta esta
# folga como espera: fica abaixo dos 0,3 s da junção de repetições (`KEY_COALESCE_AFTER_SECONDS`),
# para que as teclas tocadas durante a parada não sejam juntadas.
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
        # (instante monotônico, tempo andado até ali), em ordem.
        self._samples: deque[tuple[float, float]] = deque(maxlen=HISTORY)

    def observe(self) -> None:
        """Um carimbo (a tarefa chama a cada `interval`; o teste, direto)."""
        now = self._monotonic()
        if not self._samples:
            self._samples.append((now, now))
            return
        last, progress = self._samples[-1]
        self._samples.append((now, progress + min(max(0.0, now - last), self._slack)))

    def at(self, moment: float) -> float:
        """O tempo andado pelo laço até `moment` (relógio monotônico, passado ou agora).

        Sem carimbos, é o próprio instante (sem medida, nada é descontado). Dentro de um intervalo
        com parada não se sabe em que trecho ela foi: supõe-se que primeiro o laço parou e depois
        andou, o que desconta o MENOS possível de uma espera que comece ali dentro.
        """
        if not self._samples:
            return moment
        samples = list(self._samples)
        now = self._monotonic()
        last, progress = samples[-1]
        if now > last:
            samples.append((now, progress + min(now - last, self._slack)))
        first_time, first_progress = samples[0]
        if moment <= first_time:
            return first_progress - (first_time - moment)
        previous_time, previous_progress = samples[0]
        for sample_time, sample_progress in samples[1:]:
            if moment <= sample_time:
                moved = sample_progress - previous_progress
                return sample_progress - min(sample_time - moment, moved)
            previous_time, previous_progress = sample_time, sample_progress
        # Depois do último ponto (só um instante futuro chega aqui): sem parada conhecida.
        return previous_progress + (moment - previous_time)

    def elapsed_since(self, moment: float) -> float:
        """Quanto o laço andou de `moment` até agora (a espera sem as paradas do agente)."""
        return self.at(self._monotonic()) - self.at(moment)

    async def run(self) -> None:
        while True:
            self.observe()
            await self._sleep(self._interval)
