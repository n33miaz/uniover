# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvWatchdogV1BodyKind(
    RootModel[Literal['port_closed', 'repair_started', 'repaired', 'repair_failed', 'adb_unreachable', 'recovered']]
):
    root: Annotated[
        Literal['port_closed', 'repair_started', 'repaired', 'repair_failed', 'adb_unreachable', 'recovered'],
        Field(title='TvWatchdogV1BodyKind'),
    ]


class TvWatchdogV1BodySeverity(RootModel[Literal['info', 'warn', 'error']]):
    root: Annotated[
        Literal['info', 'warn', 'error'], Field(title='TvWatchdogV1BodySeverity')
    ]


class TvWatchdogV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    kind: Annotated[TvWatchdogV1BodyKind, Field(title='TvWatchdogV1BodyKind')]
    severity: Annotated[
        TvWatchdogV1BodySeverity, Field(title='TvWatchdogV1BodySeverity')
    ]
    detail: Annotated[str, Field(max_length=200)]
    attempts: Annotated[int, Field(ge=0, le=1000)]
    at: AwareDatetime


class TvWatchdogV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.watchdog.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvWatchdogV1Body, Field(title='TvWatchdogV1Body')]
