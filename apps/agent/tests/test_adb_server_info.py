"""De quando é o servidor do `adb`: só leitura (`netstat` e a hora do processo), nunca o abre."""

import os
import sys
import time
from types import SimpleNamespace

import pytest

from uniover_agent.adapters import adb_server_info
from uniover_agent.adapters.adb_server_info import adb_server_started_at, server_port
from uniover_agent.adapters.windows_scheduling import process_started_at

NETSTAT = (
    "\r\nConexoes ativas\r\n\r\n  Proto  Local  Externo  Estado  PID\r\n"
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000\r\n"
    "  TCP    127.0.0.1:5037         0.0.0.0:0              LISTENING       4242\r\n"
    "  TCP    127.0.0.1:5037         127.0.0.1:50000        ESTABLISHED     4242\r\n"
    "  TCP    127.0.0.1:5039         0.0.0.0:0              LISTENING       777\r\n"
)


class FakeProcess:
    def __init__(self, text: str, code: int = 0) -> None:
        self._text = text
        self.returncode: int | None = code

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._text.encode(), b""

    def kill(self) -> None:
        self.returncode = -9

    async def wait(self) -> int:
        return int(self.returncode or 0)


@pytest.fixture
def windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(adb_server_info, "sys", SimpleNamespace(platform="win32"))


def serve(monkeypatch: pytest.MonkeyPatch, text: str, code: int = 0) -> None:
    async def fake(*args: str, **kwargs: object) -> FakeProcess:
        assert args[0] == "netstat"
        return FakeProcess(text, code)

    monkeypatch.setattr(adb_server_info, "exec_hidden", fake)


async def test_the_listener_of_the_adb_port_gives_the_time(
    monkeypatch: pytest.MonkeyPatch, windows: None
) -> None:
    serve(monkeypatch, NETSTAT)
    seen: list[int] = []

    def started(pid: int) -> float | None:
        seen.append(pid)
        return 1234.5

    monkeypatch.setattr(adb_server_info, "process_started_at", started)
    assert await adb_server_started_at(5037) == 1234.5
    assert seen == [4242]  # o servidor da 5037, não o da 5039


async def test_no_listener_means_no_server(monkeypatch: pytest.MonkeyPatch, windows: None) -> None:
    serve(monkeypatch, NETSTAT)
    assert await adb_server_started_at(5555) is None


async def test_a_server_whose_time_cannot_be_read_is_an_error(
    monkeypatch: pytest.MonkeyPatch, windows: None
) -> None:
    serve(monkeypatch, NETSTAT)
    monkeypatch.setattr(adb_server_info, "process_started_at", lambda pid: None)
    with pytest.raises(OSError, match="hora do servidor"):
        await adb_server_started_at(5037)


async def test_a_netstat_that_fails_is_an_error(
    monkeypatch: pytest.MonkeyPatch, windows: None
) -> None:
    serve(monkeypatch, "", code=1)
    with pytest.raises(OSError, match="netstat"):
        await adb_server_started_at(5037)


async def test_outside_windows_the_time_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(adb_server_info, "sys", SimpleNamespace(platform="linux"))
    with pytest.raises(OSError, match="Windows"):
        await adb_server_started_at(5037)


def test_the_server_port_follows_the_adb_variable() -> None:
    assert server_port({}) == 5037
    assert server_port({"ANDROID_ADB_SERVER_PORT": "5039"}) == 5039
    assert server_port({"ANDROID_ADB_SERVER_PORT": "lixo"}) == 5037
    assert server_port({"ANDROID_ADB_SERVER_PORT": "70000"}) == 5037


@pytest.mark.skipif(sys.platform != "win32", reason="a hora do processo vem do Windows")
def test_the_start_time_of_this_very_process_is_read_from_windows() -> None:
    started = process_started_at(os.getpid())
    assert started is not None
    assert 0 < time.time() - started < 86400 * 30


@pytest.mark.skipif(sys.platform != "win32", reason="a hora do processo vem do Windows")
def test_a_process_that_does_not_exist_has_no_time() -> None:
    assert process_started_at(0x7FFFFFF0) is None
