"""Mede atrasos curtos do laço sem produzir ruído no registro."""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

_log = logging.getLogger(__name__)


class LoopLagMonitor:
    """Registra, uma vez por minuto, somente atrasos relevantes de UM laço.

    O agente tem dois laços (o principal e o da entrada do PC): cada um roda o seu medidor, com o
    `name` que o identifica na linha do registro, para saber qual deles parou.
    """

    def __init__(  # noqa: PLR0913 - tudo opcional e trocável para os testes
        self,
        *,
        name: str = "principal",
        interval: float = 1.0,
        threshold: float = 0.25,
        report_every: float = 60.0,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._name = name
        self._interval = interval
        self._threshold = threshold
        self._report_every = report_every
        self._monotonic = monotonic
        self._sleep = sleep
        self._maximum = 0.0
        self._count = 0

    def observe(self, delay: float) -> None:
        """Acumula uma amostra; exposto para testar sem esperar um minuto."""
        if delay > self._threshold:
            self._maximum = max(self._maximum, delay)
            self._count += 1

    def report(self) -> None:
        if self._count:
            _log.info(
                "atraso do laço %s no último minuto: máximo %.0f ms em %d amostras",
                self._name,
                self._maximum * 1_000,
                self._count,
            )
        self._maximum = 0.0
        self._count = 0

    async def run(self) -> None:
        next_report = self._monotonic() + self._report_every
        while True:
            expected = self._monotonic() + self._interval
            await self._sleep(self._interval)
            now = self._monotonic()
            self.observe(max(0.0, now - expected))
            if now >= next_report:
                self.report()
                next_report = now + self._report_every
