"""A tela só sai do PC com o ícone da bandeja vivo: recusa na abertura e fim da transmissão quando
ele some."""

import asyncio
import json
import mmap
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from uniover_agent.adapters import pc_screen_presence, pc_screen_process, pc_screen_worker
from uniover_agent.adapters.pc_screen_presence import (
    TRAY_UNAVAILABLE,
    TrayBeat,
    TrayUnavailableError,
    screen_indicator,
    tray_alive,
    viewing_session,
)
from uniover_agent.adapters.pc_screen_process import ScreenProcess
from uniover_agent.adapters.pc_screen_worker import Capture, ScreenSession
from uniover_agent.core.pc.devices import DeviceDecision
from uniover_agent.core.pc.direct import DirectRefused
from uniover_agent.ports.pc_direct import DirectUnavailable

from .test_pc_direct import Lab, _Approvals
from .test_pc_screen_lifecycle import FakeScreen, offer
from .test_pc_screen_stop import run_session, until

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="objetos nomeados do Windows")
WORKER = "uniover_agent.adapters.pc_screen_worker"

# Uma bandeja em outro processo: grava um carimbo, diz quem é e espera ser morta (ou o pai sumir).
_OTHER_TRAY = """
import os, sys
from uniover_agent.adapters.pc_screen_presence import TrayBeat
tray = TrayBeat()
tray.beat()
print(os.getpid(), flush=True)
sys.stdin.readline()
"""


@windows_only
@pytest.mark.usefixtures("private_screen_names")
def test_without_a_tray_nothing_is_published() -> None:
    assert not tray_alive()
    with pytest.raises(TrayUnavailableError), screen_indicator():
        pytest.fail("a visualização não pode começar sem a bandeja")
    assert viewing_session() is None


@windows_only
@pytest.mark.usefixtures("private_screen_names")
async def test_a_session_whose_tray_left_before_the_first_frame_sends_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    screen, channel, task = run_session(monkeypatch, screen_indicator)
    channel.message(k="s.get")

    await asyncio.wait_for(task, timeout=2)

    assert channel.sent == []
    screen.peer.close.assert_awaited_once()


@windows_only
@pytest.mark.parametrize("death", ["suspend", "withdraw", "hung"])
async def test_the_transmission_ends_when_the_tray_dies_mid_view(
    monkeypatch: pytest.MonkeyPatch, live_tray: TrayBeat, death: str
) -> None:
    monkeypatch.setattr(pc_screen_worker, "capture_frame", lambda _r, _p: Capture(1, 1, 1, b"j"))
    monkeypatch.setattr(pc_screen_worker, "private_bytes", lambda: 0)
    screen, channel, task = run_session(monkeypatch, screen_indicator)
    try:
        await until(viewing_session)
        channel.message(k="s.get")
        await until(lambda: any(isinstance(item, bytes) for item in channel.sent))
        assert not task.done()

        if death == "hung":
            # O objeto segue lá, mas o carimbo para de ser renovado.
            monkeypatch.setattr(pc_screen_presence, "TRAY_STALE_SECONDS", 0.3)
        else:
            getattr(live_tray, death)()
        await asyncio.wait_for(task, timeout=2)

        assert screen.closed.is_set()
        screen.peer.close.assert_awaited_once()
        assert viewing_session() is None
        sent = len(channel.sent)
        channel.message(k="s.get")
        assert screen.requests.empty() and len(channel.sent) == sent
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@windows_only
async def test_a_tray_that_keeps_beating_keeps_the_view_open(
    monkeypatch: pytest.MonkeyPatch, live_tray: TrayBeat
) -> None:
    clock = 1_000_000
    checked = asyncio.Event()

    def fake_tick(_kernel: object = None) -> int:
        return clock

    original_tray_alive = pc_screen_presence._tray_alive

    def tracked_tray_alive(kernel: object) -> bool:
        result = original_tray_alive(kernel)
        checked.set()
        return result

    monkeypatch.setattr(pc_screen_presence, "tray_tick", fake_tick)
    monkeypatch.setattr(pc_screen_presence, "_tray_alive", tracked_tray_alive)
    monkeypatch.setattr(pc_screen_presence, "TRAY_STALE_SECONDS", 1.0)
    live_tray.beat()
    screen, _channel, task = run_session(monkeypatch, screen_indicator)
    try:
        # Bem além da validade de um carimbo: só as renovações seguram a sessão.
        for _ in range(10):
            checked.clear()
            await asyncio.wait_for(checked.wait(), timeout=2)
            clock += 200  # 0.2 s no relógio controlado
            live_tray.beat()
        assert not task.done() and not screen.closed.is_set()
        assert viewing_session() is not None
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@windows_only
@pytest.mark.usefixtures("private_screen_names")
def test_a_tray_that_does_not_acknowledge_refuses_the_viewing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tray = pc_screen_presence.TrayBeat()
    tray.beat()
    assert tray_alive()
    # Reduz o tempo limite para o teste ser rápido.
    monkeypatch.setattr(pc_screen_presence, "TRAY_ACK_TIMEOUT_SECONDS", 0.1)
    try:
        with pytest.raises(TrayUnavailableError, match="não confirmou"):
            with screen_indicator():
                pytest.fail("a visualização não pode começar sem a confirmação da bandeja")
        assert viewing_session() is None
    finally:
        tray.withdraw()


