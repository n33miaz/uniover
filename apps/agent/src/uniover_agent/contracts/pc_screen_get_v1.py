# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import MISSING, BaseModel, ConfigDict, Field, StrictBool, StrictInt


class PcScreenGetV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.get']
    monitor: Annotated[StrictInt | MISSING, Field(ge=0, le=2147483647)] = MISSING
    width: Annotated[StrictInt, Field(ge=128, le=1920)] = 1280
    fps: Annotated[StrictInt, Field(ge=1, le=10)] = 5
    marker: Annotated[StrictInt, Field(ge=0, le=65535)] = 0
    reset: StrictBool = False
