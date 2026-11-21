# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class PcPowerOutcomeV1BodyAction(RootModel[Literal['SHUTDOWN', 'RESTART']]):
    root: Annotated[
        Literal['SHUTDOWN', 'RESTART'], Field(title='PcPowerOutcomeV1BodyAction')
    ]


class PcPowerOutcomeV1BodyOutcome(RootModel[Literal['refused', 'lost']]):
    root: Annotated[
        Literal['refused', 'lost'], Field(title='PcPowerOutcomeV1BodyOutcome')
    ]


class PcPowerOutcomeV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    action: Annotated[
        PcPowerOutcomeV1BodyAction, Field(title='PcPowerOutcomeV1BodyAction')
    ]
    outcome: Annotated[
        PcPowerOutcomeV1BodyOutcome, Field(title='PcPowerOutcomeV1BodyOutcome')
    ]
    code: int | None = None
    at: AwareDatetime


class PcPowerOutcomeV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['pc.power.outcome.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[PcPowerOutcomeV1Body, Field(title='PcPowerOutcomeV1Body')]
