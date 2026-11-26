# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import MISSING, BaseModel, ConfigDict, Field


class PcScreenGetV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.get']
    monitor: Annotated[int | MISSING, Field(ge=0, le=2147483647)] = MISSING
    width: Annotated[int, Field(ge=128, le=1920)] = 1280
    fps: Annotated[int, Field(ge=1, le=10)] = 5
    marker: Annotated[int, Field(ge=0, le=65535)] = 0
    reset: bool = False
