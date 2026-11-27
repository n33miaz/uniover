# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt
from pydantic import BeforeValidator


def _screen_integral(value: object) -> object:
    if type(value) is float and value.is_integer():
        return int(value)
    return value


_ScreenInt = Annotated[StrictInt, BeforeValidator(_screen_integral)]


class PcScreenSameV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.same']
    crc: Annotated[_ScreenInt, Field(ge=0, le=4294967295)]
