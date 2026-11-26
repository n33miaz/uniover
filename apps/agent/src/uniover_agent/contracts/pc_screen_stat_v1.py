# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, StrictFloat, StrictInt


class Cpu(RootModel[StrictFloat]):
    root: Annotated[StrictFloat, Field(ge=0.0)]


class PcScreenStatV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.stat']
    bytes: Annotated[StrictInt, Field(ge=0)]
    cpu: Cpu | None
    privateMB: Annotated[StrictFloat, Field(ge=0.0)]
