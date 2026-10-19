# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off
"""Liga o campo `type` ao modelo da mensagem."""

from __future__ import annotations

from pydantic import BaseModel

from .envelope import Envelope
from .agent_hello_v1 import AgentHelloV1Message
from .command_result_v1 import CommandResultV1Message
from .tv_app_launch_v1 import TvAppLaunchV1Message
from .tv_apps_refresh_v1 import TvAppsRefreshV1Message
from .tv_apps_v1 import TvAppsV1Message
from .tv_key_v1 import TvKeyV1Message
from .tv_key_v2 import TvKeyV2Message
from .tv_state_v1 import TvStateV1Message
from .tv_text_v1 import TvTextV1Message
from .tv_wake_v1 import TvWakeV1Message
from .tv_watchdog_v1 import TvWatchdogV1Message

ENVELOPE_MODEL: type[BaseModel] = Envelope

MESSAGE_MODELS: dict[str, type[BaseModel]] = {
    "agent.hello.v1": AgentHelloV1Message,
    "command.result.v1": CommandResultV1Message,
    "tv.app.launch.v1": TvAppLaunchV1Message,
    "tv.apps.refresh.v1": TvAppsRefreshV1Message,
    "tv.apps.v1": TvAppsV1Message,
    "tv.key.v1": TvKeyV1Message,
    "tv.key.v2": TvKeyV2Message,
    "tv.state.v1": TvStateV1Message,
    "tv.text.v1": TvTextV1Message,
    "tv.wake.v1": TvWakeV1Message,
    "tv.watchdog.v1": TvWatchdogV1Message,
}
