# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcPointerZoomV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    steps: Annotated[int, Field(ge=-12, le=12)]
    seq: Annotated[int | None, Field(ge=0, le=2147483647)] = None
    epoch: Annotated[str | None, Field(pattern='^[0-9a-f]{16}$')] = None


class PcPointerZoomV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.pointer.zoom.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcPointerZoomV1Body, Field(title='PcPointerZoomV1Body')]
