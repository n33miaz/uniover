# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcPowerV1BodyAction(
    RootModel[Literal['LOCK', 'SLEEP', 'SHUTDOWN', 'CANCEL_SHUTDOWN']]
):
    root: Annotated[
        Literal['LOCK', 'SLEEP', 'SHUTDOWN', 'CANCEL_SHUTDOWN'],
        Field(title='PcPowerV1BodyAction'),
    ]


class PcPowerV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    action: Annotated[PcPowerV1BodyAction, Field(title='PcPowerV1BodyAction')]


class PcPowerV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.power.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcPowerV1Body, Field(title='PcPowerV1Body')]
