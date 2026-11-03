# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcAppsV1BodyAppsItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[
        str, Field(max_length=40, min_length=1, pattern='^[a-z0-9][a-z0-9-]*$')
    ]
    label: Annotated[str, Field(max_length=60, min_length=1)]


class PcAppsV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    apps: Annotated[list[PcAppsV1BodyAppsItem], Field(max_length=24)]
    at: AwareDatetime


class PcAppsV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.apps.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcAppsV1Body, Field(title='PcAppsV1Body')]
