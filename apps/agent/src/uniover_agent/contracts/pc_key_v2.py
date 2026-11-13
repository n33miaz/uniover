# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcKeyV2BodyKey(
    RootModel[Literal['ENTER', 'BACKSPACE', 'DELETE', 'TAB', 'ESCAPE', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'MINUS', 'EQUALS', 'COMMA', 'PERIOD', 'INSERT', 'PRINT_SCREEN', 'APPS', 'WIN', 'CAPS_LOCK', 'CTRL', 'ALT', 'SHIFT']]
):
    root: Annotated[
        Literal['ENTER', 'BACKSPACE', 'DELETE', 'TAB', 'ESCAPE', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'MINUS', 'EQUALS', 'COMMA', 'PERIOD', 'INSERT', 'PRINT_SCREEN', 'APPS', 'WIN', 'CAPS_LOCK', 'CTRL', 'ALT', 'SHIFT'],
        Field(title='PcKeyV2BodyKey'),
    ]


class PcKeyV2BodyModifiersItem(RootModel[Literal['CTRL', 'ALT', 'SHIFT', 'WIN']]):
    root: Annotated[
        Literal['CTRL', 'ALT', 'SHIFT', 'WIN'], Field(title='PcKeyV2BodyModifiersItem')
    ]


class PcKeyV2BodyAction(RootModel[Literal['PRESS', 'DOWN', 'UP']]):
    root: Annotated[Literal['PRESS', 'DOWN', 'UP'], Field(title='PcKeyV2BodyAction')]


class PcKeyV2BodyTarget(RootModel[Literal['browser', 'spotify', 'vlc']]):
    root: Annotated[
        Literal['browser', 'spotify', 'vlc'], Field(title='PcKeyV2BodyTarget')
    ]


class PcKeyV2Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    key: Annotated[PcKeyV2BodyKey, Field(title='PcKeyV2BodyKey')]
    modifiers: Annotated[list[PcKeyV2BodyModifiersItem] | None, Field(max_length=4)] = (
        None
    )
    repeat: Annotated[int | None, Field(ge=1, le=50)] = None
    action: Annotated[PcKeyV2BodyAction | None, Field(title='PcKeyV2BodyAction')] = None
    seq: Annotated[int | None, Field(ge=0, le=2147483647)] = None
    epoch: Annotated[str | None, Field(pattern='^[0-9a-f]{16}$')] = None
    target: Annotated[PcKeyV2BodyTarget | None, Field(title='PcKeyV2BodyTarget')] = None


class PcKeyV2Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.key.v2']
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
    body: Annotated[PcKeyV2Body, Field(title='PcKeyV2Body')]
