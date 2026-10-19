"""Pareamento por código curto: pede, mostra o código, consulta até aprovar ou vencer."""

import logging
from collections.abc import Callable
from dataclasses import dataclass

from uniover_agent.ports import (
    Clock,
    PairingClient,
    PairingExpired,
    PairingInfo,
    PairingRateLimited,
    PairingTicket,
    PairingUnavailable,
    PollApproved,
    PollSlowDown,
    SecretStore,
)

_log = logging.getLogger(__name__)

# Com a API dormindo (Render), acordar pode passar de 4 minutos: o início insiste por esse tempo.
_START_PATIENCE_SECONDS = 360.0
_START_RETRY_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class PairedAgent:
    agent_id: str


class PairAgent:
    def __init__(self, client: PairingClient, secrets: SecretStore, clock: Clock) -> None:
        self._client = client
        self._secrets = secrets
        self._clock = clock

    async def __call__(
        self, info: PairingInfo, show_code: Callable[[PairingTicket], None]
    ) -> PairedAgent:
        """Devolve o agente pareado, com o token já no cofre (ou levanta a falha do pareamento)."""
        ticket = await self._start(info)
        show_code(ticket)
        deadline = self._clock.monotonic() + ticket.expires_in
        interval = float(ticket.interval)

        while True:
            await self._clock.sleep(interval)
            if self._clock.monotonic() >= deadline:
                raise PairingExpired("o código venceu antes de ser aprovado")
            try:
                result = await self._client.poll(ticket)
            except PairingRateLimited as exc:
                interval = max(interval, exc.retry_after)
                continue
            except PairingUnavailable:
                # API acordando ou rede instável: o código ainda vale, segue consultando.
                _log.info("API indisponível por ora; tentando de novo")
                continue
            if isinstance(result, PollApproved):
                # O token só é entregue uma vez: grava no cofre antes de qualquer outra coisa.
                self._secrets.set(result.agent_id, result.device_token)
                return PairedAgent(result.agent_id)
            if isinstance(result, PollSlowDown):
                interval = max(interval, float(result.interval))

    async def _start(self, info: PairingInfo) -> PairingTicket:
        waited = 0.0
        while True:
            try:
                return await self._client.start(info)
            except PairingUnavailable:
                if waited >= _START_PATIENCE_SECONDS:
                    raise
                _log.info("API indisponível (pode estar acordando); nova tentativa")
                await self._clock.sleep(_START_RETRY_SECONDS)
                waited += _START_RETRY_SECONDS
            except PairingRateLimited as exc:
                await self._clock.sleep(exc.retry_after)
                waited += exc.retry_after
                if waited >= _START_PATIENCE_SECONDS:
                    raise
