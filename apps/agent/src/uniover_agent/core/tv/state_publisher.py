"""Publica `tv.state.v1` quando o estado da TV muda, sem nunca bloquear quem mudou o estado."""

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from uniover_agent.core.domain import Connection, TvState, WireConnection
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.ports import Transport, TransportError

_log = logging.getLogger(__name__)


class TvStatePublisher:
    """Só o estado mais recente interessa: se a TV mudar de novo durante um envio, o intermediário
    é descartado (segurar a tecla de volume empurraria dezenas de mensagens sem valor)."""

    def __init__(  # noqa: PLR0913 - cada gancho é uma decisão independente por API
        self,
        transport: Transport,
        envelopes: EnvelopeFactory,
        *,
        reports_not_paired: Callable[[], bool] = lambda: True,
        reports_waking: Callable[[], bool] = lambda: True,
        reports_adb_permission: Callable[[], bool] = lambda: False,
        adb_permission: Callable[[], str | None] = lambda: None,
        adb_permission_reason: Callable[[], str | None] = lambda: None,
    ) -> None:
        self._transport = transport
        self._envelopes = envelopes
        # Uma API anterior recusa `not_paired` (o contrato é fechado) e ficaria com o último estado:
        # até ela dizer que o aceita, o agente conta `disconnected`, como antes.
        self._reports_not_paired = reports_not_paired
        # Idem para `waking` (TV ligando): até a API aceitá-lo, o estado sai como antes de existir.
        self._reports_waking = reports_waking
        # A permissão do ADB (`granted`, `missing`, `pending`) vai dentro do estado, e só para a API
        # que aceita o campo (uma anterior recusaria o estado inteiro): até lá o estado sai sem ela.
        self._reports_adb_permission = reports_adb_permission
        self._adb_permission = adb_permission
        self._adb_permission_reason = adb_permission_reason
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
        await self._transport.send(self._message(state))

    def _message(self, state: TvState) -> dict[str, Any]:
        permission = self._adb_permission() if self._reports_adb_permission() else None
        # O motivo só interessa ao app quando a permissão falta (é ele que decide se abre a folha).
        reason = self._adb_permission_reason() if permission == "missing" else None
        return self._envelopes.tv_state(state, self._wire(state), permission, reason)

    def _wire(self, state: TvState) -> WireConnection:
        if state.waking and self._reports_waking():
            # `waking` não é um valor da sessão: só vai ao fio, e só para a API que o conhece.
            return "waking"
        connection: Connection = state.connection
        if connection == "not_paired" and not self._reports_not_paired():
            return "disconnected"
        return connection

    async def aclose(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _drain(self) -> None:
        while self._pending is not None:
            state, self._pending = self._pending, None
            try:
                await self._transport.send(self._message(state))
            except TransportError as exc:
                # Sem canal com a API agora: o estado é reenviado no próximo `hello`.
                _log.debug("estado da TV não enviado (%s)", exc)
