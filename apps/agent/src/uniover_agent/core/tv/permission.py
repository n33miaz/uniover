"""Permissão do UniOver na TV Samsung: um aviso só, e nunca pedido em silêncio.

A TV Samsung mostra "Permitir" na tela na primeira vez e liga a resposta ao nome do cliente e ao
token. Se ela esquecer (permissão revogada ou vencida), reconectar faria o aviso aparecer de novo
sem ninguém ter pedido. Por isso o agente, ao perceber isso, **para de tentar** e avisa a API
(`tv.permission.v1` com `needed`); só o pedido explícito da pessoa (`tv.permission.request.v1`,
disparado pelo botão "Pedir Agora" do app) volta a falar com a TV nesse estado.

O gerenciador de sessão continua o único dono do canal da TV: o pedido roda com a sessão fechada
(`while_closed`).
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Final, Protocol

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.ports import Transport, TransportError

_log = logging.getLogger(__name__)

# Declarada no `agent.hello.v1`: a API só manda `tv.permission.request.v1` a quem a tem.
PERMISSION_CAPABILITY: Final = "tv.permission.v1"
PERMISSION_IN_PROGRESS: Final = "permission_in_progress"
TV_UNREACHABLE_CODE: Final = "tv_unreachable"
SEND_TIMEOUT_SECONDS: Final = 5.0


class PermissionDriver(Protocol):
    """O que o serviço pede ao driver da TV (o driver Samsung implementa)."""

    @property
    def permission_needed(self) -> bool: ...

    def on_permission(self, callback: Callable[[bool], None]) -> None: ...

    async def reachable(self) -> bool: ...

    async def request_permission(self) -> bool: ...


class PermissionSession(Protocol):
    async def while_closed(self, action: Callable[[], Awaitable[bool]]) -> bool: ...


class TvPermission:
    def __init__(
        self,
        driver: PermissionDriver,
        session: PermissionSession,
        transport: Transport,
        envelopes: EnvelopeFactory,
    ) -> None:
        self._driver = driver
        self._session = session
        self._transport = transport
        self._envelopes = envelopes
        self._running: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        driver.on_permission(self._changed)

    @property
    def in_progress(self) -> bool:
        return self._running is not None and not self._running.done()

    def _changed(self, needed: bool) -> None:
        # Chamado de dentro do laço de eventos (o driver só muda o estado nele).
        task = asyncio.get_running_loop().create_task(self._send(needed))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send(self, needed: bool) -> None:
        try:
            await asyncio.wait_for(
                self._transport.send(
                    self._envelopes.tv_permission("needed" if needed else "granted")
                ),
                SEND_TIMEOUT_SECONDS,
            )
        except TransportError, TimeoutError:
            # Sem conexão com a API: o `hello` seguinte repete o estado atual.
            _log.debug("estado da permissão da TV aguarda a conexão com a API")

    async def announce(self) -> None:
        """A API recém-conectada não conhece o estado: informa o atual depois do `hello`."""
        await self._send(self._driver.permission_needed)

    def handler(self) -> Handler:
        """`tv.permission.request.v1`: pede o aviso na TV e responde logo, sem esperar o aceite."""

        async def handle(command: Command) -> CommandResult:
            busy = CommandResult(
                command.id,
                ResultStatus.REJECTED,
                "o aviso já está na tela da TV",
                PERMISSION_IN_PROGRESS,
            )
            if self.in_progress:
                return busy
            if not await self._driver.reachable():
                return CommandResult(
                    command.id,
                    ResultStatus.FAILED,
                    "a TV não respondeu; ligue-a e tente de novo",
                    TV_UNREACHABLE_CODE,
                )
            if self.in_progress:  # outro pedido passou pela leitura ao mesmo tempo
                return busy
            # O aceite pode levar até um minuto: o pedido responde agora e o resultado chega
            # depois por `tv.permission.v1`.
            self._running = asyncio.get_running_loop().create_task(self._ask())
            return CommandResult(command.id, ResultStatus.OK)

        return handle

    async def _ask(self) -> None:
        try:
            await self._session.while_closed(self._driver.request_permission)
        except Exception:
            _log.exception("falha ao pedir a permissão à TV")

    async def aclose(self) -> None:
        pending = [task for task in (self._running, *self._tasks) if task is not None]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
