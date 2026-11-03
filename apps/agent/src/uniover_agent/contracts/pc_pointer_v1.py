# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcPointerV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    dx: Annotated[int, Field(ge=-2000, le=2000)]
    dy: Annotated[int, Field(ge=-2000, le=2000)]
    scrollX: Annotated[int | None, Field(ge=-1200, le=1200)] = None
    scrollY: Annotated[int | None, Field(ge=-1200, le=1200)] = None


class PcPointerV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.pointer.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcPointerV1Body, Field(title='PcPointerV1Body')]
