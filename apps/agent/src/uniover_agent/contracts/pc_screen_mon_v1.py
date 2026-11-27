# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import (
    MISSING,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    StrictBool,
    StrictInt,
)
from pydantic import BeforeValidator


def _screen_integral(value: object) -> object:
    if type(value) is float and value.is_integer():
        return int(value)
    return value


_ScreenInt = Annotated[StrictInt, BeforeValidator(_screen_integral)]


class PcScreenMonV1MonitorsItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[_ScreenInt, Field(ge=0, le=2147483647)]
    primary: StrictBool
    width: Annotated[_ScreenInt, Field(ge=1, le=100000)]
    height: Annotated[_ScreenInt, Field(ge=1, le=100000)]
    x: Annotated[_ScreenInt | MISSING, Field(ge=-100000, le=100000)] = MISSING
    y: Annotated[_ScreenInt | MISSING, Field(ge=-100000, le=100000)] = MISSING
    left: Annotated[_ScreenInt | MISSING, Field(ge=-100000, le=100000)] = MISSING
    top: Annotated[_ScreenInt | MISSING, Field(ge=-100000, le=100000)] = MISSING


class Layout(RootModel[_ScreenInt]):
    root: Annotated[_ScreenInt, Field(ge=0, le=4294967295)]


class PcScreenMonV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.mon']
    monitors: Annotated[
        list[PcScreenMonV1MonitorsItem], Field(max_length=16, min_length=1)
    ]
    layout: Layout | None | MISSING = MISSING
