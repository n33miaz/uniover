"""A contagem de desligar ou reiniciar que não terminou no pedido, avisada à API.

O app recebe "agendado" assim que a contagem começa; o que acontece no fim dela só o agente vê. Dois
desfechos vão à API (`pc.power.outcome.v1`): `refused` (o Windows recusou o pedido no fim da
contagem: política, permissão) e `lost` (o agente reiniciou no meio, e a contagem, que vivia só na
memória, sumiu). A API os grava na auditoria como falha e o app para de oferecer o cancelamento.

O desfecho nasce fora do laço do agente (o temporizador da contagem roda numa thread): `report` só
guarda e pede o envio ao laço por `post`. O envio espera a API listar `pc.power.outcome.v1` (uma
anterior recusaria o tipo) e a conexão: sai depois do `hello`, quando a API passa a listar a
capacidade, e logo depois de nascer. Fica guardado na memória por `KEEP_SECONDS` no máximo (depois
disso o app já parou de oferecer o cancelamento sozinho) e são no máximo `CAPACITY` de uma vez.
"""

import asyncio
import logging
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Final

from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.ports import Clock, Sender, TransportError

_log = logging.getLogger(__name__)

# Na lista de `features` da API: ela aceita o tipo (e o grava na auditoria).
PC_POWER_OUTCOME_FEATURE: Final = "pc.power.outcome.v1"
OUTCOME_REFUSED: Final = "refused"
OUTCOME_LOST: Final = "lost"
KEEP_SECONDS: Final = 10 * 60.0
CAPACITY: Final = 4


@dataclass(frozen=True, slots=True)
class _Outcome:
    action: str
    outcome: str
    code: int | None
    at: str
    born: float


class PowerOutcomes:
    def __init__(
        self,
        sender: Sender,
        envelopes: EnvelopeFactory,
        clock: Clock,
        *,
        post: Callable[[Callable[[], None]], None] | None = None,
    ) -> None:
        self._sender = sender
        self._envelopes = envelopes
        self._clock = clock
        self._post = post
        self._enabled: Callable[[], bool] = lambda: False
        self._lock = threading.Lock()
        self._queue: list[_Outcome] = []
        self._tasks: set[asyncio.Future[None]] = set()

    def bind_enabled(self, enabled: Callable[[], bool]) -> None:
        """Liga o envio ao que a API listou em `features` (quem monta o agente a conhece depois)."""
        self._enabled = enabled

    def refused(self, action: str, code: int | None) -> None:
        """O Windows recusou a ação no fim da contagem. Chamado de qualquer thread."""
        self.report(action, OUTCOME_REFUSED, code)

    def report(self, action: str, outcome: str, code: int | None = None) -> None:
        """Guarda o desfecho e pede o envio ao laço do agente. Chamado de qualquer thread."""
        now = self._clock.monotonic()
        at = self._clock.now().isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self._lock:
            self._queue = [*self._fresh(now), _Outcome(action, outcome, code, at, now)][-CAPACITY:]
        if self._post is not None:
            try:
                self._post(self.soon)
            except RuntimeError:
                pass  # o laço já fechou (encerrando): não há mais a quem enviar

    def _fresh(self, now: float) -> list[_Outcome]:
        return [item for item in self._queue if now - item.born <= KEEP_SECONDS]

    def soon(self) -> None:
        """Envia o que estiver guardado, sem esperar (no laço do agente)."""
        task = asyncio.ensure_future(self.flush())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def flush(self) -> None:
        """Envia o guardado, na ordem; nunca levanta. Sem a API aceitar ou sem conexão, fica para a
        próxima vez (o `hello` seguinte, ou a API passar a listar a capacidade)."""
        if not self._enabled():
            return
        while True:
            with self._lock:
                self._queue = self._fresh(self._clock.monotonic())
                if not self._queue:
                    return
                item = self._queue[0]
            envelope = self._envelopes.pc_power_outcome(
                item.action, item.outcome, item.code, item.at
            )
            try:
                await self._sender.send(envelope)
            except TransportError as exc:
                _log.debug("desfecho da contagem não enviado (%s); fica para a próxima", exc)
                return
            with self._lock:
                if self._queue and self._queue[0] is item:
                    self._queue.pop(0)
            _log.info("desfecho da contagem avisado à API: %s %s", item.action, item.outcome)


def outcomes_after_hello(outcomes: PowerOutcomes) -> Callable[[], Awaitable[None]]:
    """O passo de depois do `hello`: o que ficou guardado sai na conexão nova."""
    return outcomes.flush
