"""Travas que não podem voltar: passo de rede sem prazo, verificação que não responde, disco cheio.

Cada teste simula o defeito de verdade (um `await` que nunca volta, um `OSError` de disco cheio) e
confere que o agente segue: reconecta, abandona, adia ou grava de outro jeito.
"""

import asyncio
import errno
import os
import time
from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from tests.test_diagnostics import MemoryStore
from uniover_agent.adapters import self_update as update_module
from uniover_agent.adapters.absence_diary import AbsenceDiary
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.self_care_checks import (
    SUPERVISOR_SILENCE_SECONDS,
    kill_wedged_supervisor,
    supervisor_check,
)
from uniover_agent.adapters.update_status import record_status
from uniover_agent.core import BackoffPolicy, ConnectionSupervisor, EnvelopeFactory, EnvelopeGate
from uniover_agent.core.diagnostics import DiagnosticsRecorder
from uniover_agent.core.self_care import Check, CheckResult, SelfCare
from uniover_agent.ports import TransportError

from .support import AGENT_ID

NEW = "b" * 40
OLD = "a" * 40
FAST = BackoffPolicy(
    connect_timeout=0.05, send_timeout=0.05, on_connected_timeout=0.05, close_timeout=0.05
)


async def never() -> None:
    await asyncio.Event().wait()


# --- Conexão: nenhum passo de rede espera para sempre -------------------------------------------


class HangingTransport(FakeTransport):
    """Transporte que trava no passo pedido (a primeira vez) e depois se comporta."""

    def __init__(self, hangs: str) -> None:
        super().__init__([[], []])
        self.hangs = hangs
        self.hung_once = False

    async def _maybe_hang(self, step: str) -> None:
        if self.hangs == step and not self.hung_once:
            self.hung_once = True
            await never()

    async def connect(self) -> None:
        await self._maybe_hang("connect")
        await super().connect()

    async def send(self, message: dict[str, Any]) -> None:
        await self._maybe_hang("send")
        await super().send(message)

    async def close(self) -> None:
        await self._maybe_hang("close")
        await super().close()


def build(transport: FakeTransport, **kwargs: Any) -> ConnectionSupervisor:
    clock = FakeClock()
    return ConnectionSupervisor(
        transport,
        _ignore,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        lambda: 0.5,
        agent_version="0.1.0",
        capabilities=["tv.remote"],
        policy=FAST,
        **kwargs,
    )


async def _ignore(raw: str | bytes) -> None:
    return None


async def run_until(
    supervisor: ConnectionSupervisor, done: Callable[[], bool], seconds: float = 5.0
) -> None:
    task = asyncio.create_task(supervisor.run())
    end = time.monotonic() + seconds
    while not done() and not task.done() and time.monotonic() < end:  # noqa: ASYNC110
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.parametrize("step", ["connect", "send", "close"])
async def test_a_network_step_that_never_returns_is_abandoned_and_the_loop_reconnects(
    step: str,
) -> None:
    transport = HangingTransport(step)
    supervisor = build(transport)
    await run_until(supervisor, lambda: transport.connects >= 2 and transport.hung_once)
    assert transport.hung_once
    assert transport.connects >= 2, f"o laço ficou preso no passo {step}"


async def test_an_announcement_after_the_hello_that_hangs_does_not_stop_the_loop() -> None:
    transport = FakeTransport([[], []])
    calls = 0

    async def hangs_once() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            await never()

    supervisor = build(transport, on_connected=hangs_once)
    await run_until(supervisor, lambda: calls >= 2)
    assert calls >= 2


class DeadChannel(FakeTransport):
    """Canal meio morto: o batimento não sai, o fechamento não volta e a leitura não acaba."""

    def __init__(self) -> None:
        super().__init__([[], []])
        self.close_calls = 0

    async def send(self, message: dict[str, Any]) -> None:
        if message["type"] == "agent.keepalive.v1":
            await never()
        await super().send(message)

    async def incoming(self):  # type: ignore[no-untyped-def]
        await never()
        yield ""

    async def close(self) -> None:
        self.close_calls += 1
        await never()


async def test_a_dead_channel_whose_close_also_hangs_still_reconnects() -> None:
    # O batimento estoura o prazo e o fechamento do canal também nunca volta: antes, a tarefa do
    # batimento ficava presa nesse fechamento e a leitura esperava para sempre.
    transport = DeadChannel()
    supervisor = build(transport, keepalive_interval=0.01)
    await run_until(supervisor, lambda: transport.connects >= 2)
    assert transport.connects >= 2, "o laço ficou preso num canal que não fecha"
    assert transport.close_calls >= 1


