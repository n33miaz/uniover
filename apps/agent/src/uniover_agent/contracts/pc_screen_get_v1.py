# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcScreenGetV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.get']
    monitor: Annotated[int | None, Field(ge=0, le=2147483647)] = None
    width: Annotated[int | None, Field(ge=128, le=1920)] = 1280
    fps: Annotated[int | None, Field(ge=1, le=10)] = 5
    marker: Annotated[int | None, Field(ge=0, le=65535)] = 0
    reset: bool | None = False


class PcScreenGetV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.screen.get.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcScreenGetV1Body, Field(title='PcScreenGetV1Body')]
