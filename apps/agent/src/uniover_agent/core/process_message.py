"""Caso de uso de uma mensagem recebida: valida, executa só o que passou e responde."""

import asyncio
import logging
import time
from collections.abc import Callable, Collection

from uniover_agent.core.domain import Command
from uniover_agent.core.envelope_gate import Accepted, EnvelopeGate, Rejected
from uniover_agent.core.envelopes import INVALID_MESSAGE, EnvelopeFactory
from uniover_agent.core.handle_command import HandleCommand
from uniover_agent.core.tv.handlers import TimedKeyCommand
from uniover_agent.ports import Transport, TransportError

_log = logging.getLogger(__name__)

_KEEPALIVE_TYPE = "api.keepalive.v1"


class ProcessMessage:
    """Valida a mensagem, executa o comando e responde.

    As mensagens comuns são atendidas uma a uma. Comandos em `background_types` e teclas cujo
    handler confere a idade rodam em tarefa própria: a recepção não espera a TV abrir a sessão.
    Texto e POWER aguardam as teclas anteriores para conservar a ordem dos comandos. Comandos em
    `silent_types` são executados mas não respondidos.
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
        self._tasks: set[asyncio.Task[None]] = set()
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
        if command.type in self._background_types:
            task = asyncio.create_task(self._execute_detached(command))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            return
        # Texto e POWER preservam a ordem que tinham no laço serial com as teclas anteriores.
        await asyncio.gather(*tuple(self._key_tasks))
        await self._execute(command)

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
            await self._execute(command)
        except TransportError as exc:
            _log.debug("resultado de %s não enviado (%s)", command.type, exc)
        except Exception:
            _log.exception("falha ao responder %s (id=%s)", command.type, command.id)

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
