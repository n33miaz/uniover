# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class AgentUpdateStatusV1BodyOutcome(
    RootModel[Literal['not_checked', 'updating', 'updated', 'up_to_date', 'failed', 'blocked', 'rolled_back']]
):
    root: Annotated[
        Literal['not_checked', 'updating', 'updated', 'up_to_date', 'failed', 'blocked', 'rolled_back'],
        Field(title='AgentUpdateStatusV1BodyOutcome'),
    ]


class AgentUpdateStatusV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    outcome: Annotated[
        AgentUpdateStatusV1BodyOutcome, Field(title='AgentUpdateStatusV1BodyOutcome')
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


class AgentUpdateStatusV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['agent.update.status.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: None
    body: Annotated[AgentUpdateStatusV1Body, Field(title='AgentUpdateStatusV1Body')]