class RealClock:
    """Relógio de verdade (os prazos do teste são de milissegundos)."""

    def now(self) -> datetime:
        return datetime.now(UTC)

    def monotonic(self) -> float:
        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


class DefiantClose(FakeTransport):
    """Fechamento que ignora o cancelamento (um bug de biblioteca) até o teste soltá-lo."""

    def __init__(self) -> None:
        super().__init__([[], []])
        self.release = asyncio.Event()

    async def close(self) -> None:
        while True:
            try:
                await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                if self.release.is_set():
                    raise


async def test_a_connection_loop_that_ignores_its_deadlines_is_reported_as_stalled() -> None:
    transport = DefiantClose()
    clock = RealClock()
    supervisor = ConnectionSupervisor(
        transport,
        _ignore,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        lambda: 0.5,
        agent_version="0.1.0",
        capabilities=[],
        policy=BackoffPolicy(
            connect_timeout=0.05, send_timeout=0.05, close_timeout=0.05, stall_grace=0.1
        ),
        keepalive_interval=60.0,
    )
    task = asyncio.create_task(supervisor.run())
    try:
        # A sessão abre, a leitura acaba e o fechamento (que desobedece ao prazo) prende o laço.
        await asyncio.sleep(0.05)
        assert not supervisor.is_stalled(), "um laço que anda não pode ser dado por parado"
        end = time.monotonic() + 3
        while not supervisor.is_stalled() and time.monotonic() < end:  # noqa: ASYNC110
            await asyncio.sleep(0.02)
        assert supervisor.is_stalled()
    finally:
        transport.release.set()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


def test_the_pulse_stops_while_the_connection_is_stalled_and_resumes_after(tmp_path: Path) -> None:
    clock = FakeClock(datetime(2026, 11, 5, 12, 0, tzinfo=UTC))
    path = tmp_path / "runtime" / "last-alive"
    diary = AbsenceDiary(path, clock)
    healthy = True
    diary.require_healthy(lambda: healthy)

    async def beats(count: int) -> None:
        task = asyncio.create_task(diary.run())
        for _ in range(count * 3):
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(beats(2))
    assert path.exists()
    path.unlink()
    healthy = False
    asyncio.run(beats(2))
    assert not path.exists(), "a conexão presa não pode manter o agente com cara de saudável"
    healthy = True
    asyncio.run(beats(2))
    assert path.exists()


class DefiantConnect(FakeTransport):
    """Abertura que ignora o cancelamento (um bug de biblioteca) até o teste soltá-la."""

    def __init__(self) -> None:
        super().__init__([[], []])
        self.release = asyncio.Event()

    async def connect(self) -> None:
        while True:
            try:
                await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                if self.release.is_set():
                    raise


async def test_an_open_that_ignores_its_deadline_makes_the_pulse_go_stale() -> None:
    transport = DefiantConnect()
    clock = RealClock()
    supervisor = ConnectionSupervisor(
        transport,
        _ignore,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        lambda: 0.5,
        agent_version="0.1.0",
        capabilities=[],
        policy=BackoffPolicy(connect_timeout=0.05, stall_grace=0.1),
    )
    task = asyncio.create_task(supervisor.run())
    try:
        end = time.monotonic() + 3
        while not supervisor.is_stalled() and time.monotonic() < end:  # noqa: ASYNC110
            await asyncio.sleep(0.02)
        assert supervisor.is_stalled(), "a abertura passou do prazo e do atraso tolerado"
    finally:
        transport.release.set()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


def test_the_open_deadlines_favour_availability() -> None:
    from uniover_agent.adapters.transport_ws import OPEN_TIMEOUT_SECONDS  # noqa: PLC0415
    from uniover_agent.core.connection import CONNECT_TIMEOUT_SECONDS  # noqa: PLC0415

    # A API dormindo acorda em até ~1 min: 105 s para abrir, 120 s para o laço desistir.
    assert OPEN_TIMEOUT_SECONDS == 105.0
    assert CONNECT_TIMEOUT_SECONDS == 120.0
    assert OPEN_TIMEOUT_SECONDS < CONNECT_TIMEOUT_SECONDS


