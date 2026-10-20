# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class TvTextV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    text: Annotated[
        str, Field(max_length=200, min_length=0, pattern='^[^\x00-\x1f\x7f-\x9f]*$')
    ]


class TvTextV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.text.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvTextV1Body, Field(title='TvTextV1Body')]
