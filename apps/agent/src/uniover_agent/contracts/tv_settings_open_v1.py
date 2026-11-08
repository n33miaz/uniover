# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvSettingsOpenV1BodyScreen(RootModel[Literal['WIFI', 'SETTINGS']]):
    root: Annotated[
        Literal['WIFI', 'SETTINGS'], Field(title='TvSettingsOpenV1BodyScreen')
    ]


class TvSettingsOpenV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    screen: Annotated[
        TvSettingsOpenV1BodyScreen, Field(title='TvSettingsOpenV1BodyScreen')
    ]


class TvSettingsOpenV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.settings.open.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvSettingsOpenV1Body, Field(title='TvSettingsOpenV1Body')]
