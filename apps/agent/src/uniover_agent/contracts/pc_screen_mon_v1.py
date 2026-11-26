# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import MISSING, BaseModel, ConfigDict, Field, RootModel


class PcScreenMonV1MonitorsItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[int, Field(ge=0, le=2147483647)]
    primary: bool
    width: Annotated[int, Field(ge=1, le=100000)]
    height: Annotated[int, Field(ge=1, le=100000)]
    x: Annotated[int | MISSING, Field(ge=-100000, le=100000)] = MISSING
    y: Annotated[int | MISSING, Field(ge=-100000, le=100000)] = MISSING
    left: Annotated[int | MISSING, Field(ge=-100000, le=100000)] = MISSING
    top: Annotated[int | MISSING, Field(ge=-100000, le=100000)] = MISSING


class Layout(RootModel[int]):
    root: Annotated[int, Field(ge=0, le=4294967295)]


class PcScreenMonV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.mon']
    monitors: Annotated[
        list[PcScreenMonV1MonitorsItem], Field(max_length=16, min_length=1)
    ]
    layout: Layout | None | MISSING = MISSING
