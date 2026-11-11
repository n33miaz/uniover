"""A faixa do PC: a fila única dos comandos `pc.*`, executados um após o outro, na ordem de chegada.

Mouse, teclado, mídia, zoom, volume e o canal direto não esperam as teclas da TV nem a rede do
resto do agente: a faixa tem um consumidor só, e (em produção) um laço de eventos só dela, numa
thread própria (`adapters/pc_input_thread.py`). Tudo aqui roda NESSE laço: quem chama de outro
laço entra por `LaneHost.post`/`call`, que preservam a ordem. O resultado dos comandos sai por um
`Sender`, que leva o envio ao laço do transporte sem esperar por ele aqui dentro.

A semântica é a de sempre: ordem de chegada (apertar, mover, soltar), soma de movimentos vizinhos
quando a fila enche, cancelamento do que o canal direto deixou esperando e soltura do que o PC
ficou segurando quando a conexão ou o canal caem.
"""

import asyncio
import contextlib
import logging
import math
import time
from collections import deque
from collections.abc import Callable, Collection
from dataclasses import dataclass, replace
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import HandleCommand
from uniover_agent.core.pc.devices import (
    DEVICE_DENIED,
    DEVICE_PENDING,
    DEVICE_UNKNOWN,
    DeviceApprovals,
    DeviceDecision,
)
from uniover_agent.core.pc.handlers import POINTER_TYPE, merge_pointer_commands
from uniover_agent.core.pc.pointer_order import PointerSequence
from uniover_agent.ports import Sender, TransportError

_log = logging.getLogger(__name__)

# Os comandos do PC que têm `UP`.
_RELEASE_TYPES = frozenset({"pc.click.v1", "pc.key.v2"})
# Teto de comandos do PC esperando a vez. Acima disso, os dois movimentos pendentes mais NOVOS que
# estão lado a lado e podem ser somados viram um só: o movimento é relativo, então o caminho (a
# soma) se preserva, e nada que veio antes de um clique ou tecla passa para depois dele. Sem par
# que se possa somar (a soma passaria dos limites, ou misturaria movimento e rolagem fora de
# ordem), o movimento mais antigo é descartado.
MAX_PENDING_PC: Final = 128
# Movimentos fora de ordem (chegaram depois de um mais novo, por `seq`) seguidos que merecem um
# aviso: um ou outro é a reordenação normal de pedidos paralelos; uma sequência longa indica um
# caminho que embaralha. Eles são aplicados de qualquer jeito (o deslocamento é relativo).
LATE_POINTER_WARNING: Final = 20
# Envios de resultado de comandos do PC ainda em andamento (cada um é uma tarefa). Rede parada não
# pode acumular tarefas sem fim: acima disto o resultado mais antigo é abandonado (a API o dá como
# sem resposta pelo prazo dela).
MAX_PENDING_RESULTS: Final = 64
# Movimentos atrasados somados num só que merecem uma linha de registro (uma parada curta do
# laço soma dois ou três; quarenta é uma parada séria).
COALESCE_WARNING: Final = 20


def is_release(command: Command) -> bool:
    """Soltar um botão ou um modificador: o `UP` do clique e da tecla."""
    return command.type in _RELEASE_TYPES and command.body.get("action") == "UP"


@dataclass(frozen=True, slots=True)
class PointerSpread:
    """Como um salto grande do ponteiro vira passos curtos: o cursor anda em vez de teleportar.

    O app (ou o canal direto) entrega o movimento em lotes: um lote de 60 px sai num `SendInput`
    só e o cursor "pula". Acima de `min_pixels` (no maior eixo) o salto vira de 2 a `max_steps`
    passos, espalhados em `total_seconds`. Só quando nada mais espera na fila, e na hora em que
    qualquer outro comando chega o resto sai de uma vez: o espaçamento nunca atrasa a ordem.
    """

    min_pixels: int = 12
    max_steps: int = 4
    total_seconds: float = 0.016


