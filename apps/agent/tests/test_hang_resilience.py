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


async def test_a_wedged_supervisor_is_taken_out_before_the_task_is_started(tmp_path: Path) -> None:
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
    assert order == ["kill", "start teste"]


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
