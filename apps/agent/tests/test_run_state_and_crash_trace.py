"""Rastro das execuções: como a anterior terminou e o que o Python registra quando algo cai."""

import asyncio
import json
import logging
import sys
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tests.test_diagnostics import MemoryStore
from uniover_agent.adapters import crash_trace
from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.adapters.run_state import (
    STATE_FILE,
    STOP_REASON_FILE,
    SUPERVISOR_REASONS,
    RunState,
)
from uniover_agent.core.diagnostics import DiagnosticsRecorder

START = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)


def state(
    runtime: Path, *, now: datetime = START, uptime: float | None = None, pid: int = 100
) -> RunState:
    return RunState(runtime, pid=pid, now=lambda: now, uptime=lambda: uptime)


def test_the_first_ever_run_has_no_previous_trace(tmp_path: Path) -> None:
    assert state(tmp_path).begin("0.1.0") is None
    written = json.loads((tmp_path / STATE_FILE).read_text(encoding="utf-8"))
    assert (written["state"], written["pid"], written["version"]) == ("running", 100, "0.1.0")


def test_an_orderly_stop_is_remembered_with_its_reason(tmp_path: Path) -> None:
    first = state(tmp_path)
    first.begin("0.1.0")
    first.end("credencial_recusada")
    previous = state(tmp_path, now=START + timedelta(hours=1), pid=200).begin("0.1.0")
    assert previous is not None and previous.outcome == "clean"
    assert "credencial_recusada" in previous.detail


def test_only_the_first_end_counts_and_a_later_run_is_not_closed_by_an_older_one(
    tmp_path: Path,
) -> None:
    old = state(tmp_path, pid=100)
    old.begin("0.1.0")
    state(tmp_path, pid=200).begin("0.1.0")  # outra execução assumiu o arquivo
    old.end("tardio")
    assert json.loads((tmp_path / STATE_FILE).read_text(encoding="utf-8"))["state"] == "running"
    new = state(tmp_path, pid=300)
    new.begin("0.1.0")
    new.end("primeiro")
    new.end("segundo")
    assert json.loads((tmp_path / STATE_FILE).read_text(encoding="utf-8"))["reason"] == "primeiro"


def test_a_run_that_vanished_without_a_word_is_an_abrupt_end(tmp_path: Path) -> None:
    state(tmp_path).begin("0.1.0")
    previous = state(tmp_path, now=START + timedelta(hours=2), uptime=9 * 3600.0).begin("0.1.0")
    assert previous is not None and previous.outcome == "abrupt"
    assert "terminou sem se despedir" in previous.detail


def test_a_recent_windows_boot_explains_the_missing_run(tmp_path: Path) -> None:
    state(tmp_path).begin("0.1.0")
    previous = state(tmp_path, now=START + timedelta(hours=2), uptime=300.0).begin("0.1.0")
    assert previous is not None and previous.outcome == "abrupt"
    assert "foi ligado ou reiniciado há 5 min" in previous.detail


@pytest.mark.parametrize("reason", sorted(SUPERVISOR_REASONS))
def test_a_stop_the_supervisor_asked_for_is_not_a_crash(tmp_path: Path, reason: str) -> None:
    state(tmp_path).begin("0.1.0")
    (tmp_path / STOP_REASON_FILE).write_text(reason, encoding="ascii")
    previous = state(tmp_path, now=START + timedelta(minutes=5)).begin("0.1.0")
    assert previous is not None and previous.outcome == "supervisor"
    assert SUPERVISOR_REASONS[reason] in previous.detail
    # O pedido é lido uma vez: na subida seguinte não vale mais.
    assert not (tmp_path / STOP_REASON_FILE).exists()


def test_an_unknown_stop_reason_is_ignored_and_a_broken_state_file_is_no_trace(
    tmp_path: Path,
) -> None:
    state(tmp_path).begin("0.1.0")
    (tmp_path / STOP_REASON_FILE).write_text("qualquer coisa", encoding="ascii")
    previous = state(tmp_path).begin("0.1.0")
    assert previous is not None and previous.outcome == "abrupt"
    (tmp_path / STATE_FILE).write_text("{quebrado", encoding="utf-8")
    assert state(tmp_path).begin("0.1.0") is None


# --- crash_trace --------------------------------------------------------------------------------


@pytest.fixture
def traced(tmp_path: Path) -> tuple[DiagnosticsRecorder, MemoryStore, Path]:
    store = MemoryStore()
    recorder = DiagnosticsRecorder(store, FakeClock(START))
    logs = tmp_path / "logs"
    crash_trace.install_crash_trace(logs, recorder)
    return recorder, store, logs


def test_the_crash_file_is_created_and_marks_each_run(
    traced: tuple[DiagnosticsRecorder, MemoryStore, Path],
) -> None:
    _, _, logs = traced
    assert "execução iniciada" in (logs / crash_trace.CRASH_FILE).read_text(encoding="utf-8")


def test_an_unhandled_exception_is_logged_with_its_stack_recorded_and_chained(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    chained: list[type[BaseException]] = []
    monkeypatch.setattr(sys, "excepthook", lambda kind, error, trace: chained.append(kind))
    store = MemoryStore()
    crash_trace.install_crash_trace(tmp_path / "logs", DiagnosticsRecorder(store, FakeClock(START)))
    try:
        raise OSError("segredo C:\\Users\\x")
    except OSError as error:
        with caplog.at_level(logging.CRITICAL, logger="uniover_agent.crash"):
            sys.excepthook(type(error), error, error.__traceback__)
    [event] = store.events
    assert (event.kind, event.severity, event.component) == ("process.crashed", "error", "main")
    assert "segredo" not in event.detail and "OSError" in event.detail
    assert any(record.exc_info for record in caplog.records)
    # O gancho que já existia (o do interpretador, o do pytest) continua sendo chamado.
    assert chained == [OSError]


def test_ctrl_c_is_not_reported_as_a_crash(
    traced: tuple[DiagnosticsRecorder, MemoryStore, Path],
) -> None:
    _, store, _ = traced
    sys.excepthook(KeyboardInterrupt, KeyboardInterrupt(), None)
    assert store.events == []


def test_an_exception_that_kills_a_thread_is_recorded(
    traced: tuple[DiagnosticsRecorder, MemoryStore, Path],
) -> None:
    _, store, _ = traced

    def boom() -> None:
        raise ValueError("de dentro da thread")

    worker = threading.Thread(target=boom, name="leitor")
    worker.start()
    worker.join()
    [event] = store.events
    assert event.kind == "thread.failed"
    assert "leitor" in event.detail and "de dentro" not in event.detail


async def test_a_task_nobody_waited_for_is_recorded_by_the_loop_handler(
    traced: tuple[DiagnosticsRecorder, MemoryStore, Path],
) -> None:
    recorder, store, _ = traced
    handler = crash_trace.loop_exception_handler(recorder)
    handler(
        asyncio.get_running_loop(),
        {"message": "Task exception was never retrieved", "exception": KeyError("x")},
    )
    handler(asyncio.get_running_loop(), {"message": "sem exceção"})
    assert [e.kind for e in store.events] == ["loop.error", "loop.error"]
    assert "KeyError" in store.events[0].detail
    assert "KeyError" not in store.events[1].detail
