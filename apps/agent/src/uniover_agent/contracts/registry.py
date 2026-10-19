# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off
"""Liga o campo `type` ao modelo da mensagem."""

from __future__ import annotations

from pydantic import BaseModel

from .envelope import Envelope
from .agent_hello_v1 import AgentHelloV1Message
from .command_result_v1 import CommandResultV1Message
from .tv_key_v1 import TvKeyV1Message
from .tv_state_v1 import TvStateV1Message

ENVELOPE_MODEL: type[BaseModel] = Envelope

MESSAGE_MODELS: dict[str, type[BaseModel]] = {
    "agent.hello.v1": AgentHelloV1Message,
    "command.result.v1": CommandResultV1Message,
    "tv.key.v1": TvKeyV1Message,
    "tv.state.v1": TvStateV1Message,
}
