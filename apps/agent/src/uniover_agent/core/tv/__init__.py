"""Sessão e comandos da TV (sem rede nem biblioteca de TV)."""

from uniover_agent.core.tv.adb_commands import AppsAnnouncer, TvApps, tv_apps_refresh_handler
from uniover_agent.core.tv.apps import AppEntry, describe_apps
from uniover_agent.core.tv.cleanup import (
    CLEANUP_FAILED,
    CLEANUP_IN_PROGRESS,
    CleanupReport,
    TvCleanup,
    is_protected,
    tv_cleanup_handler,
    tv_cleanup_skipped_handler,
)
from uniover_agent.core.tv.cleanup_schedule import TvCleanupScheduler
from uniover_agent.core.tv.discovery import DISCOVERY_CAPABILITY, FoundTv, tv_discover_handler
from uniover_agent.core.tv.focus_closer import FocusBackgroundCloser
from uniover_agent.core.tv.handlers import (
    DEFAULT_LINK_SCHEMES,
    POWER_OFF_CAPABILITY,
    PackageLauncher,
    TvControl,
    tv_app_launch_handler,
    tv_key_handler,
    tv_power_off_handler,
    tv_text_handler,
    tv_wake_handler,
    unsupported_handler,
)
from uniover_agent.core.tv.icons import AppIconPublisher, IconResolver
from uniover_agent.core.tv.light_settings import TvLightSettings, can_restrict_background
from uniover_agent.core.tv.locator import Located, TvIdentity, TvKnown, TvLocator
from uniover_agent.core.tv.permission import PERMISSION_CAPABILITY, TvPermission
from uniover_agent.core.tv.relocator import TvRelocator
from uniover_agent.core.tv.samsung_apps import SamsungTvApps
from uniover_agent.core.tv.samsung_maintenance import (
    SAMSUNG_MAINTENANCE_CAPABILITY,
    SamsungMaintenance,
    SamsungMaintenanceScheduler,
)
from uniover_agent.core.tv.session import (
    TV_NOT_PAIRED,
    TV_PERMISSION_NEEDED,
    TV_UNREACHABLE,
    PowerOffResult,
    SessionState,
    TvSessionError,
    TvSessionManager,
)
from uniover_agent.core.tv.state_publisher import TvStatePublisher
from uniover_agent.core.tv.text_edit import AdbTyping, TextReconciler
from uniover_agent.core.tv.watchdog import TvWatchdog
from uniover_agent.core.tv.watchdog_events import WatchdogEvents

__all__ = [
    "CLEANUP_FAILED",
    "CLEANUP_IN_PROGRESS",
    "DEFAULT_LINK_SCHEMES",
    "DISCOVERY_CAPABILITY",
    "PERMISSION_CAPABILITY",
    "POWER_OFF_CAPABILITY",
    "SAMSUNG_MAINTENANCE_CAPABILITY",
    "TV_NOT_PAIRED",
    "TV_PERMISSION_NEEDED",
    "TV_UNREACHABLE",
    "AdbTyping",
    "AppEntry",
    "AppIconPublisher",
    "AppsAnnouncer",
    "CleanupReport",
    "FocusBackgroundCloser",
    "FoundTv",
    "IconResolver",
    "Located",
    "PackageLauncher",
    "PowerOffResult",
    "SamsungMaintenance",
    "SamsungMaintenanceScheduler",
    "SamsungTvApps",
    "SessionState",
    "TextReconciler",
    "TvApps",
    "TvCleanup",
    "TvCleanupScheduler",
    "TvControl",
    "TvIdentity",
    "TvKnown",
    "TvLightSettings",
    "TvLocator",
    "TvPermission",
    "TvRelocator",
    "TvSessionError",
    "TvSessionManager",
    "TvStatePublisher",
    "TvWatchdog",
    "WatchdogEvents",
    "can_restrict_background",
    "describe_apps",
    "is_protected",
    "tv_app_launch_handler",
    "tv_apps_refresh_handler",
    "tv_cleanup_handler",
    "tv_cleanup_skipped_handler",
    "tv_discover_handler",
    "tv_key_handler",
    "tv_power_off_handler",
    "tv_text_handler",
    "tv_wake_handler",
    "unsupported_handler",
]
