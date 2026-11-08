"""Vigia do endereço da TV: confere de tempos em tempos e, se ela sumiu, manda procurá-la.

Roteadores domésticos reatribuem o IP: a TV segue a mesma, mas o `tv_host` gravado deixa de
valer (e o endereço velho pode virar de outro aparelho, como um celular que responde a ping).
O vigia confere se **a TV certa** responde no endereço e, depois de algumas falhas seguidas, manda
procurar (`rescan`) a cada conferência. Quem decide o que é caro (SSDP, varredura do /24) e quanto
espaçar é o `TvLocator`; aqui só se conta o tempo. TV desligada não aparece em lugar nenhum e nada
muda: o custo é ler a tabela ARP, nunca um laço de conexões.

Quando o **próprio PC** troca de rede (o roteador de casa caiu e ele foi para o ponto de acesso do
celular, junto com a TV), esperar três conferências e a cadência lenta do localizador atrasaria o
reencontro: o vigia percebe a troca (o conjunto de endereços do PC mudou, uma leitura barata) e
manda procurar já, algumas vezes seguidas (a TV leva um tempo para entrar na rede nova), voltando
depois ao espaçamento de sempre.

O núcleo não sabe varrer rede nem gravar arquivo: as ações vêm por injeção.
"""

import logging
from collections.abc import Awaitable, Callable, Collection

from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

