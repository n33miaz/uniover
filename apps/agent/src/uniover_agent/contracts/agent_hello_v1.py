# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class AgentHelloV1BodyCapabilitiesItem(
    RootModel[Literal['transport.keepalive.v1', 'tv.remote', 'tv.adb', 'tv.kind.android', 'tv.kind.samsung']]
):
    root: Annotated[
        Literal['transport.keepalive.v1', 'tv.remote', 'tv.adb', 'tv.kind.android', 'tv.kind.samsung'],
        Field(title='AgentHelloV1BodyCapabilitiesItem'),
    ]


class AgentHelloV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    agentVersion: Annotated[str, Field(min_length=1)]
    capabilities: list[AgentHelloV1BodyCapabilitiesItem]


class AgentHelloV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['agent.hello.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[AgentHelloV1Body, Field(title='AgentHelloV1Body')]
