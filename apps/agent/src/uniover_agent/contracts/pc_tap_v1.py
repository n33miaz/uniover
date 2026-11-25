# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcTapV1BodyButton(RootModel[Literal['LEFT', 'RIGHT', 'MIDDLE']]):
    root: Annotated[
        Literal['LEFT', 'RIGHT', 'MIDDLE'], Field(title='PcTapV1BodyButton')
    ]


class PcTapV1BodyAction(RootModel[Literal['CLICK', 'DOUBLE', 'DOWN', 'UP']]):
    root: Annotated[
        Literal['CLICK', 'DOUBLE', 'DOWN', 'UP'], Field(title='PcTapV1BodyAction')
    ]


class PcTapV1BodyModifiersItem(RootModel[Literal['CTRL', 'ALT', 'SHIFT']]):
    root: Annotated[
        Literal['CTRL', 'ALT', 'SHIFT'], Field(title='PcTapV1BodyModifiersItem')
    ]


class PcTapV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    m: Annotated[int, Field(ge=0, le=63)]
    u: Annotated[int, Field(ge=0, le=65535)]
    v: Annotated[int, Field(ge=0, le=65535)]
    w: Annotated[int, Field(ge=1, le=32767)]
    h: Annotated[int, Field(ge=1, le=32767)]
    button: Annotated[PcTapV1BodyButton, Field(title='PcTapV1BodyButton')]
    action: Annotated[PcTapV1BodyAction, Field(title='PcTapV1BodyAction')]
    modifiers: Annotated[list[PcTapV1BodyModifiersItem] | None, Field(max_length=3)] = (
        None
    )


class PcTapV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.tap.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    operationId: Annotated[
        str | None,
        Field(
            description='Identificador da operação (opcional): o mesmo do pedido HTTP que originou o comando do PC (`X-Operation-Id`), para ligar o registro da API ao do agente. Só aparece em comandos `pc.*` que NÃO são o movimento do mouse e só vai a um agente que declarou a capacidade `pc.op.v1` (o esquema de um agente anterior é fechado e recusaria a mensagem inteira). Nunca leva texto, teclas nem coordenadas: é só um código.',
            pattern='^[A-Za-z0-9_-]{8,40}$',
        ),
    ] = None
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
    body: Annotated[PcTapV1Body, Field(title='PcTapV1Body')]