async def test_a_task_abandoned_by_a_session_never_touches_the_next_session() -> None:
    """Uma leitura que ignora o cancelamento fica para trás: acordando depois, não processa nada
    da sessão seguinte, que reaproveita o mesmo transporte."""
    processed: list[str] = []
    blocked = asyncio.Event()
    wake = asyncio.Event()

    class TwoSessions(FakeTransport):
        def __init__(self) -> None:
            super().__init__([["m1", "m2"], ["s2"]])

        async def send(self, message: dict[str, Any]) -> None:
            # O batimento da primeira sessão falha: a sessão acaba e a leitura (presa) é abandonada.
            if message["type"] == "agent.keepalive.v1" and self.connects == 1:
                await blocked.wait()
                raise TransportError("canal quebrado")
            await super().send(message)

    async def process(raw: str | bytes) -> None:
        if raw == "m1":
            blocked.set()
            while not wake.is_set():  # ignora o cancelamento até ser solta
                try:
                    await asyncio.sleep(0.01)
                except asyncio.CancelledError:
                    continue
        processed.append(str(raw))

    transport = TwoSessions()
    clock = FakeClock()
    supervisor = ConnectionSupervisor(
        transport,
        process,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        lambda: 0.5,
        agent_version="0.1.0",
        capabilities=[],
        policy=FAST,
        keepalive_interval=0.01,
    )
    task = asyncio.create_task(supervisor.run())
    end = time.monotonic() + 5
    while "s2" not in processed and time.monotonic() < end:  # noqa: ASYNC110
        await asyncio.sleep(0.01)
    assert "s2" in processed, "a sessão seguinte não chegou a rodar"
    wake.set()  # a leitura abandonada acorda agora
    await asyncio.sleep(0.2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert "m2" not in processed, "a leitura abandonada seguiu consumindo mensagens"


# --- Auto-diagnóstico: uma verificação presa não prende as outras ------------------------------


def care(checks: list[Check], **kwargs: Any) -> SelfCare:
    clock = FakeClock(datetime(2026, 11, 5, 12, 0, tzinfo=UTC))
    recorder = DiagnosticsRecorder(MemoryStore(), clock)
    return SelfCare(checks, recorder, clock, **kwargs)


async def test_a_check_that_never_answers_is_abandoned_and_the_next_one_still_runs() -> None:
    ran: list[str] = []

    async def stuck() -> CheckResult:
        await never()
        raise AssertionError

    async def fine() -> CheckResult:
        ran.append("fine")
        return CheckResult(True, "ok")

    outcomes = await care(
        [Check("trava", stuck), Check("boa", fine)], check_timeout=0.05
    ).run_once()
    assert [o.name for o in outcomes] == ["trava", "boa"]
    assert not outcomes[0].result.ok and "sem responder" in outcomes[0].result.detail
    assert outcomes[0].result.severity == "warn"
    assert ran == ["fine"]


async def test_a_repair_that_never_returns_is_abandoned() -> None:
    async def broken() -> CheckResult:
        return CheckResult(False, "quebrada", fixable=True)

    async def stuck_repair() -> str | None:
        await never()
        return None

    outcomes = await care([Check("x", broken, stuck_repair)], check_timeout=0.05).run_once()
    assert outcomes[0].repair_error == "o reparo passou do prazo"


async def test_the_launcher_is_asked_first_and_the_wedged_supervisor_is_taken_out_after(
    tmp_path: Path,
) -> None:
    alive = tmp_path / "supervisor-alive"
    alive.write_text("x", encoding="ascii")
    now = alive.stat().st_mtime + SUPERVISOR_SILENCE_SECONDS + 60
    order: list[str] = []

    def kill() -> bool:
        order.append("kill")
        return True

    def start(name: str) -> bool:
        order.append(f"start {name}")
        return True

    check = supervisor_check(
        tmp_path,
        name="teste",
        now=lambda: now,
        start_task=start,
        kill_supervisor=kill,
        recheck=0.0,
    )
    assert check.repair is not None and await check.repair() is None
    # O lançador é pedido ANTES: quem mata costuma estar dentro da árvore que morre.
    assert order == ["start teste", "kill"]


def test_killing_a_wedged_supervisor_without_its_script_touches_nothing(tmp_path: Path) -> None:
    # Sem o `run-agent.ps1` desta instalação não há o que procurar: nenhum processo é consultado.
    assert kill_wedged_supervisor(tmp_path / "app" / "tools" / "run-agent.ps1") is False


# --- Auto-atualização com o disco cheio ---------------------------------------------------------


def installed(tmp_path: Path, sha: str = OLD) -> Path:
    source = tmp_path / "app"
    source.mkdir()
    (source / ".version").write_text(sha + "\n", encoding="utf-8")
    return source


def test_an_update_with_a_nearly_full_disk_does_not_download_and_says_why(tmp_path: Path) -> None:
    source = installed(tmp_path)
    downloads: list[str] = []

    def download(sha: str, destination: Path) -> None:
        downloads.append(sha)

    result = update_module.self_update(
        source,
        fetch_latest=lambda: NEW,
        download=download,
        free_bytes=lambda folder: 100 * 1024 * 1024,
    )
    assert downloads == []
    assert not result.updated and result.outcome == "failed" and result.latest == NEW
    assert "pouco espaço no disco" in result.message
    assert not list(tmp_path.glob("uniover-update-*"))


def test_with_space_again_the_same_update_goes_ahead(tmp_path: Path) -> None:
    source = installed(tmp_path)
    reached: list[str] = []

    def download(sha: str, destination: Path) -> None:
        reached.append(sha)
        raise update_module.SelfUpdateError("parou aqui de propósito")

    update_module.self_update(
        source,
        fetch_latest=lambda: NEW,
        download=download,
        free_bytes=lambda folder: 10 * 1024**3,
    )
    assert reached == [NEW]


def test_an_already_current_agent_is_not_reported_as_a_disk_problem(tmp_path: Path) -> None:
    source = installed(tmp_path, NEW)
    result = update_module.self_update(
        source, fetch_latest=lambda: NEW, free_bytes=lambda folder: 1024
    )
    assert result.outcome == "up_to_date"


def test_a_disk_that_fills_during_the_update_leaves_the_install_alone(tmp_path: Path) -> None:
    source = installed(tmp_path)

    def download(sha: str, destination: Path) -> None:
        destination.write_bytes(b"parcial")
        raise OSError(errno.ENOSPC, "No space left on device")

    result = update_module.self_update(
        source, fetch_latest=lambda: NEW, download=download, free_bytes=lambda folder: 10**10
    )
    assert not result.updated and result.outcome == "failed"
    assert (source / ".version").read_text(encoding="utf-8").strip() == OLD
    assert not list(tmp_path.glob("uniover-update-*")) and not (tmp_path / "app.new").exists()


class Trickle(httpx.SyncByteStream):
    """Servidor que entrega um byte por vez (a leitura nunca estoura o prazo dela)."""

    def __init__(self, ticks: list[float]) -> None:
        self.ticks = ticks

    def __iter__(self) -> Any:
        for _ in range(1000):
            self.ticks.append(1.0)
            yield b"x"


def test_a_download_that_trickles_forever_hits_the_total_deadline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ticks: list[float] = []

    def stream(method: str, url: str, **kwargs: Any) -> AbstractContextManager[httpx.Response]:
        transport = httpx.MockTransport(lambda r: httpx.Response(200, stream=Trickle(ticks)))
        client = httpx.Client(transport=transport)
        return client.stream(method, url)

    monkeypatch.setattr(httpx, "stream", stream)
    clock = iter(float(n) for n in range(10_000))
    with pytest.raises(update_module.SelfUpdateError, match="passou de 5 s"):
        update_module.download_archive(
            NEW, tmp_path / "x.zip", deadline=5.0, monotonic=lambda: next(clock)
        )
    assert len(ticks) < 20


def test_the_update_status_survives_a_full_disk(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def full(src: Any, dst: Any) -> None:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(os, "replace", full)
    record_status(tmp_path / "update-status.json", {"outcome": "failed"})  # não levanta


# --- Sinal de vida do agente com o disco cheio --------------------------------------------------


def test_the_agent_pulse_still_moves_the_file_date_when_the_disk_is_full(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / "last-alive"
    path.write_text("1", encoding="ascii")
    os.utime(path, (1_000, 1_000))
    diary = AbsenceDiary(path, FakeClock(datetime(2026, 11, 5, tzinfo=UTC)))

    def full(self: Path, *args: Any, **kwargs: Any) -> int:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(Path, "write_text", full)
    diary.beat()
    assert path.stat().st_mtime > 1_000


def test_a_pulse_file_that_never_existed_cannot_be_faked_on_a_full_disk(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Sem o arquivo e sem espaço nada se grava: é por isso que o supervisor o cria antes de o agente
    # subir (e o trata como mudo se ele continuar sem existir). O agente, ao menos, não quebra.
    path = tmp_path / "runtime" / "last-alive"
    diary = AbsenceDiary(path, FakeClock(datetime(2026, 11, 5, tzinfo=UTC)))

    def full(self: Path, *args: Any, **kwargs: Any) -> int:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(Path, "write_text", full)
    diary.beat()
    assert not path.exists()


async def test_a_supervisor_whose_signal_came_back_is_not_killed_by_the_repair(
    tmp_path: Path,
) -> None:
    alive = tmp_path / "supervisor-alive"
    alive.write_text("x", encoding="ascii")
    order: list[str] = []

    def kill() -> bool:
        order.append("kill")
        return True

    def start(name: str) -> bool:
        order.append("start")
        return True

    # Na hora do reparo o sinal já está recente (a verificação o leu velho, o PC acordou).
    check = supervisor_check(
        tmp_path,
        name="teste",
        now=lambda: alive.stat().st_mtime + 10,
        start_task=start,
        kill_supervisor=kill,
        recheck=0.0,
    )
    assert check.repair is not None
    assert await check.repair() is None
    assert order == []


def spawn_fake_supervisor(runner: Path, marker: Path) -> Any:
    import subprocess  # noqa: PLC0415

    runner.parent.mkdir(parents=True, exist_ok=True)
    runner.write_text(
        "$child = Start-Process -PassThru -WindowStyle Hidden ping "
        "-ArgumentList '-n','120','127.0.0.1'\n"
        f"Set-Content -LiteralPath '{marker}' -Value $child.Id\n"
        "Start-Sleep -Seconds 120\n",
        encoding="ascii",
    )
    powershell = os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    )
    return subprocess.Popen(  # noqa: S603 - PowerShell do sistema; script do próprio teste
        [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(runner)],
        creationflags=0x08000000,
    )


def alive_pid(pid: int) -> bool:
    import subprocess  # noqa: PLC0415

    done = subprocess.run(  # noqa: S603 - tasklist do sistema
        [
            os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "tasklist.exe"),
            "/FI",
            f"PID eq {pid}",
            "/NH",
        ],
        capture_output=True,
        text=True,
        check=False,
        creationflags=0x08000000,
    )
    return str(pid) in done.stdout


@pytest.mark.skipif(os.name != "nt", reason="mata processos do Windows")
def test_the_real_kill_takes_the_supervisor_and_its_children_and_leaves_the_others(
    tmp_path: Path,
) -> None:
    runner = tmp_path / "UniOver" / "app" / "tools" / "run-agent.ps1"
    marker = tmp_path / "child.pid"
    decoy_runner = tmp_path / "Outra" / "app" / "tools" / "run-agent.ps1"
    decoy_marker = tmp_path / "decoy-child.pid"
    target = spawn_fake_supervisor(runner, marker)
    decoy = spawn_fake_supervisor(decoy_runner, decoy_marker)
    try:
        end = time.monotonic() + 60
        while not (marker.exists() and decoy_marker.exists()) and time.monotonic() < end:
            time.sleep(0.2)
        assert marker.exists() and decoy_marker.exists(), "os falsos supervisores não subiram"
        child = int(marker.read_text(encoding="ascii").strip())
        decoy_child = int(decoy_marker.read_text(encoding="ascii").strip())
        assert kill_wedged_supervisor(runner) is True
        assert target.wait(timeout=20) is not None
        end = time.monotonic() + 20
        while alive_pid(child) and time.monotonic() < end:
            time.sleep(0.3)
        assert not alive_pid(child), "o filho do supervisor sobrou órfão"
        # Outro supervisor (de outra pasta) e o filho dele seguem vivos.
        assert decoy.poll() is None and alive_pid(decoy_child)
    finally:
        for proc in (target, decoy):
            if proc.poll() is None:
                proc.kill()
        for marker_file in (marker, decoy_marker):
            if marker_file.exists():
                import subprocess  # noqa: PLC0415

                subprocess.run(  # noqa: S603 - taskkill do sistema; só o que o teste abriu
                    [
                        os.path.join(
                            os.environ.get("SystemRoot", r"C:\Windows"), "System32", "taskkill.exe"
                        ),
                        "/PID",
                        marker_file.read_text(encoding="ascii").strip(),
                        "/F",
                    ],
                    capture_output=True,
                    check=False,
                    creationflags=0x08000000,
                )


def test_the_stalled_connection_is_only_logged_from_the_second_unhealthy_beat(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # Ao acordar de uma suspensão o prazo de um passo parece vencido por um instante: um alarme
    # falso viraria ocorrência de erro na tela do dono.
    diary = AbsenceDiary(tmp_path / "last-alive", FakeClock(datetime(2026, 11, 5, tzinfo=UTC)))
    seen: list[int] = []

    def unhealthy() -> bool:
        # Quantos alarmes já havia quando a leitura número N foi feita.
        seen.append(len([r for r in caplog.records if "conexão está parada" in r.getMessage()]))
        return False

    diary.require_healthy(unhealthy)

    async def beats() -> None:
        task = asyncio.create_task(diary.run())
        for _ in range(60):
            if len(seen) >= 4:
                break
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    with caplog.at_level("ERROR"):
        asyncio.run(beats())
    assert seen[:4] == [0, 0, 1, 1], "o alarme sai na segunda leitura ruim, uma vez só"


async def test_a_startup_failure_hook_that_never_returns_does_not_stop_the_loop() -> None:
    transport = FakeTransport([[], []])
    transport.connect_error = TransportError("sem rede")
    calls = 0

    async def stuck(exc: BaseException, unexpected: bool, count: int) -> None:
        nonlocal calls
        calls += 1
        await never()

    supervisor = build(transport, on_startup_failure=stuck)
    await run_until(supervisor, lambda: transport.connects >= 3 and calls >= 2)
    assert transport.connects >= 3 and calls >= 2, "o gancho preso parou o laço de conexão"


@pytest.mark.skipif(os.name != "nt", reason="mata processos do Windows")
def test_a_killer_that_lives_inside_the_supervisor_tree_survives_and_the_supervisor_dies(
    tmp_path: Path,
) -> None:
    """Como no PC: supervisor -> uv -> agente -> este PowerShell. O agente que repara o supervisor
    é descendente dele; o reparo não pode levá-lo junto antes de acabar."""
    import subprocess  # noqa: PLC0415
    import sys  # noqa: PLC0415

    runner = tmp_path / "UniOver" / "app" / "tools" / "run-agent.ps1"
    result = tmp_path / "result.txt"
    survived = tmp_path / "survived.txt"
    code = (
        "import time\n"
        "from pathlib import Path\n"
        "from uniover_agent.adapters.self_care_checks import kill_wedged_supervisor\n"
        f"done = kill_wedged_supervisor(Path(r'{runner}'))\n"
        f"Path(r'{result}').write_text(str(done))\n"
        "time.sleep(1.5)\n"
        f"Path(r'{survived}').write_text('vivo')\n"
    )
    script = tmp_path / "killer.py"
    script.write_text(code, encoding="utf-8")
    runner.parent.mkdir(parents=True)
    # O supervisor falso roda o "agente" como filho e espera por ele.
    runner.write_text(
        f"& '{sys.executable}' '{script}'\nStart-Sleep -Seconds 120\n", encoding="ascii"
    )
    powershell = os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    )
    supervisor = subprocess.Popen(  # noqa: S603 - PowerShell do sistema; script do próprio teste
        [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(runner)],
        creationflags=0x08000000,
    )
    try:
        end = time.monotonic() + 90
        while not survived.exists() and time.monotonic() < end:
            time.sleep(0.3)
        assert result.exists() and result.read_text() == "True", "o reparo não terminou"
        assert survived.exists(), "o agente morreu junto com o supervisor que ele matou"
        assert supervisor.wait(timeout=30) is not None, "o supervisor travado seguiu vivo"
    finally:
        if supervisor.poll() is None:
            supervisor.kill()


@pytest.mark.skipif(os.name != "nt", reason="mata processos do Windows")
def test_only_the_supervisors_seen_silent_are_killed_not_a_newer_one(tmp_path: Path) -> None:
    from uniover_agent.adapters.self_care_checks import supervisor_pids  # noqa: PLC0415

    runner = tmp_path / "UniOver" / "app" / "tools" / "run-agent.ps1"
    old_marker = tmp_path / "old.pid"
    new_marker = tmp_path / "new.pid"
    old = spawn_fake_supervisor(runner, old_marker)
    newer = None
    try:
        end = time.monotonic() + 60
        while not old_marker.exists() and time.monotonic() < end:
            time.sleep(0.2)
        seen = supervisor_pids(runner)
        assert old.pid in seen
        # O lançador, pedido logo depois, sobe um supervisor novo antes de a morte chegar.
        newer = spawn_fake_supervisor(runner, new_marker)
        end = time.monotonic() + 60
        while not new_marker.exists() and time.monotonic() < end:
            time.sleep(0.2)
        assert kill_wedged_supervisor(runner, only=seen) is True
        assert old.wait(timeout=20) is not None
        assert newer.poll() is None, "o supervisor novo morreu junto"
    finally:
        for proc in (old, newer):
            if proc is not None and proc.poll() is None:
                proc.kill()
        for marker_file in (old_marker, new_marker):
            if marker_file.exists():
                import subprocess  # noqa: PLC0415

                subprocess.run(  # noqa: S603 - taskkill do sistema; só o que o teste abriu
                    [
                        os.path.join(
                            os.environ.get("SystemRoot", r"C:\Windows"), "System32", "taskkill.exe"
                        ),
                        "/PID",
                        marker_file.read_text(encoding="ascii").strip(),
                        "/F",
                    ],
                    capture_output=True,
                    check=False,
                    creationflags=0x08000000,
                )


@pytest.mark.skipif(os.name != "nt", reason="mata processos do Windows")
def test_an_ancestor_supervisor_takes_its_other_children_with_it(tmp_path: Path) -> None:
    """Quando o supervisor é ancestral de quem mata, os filhos dele que NÃO estão na cadeia (o
    ícone, o `uv` de um `self-update`) morrem com a árvore; quem mata sobrevive."""
    import subprocess  # noqa: PLC0415
    import sys  # noqa: PLC0415

    runner = tmp_path / "UniOver" / "app" / "tools" / "run-agent.ps1"
    result = tmp_path / "result.txt"
    survived = tmp_path / "survived.txt"
    sibling = tmp_path / "sibling.pid"
    code = (
        "import time\n"
        "from pathlib import Path\n"
        "from uniover_agent.adapters.self_care_checks import kill_wedged_supervisor\n"
        f"done = kill_wedged_supervisor(Path(r'{runner}'))\n"
        f"Path(r'{result}').write_text(str(done))\n"
        "time.sleep(1.5)\n"
        f"Path(r'{survived}').write_text('vivo')\n"
    )
    script = tmp_path / "killer.py"
    script.write_text(code, encoding="utf-8")
    runner.parent.mkdir(parents=True)
    runner.write_text(
        "$other = Start-Process -PassThru -WindowStyle Hidden ping "
        "-ArgumentList '-n','120','127.0.0.1'\n"
        f"Set-Content -LiteralPath '{sibling}' -Value $other.Id\n"
        f"& '{sys.executable}' '{script}'\n"
        "Start-Sleep -Seconds 120\n",
        encoding="ascii",
    )
    powershell = os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    )
    supervisor = subprocess.Popen(  # noqa: S603 - PowerShell do sistema; script do próprio teste
        [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(runner)],
        creationflags=0x08000000,
    )
    try:
        end = time.monotonic() + 90
        while not survived.exists() and time.monotonic() < end:
            time.sleep(0.3)
        assert result.exists() and result.read_text() == "True", "o reparo não terminou"
        assert survived.exists(), "quem mata morreu junto"
        assert supervisor.wait(timeout=30) is not None
        pid = int(sibling.read_text(encoding="ascii").strip())
        end = time.monotonic() + 20
        while alive_pid(pid) and time.monotonic() < end:
            time.sleep(0.3)
        assert not alive_pid(pid), "o filho do supervisor (fora da cadeia) ficou órfão"
    finally:
        if supervisor.poll() is None:
            supervisor.kill()
        if sibling.exists():
            subprocess.run(  # noqa: S603 - taskkill do sistema; só o que o teste abriu
                [
                    os.path.join(
                        os.environ.get("SystemRoot", r"C:\Windows"), "System32", "taskkill.exe"
                    ),
                    "/PID",
                    sibling.read_text(encoding="ascii").strip(),
                    "/F",
                ],
                capture_output=True,
                check=False,
                creationflags=0x08000000,
            )
