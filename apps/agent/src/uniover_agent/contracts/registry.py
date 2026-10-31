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
from .pc_app_launch_v1 import PcAppLaunchV1Message
from .pc_apps_v1 import PcAppsV1Message
from .pc_click_v1 import PcClickV1Message
from .pc_key_v1 import PcKeyV1Message
from .pc_media_v1 import PcMediaV1Message
from .pc_pointer_v1 import PcPointerV1Message
from .pc_power_v1 import PcPowerV1Message
from .pc_text_v1 import PcTextV1Message
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
    "pc.app.launch.v1": PcAppLaunchV1Message,
    "pc.apps.v1": PcAppsV1Message,
    "pc.click.v1": PcClickV1Message,
    "pc.key.v1": PcKeyV1Message,
    "pc.media.v1": PcMediaV1Message,
    "pc.pointer.v1": PcPointerV1Message,
    "pc.power.v1": PcPowerV1Message,
    "pc.text.v1": PcTextV1Message,
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
    "tv.power.off.v1": TvPowerOffV1Message,
    "tv.state.v1": TvStateV1Message,
    "tv.text.v1": TvTextV1Message,
    "tv.wake.v1": TvWakeV1Message,
    "tv.watchdog.v1": TvWatchdogV1Message,
}
