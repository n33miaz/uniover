# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcScreenMonV1BodyMonitorsItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[int, Field(ge=0, le=2147483647)]
    primary: bool
    width: Annotated[int, Field(ge=1, le=100000)]
    height: Annotated[int, Field(ge=1, le=100000)]
    x: Annotated[int | None, Field(ge=-100000, le=100000)] = None
    y: Annotated[int | None, Field(ge=-100000, le=100000)] = None
    left: Annotated[int | None, Field(ge=-100000, le=100000)] = None
    top: Annotated[int | None, Field(ge=-100000, le=100000)] = None


class Layout(RootModel[int]):
    root: Annotated[int, Field(ge=0, le=4294967295)]


class PcScreenMonV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.mon']
    monitors: Annotated[
        list[PcScreenMonV1BodyMonitorsItem], Field(max_length=16, min_length=1)
    ]
    layout: Layout | None = None


class PcScreenMonV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.screen.mon.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcScreenMonV1Body, Field(title='PcScreenMonV1Body')]
