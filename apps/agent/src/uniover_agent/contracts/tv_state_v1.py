# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvStateV1BodyPower(RootModel[Literal['on', 'off', 'unknown']]):
    root: Annotated[Literal['on', 'off', 'unknown'], Field(title='TvStateV1BodyPower')]


class TvStateV1BodyConnection(
    RootModel[Literal['hot', 'hibernating', 'disconnected', 'not_paired', 'waking']]
):
    root: Annotated[
        Literal['hot', 'hibernating', 'disconnected', 'not_paired', 'waking'],
        Field(title='TvStateV1BodyConnection'),
    ]


class TvStateV1BodyAdbPermission(RootModel[Literal['granted', 'missing', 'pending']]):
    root: Annotated[
        Literal['granted', 'missing', 'pending'],
        Field(title='TvStateV1BodyAdbPermission'),
    ]


class TvStateV1BodyWakeHintsItem(RootModel[Literal['screenless_off', 'replug']]):
    root: Annotated[
        Literal['screenless_off', 'replug'], Field(title='TvStateV1BodyWakeHintsItem')
    ]


class TvStateV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    power: Annotated[TvStateV1BodyPower, Field(title='TvStateV1BodyPower')]
    volume: Annotated[int | None, Field(ge=0, le=100)]
    app: str | None
    connection: Annotated[
        TvStateV1BodyConnection, Field(title='TvStateV1BodyConnection')
    ]
    adbPermission: Annotated[
        TvStateV1BodyAdbPermission | None, Field(title='TvStateV1BodyAdbPermission')
    ] = None
    adbPermissionReason: Annotated[str | None, Field(pattern='^[a-z_]{1,32}$')] = None
    wakeHints: Annotated[
        list[TvStateV1BodyWakeHintsItem] | None, Field(max_length=2, min_length=1)
    ] = None


class TvStateV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.state.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvStateV1Body, Field(title='TvStateV1Body')]
