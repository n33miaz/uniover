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
)
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
from uniover_agent.core.tv.locator import Located, TvIdentity, TvKnown, TvLocator
from uniover_agent.core.tv.relocator import TvRelocator
from uniover_agent.core.tv.samsung_apps import SamsungTvApps
from uniover_agent.core.tv.session import (
    TV_NOT_PAIRED,
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
    "POWER_OFF_CAPABILITY",
    "TV_NOT_PAIRED",
    "TV_UNREACHABLE",
    "AdbTyping",
    "AppEntry",
    "AppIconPublisher",
    "AppsAnnouncer",
    "CleanupReport",
    "IconResolver",
    "Located",
    "PackageLauncher",
    "PowerOffResult",
    "SamsungTvApps",
    "SessionState",
    "TextReconciler",
    "TvApps",
    "TvCleanup",
    "TvControl",
    "TvIdentity",
    "TvKnown",
    "TvLocator",
    "TvRelocator",
    "TvSessionError",
    "TvSessionManager",
    "TvStatePublisher",
    "TvWatchdog",
    "WatchdogEvents",
    "describe_apps",
    "is_protected",
    "tv_app_launch_handler",
    "tv_apps_refresh_handler",
    "tv_cleanup_handler",
    "tv_key_handler",
    "tv_power_off_handler",
    "tv_text_handler",
    "tv_wake_handler",
    "unsupported_handler",
]
