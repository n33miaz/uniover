# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcRtcReconcileV1BodySessionsItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    sessionId: UUID
    ticket: Annotated[
        str,
        Field(
            description='Bilhete opaco assinado pela API na oferta (HMAC sobre a sessão, quem abriu, a sessão de login, o aparelho, os escopos, a TV e o agente, com a validade do canal). O agente só o guarda e o devolve em pc.rtc.reconcile.v1; nunca o interpreta.',
            max_length=1024,
            pattern='^[A-Za-z0-9_-]{16,900}\\.[A-Za-z0-9_-]{43}$',
        ),
    ]


class PcRtcReconcileV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    sessions: Annotated[
        list[PcRtcReconcileV1BodySessionsItem], Field(max_length=1, min_length=1)
    ]


class PcRtcReconcileV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.rtc.reconcile.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcRtcReconcileV1Body, Field(title='PcRtcReconcileV1Body')]
