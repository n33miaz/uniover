# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class TvWakeV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.wake.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[dict[str, Any], Field(max_length=0, title='TvWakeV1Body')]
