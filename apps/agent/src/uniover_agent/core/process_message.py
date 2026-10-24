"""Caso de uso de uma mensagem recebida: valida, executa só o que passou e responde."""

import asyncio
import logging
from collections.abc import Collection

from uniover_agent.core.domain import Command
from uniover_agent.core.envelope_gate import Accepted, EnvelopeGate, Rejected
from uniover_agent.core.envelopes import INVALID_MESSAGE, EnvelopeFactory
from uniover_agent.core.handle_command import HandleCommand
from uniover_agent.ports import Transport, TransportError

_log = logging.getLogger(__name__)

_KEEPALIVE_TYPE = "api.keepalive.v1"


class ProcessMessage:
    """Valida a mensagem, executa o comando e responde.

    As mensagens são atendidas uma a uma. Um comando longo (a limpeza da TV leva vários segundos)
    seguraria todas as teclas atrás dele até a API desistir de esperá-las, então os tipos em
    `background_types` rodam em tarefa própria: as teclas seguem e o resultado desse comando sai
    quando ele termina.
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
    ) -> None:
        self._agent_id = agent_id
        self._gate = gate
        self._handle_command = handle_command
        self._envelopes = envelopes
        self._transport = transport
        self._background_types = frozenset(background_types)
        self._tasks: set[asyncio.Task[None]] = set()

    async def __call__(self, raw: str | bytes) -> None:
        outcome = self._gate.check_inbound(raw)
        if isinstance(outcome, Rejected):
            await self._reject(outcome)
            return

        command = outcome.command
        if command.type == _KEEPALIVE_TYPE:
            # Batimento da API: já chegou pelo canal; não executa comando nem produz resultado.
            return
        if command.type in self._background_types:
            task = asyncio.create_task(self._execute_detached(command))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            return
        await self._execute(command)

    async def aclose(self) -> None:
        """Ao encerrar o agente: cancela o que ainda roda em tarefa (e espera terminar)."""
        pending = list(self._tasks)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    async def _execute(self, command: Command) -> None:
        result = await self._handle_command(command)
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
