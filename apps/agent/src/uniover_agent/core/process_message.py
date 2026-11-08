"""Caso de uso de uma mensagem recebida: valida, executa só o que passou e responde."""

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Callable, Collection
from typing import Final

from uniover_agent.core.domain import Command, CommandResult
from uniover_agent.core.envelope_gate import Accepted, EnvelopeGate, Rejected
from uniover_agent.core.envelopes import INVALID_MESSAGE, EnvelopeFactory
from uniover_agent.core.handle_command import HandleCommand
from uniover_agent.core.pc.handlers import POINTER_TYPE, merge_pointer_commands
from uniover_agent.core.pc.pointer_order import PointerSequence
from uniover_agent.core.tv.handlers import TimedKeyCommand
from uniover_agent.core.tv.session import TV_UNREACHABLE
from uniover_agent.ports import Transport, TransportError

_log = logging.getLogger(__name__)

_KEEPALIVE_TYPE = "api.keepalive.v1"
# Comandos do PC têm faixa própria: não esperam as teclas da TV nem as seguram.
_PC_PREFIX = "pc."
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


class ProcessMessage:
    """Valida a mensagem, executa o comando e responde.

    As mensagens comuns são atendidas uma a uma. Comandos em `background_types` e teclas cujo
    handler confere a idade rodam em tarefa própria: a recepção não espera a TV abrir a sessão.
    Texto e POWER aguardam as teclas anteriores para conservar a ordem dos comandos. Comandos em
    `silent_types` são executados mas não respondidos.

    Os comandos `pc.*` correm numa faixa à parte: um só consumidor os executa um após o outro, na
    ordem de chegada (apertar, mover, soltar), sem esperar as teclas da TV e sem que elas esperem
    por eles.
    `release_inputs` solta os botões do mouse que o PC ficou segurando; é chamado quando a conexão
    cai e ao encerrar, depois de parar a faixa.
    """

    def __init__(  # noqa: PLR0913 - dependências injetadas, todas necessárias
        self,
        agent_id: str,
        gate: EnvelopeGate,
        handle_command: HandleCommand,
        envelopes: EnvelopeFactory,
        transport: Transport,
        *,
        background_types: Collection[str] = (),
        silent_types: Collection[str] = (),
        monotonic: Callable[[], float] = time.monotonic,
        on_command: Callable[[Command], None] | None = None,
        command_timeout_seconds: float | None = None,
        uncapped_types: Collection[str] = (),
        release_inputs: Callable[[], None] | None = None,
        observe_timestamp: Callable[[str | None], None] | None = None,
    ) -> None:
        self._agent_id = agent_id
        self._gate = gate
        self._handle_command = handle_command
        self._envelopes = envelopes
        self._transport = transport
        self._background_types = frozenset(background_types)
        self._silent_types = frozenset(silent_types)
        self._monotonic = monotonic
        self._on_command = on_command
        # Teto de um comando em tarefa própria: uma tecla presa não pode segurar para sempre o
        # texto e o POWER que esperam por ela. Os tipos longos por natureza ficam de fora.
        self._command_timeout = command_timeout_seconds
        self._uncapped_types = frozenset(uncapped_types)
        self._release_inputs = release_inputs
        # Recebe o `ts` de cada batimento da API (`api.keepalive.v1`): só ele, que a API nunca
        # segura, serve para estimar a diferença entre o relógio dela e o monotônico deste agente.
        # Um comando `pc.*` não entra aí: se tivesse chegado atrasado, ensinaria a estimativa a
        # tratar o atraso como normal.
        self._observe_timestamp = observe_timestamp
        self._tasks: set[asyncio.Task[None]] = set()
        # Faixa do PC: a fila, o consumidor único (criado ao primeiro comando) e o aviso de excesso.
        self._pc_queue: deque[Command] = deque()
        self._pc_wakeup = asyncio.Event()
        self._pc_consumer: asyncio.Task[None] | None = None
        self._pc_overflowing = False
        # Movimentos numerados chegam em pedidos paralelos; a ordem só alimenta o diagnóstico.
        self._pointer_order = PointerSequence()
        self._late_pointers = 0
        # Envios de resultado da faixa do PC em andamento, do mais antigo ao mais novo.
        self._result_tasks: deque[asyncio.Task[None]] = deque()
        self._results_overflowing = False
        self._key_tasks: set[asyncio.Task[None]] = set()
        self._last_key_task: asyncio.Task[None] | None = None
        self._latest_key: dict[str, int] = {}

    async def __call__(self, raw: str | bytes) -> None:
        outcome = self._gate.check_inbound(raw)
        if isinstance(outcome, Rejected):
            await self._reject(outcome)
            return

        command = outcome.command
        if self._on_command is not None:
            self._on_command(command)
        if command.type == _KEEPALIVE_TYPE:
            if self._observe_timestamp is not None:
                self._observe_timestamp(command.sent_at)
            # Batimento da API: já chegou pelo canal; não executa comando nem produz resultado.
            return
        if (
            command.type.startswith("tv.key.")
            and command.body.get("key") != "POWER"
            and self._handle_command.handles_fresh_keys(command.type)
        ):
            # A recepção continua durante a abertura lenta da sessão. Só o relógio monotônico
            # deste agente mede a espera; o horário da API pode diferir do relógio deste PC.
            key = command.body["key"]
            direction = command.body.get("direction") or "SHORT"
            is_latest = self._newest_press(key) if direction == "SHORT" else None
            command = TimedKeyCommand(
                command.id,
                command.type,
                command.body,
                command.correlation_id,
                command.sent_at,
                self._monotonic(),
                is_latest,
            )
            task = asyncio.create_task(self._execute_key(command, self._last_key_task))
            self._last_key_task = task
            self._tasks.add(task)
            self._key_tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            task.add_done_callback(self._key_tasks.discard)
            return
        if command.type.startswith(_PC_PREFIX):
            self._enqueue_pc(command)
            return
        if command.type in self._background_types:
            task = asyncio.create_task(self._execute_detached(command))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            return
        # Texto e POWER preservam a ordem que tinham no laço serial com as teclas anteriores.
        await asyncio.gather(*tuple(self._key_tasks))
        await self._execute(command)

    def _enqueue_pc(self, command: Command) -> None:
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
        self._pc_queue.append(command)
        if len(self._pc_queue) > MAX_PENDING_PC:
            self._shrink_pc_queue()
        if self._pc_consumer is None or self._pc_consumer.done():
            self._pc_consumer = asyncio.create_task(self._consume_pc())
            self._tasks.add(self._pc_consumer)
            self._pc_consumer.add_done_callback(self._tasks.discard)
        self._pc_wakeup.set()

    def _shrink_pc_queue(self) -> None:
        """Tira uma vaga da fila: soma o par de movimentos vizinhos mais novo que se possa somar.

        Só vizinhos: entre dois movimentos não há clique, tecla nem texto, então somar não muda o
        que acontece antes de nenhum deles. Se nenhum par se soma, descarta o movimento mais
        antigo; se nem movimento há (a fila só tem comandos com resposta), passa do teto por
        esta vez.
        """
        queue = self._pc_queue
        silent = self._silent_types
        for index in range(len(queue) - 2, -1, -1):
            older, newer = queue[index], queue[index + 1]
            if older.type == POINTER_TYPE == newer.type and older.type in silent:
                merged = merge_pointer_commands(older, newer)
                if merged is not None:
                    queue[index + 1] = merged
                    del queue[index]
                    self._warn_pc_overflow("somando")
                    return
        for index, queued in enumerate(queue):
            if queued.type in silent:
                del queue[index]
                self._warn_pc_overflow("descartando")
                return

    def _warn_pc_overflow(self, action: str) -> None:
        if not self._pc_overflowing:
            self._pc_overflowing = True
            _log.warning(
                "faixa do PC cheia (%d comandos esperando): %s movimentos do mouse",
                MAX_PENDING_PC,
                action,
            )

    async def _consume_pc(self) -> None:
        # Um único consumidor: a ordem da faixa não depende de tarefas encadeadas, e cancelar este
        # (queda da conexão, encerramento) interrompe tudo de uma vez.
        while True:
            while not self._pc_queue:
                self._pc_overflowing = False
                self._pc_wakeup.clear()
                await self._pc_wakeup.wait()
            await self._execute_pc(self._pc_queue.popleft())

    async def _execute_pc(self, command: Command) -> None:
        """Executa um comando da faixa e responde SEM prender a faixa: o envio do resultado (rede)
        sai em tarefa própria, para o movimento que vem atrás não esperar por ele. A ordem dos
        resultados não importa (a API os casa pelo `id`); a ordem da execução é a da faixa."""
        try:
            result = await self._handle_command(command)
        except Exception:
            _log.exception("falha ao executar %s (id=%s)", command.type, command.id)
            return
        if command.type in self._silent_types:
            return
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

    def _forget_result_task(self, task: asyncio.Task[None]) -> None:
        with contextlib.suppress(ValueError):  # já saiu da fila (abandonada ou cancelada na queda)
            self._result_tasks.remove(task)
        if not self._result_tasks:
            self._results_overflowing = False

    async def _send_result(self, command: Command, result: CommandResult) -> None:
        # Ninguém espera esta tarefa: o que der errado no envio só pode ir para o registro.
        try:
            await self._transport.send(
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

    def _newest_press(self, key: str) -> Callable[[], bool]:
        self._latest_key[key] = self._latest_key.get(key, 0) + 1
        sequence = self._latest_key[key]

        def is_latest() -> bool:
            return self._latest_key[key] == sequence

        return is_latest

    async def _execute_key(
        self, command: TimedKeyCommand, previous: asyncio.Task[None] | None
    ) -> None:
        # O envio de RIGHT seguido de OK não pode ser invertido por duas tarefas que aquecem
        # ou reabrem o mesmo canal ao mesmo tempo. A recepção segue livre enquanto elas esperam.
        if previous is not None:
            await previous
        await self._execute_detached(command)

    async def aclose(self) -> None:
        """Ao encerrar o agente: cancela o que ainda roda em tarefa (e espera terminar)."""
        pending = list(self._tasks)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self._release_held_inputs()

    def connection_lost(self) -> None:
        """A conexão com a API caiu: o que esperava na faixa do PC é descartado (seria executado
        tarde, depois de a pessoa já ter perdido o controle) e os botões apertados são soltos."""
        self._pc_queue.clear()
        self._pointer_order.reset()
        # Resultado de uma conexão que caiu não serve a ninguém: não fica tentando sair pela nova.
        while self._result_tasks:
            self._result_tasks.popleft().cancel()
        if self._pc_consumer is not None:
            self._pc_consumer.cancel()  # o próximo comando cria outro consumidor
            self._pc_consumer = None
        self._release_held_inputs()

    def _release_held_inputs(self) -> None:
        if self._release_inputs is None:
            return
        try:
            self._release_inputs()
        except Exception:
            _log.exception("falha ao soltar os botões do mouse")

    async def _execute(self, command: Command) -> None:
        result = await self._handle_command(command)
        if command.type in self._silent_types:
            # Fluxo de alta taxa (o movimento do mouse): a API o manda sem esperar resposta, e uma
            # resposta por movimento só encheria o canal e o registro dela.
            return
        # A API manda o comando com `correlationId` nulo e espera o resultado apontando o `id` dele.
        ok = result.status.value == "ok"
        await self._transport.send(
            self._envelopes.result(
                command.id,
                ok=ok,
                code=result.code or result.status.value,
                message=result.detail,
            )
        )

    async def _execute_detached(self, command: Command) -> None:
        # Ninguém espera esta tarefa: o que der errado no envio só pode ir para o registro.
        try:
            if (
                self._command_timeout is None
                or command.type in self._uncapped_types
                or command.type.startswith(_PC_PREFIX)  # o teto é das teclas da TV
            ):
                await self._execute(command)
            else:
                await self._execute_capped(command, self._command_timeout)
        except TransportError as exc:
            _log.debug("resultado de %s não enviado (%s)", command.type, exc)
        except Exception:
            _log.exception("falha ao responder %s (id=%s)", command.type, command.id)

    async def _execute_capped(self, command: Command, limit: float) -> None:
        # O corte só vale se foi o prazo que o causou: um `TimeoutError` do próprio comando passa.
        try:
            async with asyncio.timeout(limit) as deadline:
                await self._execute(command)
        except TimeoutError:
            if not deadline.expired():
                raise
        else:
            return
        _log.warning("comando %s passou do tempo máximo (id=%s)", command.type, command.id)
        if command.type in self._silent_types:
            return
        await self._transport.send(
            self._envelopes.result(
                command.id,
                ok=False,
                code=TV_UNREACHABLE,
                message="a TV demorou demais para responder",
            )
        )

    async def _reject(self, rejected: Rejected) -> None:
        # Nunca o corpo recebido: só quem enviou o quê (tipo) e por quê.
        _log.warning(
            "mensagem recusada (agente=%s, type=%s, motivo=%s%s)",
            self._agent_id,
            rejected.message_type or "?",
            rejected.reason,
            f": {rejected.detail}" if rejected.detail else "",
        )
        if rejected.reply_to is not None:
            await self._transport.send(
                self._envelopes.result(
                    rejected.reply_to,
                    ok=False,
                    code=INVALID_MESSAGE,
                    message=f"mensagem recusada: {rejected.reason}",
                )
            )


__all__ = ["Accepted", "ProcessMessage"]
