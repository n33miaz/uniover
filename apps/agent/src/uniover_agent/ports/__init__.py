"""Portas (Protocol) que o núcleo usa; adaptadores as implementam."""

from datetime import datetime
from typing import Protocol

from uniover_agent.ports.pairing import (
    PairingClient,
    PairingDenied,
    PairingError,
    PairingExpired,
    PairingInfo,
    PairingNotFound,
    PairingRateLimited,
    PairingTicket,
    PairingUnavailable,
    PollApproved,
    PollPending,
    PollResult,
    PollSlowDown,
)
from uniover_agent.ports.transport import (
    ConnectionReplaced,
    CredentialRejected,
    Transport,
    TransportError,
)


class Clock(Protocol):
    def now(self) -> datetime: ...

    def monotonic(self) -> float:
        """Relógio monotônico em segundos, para medir estabilidade da conexão."""
        ...

    async def sleep(self, seconds: float) -> None: ...


class SecretStore(Protocol):
    """Guarda segredos por nome (aqui, o token de dispositivo por `agentId`)."""

    def get(self, name: str) -> str | None: ...

    def set(self, name: str, value: str) -> None: ...

    def delete(self, name: str) -> None: ...


class TvRemote(Protocol):
    async def send_key(self, key: str) -> None: ...


__all__ = [
    "Clock",
    "ConnectionReplaced",
    "CredentialRejected",
    "PairingClient",
    "PairingDenied",
    "PairingError",
    "PairingExpired",
    "PairingInfo",
    "PairingNotFound",
    "PairingRateLimited",
    "PairingTicket",
    "PairingUnavailable",
    "PollApproved",
    "PollPending",
    "PollResult",
    "PollSlowDown",
    "SecretStore",
    "Transport",
    "TransportError",
    "TvRemote",
]
