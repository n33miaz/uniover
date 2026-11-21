"""A contagem de desligar ou reiniciar que não terminou no pedido, avisada à API.

O app recebe "agendado" assim que a contagem começa; o que acontece no fim dela só o agente vê. Três
desfechos vão à API (`pc.power.outcome.v1`), cada um com o id opaco da contagem (o do comando que a
pediu) e a hora em que aconteceu: `refused` (o Windows recusou o pedido no fim da contagem:
política, permissão), `lost` (o agente reiniciou no meio, e a contagem, que vivia só na memória,
sumiu) e `cancelled` (quem está no PC cancelou no aviso da tela). A API os grava na auditoria e o
app para de oferecer o cancelamento.

Entrega confirmada: a API que lista `pc.power.outcome.ack.v1` responde a cada desfecho que gravou
(ou que já tinha gravado) com `pc.power.outcome.ack.v1`, pela contagem e pelo desfecho. Até essa
confirmação o desfecho fica guardado: é reenviado a cada `hello` (conexão nova) e, com a conexão
de pé, a cada `RESEND_SECONDS` (a API pode ter falhado ao gravar). A API descarta o reenvio do que
já gravou, e o confirma de novo. Só depois da confirmação ele sai daqui e quem o guardava em disco
(a marca da contagem perdida) é avisado (`on_settled`). Uma API anterior, que não confirma, recebe
cada desfecho uma vez, como antes: ele sai assim que a escrita termina.

O desfecho nasce fora do laço do agente (o temporizador da contagem roda numa thread): `report` só
guarda e pede o envio ao laço por `post`. O envio espera a API listar `pc.power.outcome.v1` (uma
anterior recusaria o tipo) e a conexão. O guardado mora em `PendingOutcomes`, que quem monta o
agente mantém um por processo: a remontagem da conexão no mesmo processo não o perde. Ficam no
máximo `CAPACITY` de uma vez, por `KEEP_SECONDS` sem a confirmação da API (depois disso o app já
parou de oferecer o cancelamento sozinho) ou por `ACKED_KEEP_SECONDS` com ela.
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
# Na lista de `features` da API: ela confirma cada desfecho gravado. O agente que a vê listada a
# declara no `hello` (a API só confirma a quem declarou) e só esquece o desfecho confirmado.
PC_POWER_OUTCOME_ACK_FEATURE: Final = "pc.power.outcome.ack.v1"
# A confirmação que a API manda (sem resposta).
PC_POWER_OUTCOME_ACK_TYPE: Final = "pc.power.outcome.ack.v1"
OUTCOME_REFUSED: Final = "refused"
OUTCOME_LOST: Final = "lost"
OUTCOME_CANCELLED: Final = "cancelled"
KEEP_SECONDS: Final = 10 * 60.0
# Com a confirmação, o desfecho espera por ela até um dia (o agente pode ficar sem a API horas).
ACKED_KEEP_SECONDS: Final = 24 * 60 * 60.0
# Sem a confirmação de um desfecho enviado, ele sai de novo depois disto (com a conexão de pé).
RESEND_SECONDS: Final = 30.0
CAPACITY: Final = 4


@dataclass(slots=True)
class _Outcome:
    countdown_id: str
    action: str
    outcome: str
    code: int | None
    at: str
    born: float
    # Quando saiu pela última vez sem a confirmação ainda (`None`: ainda não saiu nesta conexão).
    sent_at: float | None = None


class PendingOutcomes:
    """O que ainda não foi entregue (ou confirmado): a lista e a trava dela. Quem monta o agente
    mantém um por processo."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.items: list[_Outcome] = []


