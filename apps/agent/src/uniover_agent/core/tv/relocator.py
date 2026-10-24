"""Reencontro da TV quando o endereço dela muda na rede.

Roteadores domésticos reatribuem o IP: a TV segue a mesma, mas o `tv_host` gravado deixa de
valer. O vigia confere, de tempos em tempos, se a TV está ao alcance e, só depois de várias
falhas seguidas, manda varrer a rede (`rescan`), no máximo uma vez a cada `rescan_seconds`.
TV desligada simplesmente não aparece na varredura e nada muda: o custo é uma varredura curta
a cada dez minutos, nunca um laço.

O núcleo não sabe varrer rede nem gravar arquivo: as três ações vêm por injeção.
"""

import logging
from collections.abc import Awaitable, Callable

from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

DEFAULT_CHECK_SECONDS = 60.0
DEFAULT_FAILURES = 3
DEFAULT_RESCAN_SECONDS = 600.0


class TvRelocator:
    def __init__(  # noqa: PLR0913 - cada argumento é uma injeção ou um limite
        self,
        clock: Clock,
        *,
        is_hot: Callable[[], bool],
        reachable: Callable[[], Awaitable[bool]],
        rescan: Callable[[], Awaitable[str | None]],
        failures: int = DEFAULT_FAILURES,
        check_seconds: float = DEFAULT_CHECK_SECONDS,
        rescan_seconds: float = DEFAULT_RESCAN_SECONDS,
    ) -> None:
        """`rescan` devolve o novo endereço da **mesma** TV, ou `None` (não achou ou não mudou)."""
        self._clock = clock
        self._is_hot = is_hot
        self._reachable = reachable
        self._rescan = rescan
        self._failures_needed = failures
        self._check_seconds = check_seconds
        self._rescan_seconds = rescan_seconds
        self._failures = 0
        self._last_rescan: float | None = None

    async def step(self) -> str | None:
        """Uma conferência. Devolve o novo endereço quando a TV mudou de lugar."""
        if self._is_hot() or await self._reachable():
            self._failures = 0
            return None
        self._failures += 1
        if self._failures < self._failures_needed:
            return None
        now = self._clock.monotonic()
        if self._last_rescan is not None and now - self._last_rescan < self._rescan_seconds:
            return None
        self._last_rescan = now
        _log.info("a TV não responde há %d conferências; procurando na rede", self._failures)
        try:
            moved = await self._rescan()
        except Exception:
            _log.exception("falha ao procurar a TV na rede")
            return None
        if moved is not None:
            _log.info("a TV mudou de endereço na rede")
        return moved

    async def run(self) -> str:
        """Confere até a TV aparecer em outro endereço; devolve esse endereço."""
        while True:
            await self._clock.sleep(self._check_seconds)
            moved = await self.step()
            if moved is not None:
                return moved