@windows_only
@pytest.mark.usefixtures("private_screen_names")
def test_a_killed_tray_process_stops_counting_at_once() -> None:
    other = subprocess.Popen(  # noqa: S603 - o próprio interpretador dos testes
        [sys.executable, "-c", _OTHER_TRAY],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert other.stdout is not None
        # O número vem do próprio processo: o `python.exe` do ambiente pode ser só um lançador.
        pid = int(other.stdout.readline())
        assert tray_alive()

        os.kill(pid, 9)  # no Windows, `TerminateProcess`: nenhuma limpeza do lado dele
        other.wait(timeout=30)

        # O carimbo ainda seria recente; quem some é o objeto, junto com o processo.
        assert not tray_alive()
    finally:
        other.kill()
        other.communicate(timeout=30)


@windows_only
def test_only_the_same_installation_can_see_and_signal_the_view(
    tmp_path: Path, live_tray: TrayBeat
) -> None:
    probe = """
import json, sys
from uniover_agent.adapters import pc_screen_presence as p
viewing = sys.argv[1]
print(json.dumps([p.tray_alive(), p.viewing_session(), p.wake_tray(),
                  p.acknowledge_viewing(viewing), p.request_screen_stop(viewing)]))
"""
    with screen_indicator() as must_stop:
        viewing = viewing_session()
        assert viewing is not None
        for home, same in ((tmp_path / "copia", False), (tmp_path, True)):
            result = subprocess.run(  # noqa: S603 - o próprio interpretador dos testes
                [sys.executable, "-c", probe, viewing],
                env={**os.environ, "UNIOVER_HOME": str(home)},
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            )
            assert json.loads(result.stdout) == [same, viewing if same else None, same, same, same]
            assert must_stop() is same


@windows_only
def test_an_old_beat_does_not_count(monkeypatch: pytest.MonkeyPatch, live_tray: TrayBeat) -> None:
    assert tray_alive()
    monkeypatch.setattr(pc_screen_presence, "TRAY_STALE_SECONDS", 0.05)
    # O relógio do Windows anda em passos de uns 16 ms.
    time.sleep(0.2)
    assert not tray_alive()
    live_tray.beat()
    monkeypatch.setattr(pc_screen_presence, "TRAY_STALE_SECONDS", 10.0)
    assert tray_alive()


@windows_only
def test_a_delayed_beat_expires_from_when_it_was_received(
    monkeypatch: pytest.MonkeyPatch, live_tray: TrayBeat
) -> None:
    now = 19_000
    monkeypatch.setattr(pc_screen_presence, "tray_tick", lambda _kernel=None: now)
    live_tray.beat(10_000)
    assert tray_alive()
    now = 20_001
    assert not tray_alive()


@windows_only
def test_leftover_files_and_an_empty_mapping_are_not_a_tray(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    private_screen_names: str,
) -> None:
    monkeypatch.setenv("UNIOVER_HOME", str(tmp_path))
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    for name in ("tray-status.json", "tray-host-state.json", "tray-start-request"):
        (runtime / name).write_text("{}", encoding="utf-8")
    assert not tray_alive()

    with mmap.mmap(-1, 8, tagname=private_screen_names):
        assert not tray_alive()  # criado e nunca carimbado


@windows_only
@pytest.mark.usefixtures("private_screen_names")
def test_a_late_beat_never_revives_a_withdrawn_tray() -> None:
    quitting, other = TrayBeat(), TrayBeat()
    try:
        quitting.beat()
        quitting.suspend()
        assert not tray_alive()
        quitting.beat()
        assert tray_alive()
        quitting.withdraw()
        quitting.beat()
        assert not tray_alive()
        # Outro ícone vivo (um novo que já abriu) vale por si.
        other.beat()
        quitting.withdraw()
        assert tray_alive()
    finally:
        quitting.withdraw()
        other.withdraw()


@pytest.mark.parametrize("alive", [False, True], ids=["sem-bandeja", "com-bandeja"])
async def test_the_worker_answers_the_offer_only_with_a_live_tray(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], alive: bool
) -> None:
    offered = {"sdp": "oferta", "token": "bilhete", "tokenTtlSeconds": 10, "maxLifetimeSeconds": 60}

    def read_pipe(
        loop: asyncio.AbstractEventLoop, raw: asyncio.Future[bytes], _closed: asyncio.Event
    ) -> None:
        loop.call_soon_threadsafe(raw.set_result, json.dumps(offered).encode("ascii"))

    started = AsyncMock()
    # O `Mock` aceita a atribuição de `argtypes`, como a função do ctypes.
    user32 = Mock()
    monkeypatch.setattr(pc_screen_worker, "_read_pipe", read_pipe)
    monkeypatch.setattr(pc_screen_worker, "tray_alive", lambda: alive)
    monkeypatch.setattr(
        f"{WORKER}.ctypes",
        SimpleNamespace(windll=SimpleNamespace(user32=user32), c_void_p=lambda value: value),
    )
    monkeypatch.setattr(ScreenSession, "run", started)

    await pc_screen_worker.main()

    printed = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    if alive:
        started.assert_awaited_once()
        assert printed == []
    else:
        started.assert_not_awaited()
        assert [reply["code"] for reply in printed] == [TRAY_UNAVAILABLE]
        assert "sdp" not in printed[0]


