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

Depois de uma queda de energia o PC liga do zero, o roteador demora e a TV volta quando volta (às
vezes com outro IP). Nos primeiros minutos depois da partida (e depois de a rede do PC voltar) as
conferências ficam mais próximas, com espera crescente e teto baixo; a primeira vez que a TV aparece
encerra essa fase e volta o espaçamento de sempre. Se a TV faltou nesta partida, o vigia reabre a
sessão (sem tecla) e registra numa linha quanto tempo a TV levou para ficar controlável.

O núcleo não sabe varrer rede nem gravar arquivo: as ações vêm por injeção.
"""

import logging
import time
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass

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
# Depois da partida (ou da rede do PC voltar): por quanto tempo as conferências ficam mais próximas,
# e a espera entre elas (crescente, com teto). Na queda de luz de 07/11 a TV só atendeu uns 5 min
# depois da partida do agente; com o espaçamento de sempre (60 s) ela esperava até mais um minuto.
DEFAULT_FAST_WINDOW_SECONDS = 600.0
DEFAULT_FAST_STEPS = (5.0, 10.0, 20.0)
# A linha "TV de volta" só fala da partida: uma TV achada horas depois (ligada de manhã) não conta.
DEFAULT_COMEBACK_REPORT_SECONDS = 1800.0


@dataclass(slots=True)
class AgentStart:
    """A partida do processo do agente (relógio monotônico).

    Sobrevive ao recomeço de `run` quando a TV muda de endereço: o vigia novo ainda sabe que a TV
    faltou nesta partida e que a linha "TV de volta" não foi registrada.
    """

    at: float
    tv_missing: bool = False
    reported: bool = False


_AGENT_START = AgentStart(time.monotonic())


def agent_start() -> AgentStart:
    """A partida deste processo (uma por processo; os testes trocam por uma nova)."""
    return _AGENT_START


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
        fast_window_seconds: float = 0.0,
        fast_steps: tuple[float, ...] = DEFAULT_FAST_STEPS,
        start: AgentStart | None = None,
        comeback_report_seconds: float = DEFAULT_COMEBACK_REPORT_SECONDS,
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

        `fast_window_seconds` (zero desliga): desde a criação, e de novo quando a rede do PC volta
        depois de sumir, as esperas de `run` seguem `fast_steps` (a última repete) em vez de
        `check_seconds`, até a TV aparecer ou a janela acabar. Só muda a cadência da conferência
        barata: a procura cara continua presa às falhas seguidas e aos espaçamentos do localizador.
        `start`: a partida do agente, para a linha "TV de volta" (sem ela, nem linha nem abertura).
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
        self._fast_window = fast_window_seconds
        self._fast_steps = fast_steps
        self._fast_until: float | None = None
        self._fast_index = 0
        self._start_fast_window()
        self._start = start
        self._comeback_report_seconds = comeback_report_seconds
        # A rede do PC sumiu (nenhuma placa com endereço) e, quando voltar, a TV é conferida já.
        self._network_lost = False
        self._network_back = False
        self._last_network_back: float | None = None

    async def step(self) -> str | None:
        """Uma conferência. Devolve o novo endereço quando a TV mudou de lugar."""
        if self._is_paused():
            return None
        if await self._take_network_change():
            self._network_burst = self._network_attempts
            self._network_changed_in_outage = True
            self._wake_locator()
        if self._take_network_back():
            _log.info("a rede do PC voltou; confiro a TV já")
            self._start_fast_window()
        if self._is_hot() or await self._safe_reachable():
            await self._tv_is_here()
            return None
        self._failures += 1
        if self._start is not None and not self._start.reported:
            self._start.tv_missing = True
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

    async def _tv_is_here(self) -> None:
        recovered = self._failures > 0
        if self._failures >= self._failures_needed:
            _log.info("a TV voltou a responder no endereço de sempre")
        self._failures = 0
        self._last_summary = None
        self._network_burst = 0
        self._network_changed_in_outage = False
        self._empty_searches = 0
        # A TV está aqui: a fase de conferências próximas acaba (nada de tráfego a mais).
        self._fast_until = None
        reopened = await self._report_comeback()
        if recovered and not reopened:
            await self._notify_recovered()
        await self._notify_alive()

    async def run(self) -> str:
        """Confere até a TV aparecer em outro endereço; devolve esse endereço."""
        while True:
            await self._wait_next_check()
            moved = await self.step()
            if moved is not None:
                return moved

    async def _wait_next_check(self) -> None:
        """Espera a próxima conferência; com a rede do PC vigiada, acorda antes se ela mudar."""
        interval = self._next_interval()
        if self._network_signature is None:
            await self._clock.sleep(interval)
            return
        waited = 0.0
        while waited < interval:
            slice_seconds = min(self._network_poll_seconds, interval - waited)
            await self._clock.sleep(slice_seconds)
            waited += slice_seconds
            if await self._poll_network():
                return

    def _start_fast_window(self) -> None:
        if self._fast_window <= 0 or not self._fast_steps:
            return
        self._fast_until = self._clock.monotonic() + self._fast_window
        self._fast_index = 0

    def _next_interval(self) -> float:
        """A espera até a próxima conferência: crescente e com teto baixo na fase próxima."""
        fast_until = self._fast_until
        if fast_until is None or self._clock.monotonic() >= fast_until:
            self._fast_until = None
            return self._check_seconds
        step = self._fast_steps[min(self._fast_index, len(self._fast_steps) - 1)]
        self._fast_index += 1
        return min(step, self._check_seconds)

    def _take_network_back(self) -> bool:
        back = self._network_back
        self._network_back = False
        return back

    def _note_network_back(self, now: float) -> None:
        """A rede voltou depois de sumir: vale uma conferência já, no máximo uma por intervalo.

        Placa que cai e volta a noite toda (TV desligada) não vira uma conferência a cada volta.
        """
        last = self._last_network_back
        if last is not None and now - last < self._network_burst_interval:
            return
        self._last_network_back = now
        self._network_back = True

    async def _poll_network(self) -> bool:
        """Lê as redes do PC; devolve `True` se houve troca estável ou volta da rede não tratada."""
        if self._network_signature is None:
            return False
        try:
            current = frozenset(await self._network_signature())
        except Exception:
            # Uma vez só: a leitura roda a cada poucos segundos e não pode encher o registro.
            if not self._signature_failed:
                _log.exception("falha ao ler a rede do PC")
            self._signature_failed = True
            return self._network_changed or self._network_back
        self._signature_failed = False
        # Sem rede nenhuma a placa está caindo ou subindo: espera a rede voltar para comparar.
        if not current:
            self._network_lost = True
            return self._network_changed or self._network_back
        now = self._clock.monotonic()
        if self._network_lost:
            # O roteador voltou (ou o cabo, ou o Wi-Fi): a TV pode já estar lá.
            self._network_lost = False
            self._note_network_back(now)
        if self._last_network is None:
            self._accept_network(current, now)  # a primeira leitura é só a base
        elif current == self._last_network:
            self._candidate = None  # a oscilação voltou ao que era: não houve troca
            self._seen[current] = now
        elif self._candidate is None or self._candidate[0] != current:
            self._candidate = (current, now)
        elif now - self._candidate[1] >= self._network_stable_seconds:
            self._settle_network(current, now)
        return self._network_changed or self._network_back

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
        await self._poll_network()
        changed = self._network_changed  # a volta da mesma rede não é troca (ver `step`)
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

    async def _report_comeback(self) -> bool:
        """A primeira vez que a TV aparece nesta partida: registra o tempo em uma linha.

        Se ela faltou antes (queda de luz, TV ligando, outro IP), reabre a sessão sem tecla para a
        TV ficar controlável e mede até ela abrir. Devolve se pediu a reabertura. TV que já estava
        lá na primeira conferência (um reinício comum do agente) só ganha a linha: nada se abre.
        """
        start = self._start
        if start is None or start.reported:
            return False
        start.reported = True
        found = max(0.0, self._clock.monotonic() - start.at)
        if found > self._comeback_report_seconds:
            return False
        if not start.tv_missing:
            _log.info("TV encontrada %.1f s depois da partida do agente", found)
            return False
        if not self._is_hot():
            await self._notify_recovered()
        opened = max(0.0, self._clock.monotonic() - start.at)
        if self._is_hot():
            _log.info(
                "TV de volta em %.1f s depois da partida do agente "
                "(achada em %.1f s; sessão aberta %.2f s depois)",
                opened,
                found,
                opened - found,
            )
        else:
            _log.info(
                "TV achada %.1f s depois da partida do agente; a sessão não abriu agora "
                "e abre no primeiro uso",
                found,
            )
        return True

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
