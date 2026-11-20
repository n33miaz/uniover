# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcMediaStateV1BodyStatus(
    RootModel[Literal['playing', 'paused', 'stopped', 'none']]
):
    root: Annotated[
        Literal['playing', 'paused', 'stopped', 'none'],
        Field(title='PcMediaStateV1BodyStatus'),
    ]


class PcMediaStateV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    status: Annotated[PcMediaStateV1BodyStatus, Field(title='PcMediaStateV1BodyStatus')]
    title: Annotated[str, Field(max_length=200)]
    artist: Annotated[str, Field(max_length=200)]
    app: Annotated[str, Field(max_length=200)]
    at: AwareDatetime


class PcMediaStateV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.media.state.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcMediaStateV1Body, Field(title='PcMediaStateV1Body')]
