# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcVolumeV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    level: Annotated[int | None, Field(ge=0, le=100)] = None
    muted: bool | None = None
    seq: Annotated[int | None, Field(ge=0, le=2147483647)] = None
    epoch: Annotated[str | None, Field(pattern='^[0-9a-f]{16}$')] = None


class PcVolumeV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.volume.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcVolumeV1Body, Field(title='PcVolumeV1Body')]
