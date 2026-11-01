# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class TvLivrePhotoV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    photoId: UUID
    index: Annotated[int, Field(ge=0, le=15)]
    total: Annotated[int, Field(ge=1, le=16)]
    sha256: Annotated[
        str,
        Field(
            description='sha256 da foto inteira (o mesmo em todos os pedaços).',
            pattern='^[0-9a-f]{64}$',
        ),
    ]
    data: Annotated[
        str,
        Field(
            description='base64 do pedaço (até 30 KB de bytes).',
            max_length=40960,
            min_length=4,
            pattern='^[A-Za-z0-9+/]+={0,2}$',
        ),
    ]


class TvLivrePhotoV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.livre.photo.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvLivrePhotoV1Body, Field(title='TvLivrePhotoV1Body')]
