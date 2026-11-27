"""Liga o processo de tela à bandeja pela sessão do Windows: quem está sendo visto e o pedido de
parar.

Enquanto alguém vê a tela, o processo dela publica o identificador da visualização num mapeamento
nomeado e cria um evento cujo nome leva esse identificador. A bandeja lê o identificador e, para
encerrar, sinaliza o evento daquele nome. Os dois objetos somem junto com o processo (nada vai ao
disco), e um pedido atrasado não acha evento nenhum: nunca alcança a visualização seguinte.

No outro sentido vai a prova de vida da bandeja: ela grava o relógio do Windows num mapeamento
nomeado ao confirmar o estado do ícone. A tela só é transmitida com um carimbo recente ali. O objeto
some quando a bandeja morre, mesmo morta por fora.
"""

import ctypes
import logging
import mmap
import secrets
import sys
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from ctypes import wintypes
from functools import cache
from typing import Any, Final

from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.tray_win32 import mutex_name

_log = logging.getLogger(__name__)

_TICK_BYTES = 8
# A folga cobre um PC lento sem aceitar um ícone parado.
TRAY_STALE_SECONDS = 10.0
# Sem o despertar, há até 2 s entre duas gravações de 3,15 s, mais 350 ms do timer do host.
TRAY_ACK_TIMEOUT_SECONDS = 9.0
_ACK_CHECK_INTERVAL_MS = 50
# O que o processo da tela responde ao agente quando recusa a oferta por falta do ícone.
TRAY_UNAVAILABLE: Final = "tray_unavailable"
_ID_BYTES = 16
_ID_CHARS = 2 * _ID_BYTES
_HEX = frozenset("0123456789abcdef")
_FILE_MAP_READ = 0x0004
_EVENT_MODIFY_STATE = 0x0002
_WAIT_OBJECT_0 = 0


@cache
def _namespace() -> str:
    """O mesmo nome da trava da bandeja, fixo enquanto este processo estiver vivo."""
    return mutex_name(installation_base())


def _is_viewing_id(value: str) -> bool:
    return len(value) == _ID_CHARS and _HEX.issuperset(value)


_kernel_instance: Any = None


def _kernel() -> Any:
    global _kernel_instance  # noqa: PLW0603
    if _kernel_instance is not None:
        return _kernel_instance
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
    kernel.GetTickCount64.argtypes = ()
    kernel.GetTickCount64.restype = ctypes.c_uint64
    _kernel_instance = kernel
    return _kernel_instance


def tray_tick(kernel: Any = None) -> int:
    return int((kernel or _kernel()).GetTickCount64())


def _read_mapping(kernel: Any, name: str, size: int) -> bytes | None:
    """O conteúdo de um mapeamento nomeado; `None` se ele não existe.

    O identificador é fechado antes de voltar: guardá-lo manteria vivo o objeto de um processo que
    já morreu.
    """
    handle = kernel.OpenFileMappingW(_FILE_MAP_READ, False, name)
    if not handle:
        return None
    try:
        view = kernel.MapViewOfFile(handle, _FILE_MAP_READ, 0, 0, size)
        if not view:
            return None
        try:
            return ctypes.string_at(view, size)
        finally:
            kernel.UnmapViewOfFile(view)
    finally:
        kernel.CloseHandle(handle)


class TrayBeat:
    """O lado da bandeja na prova de vida. Nunca levanta: sem carimbo, a tela fica fechada."""

    def __init__(self) -> None:
        # O menu ("Sair") e o laço de atualização podem chegar de threads diferentes.
        self._lock = threading.Lock()
        self._shared: mmap.mmap | None = None
        self._withdrawn = False

    def beat(self, received_tick: int | None = None) -> None:
        """Carimba o estado aplicado no ícone com o horário em que foi confirmado."""
        if sys.platform != "win32":
            return
        with self._lock:
            if self._withdrawn:
                return
            try:
                if self._shared is None:
                    self._shared = mmap.mmap(-1, _TICK_BYTES, tagname=f"{_namespace()}.Showing")
                tick = tray_tick() if received_tick is None else received_tick
                self._shared[:] = tick.to_bytes(_TICK_BYTES, "little")
            except OSError:
                _log.warning("a bandeja não conseguiu avisar que está viva", exc_info=True)

    def suspend(self) -> None:
        """O ícone saiu do ar (o host visual caiu, por exemplo); o próximo `beat` o declara de
        volta."""
        with self._lock:
            self._close()

    def withdraw(self) -> None:
        """O ícone vai fechar: nenhum `beat` atrasado o declara vivo de novo."""
        with self._lock:
            self._withdrawn = True
            self._close()

    def _close(self) -> None:
        if self._shared is not None:
            self._shared.close()
            self._shared = None


def fresh_tray_tick(tick: int, kernel: Any = None) -> bool:
    # Zero é o mapeamento recém-criado, antes do primeiro carimbo.
    return tick > 0 and 0 <= tray_tick(kernel) - tick <= TRAY_STALE_SECONDS * 1000


def _tray_alive(kernel: Any) -> bool:
    value = _read_mapping(kernel, f"{_namespace()}.Showing", _TICK_BYTES)
    if value is None:
        return False
    return fresh_tray_tick(int.from_bytes(value, "little"), kernel)


