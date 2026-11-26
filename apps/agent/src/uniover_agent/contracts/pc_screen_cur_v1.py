# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcScreenCurV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.cur']
    x: Annotated[int, Field(ge=-100000, le=100000)]
    y: Annotated[int, Field(ge=-100000, le=100000)]


class PcScreenCurV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.screen.cur.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcScreenCurV1Body, Field(title='PcScreenCurV1Body')]
