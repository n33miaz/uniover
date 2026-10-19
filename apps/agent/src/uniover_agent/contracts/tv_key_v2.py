# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvKeyV2BodyKey(
    RootModel[Literal['POWER', 'HOME', 'BACK', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'OK', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE', 'CHANNEL_UP', 'CHANNEL_DOWN', 'PLAY_PAUSE', 'MENU', 'NUM_0', 'NUM_1', 'NUM_2', 'NUM_3', 'NUM_4', 'NUM_5', 'NUM_6', 'NUM_7', 'NUM_8', 'NUM_9', 'MEDIA_NEXT', 'MEDIA_PREVIOUS', 'INPUT']]
):
    root: Annotated[
        Literal['POWER', 'HOME', 'BACK', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'OK', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE', 'CHANNEL_UP', 'CHANNEL_DOWN', 'PLAY_PAUSE', 'MENU', 'NUM_0', 'NUM_1', 'NUM_2', 'NUM_3', 'NUM_4', 'NUM_5', 'NUM_6', 'NUM_7', 'NUM_8', 'NUM_9', 'MEDIA_NEXT', 'MEDIA_PREVIOUS', 'INPUT'],
        Field(title='TvKeyV2BodyKey'),
    ]


class TvKeyV2BodyDirection(RootModel[Literal['SHORT', 'START_LONG', 'END_LONG']]):
    root: Annotated[
        Literal['SHORT', 'START_LONG', 'END_LONG'], Field(title='TvKeyV2BodyDirection')
    ] = 'SHORT'


class TvKeyV2Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    key: Annotated[TvKeyV2BodyKey, Field(title='TvKeyV2BodyKey')]
    direction: Annotated[
        TvKeyV2BodyDirection | None,
        Field(title='TvKeyV2BodyDirection', validate_default=True),
    ] = 'SHORT'


class TvKeyV2Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.key.v2']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvKeyV2Body, Field(title='TvKeyV2Body')]
