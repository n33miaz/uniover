# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class ClosedPackage(RootModel[str]):
    root: Annotated[
        str,
        Field(
            max_length=300,
            min_length=3,
            pattern='^[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+$',
        ),
    ]


class FailedStep(RootModel[str]):
    root: Annotated[
        str,
        Field(
            max_length=300,
            min_length=1,
            pattern='^[a-z][a-z-]*(:[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+)?$',
        ),
    ]


class TvCleanupResultV1BodyKind(RootModel[Literal['light', 'deep', 'manual']]):
    root: Annotated[
        Literal['light', 'deep', 'manual'], Field(title='TvCleanupResultV1BodyKind')
    ]


class TvCleanupResultV1BodyResult(RootModel[Literal['completed', 'skipped']]):
    root: Annotated[
        Literal['completed', 'skipped'], Field(title='TvCleanupResultV1BodyResult')
    ]


class TvCleanupResultV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    requestId: UUID
    closedApps: Annotated[int, Field(ge=0, le=500)]
    closedPackages: Annotated[list[ClosedPackage] | None, Field(max_length=500)] = None
    memoryBeforeMb: Annotated[int | None, Field(ge=0, le=1048576)]
    memoryAfterMb: Annotated[int | None, Field(ge=0, le=1048576)]
    freedMb: Annotated[int | None, Field(ge=0, le=1048576)]
    failedSteps: Annotated[list[FailedStep], Field(max_length=50)]
    at: AwareDatetime
    kind: Annotated[
        TvCleanupResultV1BodyKind | None, Field(title='TvCleanupResultV1BodyKind')
    ] = None
    trigger: Annotated[
        str | None, Field(max_length=40, min_length=1, pattern='^[a-z0-9-]+$')
    ] = None
    result: Annotated[
        TvCleanupResultV1BodyResult | None, Field(title='TvCleanupResultV1BodyResult')
    ] = None
    reason: Annotated[
        str | None, Field(max_length=120, min_length=1, pattern='^[a-z][a-z0-9_-]*$')
    ] = None
    durationMs: Annotated[int | None, Field(ge=0, le=300000)] = None
    backgroundProcesses: Annotated[int | None, Field(ge=0, le=10000)] = None
    sessionOpenMs: Annotated[int | None, Field(ge=0, le=300000)] = None


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
