# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcPowerOutcomeAckV1BodyOutcome(
    RootModel[Literal['refused', 'lost', 'cancelled']]
):
    root: Annotated[
        Literal['refused', 'lost', 'cancelled'],
        Field(title='PcPowerOutcomeAckV1BodyOutcome'),
    ]


class PcPowerOutcomeAckV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    countdownId: UUID
    outcome: Annotated[
        PcPowerOutcomeAckV1BodyOutcome, Field(title='PcPowerOutcomeAckV1BodyOutcome')
    ]


class PcPowerOutcomeAckV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.power.outcome.ack.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcPowerOutcomeAckV1Body, Field(title='PcPowerOutcomeAckV1Body')]
