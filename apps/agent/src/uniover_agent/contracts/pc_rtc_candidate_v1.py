# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcRtcCandidateV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    sessionId: UUID
    candidate: Annotated[str, Field(max_length=512, min_length=1)]
    sdpMid: Annotated[str | None, Field(max_length=32)] = None
    sdpMLineIndex: Annotated[int | None, Field(ge=0, le=8)] = None


class PcRtcCandidateV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.rtc.candidate.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcRtcCandidateV1Body, Field(title='PcRtcCandidateV1Body')]
