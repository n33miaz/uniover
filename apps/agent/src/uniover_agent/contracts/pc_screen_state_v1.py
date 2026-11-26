# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel


class PcScreenStateV1State(RootModel[Literal['ok', 'locked', 'elevated']]):
    root: Annotated[
        Literal['ok', 'locked', 'elevated'], Field(title='PcScreenStateV1State')
    ]


class PcScreenStateV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.state']
    state: Annotated[PcScreenStateV1State, Field(title='PcScreenStateV1State')]
