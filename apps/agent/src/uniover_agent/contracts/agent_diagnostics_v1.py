# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class AgentDiagnosticsV1BodyEventsItemSeverity(
    RootModel[Literal['info', 'warn', 'error']]
):
    root: Annotated[
        Literal['info', 'warn', 'error'],
        Field(title='AgentDiagnosticsV1BodyEventsItemSeverity'),
    ]


class AgentDiagnosticsV1BodyEventsItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: UUID
    at: AwareDatetime
    kind: Annotated[str, Field(pattern='^[a-z0-9][a-z0-9_.]{1,47}$')]
    severity: Annotated[
        AgentDiagnosticsV1BodyEventsItemSeverity,
        Field(title='AgentDiagnosticsV1BodyEventsItemSeverity'),
    ]
    component: Annotated[str | None, Field(pattern='^[a-z0-9][a-z0-9_.]{0,31}$')] = None
    detail: Annotated[str, Field(max_length=300, min_length=1)]
    count: Annotated[int | None, Field(ge=1, le=10000)] = None


class AgentDiagnosticsV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    events: Annotated[
        list[AgentDiagnosticsV1BodyEventsItem], Field(max_length=20, min_length=1)
    ]


class AgentDiagnosticsV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['agent.diagnostics.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: None
    body: Annotated[AgentDiagnosticsV1Body, Field(title='AgentDiagnosticsV1Body')]