class PowerOutcomes:
    def __init__(  # noqa: PLR0913 - portas, laço e o guardado do processo
        self,
        sender: Sender,
        envelopes: EnvelopeFactory,
        clock: Clock,
        *,
        post: Callable[[Callable[[], None]], None] | None = None,
        pending: PendingOutcomes | None = None,
        on_settled: Callable[[str, str], None] | None = None,
    ) -> None:
        self._sender = sender
        self._envelopes = envelopes
        self._clock = clock
        self._post = post
        self._pending = pending or PendingOutcomes()
        # Chamado (de qualquer thread) com a contagem e o desfecho que a API confirmou, ou que saiu
        # para uma API que não confirma: quem guardava o desfecho em disco pode esquecê-lo.
        self._on_settled = on_settled
        self._enabled: Callable[[], bool] = lambda: False
        self._acks: Callable[[], bool] = lambda: False
        self._tasks: set[asyncio.Future[None]] = set()
        # Um envio por vez: o passo do `hello` e o pedido de `soon` nunca mandam o mesmo item duas
        # vezes (criada no laço, na primeira vez).
        self._sending: asyncio.Lock | None = None
        # O reenvio do que ficou sem confirmação, com a conexão de pé.
        self._retry: asyncio.TimerHandle | None = None

    def bind_enabled(self, enabled: Callable[[], bool]) -> None:
        """Liga o envio ao que a API listou em `features` (quem monta o agente a conhece depois)."""
        self._enabled = enabled

    def bind_acks(self, acks: Callable[[], bool]) -> None:
        """Liga a espera da confirmação ao que a API listou em `features`."""
        self._acks = acks

    def report(self, countdown_id: str, action: str, outcome: str, code: int | None = None) -> None:
        """Guarda o desfecho da contagem `countdown_id` (com a hora em que aconteceu) e pede o envio
        ao laço do agente. O mesmo desfecho da mesma contagem, já guardado, não entra de novo.
        Chamado de qualquer thread."""
        now = self._clock.monotonic()
        at = self._clock.now().isoformat(timespec="milliseconds").replace("+00:00", "Z")
        item = _Outcome(countdown_id, action, outcome, code, at, now)
        pending = self._pending
        with pending.lock:
            fresh = self._fresh(now)
            if not any(_same(kept, countdown_id, outcome) for kept in fresh):
                fresh = [*fresh, item][-CAPACITY:]
            pending.items = fresh
        if self._post is not None:
            try:
                self._post(self.soon)
            except RuntimeError:
                pass  # o laço já fechou (encerrando): não há mais a quem enviar

    def acked(self, countdown_id: str, outcome: str) -> None:
        """A API confirmou o desfecho `outcome` da contagem `countdown_id`: ele sai daqui. Chamado
        de qualquer thread; uma confirmação repetida (ou de outra coisa) não faz nada."""
        pending = self._pending
        with pending.lock:
            found = next((i for i in pending.items if _same(i, countdown_id, outcome)), None)
            if found is not None:
                pending.items = [i for i in pending.items if i is not found]
        if found is None:
            return
        _log.info("a API confirmou o desfecho da contagem: %s %s", found.action, found.outcome)
        self._settle(found)

    def _fresh(self, now: float) -> list[_Outcome]:
        keep = ACKED_KEEP_SECONDS if self._acks() else KEEP_SECONDS
        return [item for item in self._pending.items if now - item.born <= keep]

    def soon(self) -> None:
        """Envia o que estiver guardado, sem esperar (no laço do agente)."""
        task = asyncio.ensure_future(self.flush())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def after_hello(self) -> None:
        """Conexão nova: tudo o que segue sem confirmação sai de novo, já."""
        with self._pending.lock:
            for item in self._pending.items:
                item.sent_at = None
        await self.flush()

    async def flush(self) -> None:
        """Envia o guardado, na ordem; nunca levanta. Sem a API aceitar ou sem conexão, fica para a
        próxima vez (o `hello` seguinte, ou a API passar a listar a capacidade)."""
        if not self._enabled():
            return
        if self._sending is None:
            self._sending = asyncio.Lock()
        async with self._sending:
            await self._send_queued()

    async def _send_queued(self) -> None:
        acks = self._acks()
        pending = self._pending
        while self._enabled():
            now = self._clock.monotonic()
            with pending.lock:
                pending.items = self._fresh(now)
                item = next((i for i in pending.items if _due(i, now, acks=acks)), None)
            if item is None:
                break
            envelope = self._envelopes.pc_power_outcome(
                item.countdown_id, item.action, item.outcome, item.code, item.at
            )
            try:
                await self._sender.send(envelope)
            except TransportError as exc:
                _log.debug("desfecho da contagem não enviado (%s); fica para a próxima", exc)
                return
            settled = False
            with pending.lock:
                if acks:
                    # Fica até a API confirmar; sem a confirmação, sai de novo mais tarde.
                    item.sent_at = now
                elif any(i is item for i in pending.items):
                    pending.items = [i for i in pending.items if i is not item]
                    settled = True
            _log.info("desfecho da contagem avisado à API: %s %s", item.action, item.outcome)
            if settled:
                self._settle(item)
        if acks:
            self._schedule_resend()

    def _schedule_resend(self) -> None:
        with self._pending.lock:
            waiting = bool(self._pending.items)
        if self._retry is not None:
            self._retry.cancel()
            self._retry = None
        if waiting:
            self._retry = asyncio.get_running_loop().call_later(RESEND_SECONDS, self.soon)

    def _settle(self, item: _Outcome) -> None:
        if self._on_settled is None:
            return
        try:
            self._on_settled(item.countdown_id, item.outcome)
        except Exception:
            _log.warning("não consegui esquecer o desfecho já entregue da contagem", exc_info=True)


def _same(item: _Outcome, countdown_id: str, outcome: str) -> bool:
    return item.countdown_id == countdown_id and item.outcome == outcome


def _due(item: _Outcome, now: float, *, acks: bool) -> bool:
    """O desfecho sai agora? Nunca saiu nesta conexão, ou (com a confirmação) saiu e ela não
    veio."""
    if item.sent_at is None:
        return True
    return acks and now - item.sent_at >= RESEND_SECONDS


def outcomes_after_hello(outcomes: PowerOutcomes) -> Callable[[], Awaitable[None]]:
    """O passo de depois do `hello`: o que ficou guardado (e sem confirmação) sai na conexão
    nova."""
    return outcomes.after_hello
