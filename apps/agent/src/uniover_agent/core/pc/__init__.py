"""Controle do PC: mouse, teclado, mídia, energia e favoritos."""

from uniover_agent.core.pc.apps import MAX_FAVORITES, PcApp, parse_favorites, slugify
from uniover_agent.core.pc.handlers import (
    PC_CONTROL_CAPABILITY,
    PC_SILENT_TYPES,
    SLEEP_DELAY_SECONDS,
    UNKNOWN_APP,
    UNSUPPORTED,
    pc_app_launch_handler,
    pc_apps_announcer,
    pc_click_handler,
    pc_handlers,
    pc_key_handler,
    pc_media_handler,
    pc_pointer_handler,
    pc_power_handler,
    pc_text_handler,
)

__all__ = [
    "MAX_FAVORITES",
    "PC_CONTROL_CAPABILITY",
    "PC_SILENT_TYPES",
    "SLEEP_DELAY_SECONDS",
    "UNKNOWN_APP",
    "UNSUPPORTED",
    "PcApp",
    "parse_favorites",
    "pc_app_launch_handler",
    "pc_apps_announcer",
    "pc_click_handler",
    "pc_handlers",
    "pc_key_handler",
    "pc_media_handler",
    "pc_pointer_handler",
    "pc_power_handler",
    "pc_text_handler",
    "slugify",
]
