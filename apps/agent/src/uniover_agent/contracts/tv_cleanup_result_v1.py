# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class FailedStep(RootModel[str]):
    root: Annotated[
        str,
        Field(
            max_length=300,
            min_length=1,
            pattern='^[a-z][a-z-]*(:[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+)?$',
        ),
    ]


class TvCleanupResultV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    requestId: UUID
    closedApps: Annotated[int, Field(ge=0, le=500)]
    memoryBeforeMb: Annotated[int | None, Field(ge=0, le=1048576)]
    memoryAfterMb: Annotated[int | None, Field(ge=0, le=1048576)]
    freedMb: Annotated[int | None, Field(ge=0, le=1048576)]
    failedSteps: Annotated[list[FailedStep], Field(max_length=50)]
    at: AwareDatetime


class TvCleanupResultV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.cleanup.result.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID
    body: Annotated[TvCleanupResultV1Body, Field(title='TvCleanupResultV1Body')]
