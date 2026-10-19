# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvKeyV1BodyKey(
    RootModel[Literal['POWER', 'HOME', 'BACK', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'OK', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE', 'CHANNEL_UP', 'CHANNEL_DOWN', 'PLAY_PAUSE']]
):
    root: Annotated[
        Literal['POWER', 'HOME', 'BACK', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'OK', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE', 'CHANNEL_UP', 'CHANNEL_DOWN', 'PLAY_PAUSE'],
        Field(title='TvKeyV1BodyKey'),
    ]


class TvKeyV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    key: Annotated[TvKeyV1BodyKey, Field(title='TvKeyV1BodyKey')]


class TvKeyV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.key.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvKeyV1Body, Field(title='TvKeyV1Body')]