class _Pipe:
    def __init__(self, line: bytes = b"") -> None:
        self.line = line

    def write(self, _data: bytes) -> None:
        pass

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        pass

    async def readline(self) -> bytes:
        return self.line


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        ({"error": "sem ícone", "code": TRAY_UNAVAILABLE}, DirectUnavailable),
        ({"error": "outra falha"}, RuntimeError),
    ],
)
async def test_the_agent_tells_a_missing_tray_from_any_other_refusal(
    monkeypatch: pytest.MonkeyPatch, reply: dict[str, str], expected: type[Exception]
) -> None:
    stderr = asyncio.StreamReader()
    stderr.feed_eof()
    process = SimpleNamespace(
        pid=1,
        stdin=_Pipe(),
        stdout=_Pipe(json.dumps(reply).encode("ascii") + b"\n"),
        stderr=stderr,
        terminate=lambda: None,
        wait=AsyncMock(),
    )
    monkeypatch.setattr(pc_screen_process, "exec_hidden", AsyncMock(return_value=process))
    monkeypatch.setattr(
        pc_screen_process, "ScreenJob", lambda _pid: SimpleNamespace(close=lambda: None)
    )

    with pytest.raises(expected):
        await ScreenProcess().accept_offer("oferta", "bilhete", 10, 60)

    process.wait.assert_awaited()


async def test_a_missing_tray_reaches_the_app_as_unavailable_and_keeps_the_control() -> None:
    class NoTray(FakeScreen):
        async def accept_offer(self, sdp: str, token: str, ttl: int, lifetime: int) -> str:
            raise DirectUnavailable("ícone da bandeja fechado")

    screen = NoTray()
    lab = Lab(screen_factory=lambda: screen)
    lab.service._devices = _Approvals(DeviceDecision.APPROVED)  # type: ignore[assignment]
    try:
        await lab.open_authenticated(device_id="iphone-da-casa", clock=False)

        with pytest.raises(DirectRefused) as refused:
            await offer(lab)

        assert refused.value.code == "rtc_unavailable"
        assert screen.stopped.is_set()
        assert lab.service.authenticated
    finally:
        await lab.aclose()
