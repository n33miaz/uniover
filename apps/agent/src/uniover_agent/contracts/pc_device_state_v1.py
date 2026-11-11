# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcDeviceStateV1BodyState(RootModel[Literal['pending', 'denied', 'approved']]):
    root: Annotated[
        Literal['pending', 'denied', 'approved'],
        Field(title='PcDeviceStateV1BodyState'),
    ]


class PcDeviceStateV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    deviceId: Annotated[
        str,
        Field(
            description='O aparelho do app que originou o comando do PC (opcional): um código estável da sessão (a família da sessão do app). Vem junto com `deviceName`, o nome para mostrar ao dono na pergunta "Permitir que <nome> controle este PC?". Só vai a um agente que declarou a capacidade `pc.device.v1` (a aprovação de aparelho novo no PC) e vale também para a oferta do canal direto: o canal herda o aparelho da oferta.',
            pattern='^[A-Za-z0-9_-]{8,64}$',
        ),
    ]
    state: Annotated[PcDeviceStateV1BodyState, Field(title='PcDeviceStateV1BodyState')]
    at: AwareDatetime


class PcDeviceStateV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.device.state.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcDeviceStateV1Body, Field(title='PcDeviceStateV1Body')]
