"""Vigia do endereço da TV: confere de tempos em tempos e, se ela sumiu, manda procurá-la.

Roteadores domésticos reatribuem o IP: a TV segue a mesma, mas o `tv_host` gravado deixa de
valer (e o endereço velho pode virar de outro aparelho, como um celular que responde a ping).
O vigia confere se **a TV certa** responde no endereço e, depois de algumas falhas seguidas, manda
procurar (`rescan`) a cada conferência. Quem decide o que é caro (SSDP, varredura do /24) e quanto
espaçar é o `TvLocator`; aqui só se conta o tempo. TV desligada não aparece em lugar nenhum e nada
muda: o custo é ler a tabela ARP, nunca um laço de conexões.

O núcleo não sabe varrer rede nem gravar arquivo: as ações vêm por injeção.
"""

import logging
from collections.abc import Awaitable, Callable

from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

DEFAULT_CHECK_SECONDS = 60.0
DEFAULT_FAILURES = 3
# Com a TV fora, o registro conta isto uma vez e depois só um resumo de tempos em tempos.
DEFAULT_SUMMARY_SECONDS = 1800.0


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
        summary_seconds: float = DEFAULT_SUMMARY_SECONDS,
        on_alive: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        """`rescan` devolve o novo endereço da **mesma** TV, ou `None` (não achou ou não mudou).

        Ele é chamado a cada conferência depois de `failures` falhas seguidas e limita sozinho o
        que custa caro.
        """
        self._clock = clock
        self._is_hot = is_hot
        self._reachable = reachable
        self._rescan = rescan
        self._failures_needed = failures
        self._check_seconds = check_seconds
        self._summary_seconds = summary_seconds
        # Chamado a cada conferência em que a TV está lá (para aprender o que falta dela).
        self._on_alive = on_alive
        self._failures = 0
        self._last_summary: float | None = None

    async def step(self) -> str | None:
        """Uma conferência. Devolve o novo endereço quando a TV mudou de lugar."""
        if self._is_hot() or await self._safe_reachable():
            if self._failures >= self._failures_needed:
                _log.info("a TV voltou a responder no endereço de sempre")
            self._failures = 0
            self._last_summary = None
            await self._notify_alive()
            return None
        self._failures += 1
        if self._failures < self._failures_needed:
            return None
        self._announce_search()
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

    async def _notify_alive(self) -> None:
        if self._on_alive is None:
            return
        try:
            await self._on_alive()
        except Exception:
            _log.exception("falha ao guardar o que se sabe da TV")

    async def _safe_reachable(self) -> bool:
        try:
            return await self._reachable()
        except Exception:
            _log.exception("falha ao conferir a TV")
            return False

    def _announce_search(self) -> None:
        now = self._clock.monotonic()
        if self._last_summary is None:
            _log.info("a TV não responde há %d conferências; procurando na rede", self._failures)
        elif now - self._last_summary >= self._summary_seconds:
            _log.info(
                "a TV segue sem responder (%d conferências); continuo procurando", self._failures
            )
        else:
            return
        self._last_summary = now
