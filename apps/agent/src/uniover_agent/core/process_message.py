"""Caso de uso de uma mensagem recebida: valida, executa só o que passou e responde."""

import asyncio
import logging
import time
from collections import deque
from collections.abc import Callable, Collection
from typing import Final

from uniover_agent.core.domain import Command
from uniover_agent.core.envelope_gate import Accepted, EnvelopeGate, Rejected
from uniover_agent.core.envelopes import INVALID_MESSAGE, EnvelopeFactory
from uniover_agent.core.handle_command import HandleCommand
from uniover_agent.core.tv.handlers import TimedKeyCommand
from uniover_agent.core.tv.session import TV_UNREACHABLE
from uniover_agent.ports import Transport, TransportError

_log = logging.getLogger(__name__)

_KEEPALIVE_TYPE = "api.keepalive.v1"
# Comandos do PC têm faixa própria: não esperam as teclas da TV nem as seguram.
_PC_PREFIX = "pc."
# Teto de comandos do PC esperando a vez. Acima disso, cada movimento novo do mouse (silencioso: o
# app manda outro logo) descarta o movimento pendente MAIS ANTIGO, e o posicionamento mais recente
# é o que sobrevive se algo travar.
MAX_PENDING_PC: Final = 128


class ProcessMessage:
    """Valida a mensagem, executa o comando e responde.

    As mensagens comuns são atendidas uma a uma. Comandos em `background_types` e teclas cujo
    handler confere a idade rodam em tarefa própria: a recepção não espera a TV abrir a sessão.
    Texto e POWER aguardam as teclas anteriores para conservar a ordem dos comandos. Comandos em
    `silent_types` são executados mas não respondidos.

    Os comandos `pc.*` correm numa faixa à parte: um após o outro, na ordem de chegada (apertar,
    mover, soltar), sem esperar as teclas da TV e sem que elas esperem por eles.
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
        # Recebe o `ts` de toda mensagem aceita da API (batimento e comandos): é daí que o PC estima
        # a diferença entre o relógio dele e o da API.
        self._observe_timestamp = observe_timestamp
        self._tasks: set[asyncio.Task[None]] = set()
        self._pc_tasks: set[asyncio.Task[None]] = set()
        self._last_pc_task: asyncio.Task[None] | None = None
        self._pending_silent: deque[asyncio.Task[None]] = deque()
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
        if self._observe_timestamp is not None:
            self._observe_timestamp(command.sent_at)
        if command.type == _KEEPALIVE_TYPE:
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
        silent = command.type in self._silent_types
        if len(self._pc_tasks) >= MAX_PENDING_PC and not self._drop_oldest_silent() and silent:
            return  # fila cheia só de comandos com resposta: este movimento novo é que cai
        task = asyncio.create_task(self._execute_pc(command, self._last_pc_task))
        self._last_pc_task = task
        self._tasks.add(task)
        self._pc_tasks.add(task)
        if silent:
            self._pending_silent.append(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(self._pc_tasks.discard)

    def _drop_oldest_silent(self) -> bool:
        """Cancela o movimento pendente mais antigo; devolve se havia algum."""
        while self._pending_silent:
            oldest = self._pending_silent.popleft()
            if oldest.done():
                continue
            oldest.cancel()
            self._pc_tasks.discard(oldest)  # já não conta para o teto
            return True
        return False

    async def _execute_pc(self, command: Command, previous: asyncio.Task[None] | None) -> None:
        # Só espera quem veio antes na faixa do PC (nunca as teclas da TV). `wait` não propaga o
        # cancelamento do anterior: o cancelamento desta tarefa, sim.
        if previous is not None and not previous.done():
            await asyncio.wait({previous})
        await self._execute_detached(command)

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
        for task in tuple(self._pc_tasks):
            task.cancel()
        self._last_pc_task = None
        self._pending_silent.clear()
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
