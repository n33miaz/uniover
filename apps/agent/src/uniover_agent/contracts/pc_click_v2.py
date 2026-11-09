# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcClickV2BodyButton(RootModel[Literal['LEFT', 'RIGHT', 'MIDDLE']]):
    root: Annotated[
        Literal['LEFT', 'RIGHT', 'MIDDLE'], Field(title='PcClickV2BodyButton')
    ]


class PcClickV2BodyAction(RootModel[Literal['CLICK', 'DOUBLE']]):
    root: Annotated[Literal['CLICK', 'DOUBLE'], Field(title='PcClickV2BodyAction')] = (
        'CLICK'
    )


class PcClickV2BodyModifiersItem(RootModel[Literal['CTRL', 'ALT', 'SHIFT']]):
    root: Annotated[
        Literal['CTRL', 'ALT', 'SHIFT'], Field(title='PcClickV2BodyModifiersItem')
    ]


class PcClickV2Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    button: Annotated[PcClickV2BodyButton, Field(title='PcClickV2BodyButton')]
    action: Annotated[
        PcClickV2BodyAction | None,
        Field(title='PcClickV2BodyAction', validate_default=True),
    ] = 'CLICK'
    modifiers: Annotated[
        list[PcClickV2BodyModifiersItem] | None, Field(max_length=3)
    ] = None
    gapMs: Annotated[int | None, Field(ge=0, le=400)] = None
    seq: Annotated[int | None, Field(ge=0, le=2147483647)] = None
    epoch: Annotated[str | None, Field(pattern='^[0-9a-f]{16}$')] = None


class PcClickV2Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.click.v2']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcClickV2Body, Field(title='PcClickV2Body')]
