from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


@dataclass(frozen=True, slots=True)
class Command:
    """Comando já validado contra o schema; o núcleo não valida formato."""

    id: str
    type: str
    body: dict[str, Any] = field(default_factory=dict)
    correlation_id: str | None = None


class ResultStatus(StrEnum):
    OK = "ok"
    REJECTED = "rejected"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class CommandResult:
    command_id: str
    status: ResultStatus
    detail: str = ""