DEFAULT_CHECK_SECONDS = 60.0
DEFAULT_FAILURES = 3
# Com a TV fora, o registro conta isto uma vez e depois só um resumo de tempos em tempos.
DEFAULT_SUMMARY_SECONDS = 1800.0
# A rede do PC é lida a cada tantos segundos enquanto se espera a próxima conferência.
DEFAULT_NETWORK_POLL_SECONDS = 5.0
# Procuras seguidas, sem esperar o espaçamento, depois que o PC trocou de rede.
DEFAULT_NETWORK_ATTEMPTS = 3
# Procuras sem achar a TV antes de registrar que ela não foi encontrada.
DEFAULT_NOT_FOUND_ATTEMPTS = 10
# Uma rede nova só vale depois de estável por este tempo: placa que oscila (doca com cabo e
# Wi-Fi, tethering USB que cai com a tela do celular) não é troca de rede.
DEFAULT_NETWORK_STABLE_SECONDS = 30.0
# No máximo uma rajada de procuras por este tempo, salvo rede nunca vista na última hora.
DEFAULT_NETWORK_BURST_INTERVAL_SECONDS = 900.0
DEFAULT_NETWORK_MEMORY_SECONDS = 3600.0


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
        on_recovered: Callable[[], Awaitable[None]] | None = None,
        is_paused: Callable[[], bool] = lambda: False,
        network_signature: Callable[[], Awaitable[Collection[str]]] | None = None,
        on_network_change: Callable[[bool], None] | None = None,
        on_not_found: Callable[[int, bool], None] | None = None,
        searched: Callable[[], bool] = lambda: True,
        network_stable_seconds: float = DEFAULT_NETWORK_STABLE_SECONDS,
        network_burst_interval_seconds: float = DEFAULT_NETWORK_BURST_INTERVAL_SECONDS,
        network_memory_seconds: float = DEFAULT_NETWORK_MEMORY_SECONDS,
        network_poll_seconds: float = DEFAULT_NETWORK_POLL_SECONDS,
        network_attempts: int = DEFAULT_NETWORK_ATTEMPTS,
        not_found_attempts: int = DEFAULT_NOT_FOUND_ATTEMPTS,
    ) -> None:
        """`rescan` devolve o novo endereço da **mesma** TV, ou `None` (não achou ou não mudou).

        Ele é chamado a cada conferência depois de `failures` falhas seguidas e limita sozinho o
        que custa caro.

        `network_signature` devolve as redes do PC (vazio: sem rede agora, não conta). Quando o
        conjunto muda e **fica igual por `network_stable_seconds`**, `on_network_change(nova)` é
        avisado (o localizador esquece os espaçamentos; `nova` diz que a rede não foi vista na
        última hora) e as próximas `network_attempts` conferências procuram sem esperar as
        falhas seguidas. Uma rajada por `network_burst_interval_seconds`, salvo rede nova.
        `on_not_found(procuras, rede_mudou)` é avisado uma vez, depois de `not_found_attempts`
        procuras **de verdade** (`searched` diz se a última procura rodou alguma etapa).
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
        self._on_recovered = on_recovered
        self._is_paused = is_paused
        self._network_signature = network_signature
        self._on_network_change = on_network_change
        self._on_not_found = on_not_found
        self._network_poll_seconds = max(0.1, network_poll_seconds)
        self._network_attempts = network_attempts
        self._not_found_attempts = not_found_attempts
        self._searched = searched
        self._network_stable_seconds = network_stable_seconds
        self._network_burst_interval = network_burst_interval_seconds
        self._network_memory = network_memory_seconds
        self._last_network: frozenset[str] | None = None
        self._candidate: tuple[frozenset[str], float] | None = None
        self._seen: dict[frozenset[str], float] = {}
        self._last_burst: float | None = None
        self._burst_is_new = False
        self._signature_failed = False
        self._network_changed = False
        self._network_burst = 0
        self._network_changed_in_outage = False
        self._empty_searches = 0
        self._failures = 0
        self._last_summary: float | None = None

    async def step(self) -> str | None:
        """Uma conferência. Devolve o novo endereço quando a TV mudou de lugar."""
        if self._is_paused():
            return None
        if await self._take_network_change():
            self._network_burst = self._network_attempts
            self._network_changed_in_outage = True
            self._wake_locator()
        if self._is_hot() or await self._safe_reachable():
            recovered = self._failures > 0
            if self._failures >= self._failures_needed:
                _log.info("a TV voltou a responder no endereço de sempre")
            self._failures = 0
            self._last_summary = None
            self._network_burst = 0
            self._network_changed_in_outage = False
            self._empty_searches = 0
            if recovered:
                await self._notify_recovered()
            await self._notify_alive()
            return None
        self._failures += 1
        if self._network_burst > 0:
            # O PC mudou de rede: procura já, sem esperar as falhas seguidas. A primeira procura da
            # rajada já acordou o localizador; as seguintes o acordam de novo (a TV pode ter
            # demorado para entrar na rede nova).
            self._failures = max(self._failures, self._failures_needed)
            self._network_burst -= 1
            if self._network_burst < self._network_attempts - 1:
                self._wake_locator()
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
            self._empty_searches = 0
        elif self._searched():
            self._note_empty_search()
        return moved

    async def run(self) -> str:
        """Confere até a TV aparecer em outro endereço; devolve esse endereço."""
        while True:
            await self._wait_next_check()
            moved = await self.step()
            if moved is not None:
                return moved

    async def _wait_next_check(self) -> None:
        """Espera a próxima conferência; com a rede do PC vigiada, acorda antes se ela mudar."""
        if self._network_signature is None:
            await self._clock.sleep(self._check_seconds)
            return
        waited = 0.0
        while waited < self._check_seconds:
            slice_seconds = min(self._network_poll_seconds, self._check_seconds - waited)
            await self._clock.sleep(slice_seconds)
            waited += slice_seconds
            if await self._poll_network():
                return

    async def _poll_network(self) -> bool:
        """Lê as redes do PC; devolve `True` se houve troca estável ainda não tratada."""
        if self._network_signature is None:
            return False
        try:
            current = frozenset(await self._network_signature())
        except Exception:
            # Uma vez só: a leitura roda a cada poucos segundos e não pode encher o registro.
            if not self._signature_failed:
                _log.exception("falha ao ler a rede do PC")
            self._signature_failed = True
            return self._network_changed
        self._signature_failed = False
        # Sem rede nenhuma a placa está caindo ou subindo: espera a rede voltar para comparar.
        if not current:
            return self._network_changed
        now = self._clock.monotonic()
        if self._last_network is None:
            self._accept_network(current, now)  # a primeira leitura é só a base
        elif current == self._last_network:
            self._candidate = None  # a oscilação voltou ao que era: não houve troca
            self._seen[current] = now
        elif self._candidate is None or self._candidate[0] != current:
            self._candidate = (current, now)
        elif now - self._candidate[1] >= self._network_stable_seconds:
            self._settle_network(current, now)
        return self._network_changed

    def _accept_network(self, current: frozenset[str], now: float) -> None:
        self._last_network = current
        self._candidate = None
        self._seen[current] = now
        for network, seen_at in list(self._seen.items()):
            if now - seen_at > self._network_memory:
                del self._seen[network]

    def _settle_network(self, current: frozenset[str], now: float) -> None:
        """A rede nova ficou estável: vale uma rajada, se é nova ou se faz tempo da última."""
        seen_at = self._seen.get(current)
        is_new = seen_at is None or now - seen_at > self._network_memory
        self._accept_network(current, now)
        recent = (
            self._last_burst is not None and now - self._last_burst < self._network_burst_interval
        )
        if is_new or not recent:
            self._network_changed = True
            self._burst_is_new = is_new
            self._last_burst = now

    async def _take_network_change(self) -> bool:
        changed = await self._poll_network()
        self._network_changed = False
        if changed:
            _log.info("o PC mudou de rede; procurando a TV já")
        return changed

    def _wake_locator(self) -> None:
        if self._on_network_change is None:
            return
        try:
            self._on_network_change(self._burst_is_new)
        except Exception:
            _log.exception("falha ao reiniciar a procura da TV")

    def _note_empty_search(self) -> None:
        self._empty_searches += 1
        if self._empty_searches != self._not_found_attempts or self._on_not_found is None:
            return
        try:
            self._on_not_found(self._empty_searches, self._network_changed_in_outage)
        except Exception:
            _log.exception("falha ao registrar que a TV não foi achada")

    async def _notify_alive(self) -> None:
        if self._on_alive is None:
            return
        try:
            await self._on_alive()
        except Exception:
            _log.exception("falha ao guardar o que se sabe da TV")

    async def _notify_recovered(self) -> None:
        if self._on_recovered is None:
            return
        try:
            await self._on_recovered()
        except TvSessionError as exc:
            # A TV voltou mas a sessão não abriu: é esperado e tem causa (sem rastro de pilha).
            _log.info("a TV voltou, mas a sessão não abriu (%s)", exc.code)
        except Exception:
            _log.exception("falha ao reabrir a sessão da TV")

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
