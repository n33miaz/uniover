"""Enumeração dos monitores físicos para a tela ao vivo."""

import ctypes
from ctypes import wintypes
from dataclasses import dataclass

MONITORINFOF_PRIMARY = 1


@dataclass(frozen=True)
class Monitor:
    """Um monitor no retângulo virtual do desktop; `left`/`top` podem ser negativos."""

    id: int
    left: int
    top: int
    width: int
    height: int
    primary: bool

    @property
    def area(self) -> tuple[int, int, int, int]:
        return self.left, self.top, self.left + self.width, self.top + self.height


class _MonitorInfo(ctypes.Structure):
    _fields_ = [
        ("size", wintypes.DWORD),
        ("monitor", wintypes.RECT),
        ("work", wintypes.RECT),
        ("flags", wintypes.DWORD),
    ]


def list_monitors() -> list[Monitor]:
    """Monitores ativos, numerados pela ordem da enumeração do Windows (pixels físicos)."""
    user = ctypes.windll.user32
    user.GetMonitorInfoW.argtypes = (wintypes.HANDLE, ctypes.POINTER(_MonitorInfo))
    user.GetMonitorInfoW.restype = wintypes.BOOL
    found: list[Monitor] = []

    def visit(handle: int, _dc: int, _rect: int, _data: int) -> bool:
        info = _MonitorInfo()
        info.size = ctypes.sizeof(info)
        if user.GetMonitorInfoW(handle, ctypes.byref(info)):
            rect = info.monitor
            found.append(
                Monitor(
                    len(found),
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    bool(info.flags & MONITORINFOF_PRIMARY),
                )
            )
        return True

    callback_type = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HANDLE, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM
    )
    callback = callback_type(visit)
    user.EnumDisplayMonitors.argtypes = (
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        callback_type,
        wintypes.LPARAM,
    )
    user.EnumDisplayMonitors.restype = wintypes.BOOL
    if not user.EnumDisplayMonitors(None, None, callback, 0):
        raise OSError("Falha ao enumerar os monitores.")
    return found
