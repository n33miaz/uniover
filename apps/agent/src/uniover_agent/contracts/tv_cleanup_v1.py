# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvCleanupV1BodyMode(RootModel[Literal['light', 'deep', 'manual']]):
    root: Annotated[
        Literal['light', 'deep', 'manual'], Field(title='TvCleanupV1BodyMode')
    ]


class TvCleanupV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    requestId: UUID
    mode: Annotated[TvCleanupV1BodyMode | None, Field(title='TvCleanupV1BodyMode')] = (
        None
    )
    foregroundPackage: Annotated[
        str | None, Field(pattern='^[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+$')
    ] = None


class TvCleanupV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.cleanup.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvCleanupV1Body, Field(title='TvCleanupV1Body')]
