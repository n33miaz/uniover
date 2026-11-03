# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcClickV1BodyButton(RootModel[Literal['LEFT', 'RIGHT', 'MIDDLE']]):
    root: Annotated[
        Literal['LEFT', 'RIGHT', 'MIDDLE'], Field(title='PcClickV1BodyButton')
    ]


class PcClickV1BodyAction(RootModel[Literal['CLICK', 'DOUBLE', 'DOWN', 'UP']]):
    root: Annotated[
        Literal['CLICK', 'DOUBLE', 'DOWN', 'UP'], Field(title='PcClickV1BodyAction')
    ] = 'CLICK'


class PcClickV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    button: Annotated[PcClickV1BodyButton, Field(title='PcClickV1BodyButton')]
    action: Annotated[
        PcClickV1BodyAction | None,
        Field(title='PcClickV1BodyAction', validate_default=True),
    ] = 'CLICK'


class PcClickV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.click.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcClickV1Body, Field(title='PcClickV1Body')]
