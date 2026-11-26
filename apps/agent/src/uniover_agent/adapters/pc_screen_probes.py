"""Leituras leves do desktop para a tela ao vivo: estado (bloqueado/elevado) e posição do cursor."""

import ctypes
from ctypes import wintypes

from uniover_agent.adapters.pc_windows import USER_DESKTOP

STATE_OK = "ok"
STATE_LOCKED = "locked"
STATE_ELEVATED = "elevated"


def classify_state(desktop: str | None, foreground: int | None, own: int | None) -> str:
    """Um desktop que não é o do usuário vale como bloqueado; uma janela com integridade acima da
    deste processo vale como elevada (a captura dela pode sair preta)."""
    if desktop is None or desktop.lower() != USER_DESKTOP:
        return STATE_LOCKED
    if foreground is not None and own is not None and foreground > own:
        return STATE_ELEVATED
    return STATE_OK


def read_state() -> str:
    from uniover_agent.adapters import pc_windows  # noqa: PLC0415

    desktop = pc_windows._input_desktop_name()
    if desktop is None or desktop.lower() != USER_DESKTOP:
        return STATE_LOCKED
    own = pc_windows._process_integrity(ctypes.windll.kernel32.GetCurrentProcess())
    return classify_state(desktop, pc_windows._foreground_integrity(), own)


def read_cursor() -> tuple[int, int] | None:
    """Posição física do cursor no desktop virtual; `None` se o Windows não informa."""
    point = wintypes.POINT()
    if not ctypes.windll.user32.GetCursorPos(ctypes.byref(point)):
        return None
    return point.x, point.y
