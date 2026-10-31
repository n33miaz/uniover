# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class AgentHelloV1BodyCapabilitiesItem(
    RootModel[Literal['transport.keepalive.v1', 'agent.logs.v1', 'agent.maintenance.v1', 'tv.cleanup.automatic.v1', 'tv.light-settings.v1', 'tv.focus-closes-background.v1', 'tv.remote', 'tv.adb', 'tv.kind.android', 'tv.kind.samsung', 'tv.key.v3', 'tv.power.off.v1', 'tv.key.INPUT', 'tv.key.INFO', 'tv.key.GUIDE', 'tv.key.TOOLS', 'tv.key.CHANNEL_LIST', 'tv.key.PREVIOUS_CHANNEL', 'tv.key.EXIT', 'tv.key.PLAY', 'tv.key.PAUSE', 'tv.key.STOP', 'tv.key.REWIND', 'tv.key.FAST_FORWARD', 'tv.key.RED', 'tv.key.GREEN', 'tv.key.YELLOW', 'tv.key.BLUE', 'tv.key.SUBTITLE', 'tv.key.ASPECT', 'tv.key.SLEEP', 'tv.key.E_MANUAL']]
):
    root: Annotated[
        Literal['transport.keepalive.v1', 'agent.logs.v1', 'agent.maintenance.v1', 'tv.cleanup.automatic.v1', 'tv.light-settings.v1', 'tv.focus-closes-background.v1', 'tv.remote', 'tv.adb', 'tv.kind.android', 'tv.kind.samsung', 'tv.key.v3', 'tv.power.off.v1', 'tv.key.INPUT', 'tv.key.INFO', 'tv.key.GUIDE', 'tv.key.TOOLS', 'tv.key.CHANNEL_LIST', 'tv.key.PREVIOUS_CHANNEL', 'tv.key.EXIT', 'tv.key.PLAY', 'tv.key.PAUSE', 'tv.key.STOP', 'tv.key.REWIND', 'tv.key.FAST_FORWARD', 'tv.key.RED', 'tv.key.GREEN', 'tv.key.YELLOW', 'tv.key.BLUE', 'tv.key.SUBTITLE', 'tv.key.ASPECT', 'tv.key.SLEEP', 'tv.key.E_MANUAL'],
        Field(title='AgentHelloV1BodyCapabilitiesItem'),
    ]


class AgentHelloV1BodyTvKind(RootModel[Literal['android', 'samsung']]):
    root: Annotated[
        Literal['android', 'samsung'], Field(title='AgentHelloV1BodyTvKind')
    ]


class AgentHelloV1BodyTv(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    kind: Annotated[AgentHelloV1BodyTvKind, Field(title='AgentHelloV1BodyTvKind')]
    host: Annotated[str, Field(max_length=64, min_length=1)]


class AgentHelloV1BodyUpdateOutcome(
    RootModel[Literal['not_checked', 'updating', 'updated', 'up_to_date', 'failed', 'blocked', 'rolled_back']]
):
    root: Annotated[
        Literal['not_checked', 'updating', 'updated', 'up_to_date', 'failed', 'blocked', 'rolled_back'],
        Field(title='AgentHelloV1BodyUpdateOutcome'),
    ]


class AgentHelloV1BodyUpdate(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    outcome: Annotated[
        AgentHelloV1BodyUpdateOutcome, Field(title='AgentHelloV1BodyUpdateOutcome')
    ]
    installedSha: Annotated[str | None, Field(pattern='^[0-9a-f]{40}$')] = None
    installedAt: AwareDatetime | None = None
    latestSha: Annotated[str | None, Field(pattern='^[0-9a-f]{40}$')] = None
    checkedAt: AwareDatetime | None = None
    nextCheckAt: AwareDatetime | None = None
    reason: Annotated[str | None, Field(max_length=200, min_length=1)] = None
    blockedSha: Annotated[str | None, Field(pattern='^[0-9a-f]{40}$')] = None
    previousSha: Annotated[str | None, Field(pattern='^[0-9a-f]{40}$')] = None
    rolledBack: bool | None = None


class AgentHelloV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    agentVersion: Annotated[str, Field(min_length=1)]
    capabilities: list[AgentHelloV1BodyCapabilitiesItem]
    os: Annotated[str | None, Field(max_length=80, min_length=1)] = None
    tv: Annotated[AgentHelloV1BodyTv | None, Field(title='AgentHelloV1BodyTv')] = None
    update: Annotated[
        AgentHelloV1BodyUpdate | None, Field(title='AgentHelloV1BodyUpdate')
    ] = None


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
