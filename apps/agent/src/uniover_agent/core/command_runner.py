"""Executar um comando aceito e responder: o trecho comum ao laço principal e à faixa da TV.

Quem recebe (o `ProcessMessage`) e a faixa das teclas da TV (`TvLane`, que pode viver noutro laço)
executam do mesmo jeito: grava o id de `POWER`, chama o handler, guarda o resultado para o id
repetido e responde pela nuvem ou pelo canal direto. Só o `sender` muda: na faixa em laço próprio
ele leva o envio ao laço do transporte.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Collection, Iterable

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import HandleCommand
from uniover_agent.core.power_ids import PowerIds
from uniover_agent.core.tv.session import TV_UNREACHABLE
from uniover_agent.ports import Sender, TransportError

_log = logging.getLogger(__name__)

_TV_KEY_PREFIX = "tv.key."
# O teto do tempo é das teclas da TV: a entrada do PC tem a faixa e os prazos dela.
_PC_PREFIX = "pc."

# Resposta de quem foi aceito e não terminou quando o agente fecha (encerramento ou passagem para a
# versão nova, depois do prazo do `drain`): todo comando aceito recebe uma resposta só.
AGENT_STOPPING = "agent_stopping"
STOPPING_MESSAGE = (
    "o agente está encerrando ou trocando de versão; o comando pode não ter terminado, "
    "tente de novo em instantes"
)

# Como o resultado de um comando volta a quem o pediu: pela nuvem (o transporte) ou, no canal
# direto, pela resposta do próprio canal.
Reply = Callable[[Command, CommandResult], Awaitable[None]]
# Quem leva a resposta sem que a execução espere por ela (a faixa da TV em laço próprio: o envio
# depende do laço principal, e a próxima tecla não pode esperar por ele).
Respond = Callable[[Command, CommandResult, Reply | None], None]


def is_power(command: Command) -> bool:
    """`POWER` pelo caminho das teclas da TV: interruptor, nunca pode executar duas vezes."""
    return command.type.startswith(_TV_KEY_PREFIX) and command.body.get("key") == "POWER"


class CommandRunner:
    """Executa, guarda o resultado (`remember`) e responde."""

    def __init__(  # noqa: PLR0913 - dependências injetadas, todas necessárias
        self,
        handle_command: HandleCommand,
        envelopes: EnvelopeFactory,
        sender: Sender,
        power: PowerIds,
        remember: Callable[[Command, CommandResult], None],
        *,
        silent_types: Collection[str] = (),
        command_timeout_seconds: float | None = None,
        uncapped_types: Collection[str] = (),
    ) -> None:
        self._handle_command = handle_command
        self._envelopes = envelopes
        self._sender = sender
        self._power = power
        self._remember = remember
        self._silent_types = frozenset(silent_types)
        # Teto de um comando em tarefa própria: uma tecla presa não pode segurar para sempre o
        # texto e o POWER que esperam por ela. Os tipos longos por natureza ficam de fora.
        self._command_timeout = command_timeout_seconds
        self._uncapped_types = frozenset(uncapped_types)

    async def reply_result(
        self, command: Command, result: CommandResult, reply: Reply | None = None
    ) -> None:
        """Pelo canal direto o resultado volta pelo próprio canal; pela nuvem, pelo transporte."""
        if reply is not None:
            await reply(command, result)
            return
        if command.type in self._silent_types:
            # Fluxo de alta taxa (o movimento do mouse): a API o manda sem esperar resposta, e uma
            # resposta por movimento só encheria o canal e o registro dela.
            return
        # A API manda o comando com `correlationId` nulo e espera o resultado apontando o `id` dele.
        await self._sender.send(
            self._envelopes.result(
                command.id,
                ok=result.status.value == "ok",
                code=result.code or result.status.value,
                message=result.detail,
                notice=result.notice,
            )
        )

    async def execute(
        self, command: Command, reply: Reply | None = None, *, respond: Respond | None = None
    ) -> None:
        """Executa e responde; com `respond`, a resposta é entregue a ele e não esperada aqui."""
        if is_power(command):
            # O id já está na memória (o leitor reconhece o repetido); vai a disco aqui, fora do
            # leitor, antes de a tecla ir à TV.
            await self._power.persist()
        result = await self._handle_command(command)
        self._remember(command, result)
        await self._answer(command, result, reply, respond)

    async def _answer(
        self,
        command: Command,
        result: CommandResult,
        reply: Reply | None,
        respond: Respond | None,
    ) -> None:
        if respond is None:
            await self.reply_result(command, result, reply)
        else:
            respond(command, result, reply)

    async def execute_detached(
        self, command: Command, reply: Reply | None = None, *, respond: Respond | None = None
    ) -> None:
        # Ninguém espera esta tarefa: o que der errado no envio só pode ir para o registro.
        try:
            if (
                self._command_timeout is None
                or command.type in self._uncapped_types
                or command.type.startswith(_PC_PREFIX)
            ):
                await self.execute(command, reply, respond=respond)
            else:
                await self._execute_capped(command, self._command_timeout, reply, respond)
        except TransportError as exc:
            _log.debug("resultado de %s não enviado (%s)", command.type, exc)
        except Exception:
            _log.exception("falha ao responder %s (id=%s)", command.type, command.id)

    async def _execute_capped(
        self,
        command: Command,
        limit: float,
        reply: Reply | None = None,
        respond: Respond | None = None,
    ) -> None:
        # O corte só vale se foi o prazo que o causou: um `TimeoutError` do próprio comando passa.
        try:
            async with asyncio.timeout(limit) as deadline:
                await self.execute(command, reply, respond=respond)
        except TimeoutError:
            if not deadline.expired():
                raise
        else:
            return
        _log.warning("comando %s passou do tempo máximo (id=%s)", command.type, command.id)
        result = CommandResult(
            command.id, ResultStatus.FAILED, "a TV demorou demais para responder", TV_UNREACHABLE
        )
        self._remember(command, result)
        await self._answer(command, result, reply, respond)

    async def answer_stopping(self, unanswered: Iterable[tuple[Command, Reply | None]]) -> None:
        """`agent_stopping` a cada comando aceito que foi cancelado sem resposta."""
        for command, reply in unanswered:
            try:
                if reply is not None:
                    await reply(
                        command,
                        CommandResult(
                            command.id, ResultStatus.FAILED, STOPPING_MESSAGE, AGENT_STOPPING
                        ),
                    )
                else:
                    await self._sender.send(
                        self._envelopes.result(
                            command.id, ok=False, code=AGENT_STOPPING, message=STOPPING_MESSAGE
                        )
                    )
            except TransportError as exc:
                _log.debug("resposta de encerramento de %s não enviada (%s)", command.type, exc)
            except Exception:
                _log.exception("falha ao responder %s ao encerrar", command.type)
