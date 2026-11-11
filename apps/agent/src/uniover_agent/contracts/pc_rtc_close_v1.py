# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcRtcCloseV1BodyReason(
    RootModel[Literal['requested', 'connect_timeout', 'idle', 'failed', 'replaced', 'shutdown', 'disconnected', 'lifetime', 'revoked', 'cloud', 'rescoped']]
):
    root: Annotated[
        Literal['requested', 'connect_timeout', 'idle', 'failed', 'replaced', 'shutdown', 'disconnected', 'lifetime', 'revoked', 'cloud', 'rescoped'],
        Field(title='PcRtcCloseV1BodyReason'),
    ]


class PcRtcCloseV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    sessionId: UUID
    reason: Annotated[
        PcRtcCloseV1BodyReason | None, Field(title='PcRtcCloseV1BodyReason')
    ] = None


class PcRtcCloseV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.rtc.close.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcRtcCloseV1Body, Field(title='PcRtcCloseV1Body')]
