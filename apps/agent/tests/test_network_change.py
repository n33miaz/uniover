import logging
import sys
import threading
from collections.abc import Callable

import pytest

from uniover_agent.adapters import network_change
from uniover_agent.adapters.network_change import (
    CHANGED,
    FAILED,
    STOPPED,
    WindowsNetworkChangeWatcher,
)


def test_observer_is_silent_when_windows_api_is_unavailable(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    class Unavailable:
        def __init__(self, on_change: Callable[[], None]) -> None:
            raise OSError("indisponível")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(network_change, "WindowsNetworkChangeWatcher", Unavailable)

    with caplog.at_level(logging.INFO):
        assert network_change.network_change_watcher(lambda: None) is None

    assert caplog.records == []


def test_observer_is_disabled_outside_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    class MustNotStart:
        def __init__(self, on_change: Callable[[], None]) -> None:
            raise AssertionError("não deve carregar a API do Windows")

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(network_change, "WindowsNetworkChangeWatcher", MustNotStart)

    assert network_change.network_change_watcher(lambda: None) is None


class FakeApi:
    """O Windows de mentira: cada espera devolve o próximo resultado do roteiro; sem roteiro, a
    espera só acaba quando o evento de parada é sinalizado."""

    def __init__(self, script: list[str] | None = None, raises: bool = False) -> None:
        self._script = list(script or [])
        self._raises = raises
        self._next = 100
        self.open: set[int] = set()
        self.closed: list[int] = []
        self.stop_signaled = threading.Event()
        self.waiting = threading.Event()
        self.fail_create = False

    def create_event(self) -> int | None:
        if self.fail_create:
            return None
        self._next += 1
        self.open.add(self._next)
        return self._next

    def set_event(self, handle: int) -> None:
        assert handle in self.open, "sinalizou um handle já fechado"
        self.stop_signaled.set()

    def close_handle(self, handle: int) -> None:
        assert handle in self.open, "fechou um handle duas vezes"
        self.open.discard(handle)
        self.closed.append(handle)

    def wait_for_change(self, changed_handle: int, stop_handle: int) -> str:
        if self._raises:
            raise OSError("WinAPI recusou")
        if self._script:
            return self._script.pop(0)
        self.waiting.set()
        self.stop_signaled.wait(timeout=5)
        return STOPPED


def test_a_change_from_the_watch_thread_reaches_the_callback_and_stop_closes_every_handle() -> None:
    api = FakeApi([CHANGED])
    calls: list[int] = []
    got = threading.Event()

    def on_change() -> None:
        calls.append(threading.get_ident())
        got.set()

    watcher = WindowsNetworkChangeWatcher(on_change, api)
    watcher.start()
    assert got.wait(timeout=5)
    assert api.waiting.wait(timeout=5)
    watcher.stop()
    watcher.stop()  # idempotente

    assert calls and calls[0] != threading.get_ident()
    assert api.open == set()
    assert len(api.closed) == len(set(api.closed))
    assert watcher._thread is not None and not watcher._thread.is_alive()


def test_a_winapi_failure_releases_the_stop_handle_without_waiting_for_stop() -> None:
    api = FakeApi([FAILED])
    calls: list[int] = []
    watcher = WindowsNetworkChangeWatcher(lambda: calls.append(1), api)
    watcher.start()
    assert watcher._thread is not None
    watcher._thread.join(timeout=5)

    assert not watcher._thread.is_alive()
    assert api.open == set()
    assert calls == []
    watcher.stop()  # depois da falha, parar não sinaliza handle fechado
    assert api.open == set()


def test_an_exception_in_the_wait_releases_the_stop_handle() -> None:
    api = FakeApi(raises=True)
    watcher = WindowsNetworkChangeWatcher(lambda: None, api)
    watcher.start()
    assert watcher._thread is not None
    watcher._thread.join(timeout=5)

    assert api.open == set()
    watcher.stop()


def test_without_a_stop_event_there_is_no_thread_and_stop_is_harmless() -> None:
    api = FakeApi()
    api.fail_create = True
    watcher = WindowsNetworkChangeWatcher(lambda: None, api)
    watcher.start()

    assert watcher._thread is None
    watcher.stop()
    assert api.open == set()
