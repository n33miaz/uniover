# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class AgentMaintenanceV1BodyAction(RootModel[Literal['update', 'restart', 'rollback']]):
    root: Annotated[
        Literal['update', 'restart', 'rollback'],
        Field(title='AgentMaintenanceV1BodyAction'),
    ]


class AgentMaintenanceV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    action: Annotated[
        AgentMaintenanceV1BodyAction, Field(title='AgentMaintenanceV1BodyAction')
    ]


class AgentMaintenanceV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['agent.maintenance.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[AgentMaintenanceV1Body, Field(title='AgentMaintenanceV1Body')]
