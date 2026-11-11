# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off
"""Liga o campo `type` ao modelo da mensagem."""

from __future__ import annotations

from pydantic import BaseModel

from .envelope import Envelope
from .agent_diagnostics_v1 import AgentDiagnosticsV1Message
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
from .pc_click_v2 import PcClickV2Message
from .pc_device_state_v1 import PcDeviceStateV1Message
from .pc_key_v1 import PcKeyV1Message
from .pc_key_v2 import PcKeyV2Message
from .pc_media_v1 import PcMediaV1Message
from .pc_pointer_v1 import PcPointerV1Message
from .pc_pointer_zoom_v1 import PcPointerZoomV1Message
from .pc_power_v1 import PcPowerV1Message
from .pc_rtc_answer_v1 import PcRtcAnswerV1Message
from .pc_rtc_candidate_v1 import PcRtcCandidateV1Message
from .pc_rtc_close_v1 import PcRtcCloseV1Message
from .pc_rtc_closed_v1 import PcRtcClosedV1Message
from .pc_rtc_offer_v1 import PcRtcOfferV1Message
from .pc_text_v1 import PcTextV1Message
from .pc_text_v2 import PcTextV2Message
from .pc_volume_state_v1 import PcVolumeStateV1Message
from .pc_volume_v1 import PcVolumeV1Message
from .tv_adb_rebind_v1 import TvAdbRebindV1Message
from .tv_app_launch_v1 import TvAppLaunchV1Message
from .tv_apps_refresh_v1 import TvAppsRefreshV1Message
from .tv_apps_v1 import TvAppsV1Message
from .tv_apps_v2 import TvAppsV2Message
from .tv_cleanup_config_v1 import TvCleanupConfigV1Message
from .tv_cleanup_result_v1 import TvCleanupResultV1Message
from .tv_cleanup_v1 import TvCleanupV1Message
from .tv_discover_v1 import TvDiscoverV1Message
from .tv_discovery_v1 import TvDiscoveryV1Message
from .tv_key_v1 import TvKeyV1Message
from .tv_key_v2 import TvKeyV2Message
from .tv_key_v3 import TvKeyV3Message
from .tv_livre_photo_v1 import TvLivrePhotoV1Message
from .tv_livre_state_v1 import TvLivreStateV1Message
from .tv_livre_v1 import TvLivreV1Message
from .tv_pair_v1 import TvPairV1Message
from .tv_permission_request_v1 import TvPermissionRequestV1Message
from .tv_permission_v1 import TvPermissionV1Message
from .tv_power_off_v1 import TvPowerOffV1Message
from .tv_presence_v1 import TvPresenceV1Message
from .tv_settings_open_v1 import TvSettingsOpenV1Message
from .tv_state_v1 import TvStateV1Message
from .tv_text_v1 import TvTextV1Message
from .tv_wake_v1 import TvWakeV1Message
from .tv_watchdog_v1 import TvWatchdogV1Message

ENVELOPE_MODEL: type[BaseModel] = Envelope

MESSAGE_MODELS: dict[str, type[BaseModel]] = {
    "agent.diagnostics.v1": AgentDiagnosticsV1Message,
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
    "pc.click.v2": PcClickV2Message,
    "pc.device.state.v1": PcDeviceStateV1Message,
    "pc.key.v1": PcKeyV1Message,
    "pc.key.v2": PcKeyV2Message,
    "pc.media.v1": PcMediaV1Message,
    "pc.pointer.v1": PcPointerV1Message,
    "pc.pointer.zoom.v1": PcPointerZoomV1Message,
    "pc.power.v1": PcPowerV1Message,
    "pc.rtc.answer.v1": PcRtcAnswerV1Message,
    "pc.rtc.candidate.v1": PcRtcCandidateV1Message,
    "pc.rtc.close.v1": PcRtcCloseV1Message,
    "pc.rtc.closed.v1": PcRtcClosedV1Message,
    "pc.rtc.offer.v1": PcRtcOfferV1Message,
    "pc.text.v1": PcTextV1Message,
    "pc.text.v2": PcTextV2Message,
    "pc.volume.state.v1": PcVolumeStateV1Message,
    "pc.volume.v1": PcVolumeV1Message,
    "tv.adb.rebind.v1": TvAdbRebindV1Message,
    "tv.app.launch.v1": TvAppLaunchV1Message,
    "tv.apps.refresh.v1": TvAppsRefreshV1Message,
    "tv.apps.v1": TvAppsV1Message,
    "tv.apps.v2": TvAppsV2Message,
    "tv.cleanup.config.v1": TvCleanupConfigV1Message,
    "tv.cleanup.result.v1": TvCleanupResultV1Message,
    "tv.cleanup.v1": TvCleanupV1Message,
    "tv.discover.v1": TvDiscoverV1Message,
    "tv.discovery.v1": TvDiscoveryV1Message,
    "tv.key.v1": TvKeyV1Message,
    "tv.key.v2": TvKeyV2Message,
    "tv.key.v3": TvKeyV3Message,
    "tv.livre.photo.v1": TvLivrePhotoV1Message,
    "tv.livre.state.v1": TvLivreStateV1Message,
    "tv.livre.v1": TvLivreV1Message,
    "tv.pair.v1": TvPairV1Message,
    "tv.permission.request.v1": TvPermissionRequestV1Message,
    "tv.permission.v1": TvPermissionV1Message,
    "tv.power.off.v1": TvPowerOffV1Message,
    "tv.presence.v1": TvPresenceV1Message,
    "tv.settings.open.v1": TvSettingsOpenV1Message,
    "tv.state.v1": TvStateV1Message,
    "tv.text.v1": TvTextV1Message,
    "tv.wake.v1": TvWakeV1Message,
    "tv.watchdog.v1": TvWatchdogV1Message,
}
