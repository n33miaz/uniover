"""A bandeja consome somente um estado pequeno, sem token nem comandos da TV."""

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from uniover_agent.adapters.tray_status import TrayStatus, heartbeat_age, read_tray_inputs
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
