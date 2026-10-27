import logging
from collections.abc import Awaitable, Callable, Mapping

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.ports import Clock

Handler = Callable[[Command], Awaitable[CommandResult]]

_log = logging.getLogger(__name__)


class FreshKeyHandler:
    """Handler de tecla que confere a idade do comando antes de enviá-lo à TV.

    A marca é o tipo: o receptor só segue lendo mensagens durante a abertura da TV quando o
    handler instalado é deste tipo.
    """

    def __init__(self, handle: Handler) -> None:
        self._handle = handle

    async def __call__(self, command: Command) -> CommandResult:
        return await self._handle(command)


class HandleCommand:
    """Escolhe o handler pelo type do comando; tipo desconhecido é recusado e registrado."""

    def __init__(self, handlers: Mapping[str, Handler], clock: Clock) -> None:
        self._handlers = dict(handlers)
        self._clock = clock

    def handles_fresh_keys(self, message_type: str) -> bool:
        """Só executa tecla em paralelo quando o handler confere sua idade antes do envio."""
        return isinstance(self._handlers.get(message_type), FreshKeyHandler)

    async def __call__(self, command: Command) -> CommandResult:
        handler = self._handlers.get(command.type)
        if handler is None:
            _log.warning(
                "comando recusado: tipo desconhecido %r (id=%s, em %s)",
                command.type,
                command.id,
                self._clock.now().isoformat(),
            )
            return CommandResult(
                command.id, ResultStatus.REJECTED, f"tipo desconhecido: {command.type}"
            )
        try:
            return await handler(command)
        except Exception as exc:  # falha do aparelho não pode derrubar o agente
            _log.exception("falha ao executar %s (id=%s)", command.type, command.id)
            return CommandResult(command.id, ResultStatus.FAILED, str(exc))
