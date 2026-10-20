# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvAppsV2BodyAppsItemIconMime(RootModel[Literal['image/png', 'image/webp']]):
    root: Annotated[
        Literal['image/png', 'image/webp'], Field(title='TvAppsV2BodyAppsItemIconMime')
    ]


class TvAppsV2BodyAppsItemIcon(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    mime: Annotated[
        TvAppsV2BodyAppsItemIconMime, Field(title='TvAppsV2BodyAppsItemIconMime')
    ]
    data: Annotated[
        str,
        Field(
            description='Imagem em base64 padrão com preenchimento. No máximo 32768 bytes (43692 caracteres).',
            max_length=43692,
            min_length=8,
            pattern='^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
        ),
    ]


class TvAppsV2BodyAppsItem(BaseModel):
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
    icon: Annotated[
        TvAppsV2BodyAppsItemIcon | None, Field(title='TvAppsV2BodyAppsItemIcon')
    ] = None


class TvAppsV2Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    apps: Annotated[list[TvAppsV2BodyAppsItem], Field(max_length=500)]
    at: AwareDatetime


class TvAppsV2Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.apps.v2']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvAppsV2Body, Field(title='TvAppsV2Body')]
