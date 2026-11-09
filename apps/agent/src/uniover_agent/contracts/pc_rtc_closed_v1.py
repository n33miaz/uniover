# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcRtcClosedV1BodyReason(
    RootModel[Literal['requested', 'connect_timeout', 'idle', 'failed', 'replaced', 'shutdown', 'disconnected', 'lifetime', 'revoked', 'cloud']]
):
    root: Annotated[
        Literal['requested', 'connect_timeout', 'idle', 'failed', 'replaced', 'shutdown', 'disconnected', 'lifetime', 'revoked', 'cloud'],
        Field(title='PcRtcClosedV1BodyReason'),
    ]


class PcRtcClosedV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    sessionId: UUID
    reason: Annotated[PcRtcClosedV1BodyReason, Field(title='PcRtcClosedV1BodyReason')]


class PcRtcClosedV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.rtc.closed.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcRtcClosedV1Body, Field(title='PcRtcClosedV1Body')]
