# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcTextV2BodyKey(RootModel[Literal['ENTER', 'TAB']]):
    root: Annotated[Literal['ENTER', 'TAB'], Field(title='PcTextV2BodyKey')]


class PcTextV2Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    erase: Annotated[int | None, Field(ge=1, le=200)] = None
    text: Annotated[
        str | None,
        Field(max_length=200, min_length=1, pattern='^[^\x00-\x1f\x7f-\x9f]+$'),
    ] = None
    key: Annotated[PcTextV2BodyKey | None, Field(title='PcTextV2BodyKey')] = None
    seq: Annotated[int | None, Field(ge=0, le=2147483647)] = None
    epoch: Annotated[str | None, Field(pattern='^[0-9a-f]{16}$')] = None


class PcTextV2Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.text.v2']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcTextV2Body, Field(title='PcTextV2Body')]
