"""Sinaliza à bandeja, pela sessão do Windows, que há captura autenticada."""

import ctypes
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from ctypes import wintypes

_NAME = r"Local\UniOverScreenMeasurement"
_SYNCHRONIZE = 0x00100000


@contextmanager
def screen_indicator() -> Iterator[None]:
    kernel = ctypes.windll.kernel32
    kernel.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.CreateMutexW(None, False, _NAME)
    if not handle:
        raise OSError("Não foi possível sinalizar a medição da tela na bandeja.")
    try:
        yield
    finally:
        kernel.CloseHandle(handle)


def screen_is_viewing() -> bool:
    if sys.platform != "win32":
        return False
    kernel = ctypes.windll.kernel32
    kernel.OpenMutexW.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.OpenMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.OpenMutexW(_SYNCHRONIZE, False, _NAME)
    if not handle:
        return False
    kernel.CloseHandle(handle)
    return True
