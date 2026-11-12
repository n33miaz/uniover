# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class AgentKeepaliveV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    loopLagMs: Annotated[
        int | None,
        Field(
            description='Maior atraso do laço principal do agente desde o batimento anterior, em milissegundos. Opcional: os agentes anteriores não o mandam, e o agente só o manda à API que lista agent.keepalive.loop_lag em features.',
            ge=0,
            le=600000,
        ),
    ] = None


class AgentKeepaliveV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['agent.keepalive.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: None
    body: Annotated[AgentKeepaliveV1Body, Field(title='AgentKeepaliveV1Body')]
