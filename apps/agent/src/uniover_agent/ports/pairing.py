"""Porta do pareamento por código curto (iniciar e consultar)."""

from dataclasses import dataclass
from typing import Protocol


class PairingError(Exception):
    """Falha definitiva do pareamento (pedido recusado, resposta fora do esperado)."""


class PairingUnavailable(PairingError):  # noqa: N818
    """API fora do ar ou acordando: vale tentar de novo."""


class PairingExpired(PairingError):  # noqa: N818
    """O código venceu (ou o token já foi entregue): é preciso pedir outro."""


class PairingDenied(PairingError):  # noqa: N818
    """O dono recusou o pareamento."""


class PairingNotFound(PairingError):  # noqa: N818
    """O servidor não conhece este pareamento."""


class PairingRateLimited(PairingError):  # noqa: N818
    def __init__(self, retry_after: float) -> None:
        super().__init__("limite de requisições do pareamento")
        self.retry_after = retry_after


@dataclass(frozen=True, slots=True)
class PairingInfo:
    """O que o agente informa ao pedir o pareamento (texto de forma limitada pelo servidor)."""

    agent_name: str
    platform: str
    agent_version: str


@dataclass(frozen=True, slots=True, repr=False)
class PairingTicket:
    """Resposta do início. `device_code` é segredo: fica fora de `repr` e de qualquer log."""

    pairing_id: str
    device_code: str
    user_code: str
    expires_in: int
    interval: int

    def __repr__(self) -> str:
        return f"PairingTicket(pairing_id={self.pairing_id!r}, user_code={self.user_code!r})"


@dataclass(frozen=True, slots=True)
class PollPending:
    pass


@dataclass(frozen=True, slots=True)
class PollSlowDown:
    interval: int


@dataclass(frozen=True, slots=True, repr=False)
class PollApproved:
    agent_id: str
    device_token: str

    def __repr__(self) -> str:
        return f"PollApproved(agent_id={self.agent_id!r})"


PollResult = PollPending | PollSlowDown | PollApproved


class PairingClient(Protocol):
    async def start(self, info: PairingInfo) -> PairingTicket: ...

    async def poll(self, ticket: PairingTicket) -> PollResult: ...
