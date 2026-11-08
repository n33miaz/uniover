# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcRtcOfferV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    sessionId: UUID
    sdp: Annotated[str, Field(max_length=16384, min_length=1)]
    token: Annotated[str, Field(pattern='^[A-Za-z0-9_-]{32,86}$')]
    tokenTtlSeconds: Annotated[int, Field(ge=5, le=120)]


class PcRtcOfferV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.rtc.offer.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcRtcOfferV1Body, Field(title='PcRtcOfferV1Body')]
