"""Publica `tv.state.v1` quando o estado da TV muda, sem nunca bloquear quem mudou o estado."""

import asyncio
import logging

from uniover_agent.core.domain import TvState
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.ports import Transport, TransportError

_log = logging.getLogger(__name__)


class TvStatePublisher:
    """Só o estado mais recente interessa: se a TV mudar de novo durante um envio, o intermediário
    é descartado (segurar a tecla de volume empurraria dezenas de mensagens sem valor)."""

    def __init__(self, transport: Transport, envelopes: EnvelopeFactory) -> None:
        self._transport = transport
        self._envelopes = envelopes
        self._pending: TvState | None = None
        self._task: asyncio.Task[None] | None = None

    def publish(self, state: TvState) -> None:
        """Ouvinte do gerenciador (síncrono): agenda o envio do estado mais recente."""
        self._pending = state
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._drain())

    async def announce(self, state: TvState) -> None:
        """Envia já o estado atual (depois do `hello`: a API recém-conectada ainda não o conhece).

        Uma falha de envio sobe para o laço de conexão, que reconecta.
        """
        await self._transport.send(self._envelopes.tv_state(state))

    async def aclose(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _drain(self) -> None:
        while self._pending is not None:
            state, self._pending = self._pending, None
            try:
                await self._transport.send(self._envelopes.tv_state(state))
            except TransportError as exc:
                # Sem canal com a API agora: o estado é reenviado no próximo `hello`.
                _log.debug("estado da TV não enviado (%s)", exc)
