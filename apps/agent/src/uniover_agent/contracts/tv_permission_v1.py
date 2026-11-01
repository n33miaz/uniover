# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvPermissionV1BodyState(RootModel[Literal['needed', 'granted']]):
    root: Annotated[
        Literal['needed', 'granted'], Field(title='TvPermissionV1BodyState')
    ]


class TvPermissionV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    state: Annotated[TvPermissionV1BodyState, Field(title='TvPermissionV1BodyState')]
    at: AwareDatetime


class TvPermissionV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.permission.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvPermissionV1Body, Field(title='TvPermissionV1Body')]
