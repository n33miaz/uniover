"""A área de transferência do PC no Windows: só texto Unicode (`CF_UNICODETEXT`), por `ctypes`.

O que a pessoa copiou pode ser uma senha: o texto nunca vai para o registro, nem em depuração. A
leitura corta em `MAX_CLIPBOARD_TEXT` caracteres (o limite do contrato) e a escrita recusa o que
passa disso.
Outros formatos (imagem, arquivos) não passam: sem texto na área, a leitura devolve vazio.

As chamadas ao sistema ficam atrás de `ClipboardApi`: os testes entregam uma área de mentira e nunca
tocam na área de transferência de verdade. Fora do Windows tudo recusa com `PcUnsupported`.
"""

import sys
import time
from collections.abc import Callable
from typing import Final, Protocol

from uniover_agent.ports.pc import PcUnsupported
from uniover_agent.ports.pc_media import MAX_CLIPBOARD_TEXT

_UNSUPPORTED: Final = "a área de transferência do PC só existe no Windows"

# Outro programa pode estar com a área aberta por alguns milissegundos: tenta de novo antes de
# desistir.
_OPEN_ATTEMPTS: Final = 10
_OPEN_PAUSE_SECONDS: Final = 0.02


class ClipboardApi(Protocol):
    """As chamadas do sistema de que a área de transferência precisa."""

    def read_text(self) -> str | None:
        """O texto da área, ou `None` se ela não tem texto. `OSError` se não deu para abri-la."""
        ...

    def write_text(self, text: str) -> None:
        """Troca a área por este texto. `OSError` se não deu."""
        ...


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _CF_UNICODETEXT = 13
    _GMEM_MOVEABLE = 0x0002
    _HWND_MESSAGE = -3

    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    _user32.OpenClipboard.argtypes = [wintypes.HWND]
    _user32.OpenClipboard.restype = wintypes.BOOL
    _user32.CloseClipboard.argtypes = []
    _user32.CloseClipboard.restype = wintypes.BOOL
    _user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        wintypes.LPVOID,
    ]
    _user32.CreateWindowExW.restype = wintypes.HWND
    _user32.DestroyWindow.argtypes = [wintypes.HWND]
    _user32.DestroyWindow.restype = wintypes.BOOL
    _user32.EmptyClipboard.argtypes = []
    _user32.EmptyClipboard.restype = wintypes.BOOL
    _user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
    _user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
    _user32.GetClipboardData.argtypes = [wintypes.UINT]
    _user32.GetClipboardData.restype = wintypes.HANDLE
    _user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    _user32.SetClipboardData.restype = wintypes.HANDLE
    _kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    _kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    _kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalFree.restype = wintypes.HGLOBAL
    _kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalLock.restype = wintypes.LPVOID
    _kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalUnlock.restype = wintypes.BOOL
    _kernel32.GlobalSize.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalSize.restype = ctypes.c_size_t

    def _open(owner: int | None = None) -> None:
        for _ in range(_OPEN_ATTEMPTS):
            if _user32.OpenClipboard(owner):
                return
            time.sleep(_OPEN_PAUSE_SECONDS)
        raise OSError("a área de transferência está em uso por outro programa")

    class _WindowsClipboardApi:
        def read_text(self) -> str | None:
            _open()
            try:
                if not _user32.IsClipboardFormatAvailable(_CF_UNICODETEXT):
                    return None
                handle = _user32.GetClipboardData(_CF_UNICODETEXT)
                if not handle:
                    return None
                locked = _kernel32.GlobalLock(handle)
                if not locked:
                    raise OSError("o Windows não deixou ler a área de transferência")
                try:
                    # O bloco pode ser maior que o texto: o tamanho dele limita a leitura, e o
                    # fim é o nulo.
                    limit = _kernel32.GlobalSize(handle) // ctypes.sizeof(ctypes.c_wchar)
                    return ctypes.wstring_at(locked, limit).split("\x00", 1)[0]
                finally:
                    _kernel32.GlobalUnlock(handle)
            finally:
                _user32.CloseClipboard()

        def write_text(self, text: str) -> None:
            data = (text + "\x00").encode("utf-16-le")
            block = _kernel32.GlobalAlloc(_GMEM_MOVEABLE, len(data))
            if not block:
                raise OSError("sem memória para a área de transferência")
            try:
                locked = _kernel32.GlobalLock(block)
                if not locked:
                    raise OSError("o Windows não deixou escrever na área de transferência")
                try:
                    ctypes.memmove(locked, data, len(data))
                finally:
                    _kernel32.GlobalUnlock(block)
                # EmptyClipboard precisa de uma janela proprietária para aceitar SetClipboardData.
                owner = _user32.CreateWindowExW(
                    0, "STATIC", None, 0, 0, 0, 0, 0, _HWND_MESSAGE, None, None, None
                )
                if not owner:
                    raise OSError("o Windows não criou a janela da área de transferência")
                try:
                    _open(owner)
                    try:
                        if not _user32.EmptyClipboard():
                            raise OSError("o Windows não deixou limpar a área de transferência")
                        if not _user32.SetClipboardData(_CF_UNICODETEXT, block):
                            raise OSError("o Windows não aceitou o texto na área de transferência")
                        block = None  # agora o bloco é do sistema
                    finally:
                        _user32.CloseClipboard()
                finally:
                    _user32.DestroyWindow(owner)
            finally:
                if block:
                    _kernel32.GlobalFree(block)

    def _system_api() -> ClipboardApi:
        return _WindowsClipboardApi()

else:

    def _system_api() -> ClipboardApi:
        raise PcUnsupported(_UNSUPPORTED)


class WindowsPcClipboard:
    """A área de transferência do PC. `api` é trocável: os testes nunca tocam na de verdade."""

    def __init__(self, api: Callable[[], ClipboardApi] | None = None) -> None:
        self._api = api or _system_api

    def read(self) -> str:
        text = self._api().read_text()
        return (text or "")[:MAX_CLIPBOARD_TEXT]

    def write(self, text: str) -> None:
        if len(text) > MAX_CLIPBOARD_TEXT:
            raise ValueError("texto grande demais para a área de transferência")
        self._api().write_text(text)
