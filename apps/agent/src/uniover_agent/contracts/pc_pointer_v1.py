# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class PcPointerV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    dx: Annotated[int, Field(ge=-2000, le=2000)]
    dy: Annotated[int, Field(ge=-2000, le=2000)]
    scrollX: Annotated[int | None, Field(ge=-1200, le=1200)] = None
    scrollY: Annotated[int | None, Field(ge=-1200, le=1200)] = None
    seq: Annotated[int | None, Field(ge=0, le=2147483647)] = None


class PcPointerV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.pointer.v1']
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
    body: Annotated[PcPointerV1Body, Field(title='PcPointerV1Body')]
