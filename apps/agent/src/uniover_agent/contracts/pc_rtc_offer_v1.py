# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcRtcOfferV1BodyScopesItem(RootModel[Literal['pc', 'tv']]):
    root: Annotated[Literal['pc', 'tv'], Field(title='PcRtcOfferV1BodyScopesItem')]


class PcRtcOfferV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    sessionId: UUID
    sdp: Annotated[str, Field(max_length=16384, min_length=1)]
    token: Annotated[str, Field(pattern='^[A-Za-z0-9_-]{32,86}$')]
    tokenTtlSeconds: Annotated[int, Field(ge=5, le=120)]
    maxLifetimeSeconds: Annotated[int, Field(ge=30, le=3600)]
    scopes: Annotated[
        list[PcRtcOfferV1BodyScopesItem] | None, Field(max_length=2, min_length=1)
    ] = None
    ticket: Annotated[
        str | None,
        Field(
            description='Bilhete opaco assinado pela API na oferta (HMAC sobre a sessão, quem abriu, a sessão de login, o aparelho, os escopos, a TV e o agente, com a validade do canal). O agente só o guarda e o devolve em pc.rtc.reconcile.v1; nunca o interpreta.',
            max_length=1024,
            pattern='^[A-Za-z0-9_-]{16,900}\\.[A-Za-z0-9_-]{43}$',
        ),
    ] = None


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
    deviceId: Annotated[
        str | None,
        Field(
            description='O aparelho do app que originou o comando do PC (opcional): um código estável da sessão (a família da sessão do app). Vem junto com `deviceName`, o nome para mostrar ao dono na pergunta "Permitir que <nome> controle este PC?". Só vai a um agente que declarou a capacidade `pc.device.v1` (a aprovação de aparelho novo no PC) e vale também para a oferta do canal direto: o canal herda o aparelho da oferta.',
            pattern='^[A-Za-z0-9_-]{8,64}$',
        ),
    ] = None
    deviceName: Annotated[
        str | None,
        Field(
            description='O nome do aparelho para a pergunta de aprovação no PC (ver `deviceId`): até 60 caracteres, sem texto de controle.',
            max_length=60,
            min_length=1,
        ),
    ] = None
    body: Annotated[PcRtcOfferV1Body, Field(title='PcRtcOfferV1Body')]
