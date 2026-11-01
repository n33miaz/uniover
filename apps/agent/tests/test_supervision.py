"""Tarefas de fundo supervisionadas: nenhuma morre calada e as que são laços voltam sozinhas."""

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.test_diagnostics import MemoryStore
from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.core.diagnostics import DiagnosticsRecorder
from uniover_agent.core.supervision import TaskHealth, keep_running, run_supervised
from uniover_agent.main import supervise


def recorder(clock: FakeClock) -> tuple[DiagnosticsRecorder, MemoryStore]:
    store = MemoryStore()
    return DiagnosticsRecorder(store, FakeClock(datetime(2026, 10, 31, tzinfo=UTC))), store


async def test_a_job_that_raises_is_logged_recorded_and_started_again(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = FakeClock()
    rec, store = recorder(clock)
    runs = 0

    async def job() -> None:
        nonlocal runs
        runs += 1
        if runs == 1:
            raise TimeoutError("segredo uo_dev_ABC")

    with caplog.at_level(logging.ERROR):
        finished = await run_supervised("tv.watch", job, clock=clock, recorder=rec)
    assert finished is True
    assert runs == 2
    [event] = store.events
    assert (event.kind, event.severity, event.component) == (
        "background.failed",
        "error",
        "tv.watch",
    )
    assert "TimeoutError" in event.detail and "uo_dev_ABC" not in event.detail
    # O registro local leva a pilha inteira (e o texto da exceção).
    assert "Traceback" in caplog.text or any(r.exc_info for r in caplog.records)


async def test_the_wait_doubles_on_each_failure_up_to_the_cap() -> None:
    clock = FakeClock()
    runs = 0

    async def job() -> None:
        nonlocal runs
        runs += 1
        if runs <= 6:
            raise RuntimeError("x")

    await run_supervised("t", job, clock=clock, first_delay=1, max_delay=8)
    assert clock.sleeps == [1, 2, 4, 8, 8, 8]


async def test_a_job_that_lived_long_enough_starts_the_wait_over() -> None:
    clock = FakeClock()
    runs = 0

    async def job() -> None:
        nonlocal runs
        runs += 1
        if runs == 3:
            clock.advance(120)  # viveu mais que `stable_after` antes de cair
        if runs <= 3:
            raise RuntimeError("x")

    await run_supervised("t", job, clock=clock, first_delay=1, max_delay=60, stable_after=60)
    assert clock.sleeps == [1, 2, 1]


async def test_cancelling_passes_through_and_is_not_restarted() -> None:
    clock = FakeClock()
    started = asyncio.Event()

    async def job() -> None:
        started.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(run_supervised("t", job, clock=clock))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert clock.sleeps == []


async def test_a_job_that_finishes_by_itself_returns_true_and_keep_running_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = FakeClock()

    async def job() -> None:
        return None

    assert await run_supervised("t", job, clock=clock) is True
    with caplog.at_level(logging.WARNING):
        await keep_running("tarefa.curta", job, clock=clock)
    assert "terminou por conta própria" in caplog.text


async def test_failures_are_counted_per_task_and_age_out() -> None:
    clock = FakeClock()
    health = TaskHealth(clock)
    health.note_failure("a")
    health.note_failure("a")
    health.note_failure("b")
    assert health.recent_failures() == {"a": 2, "b": 1}
    clock.advance(3601)
    health.note_failure("b")
    assert health.recent_failures() == {"b": 1}


async def test_run_supervised_feeds_the_health_counter() -> None:
    clock = FakeClock()
    health = TaskHealth(clock)
    runs = 0

    async def job() -> None:
        nonlocal runs
        runs += 1
        if runs < 4:
            raise RuntimeError("x")

    await run_supervised("laco", job, clock=clock, health=health)
    assert health.recent_failures() == {"laco": 3}


class Connection:
    """Fio que cede a vez algumas vezes e termina: o fim da conexão com a API."""

    def __init__(self, turns: int) -> None:
        self.turns = turns

    async def run(self) -> None:
        for _ in range(self.turns):
            await asyncio.sleep(0)


class Watcher:
    def __init__(self, behaviour: list[Any]) -> None:
        self.behaviour = behaviour
        self.runs = 0

    async def run(self) -> Any:
        step = self.behaviour[min(self.runs, len(self.behaviour) - 1)]
        self.runs += 1
        if isinstance(step, Exception):
            raise step
        if step == "forever":
            await asyncio.Event().wait()
        return step


async def test_an_error_in_the_address_watcher_is_not_mistaken_for_the_tv_moving() -> None:
    watcher = Watcher([RuntimeError("bug"), "forever"])
    moved = await supervise(Connection(30), watcher, clock=FakeClock())  # type: ignore[arg-type]
    assert moved is False
    assert watcher.runs == 2


async def test_the_watcher_returning_on_its_own_still_means_the_tv_moved() -> None:
    watcher = Watcher(["novo-endereco"])
    moved = await supervise(Connection(50), watcher, clock=FakeClock())  # type: ignore[arg-type]
    assert moved is True


async def test_without_a_watcher_the_connection_alone_decides() -> None:
    assert await supervise(Connection(2), None, clock=FakeClock()) is False  # type: ignore[arg-type]
