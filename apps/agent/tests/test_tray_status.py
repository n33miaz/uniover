"""A bandeja consome somente um estado pequeno, sem token nem comandos da TV."""

import asyncio
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.adapters.tray_status import (
    REWRITE_SECONDS,
    TrayStatus,
    heartbeat_age,
    read_state_text,
    read_tray_inputs,
)
from uniover_agent.core.domain import TvState
from uniover_agent.core.tray_model import view_of


def runtime(tmp_path: Path) -> Path:
    return tmp_path / "UniOver" / "runtime"


def test_tray_status_writes_connected_tv_state_atomically(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    status = TrayStatus("Sala")
    status.connected()
    status.tv_state(TvState("on", None, None, "hot"))

    saved = json.loads((runtime(tmp_path) / "tray-status.json").read_text())
    since = datetime.fromisoformat(saved.pop("since"))
    assert saved == {"connected": True, "power": "on", "tv_name": "Sala"}
    assert abs(datetime.now(UTC) - since) < timedelta(minutes=1)


def test_since_changes_only_when_the_connection_changes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    status = TrayStatus("Sala")
    status.connected()
    first = json.loads((runtime(tmp_path) / "tray-status.json").read_text())["since"]

    status.connected()
    status.tv_state(TvState("off", None, None, "hibernating"))

    assert json.loads((runtime(tmp_path) / "tray-status.json").read_text())["since"] == first


def test_the_tray_reads_connection_update_and_heartbeat_together(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    now = datetime.now(UTC)
    status = TrayStatus("Sala")
    status.connected()
    status.tv_state(TvState("on", None, None, "hot"))
    (runtime(tmp_path) / "last-alive").write_text("x", encoding="utf-8")
    (runtime(tmp_path) / "update-status.json").write_text(
        json.dumps(
            {
                "outcome": "failed",
                "checkedAt": now.isoformat().replace("+00:00", "Z"),
                "reason": "sem rede",
            }
        ),
        encoding="utf-8",
    )

    inputs = read_tray_inputs(now)
    view = view_of(inputs)

    assert (inputs.connected, inputs.power, inputs.tv_name) == (True, "on", "Sala")
    assert inputs.update_outcome == "failed"
    assert inputs.heartbeat_age is not None
    assert (view.state, view.attention) == ("connected", True)


def test_a_missing_or_broken_state_reads_as_reconnecting_without_failing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    now = datetime.now(UTC)

    assert view_of(read_tray_inputs(now)).state == "reconnecting"

    (runtime(tmp_path)).mkdir(parents=True)
    (runtime(tmp_path) / "tray-status.json").write_text("{ nao e json", encoding="utf-8")
    (runtime(tmp_path) / "update-status.json").write_text("[]", encoding="utf-8")

    inputs = read_tray_inputs(now)
    assert inputs.connected is False
    assert inputs.update_outcome == "not_checked"


def test_a_stale_heartbeat_turns_a_connected_file_into_an_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    TrayStatus("Sala").connected()
    alive = runtime(tmp_path) / "last-alive"
    alive.write_text("x", encoding="utf-8")
    old = (datetime.now(UTC) - timedelta(minutes=30)).timestamp()
    os.utime(alive, (old, old))

    inputs = read_tray_inputs(datetime.now(UTC))

    assert inputs.heartbeat_age is not None
    assert inputs.heartbeat_age > timedelta(minutes=20)
    assert view_of(inputs).state == "error"


def test_no_heartbeat_file_means_unknown(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    assert heartbeat_age(datetime.now(UTC)) is None


def saved(tmp_path: Path) -> dict[str, Any]:
    decoded: dict[str, Any] = json.loads((runtime(tmp_path) / "tray-status.json").read_text())
    return decoded


def block_replace(monkeypatch: pytest.MonkeyPatch, failures: list[int]) -> list[int]:
    """Faz `Path.replace` falhar enquanto `failures[0]` for positivo; devolve as chamadas feitas."""
    original = Path.replace
    calls: list[int] = []

    def replace(self: Path, target: Path) -> Path:
        calls.append(1)
        if failures[0] > 0:
            failures[0] -= 1
            raise PermissionError("[WinError 5] bandeja lendo o arquivo")
        return original(self, target)

    monkeypatch.setattr(Path, "replace", replace)
    return calls


def test_a_replace_that_fails_then_succeeds_ends_with_the_correct_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    status = TrayStatus("Sala", retry_delays=(0.0, 0.0, 0.0))
    failures = [2]
    calls = block_replace(monkeypatch, failures)

    status.connected()
    status.wait_retries()

    assert saved(tmp_path)["connected"] is True
    assert len(calls) == 3
    assert status.dirty is False
    assert list(runtime(tmp_path).glob("*.new")) == []


def test_a_replace_that_always_fails_is_healed_by_the_periodic_rewrite(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    clock = FakeClock()
    status = TrayStatus("Sala", clock, retry_delays=(0.0, 0.0))
    failures = [1000]
    block_replace(monkeypatch, failures)

    status.connected()
    status.wait_retries()

    # As novas tentativas desistiram: o arquivo continua velho e o estado fica pendente.
    assert saved(tmp_path)["connected"] is False
    assert status.dirty is True
    assert list(runtime(tmp_path).glob("*.new")) == []

    failures[0] = 0
    original = clock.sleep

    async def sleep_once(seconds: float) -> None:
        if clock.sleeps:
            raise asyncio.CancelledError
        await original(seconds)

    monkeypatch.setattr(clock, "sleep", sleep_once)

    async def one_tick() -> None:
        with pytest.raises(asyncio.CancelledError):
            await status.run()

    asyncio.run(one_tick())

    assert clock.sleeps == [REWRITE_SECONDS]
    assert saved(tmp_path)["connected"] is True
    assert status.dirty is False


def test_no_exception_escapes_when_the_write_cannot_succeed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    block_replace(monkeypatch, [1000])
    status = TrayStatus("Sala", retry_delays=(0.0, 0.0))

    status.connected()
    status.tv_state(TvState("on", None, None, "hot"))
    status.disconnected()
    status.wait_retries()

    assert status.dirty is True


def test_a_write_from_the_event_loop_does_not_sleep_there(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    status = TrayStatus("Sala", retry_delays=(5.0,))
    block_replace(monkeypatch, [1000])
    sleeps: list[float] = []
    monkeypatch.setattr("uniover_agent.adapters.tray_status.time.sleep", sleeps.append)

    status.connected()
    status.wait_retries()

    # O único sono acontece na thread de nova tentativa, nunca em quem chamou `write()`.
    assert sleeps == [5.0]


def test_the_tray_read_retries_when_windows_briefly_denies_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    TrayStatus("Sala").connected()
    original = Path.read_text
    denied = [2]

    def read_text(self: Path, *args: Any, **kwargs: Any) -> str:
        if denied[0] > 0:
            denied[0] -= 1
            raise PermissionError("[WinError 5] agente trocando o arquivo")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    monkeypatch.setattr("uniover_agent.adapters.tray_status.time.sleep", lambda _: None)

    inputs = read_tray_inputs(datetime.now(UTC))

    assert inputs.connected is True
    assert denied[0] == 0
    assert read_state_text(runtime(tmp_path) / "tray-status.json")
