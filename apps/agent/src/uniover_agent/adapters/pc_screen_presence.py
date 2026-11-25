"""Liga o processo de tela à bandeja pela sessão do Windows: quem está sendo visto e o pedido de
parar.

Enquanto alguém vê a tela, o processo dela publica o identificador da visualização num mapeamento
nomeado e cria um evento cujo nome leva esse identificador. A bandeja lê o identificador e, para
encerrar, sinaliza o evento daquele nome. Os dois objetos somem junto com o processo (nada vai ao
disco), e um pedido atrasado não acha evento nenhum: nunca alcança a visualização seguinte.
"""

import ctypes
import mmap
import secrets
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from ctypes import wintypes
from typing import Any

_VIEWING_NAME = r"Local\UniOverScreenViewing"
_STOP_PREFIX = r"Local\UniOverScreenStop."
_ID_BYTES = 16
_ID_CHARS = 2 * _ID_BYTES
_HEX = frozenset("0123456789abcdef")
_FILE_MAP_READ = 0x0004
_EVENT_MODIFY_STATE = 0x0002
_WAIT_OBJECT_0 = 0


def _is_viewing_id(value: str) -> bool:
    return len(value) == _ID_CHARS and _HEX.issuperset(value)


def _kernel() -> Any:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateEventW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.CreateEventW.restype = wintypes.HANDLE
    kernel.OpenEventW.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.OpenEventW.restype = wintypes.HANDLE
    kernel.SetEvent.argtypes = (wintypes.HANDLE,)
    kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.OpenFileMappingW.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.OpenFileMappingW.restype = wintypes.HANDLE
    kernel.MapViewOfFile.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_size_t,
    )
    kernel.MapViewOfFile.restype = ctypes.c_void_p
    kernel.UnmapViewOfFile.argtypes = (ctypes.c_void_p,)
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    return kernel


@contextmanager
def screen_indicator() -> Iterator[Callable[[], bool]]:
    """Mostra a visualização à bandeja; entrega a consulta "pediram para parar esta?"."""
    kernel = _kernel()
    viewing = secrets.token_hex(_ID_BYTES)
    # O evento nasce antes de o identificador aparecer: quem o lê já tem a quem pedir.
    stop = kernel.CreateEventW(None, True, False, _STOP_PREFIX + viewing)
    if not stop:
        raise OSError("Não foi possível sinalizar a tela na bandeja.")
    try:
        with mmap.mmap(-1, _ID_CHARS, tagname=_VIEWING_NAME) as shared:
            shared.write(viewing.encode("ascii"))
            yield lambda: bool(kernel.WaitForSingleObject(stop, 0) == _WAIT_OBJECT_0)
    finally:
        kernel.CloseHandle(stop)


def viewing_session() -> str | None:
    """O identificador da visualização em curso; `None` se ninguém está vendo."""
    if sys.platform != "win32":
        return None
    kernel = _kernel()
    handle = kernel.OpenFileMappingW(_FILE_MAP_READ, False, _VIEWING_NAME)
    if not handle:
        return None
    try:
        view = kernel.MapViewOfFile(handle, _FILE_MAP_READ, 0, 0, _ID_CHARS)
        if not view:
            return None
        try:
            value = ctypes.string_at(view, _ID_CHARS).decode("ascii", errors="replace")
        finally:
            kernel.UnmapViewOfFile(view)
    finally:
        kernel.CloseHandle(handle)
    return value if _is_viewing_id(value) else None


def request_screen_stop(viewing: str) -> bool:
    """Pede o fim daquela visualização; `False` se ela já acabou (nenhuma outra é afetada)."""
    if sys.platform != "win32" or not _is_viewing_id(viewing):
        return False
    kernel = _kernel()
    stop = kernel.OpenEventW(_EVENT_MODIFY_STATE, False, _STOP_PREFIX + viewing)
    if not stop:
        return False
    try:
        return bool(kernel.SetEvent(stop))
    finally:
        kernel.CloseHandle(stop)
