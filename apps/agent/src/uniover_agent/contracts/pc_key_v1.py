# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcKeyV1BodyKey(
    RootModel[Literal['ENTER', 'BACKSPACE', 'DELETE', 'TAB', 'ESCAPE', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']]
):
    root: Annotated[
        Literal['ENTER', 'BACKSPACE', 'DELETE', 'TAB', 'ESCAPE', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'],
        Field(title='PcKeyV1BodyKey'),
    ]


class PcKeyV1BodyModifiersItem(RootModel[Literal['CTRL', 'ALT', 'SHIFT', 'WIN']]):
    root: Annotated[
        Literal['CTRL', 'ALT', 'SHIFT', 'WIN'], Field(title='PcKeyV1BodyModifiersItem')
    ]


class PcKeyV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    key: Annotated[PcKeyV1BodyKey, Field(title='PcKeyV1BodyKey')]
    modifiers: Annotated[list[PcKeyV1BodyModifiersItem] | None, Field(max_length=4)] = (
        None
    )


class PcKeyV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.key.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcKeyV1Body, Field(title='PcKeyV1Body')]
