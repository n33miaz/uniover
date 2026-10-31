# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off
"""Liga o campo `type` ao modelo da mensagem."""

from __future__ import annotations

from pydantic import BaseModel

from .envelope import Envelope
from .agent_hello_v1 import AgentHelloV1Message
from .agent_keepalive_v1 import AgentKeepaliveV1Message
from .agent_logs_request_v1 import AgentLogsRequestV1Message
from .agent_logs_v1 import AgentLogsV1Message
from .agent_maintenance_v1 import AgentMaintenanceV1Message
from .agent_update_status_v1 import AgentUpdateStatusV1Message
from .api_keepalive_v1 import ApiKeepaliveV1Message
from .command_result_v1 import CommandResultV1Message
from .tv_app_launch_v1 import TvAppLaunchV1Message
from .tv_apps_refresh_v1 import TvAppsRefreshV1Message
from .tv_apps_v1 import TvAppsV1Message
from .tv_apps_v2 import TvAppsV2Message
from .tv_cleanup_config_v1 import TvCleanupConfigV1Message
from .tv_cleanup_result_v1 import TvCleanupResultV1Message
from .tv_cleanup_v1 import TvCleanupV1Message
from .tv_key_v1 import TvKeyV1Message
from .tv_key_v2 import TvKeyV2Message
from .tv_key_v3 import TvKeyV3Message
from .tv_livre_photo_v1 import TvLivrePhotoV1Message
from .tv_livre_state_v1 import TvLivreStateV1Message
from .tv_livre_v1 import TvLivreV1Message
from .tv_power_off_v1 import TvPowerOffV1Message
from .tv_state_v1 import TvStateV1Message
from .tv_text_v1 import TvTextV1Message
from .tv_wake_v1 import TvWakeV1Message
from .tv_watchdog_v1 import TvWatchdogV1Message

ENVELOPE_MODEL: type[BaseModel] = Envelope

MESSAGE_MODELS: dict[str, type[BaseModel]] = {
    "agent.hello.v1": AgentHelloV1Message,
    "agent.keepalive.v1": AgentKeepaliveV1Message,
    "agent.logs.request.v1": AgentLogsRequestV1Message,
    "agent.logs.v1": AgentLogsV1Message,
    "agent.maintenance.v1": AgentMaintenanceV1Message,
    "agent.update.status.v1": AgentUpdateStatusV1Message,
    "api.keepalive.v1": ApiKeepaliveV1Message,
    "command.result.v1": CommandResultV1Message,
    "tv.app.launch.v1": TvAppLaunchV1Message,
    "tv.apps.refresh.v1": TvAppsRefreshV1Message,
    "tv.apps.v1": TvAppsV1Message,
    "tv.apps.v2": TvAppsV2Message,
    "tv.cleanup.config.v1": TvCleanupConfigV1Message,
    "tv.cleanup.result.v1": TvCleanupResultV1Message,
    "tv.cleanup.v1": TvCleanupV1Message,
    "tv.key.v1": TvKeyV1Message,
    "tv.key.v2": TvKeyV2Message,
    "tv.key.v3": TvKeyV3Message,
    "tv.livre.photo.v1": TvLivrePhotoV1Message,
    "tv.livre.state.v1": TvLivreStateV1Message,
    "tv.livre.v1": TvLivreV1Message,
    "tv.power.off.v1": TvPowerOffV1Message,
    "tv.state.v1": TvStateV1Message,
    "tv.text.v1": TvTextV1Message,
    "tv.wake.v1": TvWakeV1Message,
    "tv.watchdog.v1": TvWatchdogV1Message,
}
