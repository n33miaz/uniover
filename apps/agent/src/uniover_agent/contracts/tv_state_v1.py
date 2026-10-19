# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvStateV1BodyPower(RootModel[Literal['on', 'off', 'unknown']]):
    root: Annotated[Literal['on', 'off', 'unknown'], Field(title='TvStateV1BodyPower')]


class TvStateV1BodyConnection(RootModel[Literal['hot', 'hibernating', 'disconnected']]):
    root: Annotated[
        Literal['hot', 'hibernating', 'disconnected'],
        Field(title='TvStateV1BodyConnection'),
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
