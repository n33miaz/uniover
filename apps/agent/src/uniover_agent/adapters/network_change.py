"""Observador de mudança de rede do Windows (`NotifyAddrChange`): acorda a reconexão da API."""

import ctypes
import sys
import threading
from collections.abc import Callable
from typing import Final, Protocol

from uniover_agent.ports import NetworkChangeWatcher

CHANGED: Final = "changed"
STOPPED: Final = "stopped"
FAILED: Final = "failed"


class WindowsApi(Protocol):
    """As chamadas do Windows de que o observador precisa (trocáveis nos testes)."""

    def create_event(self) -> int | None:
        """Cria um evento (`CreateEventW`) e devolve o `HANDLE`, ou `None` se falhou."""
        ...

    def set_event(self, handle: int) -> None: ...

    def close_handle(self, handle: int) -> None: ...

    def wait_for_change(self, changed_handle: int, stop_handle: int) -> str:
        """Espera a mudança de endereço (`NotifyAddrChange`) ou a parada.

        Devolve `CHANGED`, `STOPPED` ou `FAILED`; na parada e na falha a espera pendente já foi
        cancelada.
        """
        ...


class _Overlapped(ctypes.Structure):
    """Estrutura usada por `NotifyAddrChange` para poder cancelar a espera."""

    _fields_ = [
        ("Internal", ctypes.c_size_t),
        ("InternalHigh", ctypes.c_size_t),
        ("Offset", ctypes.c_uint32),
        ("OffsetHigh", ctypes.c_uint32),
        ("hEvent", ctypes.c_void_p),
    ]


def _handle_value(handle: object) -> int | None:
    """Normaliza o `HANDLE`, que o ctypes pode devolver como inteiro ou ponteiro."""
    if isinstance(handle, ctypes.c_void_p):
        return handle.value
    return handle if isinstance(handle, int) and handle else None


class CtypesWindowsApi:
    """As chamadas reais, por ctypes (`kernel32` e `iphlpapi`). Só existe no Windows."""

    _ERROR_IO_PENDING: Final = 997
    _WAIT_OBJECT_0: Final = 0
    _INFINITE: Final = 0xFFFFFFFF

    def __init__(self) -> None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        iphlpapi = ctypes.WinDLL("iphlpapi", use_last_error=True)
        self._create = kernel32.CreateEventW
        self._create.argtypes = [
            ctypes.c_void_p,
            ctypes.c_bool,
            ctypes.c_bool,
            ctypes.c_wchar_p,
        ]
        self._create.restype = ctypes.c_void_p
        self._close = kernel32.CloseHandle
        self._close.argtypes = [ctypes.c_void_p]
        self._close.restype = ctypes.c_bool
        self._set = kernel32.SetEvent
        self._set.argtypes = [ctypes.c_void_p]
        self._set.restype = ctypes.c_bool
        self._wait = kernel32.WaitForMultipleObjects
        self._wait.argtypes = [
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.c_bool,
            ctypes.c_uint32,
        ]
        self._wait.restype = ctypes.c_uint32
        self._notify = iphlpapi.NotifyAddrChange
        self._notify.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(_Overlapped)]
        self._notify.restype = ctypes.c_ulong
        self._cancel = iphlpapi.CancelIPChangeNotify
        self._cancel.argtypes = [ctypes.POINTER(_Overlapped)]
        self._cancel.restype = None

    def create_event(self) -> int | None:
        return _handle_value(self._create(None, True, False, None))

    def set_event(self, handle: int) -> None:
        self._set(ctypes.c_void_p(handle))

    def close_handle(self, handle: int) -> None:
        self._close(ctypes.c_void_p(handle))

    def wait_for_change(self, changed_handle: int, stop_handle: int) -> str:
        overlapped = _Overlapped()
        overlapped.hEvent = changed_handle
        notify_handle = ctypes.c_void_p()
        result = self._notify(ctypes.byref(notify_handle), ctypes.byref(overlapped))
        if result == 0:
            return CHANGED
        if result != self._ERROR_IO_PENDING:
            return FAILED
        handles = (ctypes.c_void_p * 2)(
            ctypes.c_void_p(changed_handle), ctypes.c_void_p(stop_handle)
        )
        waited = self._wait(2, handles, False, self._INFINITE)
        if waited == self._WAIT_OBJECT_0:
            return CHANGED
        self._cancel(ctypes.byref(overlapped))
        return STOPPED if waited == self._WAIT_OBJECT_0 + 1 else FAILED


class WindowsNetworkChangeWatcher:
    """Acorda o supervisor quando o Windows informa que a configuração de rede mudou."""

    def __init__(self, on_change: Callable[[], None], api: WindowsApi | None = None) -> None:
        self._on_change = on_change
        self._api: WindowsApi = api if api is not None else CtypesWindowsApi()
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None
        self._stop_handle: int | None = None
        self._lock = threading.Lock()

    def start(self) -> None:
        try:
            stop_handle = self._api.create_event()
            if stop_handle is None:
                return
            self._stop_handle = stop_handle
            self._thread = threading.Thread(target=self._watch, name="network-change", daemon=True)
            self._thread.start()
        except Exception:
            # A observação é só uma otimização; o backoff normal continua sendo suficiente.
            self._release_stop_handle()

    def stop(self) -> None:
        """Pede a parada e espera a thread; pode ser chamado mais de uma vez."""
        self._stopped.set()
        thread = self._thread
        with self._lock:
            # Sob o trinco do fechamento: nunca sinaliza um handle já fechado e reaproveitado.
            if self._stop_handle is not None:
                self._api.set_event(self._stop_handle)
        if thread is not None:
            thread.join(timeout=1)
            if thread.is_alive():
                # A thread ainda usa o handle: ela mesma o fecha ao sair.
                return
        self._release_stop_handle()

    def _release_stop_handle(self) -> None:
        """Fecha o handle de parada uma única vez, venha a chamada de `stop` ou da thread."""
        with self._lock:
            handle, self._stop_handle = self._stop_handle, None
        if handle is not None:
            self._api.close_handle(handle)

    def _watch(self) -> None:
        stop_handle = self._stop_handle
        try:
            while stop_handle is not None and not self._stopped.is_set():
                changed = self._api.create_event()
                if changed is None:
                    return
                try:
                    outcome = self._api.wait_for_change(changed, stop_handle)
                finally:
                    self._api.close_handle(changed)
                if outcome != CHANGED:
                    return
                if not self._stopped.is_set():
                    self._on_change()
        except Exception:
            # Uma API ausente ou recusada não pode impedir a reconexão normal.
            return
        finally:
            # Falha da WinAPI: o handle de parada não fica retido até o fim do processo.
            self._release_stop_handle()


def network_change_watcher(on_change: Callable[[], None]) -> NetworkChangeWatcher | None:
    """Cria o observador apenas no Windows; nos demais sistemas o backoff não muda."""
    if sys.platform != "win32":
        return None
    try:
        return WindowsNetworkChangeWatcher(on_change)
    except Exception:
        return None
