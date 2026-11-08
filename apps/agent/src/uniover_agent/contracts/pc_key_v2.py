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
    body: Annotated[PcKeyV2Body, Field(title='PcKeyV2Body')]