def tray_alive() -> bool:
    """Há um ícone da bandeja desta sessão do Windows sendo atualizado agora?"""
    return sys.platform == "win32" and _tray_alive(_kernel())


class TrayUnavailableError(RuntimeError):
    """Sem o ícone da bandeja não há como mostrar quem vê a tela nem como parar."""


def create_tray_wake_event() -> Any:
    """Cria ou abre o evento para a bandeja acordar e atualizar o ícone sem espera."""
    if sys.platform != "win32":
        return None
    return _kernel().CreateEventW(None, False, False, f"{_namespace()}.Wake")


def wake_tray() -> bool:
    """Acorda o laço da bandeja para que ela atualize o estado sem esperar pelo próximo ciclo."""
    if sys.platform != "win32":
        return False
    kernel = _kernel()
    wake = kernel.OpenEventW(_EVENT_MODIFY_STATE, False, f"{_namespace()}.Wake")
    if not wake:
        return False
    try:
        return bool(kernel.SetEvent(wake))
    finally:
        kernel.CloseHandle(wake)


def wait_tray_wake(wake: Any, timeout_seconds: float) -> bool:
    """Aguarda o evento de despertar da bandeja ou o tempo limite."""
    if sys.platform != "win32" or not wake:
        return False
    return bool(_kernel().WaitForSingleObject(wake, int(timeout_seconds * 1000)) == _WAIT_OBJECT_0)


def close_tray_handle(handle: Any) -> None:
    """Fecha um handle do Windows se válido."""
    if sys.platform == "win32" and handle:
        _kernel().CloseHandle(handle)


def _wait_for_ack(kernel: Any, ack: wintypes.HANDLE) -> bool:
    deadline = time.monotonic() + TRAY_ACK_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not _tray_alive(kernel):
            return False
        res = kernel.WaitForSingleObject(ack, _ACK_CHECK_INTERVAL_MS)
        if res == _WAIT_OBJECT_0:
            return True
    return False


@contextmanager
def screen_indicator() -> Iterator[Callable[[], bool]]:
    """Mostra a visualização à bandeja; entrega a consulta "esta visualização tem de parar?".

    A resposta é sim quando o dono pede ou quando a bandeja deixa de estar viva. A checagem inicial
    precede a publicação do identificador. Depois de publicá-lo, aguarda a confirmação antes de
    entregar a consulta. Se a bandeja estiver indisponível, levanta `TrayUnavailableError` e libera
    os objetos da visualização que tiver criado.
    """
    kernel = _kernel()
    if not _tray_alive(kernel):
        raise TrayUnavailableError("O ícone do UniOver não está aberto neste PC.")
    viewing = secrets.token_hex(_ID_BYTES)
    # O evento nasce antes de o identificador aparecer: quem o lê já tem a quem pedir.
    stop = kernel.CreateEventW(None, True, False, f"{_namespace()}.Stop.{viewing}")
    if not stop:
        raise OSError("Não foi possível sinalizar a tela na bandeja.")
    ack = kernel.CreateEventW(None, True, False, f"{_namespace()}.Ack.{viewing}")
    if not ack:
        kernel.CloseHandle(stop)
        raise OSError("Não foi possível criar o evento de confirmação da tela.")

    def must_stop() -> bool:
        asked = bool(kernel.WaitForSingleObject(stop, 0) == _WAIT_OBJECT_0)
        return asked or not _tray_alive(kernel)

    try:
        with mmap.mmap(-1, _ID_CHARS, tagname=f"{_namespace()}.Viewing") as shared:
            shared.write(viewing.encode("ascii"))
            wake_tray()
            if not _wait_for_ack(kernel, ack):
                raise TrayUnavailableError("O ícone do UniOver não confirmou a exibição da tela.")
            yield must_stop
    finally:
        kernel.CloseHandle(ack)
        kernel.CloseHandle(stop)


def viewing_session() -> str | None:
    """O identificador da visualização em curso; `None` se ninguém está vendo."""
    if sys.platform != "win32":
        return None
    raw = _read_mapping(_kernel(), f"{_namespace()}.Viewing", _ID_CHARS)
    if raw is None:
        return None
    value = raw.decode("ascii", errors="replace")
    return value if _is_viewing_id(value) else None


def request_screen_stop(viewing: str) -> bool:
    """Pede o fim daquela visualização; `False` se ela já acabou (nenhuma outra é afetada)."""
    if sys.platform != "win32" or not _is_viewing_id(viewing):
        return False
    kernel = _kernel()
    stop = kernel.OpenEventW(_EVENT_MODIFY_STATE, False, f"{_namespace()}.Stop.{viewing}")
    if not stop:
        return False
    try:
        return bool(kernel.SetEvent(stop))
    finally:
        kernel.CloseHandle(stop)


def acknowledge_viewing(viewing: str) -> bool:
    """Confirma que a bandeja recebeu e exibiu o identificador da visualização."""
    if sys.platform != "win32" or not _is_viewing_id(viewing):
        return False
    kernel = _kernel()
    ack = kernel.OpenEventW(_EVENT_MODIFY_STATE, False, f"{_namespace()}.Ack.{viewing}")
    if not ack:
        return False
    try:
        return bool(kernel.SetEvent(ack))
    finally:
        kernel.CloseHandle(ack)
