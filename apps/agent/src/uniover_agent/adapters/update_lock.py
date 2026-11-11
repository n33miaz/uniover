r"""Trava de atualização da instalação: preparar, aplicar e passar para a versão nova não se cruzam.

Quem prepara apaga candidatos e ambientes e poda as versões que o ponteiro não usa; quem troca
(o supervisor, na passagem sem queda, ou `self-update --apply`) depende de a pasta e o ambiente da
versão nova estarem inteiros até o ponteiro ser gravado. Um `self-update` manual no meio de uma
passagem podaria justo a versão que está subindo. Por isso os três tomam a mesma trava.

No Windows é um mutex nomeado `Local\UniOver-Update-<hash da pasta>` (some sozinho com o processo,
mesmo numa queda); o supervisor (`run-agent.ps1`) calcula o mesmo nome. Fora dele, um `flock` em
`runtime\update.lock`.
"""

import hashlib
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any, Final

LOCK_FILE: Final = "update.lock"
_WAIT_OBJECT_0: Final = 0
_WAIT_ABANDONED: Final = 0x80
_MS: Final = 1000


def mutex_name(base: Path) -> str:
    """O nome que o supervisor também calcula: caminho sem barra final, minúsculas, SHA-256."""
    key = str(base).rstrip("\\/").lower()
    return f"Local\\UniOver-Update-{hashlib.sha256(key.encode('utf-8')).hexdigest()[:16]}"


def _acquire_windows(name: str, wait_seconds: float) -> Any | None:
    import ctypes  # noqa: PLC0415 - só existe no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.CreateMutexW(None, False, name)
    if not handle:
        # Sem como criar a trava (mutex de outro nível de permissão): quem a tem é outro.
        return None
    outcome = kernel32.WaitForSingleObject(handle, int(wait_seconds * _MS))
    if outcome in {_WAIT_OBJECT_0, _WAIT_ABANDONED}:
        return (kernel32, handle)
    kernel32.CloseHandle(handle)
    return None


def _release_windows(held: Any) -> None:
    kernel32, handle = held
    kernel32.ReleaseMutex(handle)
    kernel32.CloseHandle(handle)


@contextmanager
def update_lock(base: Path, *, wait_seconds: float = 0.0) -> Iterator[bool]:
    """Toma a trava de atualização por até `wait_seconds`; devolve se a tomou. Solta ao sair."""
    if sys.platform == "win32":
        held = _acquire_windows(mutex_name(base), wait_seconds)
        try:
            yield held is not None
        finally:
            if held is not None:
                with suppress(OSError):
                    _release_windows(held)
        return
    import fcntl  # noqa: PLC0415 - só existe fora do Windows

    path = base / "runtime" / LOCK_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        deadline = time.monotonic() + wait_seconds
        taken = False
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                taken = True
                break
            except OSError:
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.1)
        try:
            yield taken
        finally:
            if taken:
                fcntl.flock(handle, fcntl.LOCK_UN)
