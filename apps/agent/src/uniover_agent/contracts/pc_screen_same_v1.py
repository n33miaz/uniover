# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt


class PcScreenSameV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.same']
    crc: Annotated[StrictInt, Field(ge=0, le=4294967295)]
