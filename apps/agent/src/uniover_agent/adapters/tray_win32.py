"""As chamadas do Windows que a bandeja precisa e o pystray não faz: DPI, tamanho do ícone,
instância única.

Tudo aqui é opcional e nunca levanta: sem Windows (ou se uma chamada falhar) cada função devolve o
valor neutro e o ícone sai do jeito antigo, só menos nítido.
"""

import ctypes
import hashlib
import sys
from ctypes import wintypes
from pathlib import Path
from typing import Final

SM_CXSMICON: Final = 49
IMAGE_ICON: Final = 1
LR_LOADFROMFILE: Final = 0x10
ERROR_ALREADY_EXISTS: Final = 183
# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
_PER_MONITOR_V2: Final = -4
_DEFAULT_SIZE: Final = 16


def is_windows() -> bool:
    return sys.platform == "win32"


def make_dpi_aware() -> bool:
    """Sem isto o Windows trata o processo como "sem suporte a DPI", pede sempre 16 px e estica o
    ícone a 125%/150%."""
    if not is_windows():
        return False
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined,unused-ignore]
        user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        return bool(user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(_PER_MONITOR_V2)))
    except OSError, AttributeError:
        return False


def small_icon_size(hwnd: int | None = None) -> int:
    """O lado, em pixels, do ícone pequeno da bandeja na escala atual (16, 20, 24, 32...)."""
    if not is_windows():
        return _DEFAULT_SIZE
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined,unused-ignore]
        dpi = 0
        if hwnd:
            dpi = int(user32.GetDpiForWindow(wintypes.HWND(hwnd)))
        if dpi <= 0:
            dpi = int(user32.GetDpiForSystem())
        size = int(user32.GetSystemMetricsForDpi(SM_CXSMICON, dpi))
    except OSError, AttributeError:
        return _DEFAULT_SIZE
    return size if size > 0 else _DEFAULT_SIZE


def load_icon_handle(path: Path, size: int) -> int | None:
    """Carrega do `.ico` o quadro do tamanho pedido (o Windows escolhe o de lado igual, sem
    reamostrar)."""
    if not is_windows():
        return None
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined,unused-ignore]
        user32.LoadImageW.restype = wintypes.HANDLE
        user32.LoadImageW.argtypes = [
            wintypes.HINSTANCE,
            wintypes.LPCWSTR,
            wintypes.UINT,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.UINT,
        ]
        handle = user32.LoadImageW(None, str(path), IMAGE_ICON, size, size, LR_LOADFROMFILE)
    except OSError, AttributeError:
        return None
    return int(handle) if handle else None


def own_image_path() -> str:
    """O executável que o Windows enxerga neste processo (é o que ele grava em `ExecutablePath`)."""
    if is_windows():
        try:
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined,unused-ignore]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            kernel32.QueryFullProcessImageNameW.argtypes = [
                wintypes.HANDLE,
                wintypes.DWORD,
                wintypes.LPWSTR,
                ctypes.POINTER(wintypes.DWORD),
            ]
            buffer = ctypes.create_unicode_buffer(1024)
            length = wintypes.DWORD(len(buffer))
            if kernel32.QueryFullProcessImageNameW(
                kernel32.GetCurrentProcess(), 0, buffer, ctypes.byref(length)
            ):
                return buffer.value
        except OSError, AttributeError:
            pass
    return sys.executable


def mutex_name(base: Path) -> str:
    """Um nome por pasta de instalação (uma cópia de teste não disputa com a real)."""
    digest = hashlib.sha256(str(base).lower().encode("utf-8")).hexdigest()[:16]
    return f"Local\\UniOverTray-{digest}"


class SingleInstance:
    """Mutex nomeado: a segunda cópia da bandeja descobre que já existe uma e sai."""

    def __init__(self, name: str) -> None:
        self._handle: int | None = None
        self.first = True
        if not is_windows():
            return
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined,unused-ignore]
            kernel32.CreateMutexW.restype = wintypes.HANDLE
            kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
            handle = kernel32.CreateMutexW(None, False, name)
            self._handle = int(handle) if handle else None
            self.first = ctypes.get_last_error() != ERROR_ALREADY_EXISTS
        except OSError, AttributeError:
            self.first = True
