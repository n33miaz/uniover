# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class TvCleanupConfigV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    lightEnabled: bool
    deepEnabled: bool
    deepThresholdMb: Annotated[int, Field(ge=64, le=512)]
    closeBackgroundApps: bool | None = None


class TvCleanupConfigV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.cleanup.config.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: None
    body: Annotated[TvCleanupConfigV1Body, Field(title='TvCleanupConfigV1Body')]
