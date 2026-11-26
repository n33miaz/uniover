# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcScreenStateV1BodyState(RootModel[Literal['ok', 'locked', 'elevated']]):
    root: Annotated[
        Literal['ok', 'locked', 'elevated'], Field(title='PcScreenStateV1BodyState')
    ]


class PcScreenStateV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    k: Literal['s.state']
    state: Annotated[PcScreenStateV1BodyState, Field(title='PcScreenStateV1BodyState')]


class PcScreenStateV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.screen.state.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcScreenStateV1Body, Field(title='PcScreenStateV1Body')]
