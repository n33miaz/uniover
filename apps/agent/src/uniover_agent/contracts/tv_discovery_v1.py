# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvDiscoveryV1BodyTvsItemKind(RootModel[Literal['android', 'samsung']]):
    root: Annotated[
        Literal['android', 'samsung'], Field(title='TvDiscoveryV1BodyTvsItemKind')
    ]


class TvDiscoveryV1BodyTvsItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[str, Field(pattern='^[A-Za-z0-9_-]{8,64}$')]
    kind: Annotated[
        TvDiscoveryV1BodyTvsItemKind, Field(title='TvDiscoveryV1BodyTvsItemKind')
    ]
    name: Annotated[str | None, Field(max_length=60)]
    controlled: bool


class TvDiscoveryV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    requestId: UUID
    tvs: Annotated[list[TvDiscoveryV1BodyTvsItem], Field(max_length=50)]
    at: AwareDatetime


class TvDiscoveryV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.discovery.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID
    body: Annotated[TvDiscoveryV1Body, Field(title='TvDiscoveryV1Body')]