def spread_steps(dx: int, dy: int, spread: PointerSpread) -> list[tuple[int, int]]:
    """Os passos de um salto: a soma é exatamente `(dx, dy)`, e cada um é o menor possível."""
    biggest = max(abs(dx), abs(dy))
    if biggest <= spread.min_pixels or spread.max_steps < 2:  # noqa: PLR2004
        return [(dx, dy)]
    count = min(spread.max_steps, max(2, math.ceil(biggest / spread.min_pixels)))
    steps: list[tuple[int, int]] = []
    done_x = done_y = 0
    for index in range(1, count + 1):
        target_x = round(dx * index / count)
        target_y = round(dy * index / count)
        steps.append((target_x - done_x, target_y - done_y))
        done_x, done_y = target_x, target_y
    return steps


class PcLane:
    """Enfileira (o portão já validou), executa e responde. Só roda no laço da faixa."""

    def __init__(  # noqa: PLR0913 - dependências injetadas, todas necessárias
        self,
        handle_command: HandleCommand,
        envelopes: EnvelopeFactory,
        sender: Sender,
        *,
        silent_types: Collection[str] = (),
        monotonic: Callable[[], float] = time.monotonic,
        release_inputs: Callable[[], None] | None = None,
        on_cloud_pc_input: Callable[[str, int | None, str | None], None] | None = None,
        on_release_queued: Callable[[], None] | None = None,
        direct_active: Callable[[], bool] | None = None,
        pointer_stale: Callable[[Command], bool] | None = None,
        spread: PointerSpread | None = None,
        devices: DeviceApprovals | None = None,
    ) -> None:
        self._handle_command = handle_command
        self._envelopes = envelopes
        self._sender = sender
        self._silent_types = frozenset(silent_types)
        self._monotonic = monotonic
        self._release_inputs = release_inputs
        # Chamado com o tipo e o `seq` (se veio) de cada comando `pc.*` que chega pela API (nunca
        # pelo canal direto), antes de ele entrar na fila: o canal direto fecha primeiro, e nada
        # dele cai depois do que a nuvem faz.
        self._on_cloud_pc_input = on_cloud_pc_input
        # Chamado quando uma soltura (`UP`) entra na fila: quem espera um intervalo de clique para
        # de esperar (a soltura nunca espera por ele).
        self._on_release_queued = on_release_queued
        # O canal direto tem um par autenticado em uso (então o que o PC segura é dele, e uma queda
        # da conexão com a API não o solta).
        self._direct_active = direct_active or (lambda: False)
        # O movimento já velho demais para valer (o handler o descarta) não entra na soma. Sem este
        # predicado a faixa não soma movimentos vizinhos ao executar (só quando a fila enche).
        self._pointer_stale = pointer_stale
        self._spread = spread
        # A aprovação de aparelho novo: todo comando passa por ela; sem `deviceId` só passa com uma
        # API que, confirmadamente, não a oferece (ver `DeviceApprovals.check`).
        self._devices = devices
        # Algo chegou à fila enquanto um salto era espalhado: o resto sai de uma vez.
        self._arrival = asyncio.Event()
        # O comando do canal direto que a faixa executa agora: se o canal fecha, ele é cancelado.
        self._running_direct: asyncio.Future[CommandResult] | None = None
        # Um comando da nuvem está sendo executado agora (a queda da conexão o cancela).
        self._running_cloud = False
        self._tasks: set[asyncio.Task[None]] = set()
        self._queue: deque[tuple[Command, float]] = deque()
        self._wakeup = asyncio.Event()
        self._consumer: asyncio.Task[None] | None = None
        self._overflowing = False
        # Movimentos numerados chegam em pedidos paralelos; a ordem só alimenta o diagnóstico.
        self._pointer_order = PointerSequence()
        self._late_pointers = 0
        # Envios de resultado em andamento, do mais antigo ao mais novo.
        self._result_tasks: deque[asyncio.Task[None]] = deque()
        self._results_overflowing = False
        # Comandos que vieram pelo canal direto e esperam a vez (id -> quem recebe o resultado). O
        # resultado deles volta pelo canal, nunca pela API (que não os pediu).
        self._direct: dict[str, Callable[[CommandResult], None]] = {}
        # Os ids de TODO comando do canal direto ainda na fila (inclusive o movimento, que não tem
        # quem espere resposta): o que sai da fila quando o canal fecha, e que nunca vai à API.
        self._direct_ids: set[str] = set()

    # ---- entrada ------------------------------------------------------------------------------

    def accept(self, command: Command) -> None:
        """Um comando `pc.*` que veio pela API (nuvem): fecha antes o canal direto em uso, entra
        na fila. De um aparelho que o dono ainda não aprovou (ou recusou), ou sem aparelho
        identificado enquanto não se sabe se a API faz a aprovação, ele nem entra, e nem fecha o
        canal direto do aparelho aprovado."""
        if self._devices is not None:
            decision = self._devices.check(command.device_id, command.device_name)
            if decision is not DeviceDecision.APPROVED:
                self._refuse_device(command, decision)
                return
        if self._on_cloud_pc_input is not None:
            seq = command.body.get("seq")
            epoch = command.body.get("epoch")
            self._on_cloud_pc_input(
                command.type,
                seq if isinstance(seq, int) and not isinstance(seq, bool) else None,
                epoch if isinstance(epoch, str) else None,
            )
        self._enqueue(command)

    def _refuse_device(self, command: Command, decision: DeviceDecision) -> None:
        """Responde `device_pending` ou `device_denied` (o movimento é descartado)."""
        if command.type in self._silent_types:
            return
        code, detail = {
            DeviceDecision.DENIED: (DEVICE_DENIED, "o dono do PC recusou este aparelho"),
            DeviceDecision.UNKNOWN: (DEVICE_UNKNOWN, "o PC ainda não identificou este aparelho"),
        }.get(decision, (DEVICE_PENDING, "aguardando o dono aprovar este aparelho no PC"))
        self._reply_later(command, CommandResult(command.id, ResultStatus.REJECTED, detail, code))

    def submit_direct(
        self, command: Command, on_result: Callable[[CommandResult], None] | None
    ) -> None:
        """Põe na fila um comando que veio pelo canal direto (já validado pelo portão).

        Entra na mesma fila, na mesma ordem e nos mesmos handlers dos da API. O resultado vai para
        `on_result` (o canal), não para a API; `None` não espera resposta.
        """
        self._direct_ids.add(command.id)
        if on_result is not None:
            self._direct[command.id] = on_result
        self._enqueue(command)

    def run_detached(self, command: Command) -> None:
        """Um comando fora da fila (a sinalização do canal direto): roda em tarefa própria, porque a
        oferta espera a biblioteca carregar e não pode segurar o mouse nem ser segurada por ele."""
        task = asyncio.ensure_future(self._detached(command))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _detached(self, command: Command) -> None:
        # Ninguém espera esta tarefa: o que der errado no envio só pode ir para o registro.
        try:
            result = await self._handle_command(command)
            if command.type in self._silent_types:
                return
            await self._sender.send(
                self._envelopes.result(
                    command.id,
                    ok=result.status.value == "ok",
                    code=result.code or result.status.value,
                    message=result.detail,
                )
            )
        except TransportError as exc:
            _log.debug("resultado de %s não enviado (%s)", command.type, exc)
        except Exception:
            _log.exception("falha ao responder %s (id=%s)", command.type, command.id)

    # ---- estado -------------------------------------------------------------------------------

    def release_waiting(self) -> bool:
        """Há uma soltura (`UP`) esperando na fila?"""
        return any(is_release(queued) for queued, _ in self._queue)

    def direct_lost(self) -> None:
        """O canal direto fechou: tudo o que dele esperava na fila (comandos e movimento) sai dela
        e o que o PC segurava é solto (como na queda da API, sem mexer no da nuvem). O comando do
        canal que já estava sendo executado é cancelado no próximo ponto de espera dele (um clique
        esperando o intervalo do duplo clique não sai depois de o canal fechar); o resultado dele
        nunca vai a lugar nenhum."""
        running = self._running_direct
        if running is not None and not running.done():
            running.cancel()
        if self._direct_ids:
            keep = [item for item in self._queue if item[0].id not in self._direct_ids]
            self._queue.clear()
            self._queue.extend(keep)
        self._direct_ids.clear()
        self._direct.clear()
        self._release_held_inputs()

    def connection_lost(self) -> None:
        """A conexão com a API caiu: o que esperava na fila vindo da nuvem é descartado (seria
        executado tarde, depois de a pessoa já ter perdido o controle) e os botões que a nuvem
        apertou são soltos.

        Com um canal direto autenticado em uso, o que ele tem na fila (e o que o PC segura, que
        é dele) fica como está: o canal sobrevive à queda curta da conexão com a API.
        """
        keep_direct = self._direct_active()
        self._pointer_order.reset()
        # Resultado de uma conexão que caiu não serve a ninguém: não fica tentando sair pela nova.
        while self._result_tasks:
            self._result_tasks.popleft().cancel()
        if keep_direct:
            keep = [item for item in self._queue if item[0].id in self._direct_ids]
            self._queue.clear()
            self._queue.extend(keep)
            if self._running_cloud and self._consumer is not None:
                self._consumer.cancel()  # o que a nuvem executava; o consumidor volta já abaixo
                self._consumer = None
                self._running_cloud = False
            if self._queue:
                self._ensure_consumer()
            return
        self._queue.clear()
        self._direct.clear()
        self._direct_ids.clear()
        if self._consumer is not None:
            self._consumer.cancel()  # o próximo comando cria outro consumidor
            self._consumer = None
        self._running_cloud = False
        self._release_held_inputs()

    async def aclose(self) -> None:
        """Ao encerrar o agente: cancela o que ainda roda em tarefa (e espera terminar)."""
        pending = list(self._tasks)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self._release_held_inputs()

    def _release_held_inputs(self) -> None:
        if self._release_inputs is None:
            return
        try:
            self._release_inputs()
        except Exception:
            _log.exception("falha ao soltar os botões do mouse")

    # ---- fila ---------------------------------------------------------------------------------

    def _enqueue(self, command: Command) -> None:
        if command.type == POINTER_TYPE:
            seq = command.body.get("seq")
            if self._pointer_order.is_late(
                seq if isinstance(seq, int) else None, self._monotonic()
            ):
                self._late_pointers += 1
                if self._late_pointers == LATE_POINTER_WARNING:
                    _log.warning(
                        "%d movimentos do mouse seguidos chegaram fora de ordem (aplicados)",
                        LATE_POINTER_WARNING,
                    )
            else:
                self._late_pointers = 0
        self._queue.append((command, self._monotonic()))
        self._arrival.set()
        if self._on_release_queued is not None and is_release(command):
            self._on_release_queued()
        if len(self._queue) > MAX_PENDING_PC:
            self._shrink()
        self._ensure_consumer()
        self._wakeup.set()

    def _ensure_consumer(self) -> None:
        if self._consumer is None or self._consumer.done():
            self._consumer = asyncio.create_task(self._consume())
            self._tasks.add(self._consumer)
            self._consumer.add_done_callback(self._tasks.discard)

    def _shrink(self) -> None:
        """Tira uma vaga da fila: soma o par de movimentos vizinhos mais novo que se possa somar.

        Só vizinhos: entre dois movimentos não há clique, tecla nem texto, então somar não muda o
        que acontece antes de nenhum deles. Se nenhum par se soma, descarta o movimento mais
        antigo; se nem movimento há (a fila só tem comandos com resposta), passa do teto por
        esta vez.
        """
        queue = self._queue
        silent = self._silent_types
        for index in range(len(queue) - 2, -1, -1):
            (older, older_at), (newer, _) = queue[index], queue[index + 1]
            if older.type == POINTER_TYPE == newer.type and older.type in silent:
                merged = merge_pointer_commands(older, newer)
                if merged is not None:
                    # O movimento somado conta desde o mais antigo (é o que esperou mais).
                    queue[index + 1] = (merged, older_at)
                    del queue[index]
                    self._direct_ids.discard(older.id)
                    self._warn_overflow("somando")
                    return
        for index, (queued, _) in enumerate(queue):
            if queued.type in silent:
                del queue[index]
                self._direct_ids.discard(queued.id)
                self._warn_overflow("descartando")
                return

    def _warn_overflow(self, action: str) -> None:
        if not self._overflowing:
            self._overflowing = True
            _log.warning(
                "faixa do PC cheia (%d comandos esperando): %s movimentos do mouse",
                MAX_PENDING_PC,
                action,
            )

    async def _consume(self) -> None:
        # Um único consumidor: a ordem da faixa não depende de tarefas encadeadas, e cancelar este
        # (queda da conexão, encerramento) interrompe tudo de uma vez.
        while True:
            while not self._queue:
                self._overflowing = False
                self._wakeup.clear()
                await self._wakeup.wait()
            command, queued_at = self._queue.popleft()
            command = self._coalesce(command)
            await self._execute(command, queued_at)

    def _coalesce(self, first: Command) -> Command:
        """Soma ao movimento que vai sair os movimentos vizinhos que já esperam atrás dele.

        Depois de uma parada (a fila encheu enquanto o laço do agente ou a rede engasgou), o
        deslocamento atrasado não se perde nem sai em mil passinhos: vira um só, o mesmo caminho
        (o movimento é relativo). Só o que ainda vale entra na soma (o que passou do prazo o
        handler descarta, calado), só vizinhos do mesmo tipo e da mesma origem (nunca atravessa
        um clique ou tecla) e o resultado leva o `id` e o `ts` do mais novo.
        """
        stale = self._pointer_stale
        if stale is None or first.type != POINTER_TYPE or stale(first):
            return first
        merged, count = first, 1
        from_direct = first.id in self._direct_ids
        while self._queue:
            candidate, _ = self._queue[0]
            if (
                candidate.type != POINTER_TYPE
                or (candidate.id in self._direct_ids) != from_direct
                or stale(candidate)
            ):
                break
            combined = merge_pointer_commands(merged, candidate)
            if combined is None:
                break
            self._queue.popleft()
            self._direct_ids.discard(merged.id)
            merged, count = combined, count + 1
        if count >= COALESCE_WARNING:
            _log.info("faixa do PC: %d movimentos atrasados somados num só", count)
        return merged

    async def _execute(self, command: Command, queued_at: float) -> None:
        """Executa um comando da faixa e responde SEM prender a faixa: o envio do resultado (rede)
        sai em tarefa própria, para o movimento que vem atrás não esperar por ele. A ordem dos
        resultados não importa (a API os casa pelo `id`); a ordem da execução é a da faixa."""
        # De onde veio, anotado ANTES de executar: se o canal fechar no meio, o resultado é dele
        # (e é descartado), nunca da API, que não pediu este comando.
        from_direct = command.id in self._direct_ids
        self._direct_ids.discard(command.id)
        started = self._monotonic()
        result = await self._run_spread(command, from_direct=from_direct)
        self._log_operation(
            command, from_direct, started - queued_at, self._monotonic() - started, result
        )
        if result is None:
            return
        if from_direct:
            sink = self._direct.pop(command.id, None)
            if sink is not None:
                try:
                    sink(result)
                except Exception:
                    _log.exception("falha ao responder pelo canal direto (%s)", command.type)
            return
        if command.type in self._silent_types:
            return
        self._reply_later(command, result)

    def _reply_later(self, command: Command, result: CommandResult) -> None:
        """Envia o resultado em tarefa própria (a faixa não espera a rede), com teto."""
        task = asyncio.create_task(self._send_result(command, result))
        self._tasks.add(task)
        self._result_tasks.append(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(self._forget_result_task)
        while len(self._result_tasks) > MAX_PENDING_RESULTS:
            oldest = self._result_tasks.popleft()
            oldest.cancel()
            if not self._results_overflowing:
                self._results_overflowing = True
                _log.warning(
                    "envio de resultados do PC acumulado (%d): abandonando o mais antigo",
                    MAX_PENDING_RESULTS,
                )

    def _log_operation(
        self,
        command: Command,
        from_direct: bool,
        queued_seconds: float,
        run_seconds: float,
        result: CommandResult | None,
    ) -> None:
        """Uma linha por comando que NÃO é movimento do mouse: a operação, o tipo, o caminho (nuvem
        ou canal direto), quanto esperou na fila, quanto levou e o resultado.

        A operação é o `operationId` do pedido (o mesmo que a API registra) ou, sem ele, o `id` do
        envelope. Nunca o texto, as teclas nem as coordenadas: só tipo e números."""
        if command.type == POINTER_TYPE:
            return
        if result is None:
            outcome = "descartado"
        elif result.status is ResultStatus.OK:
            outcome = "ok"
        else:
            outcome = result.code or result.status.value
        _log.info(
            "operação %s: %s via %s; fila %.0f ms; execução %.0f ms; resultado %s",
            command.operation_id or command.id,
            command.type,
            "canal direto" if from_direct else "nuvem",
            queued_seconds * 1000,
            run_seconds * 1000,
            outcome,
        )

    def _spread_parts(self, command: Command) -> list[Command]:
        """O salto grande do ponteiro em passos; o comando como veio se não vale espalhar.

        Só movimento sem rolagem, só com nada mais esperando na fila (um lote atrasado sai de
        uma vez: espalhar o atraso o aumentaria) e só acima do mínimo de pixels."""
        spread = self._spread
        body = command.body
        if (
            spread is None
            or command.type != POINTER_TYPE
            or self._queue
            or body.get("scrollX")
            or body.get("scrollY")
        ):
            return [command]
        dx, dy = int(body.get("dx", 0)), int(body.get("dy", 0))
        steps = spread_steps(dx, dy, spread)
        if len(steps) < 2:  # noqa: PLR2004
            return [command]
        return [replace(command, body={"dx": sx, "dy": sy}) for sx, sy in steps]

    async def _run_spread(self, command: Command, *, from_direct: bool) -> CommandResult | None:
        """Roda o comando; um salto grande do ponteiro sai em passos espaçados (`PointerSpread`)."""
        parts = self._spread_parts(command)
        spread = self._spread
        if len(parts) == 1 or spread is None:
            return await self._run(command, from_direct=from_direct)
        spacing = spread.total_seconds / (len(parts) - 1)
        result: CommandResult | None = None
        for index, part in enumerate(parts):
            if index:
                await self._spread_wait(spacing)
            result = await self._run(part, from_direct=from_direct)
            if result is None or result.status is not ResultStatus.OK:
                break  # recusado ou descartado: o resto do salto não segue
        return result

    async def _spread_wait(self, seconds: float) -> None:
        """Espera o espaçamento entre dois passos, a menos que algo chegue à fila (então não espera:
        a ordem e o caminho são os mesmos, só o espaçamento se perde)."""
        if self._queue:
            return
        self._arrival.clear()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._arrival.wait(), seconds)

    async def _run(self, command: Command, *, from_direct: bool) -> CommandResult | None:
        """Roda o handler; `None` se ele falhou ou se o canal direto fechou com ele na espera.

        O comando do canal direto (menos o movimento, que não espera nada) roda em tarefa própria,
        para o fechamento do canal poder cancelá-lo no meio de uma espera.
        """
        inner: asyncio.Future[CommandResult] | None = None
        self._running_cloud = not from_direct
        try:
            if from_direct and command.type != POINTER_TYPE:
                inner = asyncio.ensure_future(self._handle_command(command))
                self._running_direct = inner
                return await inner
            return await self._handle_command(command)
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if inner is not None and inner.cancelled() and not (current and current.cancelling()):
                # O canal fechou com o comando na espera: ele não sai e ninguém é avisado.
                self._direct.pop(command.id, None)
                return None
            if inner is not None:
                inner.cancel()
            raise
        except Exception:
            _log.exception("falha ao executar %s (id=%s)", command.type, command.id)
            self._direct.pop(command.id, None)
            return None
        finally:
            self._running_cloud = False
            if inner is not None and self._running_direct is inner:
                self._running_direct = None

    def _forget_result_task(self, task: asyncio.Task[None]) -> None:
        with contextlib.suppress(ValueError):  # já saiu da fila (abandonada ou cancelada na queda)
            self._result_tasks.remove(task)
        if not self._result_tasks:
            self._results_overflowing = False

    async def _send_result(self, command: Command, result: CommandResult) -> None:
        # Ninguém espera esta tarefa: o que der errado no envio só pode ir para o registro.
        try:
            await self._sender.send(
                self._envelopes.result(
                    command.id,
                    ok=result.status.value == "ok",
                    code=result.code or result.status.value,
                    message=result.detail,
                )
            )
        except TransportError as exc:
            _log.debug("resultado de %s não enviado (%s)", command.type, exc)
        except Exception:
            _log.exception("falha ao responder %s (id=%s)", command.type, command.id)
