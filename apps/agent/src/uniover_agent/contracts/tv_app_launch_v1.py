# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvAppLaunchV1BodyTargetKind(RootModel[Literal['package', 'link']]):
    root: Annotated[
        Literal['package', 'link'], Field(title='TvAppLaunchV1BodyTargetKind')
    ]


class TvAppLaunchV1BodyTarget(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    kind: Annotated[
        TvAppLaunchV1BodyTargetKind, Field(title='TvAppLaunchV1BodyTargetKind')
    ]
    value: Annotated[
        str, Field(max_length=2048, min_length=1, pattern='^[^\x00- \x7f-\x9f]+$')
    ]


class TvAppLaunchV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    target: Annotated[TvAppLaunchV1BodyTarget, Field(title='TvAppLaunchV1BodyTarget')]


class TvAppLaunchV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.app.launch.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvAppLaunchV1Body, Field(title='TvAppLaunchV1Body')]
