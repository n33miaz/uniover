from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal


@dataclass(frozen=True, slots=True)
class Command:
    """Comando já validado contra o schema; o núcleo não valida formato."""

    id: str
    type: str
    body: dict[str, Any] = field(default_factory=dict)
    correlation_id: str | None = None
    # `ts` do envelope (ISO 8601, UTC): quando a API montou a mensagem. Quem se importa com a idade
    # dela (o sinal de presença) a confere; os demais ignoram.
    sent_at: str | None = None


class ResultStatus(StrEnum):
    OK = "ok"
    REJECTED = "rejected"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class CommandResult:
    command_id: str
    status: ResultStatus
    detail: str = ""
    # Código estável para a API (`tv_unreachable`, `unsupported`...); vazio = o próprio status.
    code: str = ""


Power = Literal["on", "off", "unknown"]
Connection = Literal["hot", "hibernating", "disconnected", "not_paired"]


@dataclass(frozen=True, slots=True)
class TvState:
    """Corpo de `tv.state.v1`."""

    power: Power
    volume: int | None
    app: str | None
    connection: Connection
