# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class CommandResultV1BodyError(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    code: Annotated[str, Field(min_length=1)]
    message: Annotated[str, Field(min_length=1)]


class CommandResultV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    ok: bool
    error: Annotated[
        CommandResultV1BodyError | None, Field(title='CommandResultV1BodyError')
    ] = None


class CommandResultV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['command.result.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID
    body: Annotated[CommandResultV1Body, Field(title='CommandResultV1Body')]
