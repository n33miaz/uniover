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
from uniover_agent.ports.tv_adb import (
    AdbCommandFailed,
    AdbError,
    AdbNotReady,
    AdbTimeout,
    AdbUnauthorized,
    AdbUnavailable,
    AdbUnreachable,
    LaunchableApp,
    TvAdb,
    is_adb_typable,
)
from uniover_agent.ports.tv_channel import (
    TvChannel,
    TvChannelError,
    TvNotPaired,
    TvPortClosed,
    TvUnreachable,
)
from uniover_agent.ports.tv_remote import TvRemote


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


__all__ = [
    "AdbCommandFailed",
    "AdbError",
    "AdbNotReady",
    "AdbTimeout",
    "AdbUnauthorized",
    "AdbUnavailable",
    "AdbUnreachable",
    "Clock",
    "ConnectionReplaced",
    "CredentialRejected",
    "LaunchableApp",
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
    "TvAdb",
    "TvChannel",
    "TvChannelError",
    "TvNotPaired",
    "TvPortClosed",
    "TvRemote",
    "TvUnreachable",
    "is_adb_typable",
]
