# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import MISSING, BaseModel, ConfigDict, Field, StrictBool, StrictInt
from pydantic import BeforeValidator


def _screen_integral(value: object) -> object:
    if type(value) is float and value.is_integer():
        return int(value)
    return value


_ScreenInt = Annotated[StrictInt, BeforeValidator(_screen_integral)]


class PcScreenGetV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.get']
    monitor: Annotated[_ScreenInt | MISSING, Field(ge=0, le=2147483647)] = MISSING
    width: Annotated[_ScreenInt, Field(ge=128, le=1920)] = 1280
    fps: Annotated[_ScreenInt, Field(ge=1, le=10)] = 5
    marker: Annotated[_ScreenInt, Field(ge=0, le=65535)] = 0
    reset: StrictBool = False
