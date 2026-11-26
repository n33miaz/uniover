# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class PcScreenCurV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.cur']
    x: Annotated[int, Field(ge=-100000, le=100000)]
    y: Annotated[int, Field(ge=-100000, le=100000)]
