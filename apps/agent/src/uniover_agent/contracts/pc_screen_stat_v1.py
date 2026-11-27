# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, StrictFloat, StrictInt
from pydantic import BeforeValidator


def _screen_integral(value: object) -> object:
    if type(value) is float and value.is_integer():
        return int(value)
    return value


_ScreenInt = Annotated[StrictInt, BeforeValidator(_screen_integral)]


class Cpu(RootModel[StrictFloat]):
    root: Annotated[StrictFloat, Field(ge=0.0)]


class PcScreenStatV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.stat']
    bytes: Annotated[_ScreenInt, Field(ge=0)]
    cpu: Cpu | None
    privateMB: Annotated[StrictFloat, Field(ge=0.0)]
