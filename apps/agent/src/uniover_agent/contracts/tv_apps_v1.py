# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class TvAppsV1BodyAppsItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    package: Annotated[
        str,
        Field(
            max_length=255,
            min_length=1,
            pattern='^[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+$',
        ),
    ]
    label: Annotated[str | None, Field(max_length=100, min_length=1)]


class TvAppsV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    apps: Annotated[list[TvAppsV1BodyAppsItem], Field(max_length=500)]
    at: AwareDatetime


class TvAppsV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.apps.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvAppsV1Body, Field(title='TvAppsV1Body')]
