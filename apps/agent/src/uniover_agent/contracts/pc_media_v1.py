# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcMediaV1BodyAction(
    RootModel[Literal['PLAY_PAUSE', 'NEXT', 'PREVIOUS', 'STOP', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE']]
):
    root: Annotated[
        Literal['PLAY_PAUSE', 'NEXT', 'PREVIOUS', 'STOP', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE'],
        Field(title='PcMediaV1BodyAction'),
    ]


class PcMediaV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    action: Annotated[PcMediaV1BodyAction, Field(title='PcMediaV1BodyAction')]
    steps: Annotated[int | None, Field(ge=1, le=10)] = 1


class PcMediaV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.media.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcMediaV1Body, Field(title='PcMediaV1Body')]
