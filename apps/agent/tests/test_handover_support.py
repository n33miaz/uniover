r"""Peças de apoio da passagem sem queda: a marca de conexão, a arrumação das versões preparadas e a
pasta do código em uso (`UNIOVER_APP_DIR` e o ponteiro)."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from uniover_agent import config
from uniover_agent.adapters import current_pointer as pointer
from uniover_agent.adapters import housekeeping
from uniover_agent.adapters.connection_marker import MARKER_FILE, TOKEN_ENV, ConnectionMarker
from uniover_agent.adapters.maintenance_signals import RuntimeFlagSignals
from uniover_agent.adapters.update_status import previous_dir

from .test_current_pointer import NEW, OLD, OLDER, make_slot

TOKEN = "ab" * 16


def moment(second: int) -> datetime:
    return datetime(2026, 11, 10, 12, 0, second, 123000, tzinfo=UTC)


def read(path: Path) -> dict[str, object]:
    loaded: dict[str, object] = json.loads((path / MARKER_FILE).read_text(encoding="utf-8"))
    return loaded


# ---- marca de conexão ----


def test_the_marker_says_when_the_run_connected_and_only_the_first_time(tmp_path: Path) -> None:
    times = iter([moment(1), moment(2), moment(3)])
    marker = ConnectionMarker(tmp_path, pid=77, now=lambda: next(times))
    marker.connected()
    assert read(tmp_path) == {"pid": 77, "connectedAt": "2026-11-10T12:00:01.123Z"}
    marker.connected()  # uma reconexão não muda a marca
    assert read(tmp_path)["connectedAt"] == "2026-11-10T12:00:01.123Z"
    marker.ready()
    assert read(tmp_path)["readyAt"] == "2026-11-10T12:00:02.123Z"
    marker.ready()
    assert read(tmp_path)["readyAt"] == "2026-11-10T12:00:02.123Z"
    assert not list(tmp_path.glob("*.tmp"))


def test_the_marker_carries_the_code_the_supervisor_gave_only_when_it_is_well_formed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(TOKEN_ENV, TOKEN)
    ConnectionMarker(tmp_path, now=lambda: moment(1)).connected()
    assert read(tmp_path)["token"] == TOKEN
    monkeypatch.setenv(TOKEN_ENV, "x" * 40)
    ConnectionMarker(tmp_path, now=lambda: moment(1)).connected()
    assert "token" not in read(tmp_path)


def test_a_marker_that_cannot_be_written_never_stops_the_agent(tmp_path: Path) -> None:
    (tmp_path / "runtime").write_text("isto é um arquivo, não uma pasta", encoding="utf-8")
    marker = ConnectionMarker(tmp_path / "runtime")
    marker.connected()
    marker.ready()


# ---- arrumação ----


def test_tidy_removes_the_versions_nobody_uses_and_keeps_the_waiting_and_the_running_ones(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = make_slot(tmp_path, NEW)
    waiting = make_slot(tmp_path, OLD)
    stale = make_slot(tmp_path, OLDER)
    pointer.switch_to(tmp_path, current)
    pointer.write_prepared(tmp_path, OLD)
    done = housekeeping.tidy(tmp_path)
    assert any("versão preparada antiga" in action for action in done)
    assert not stale.app.exists()
    assert not stale.venv.exists()
    assert current.app.exists()
    assert waiting.app.exists()
    assert waiting.venv.exists()


def test_tidy_keeps_the_version_that_runs_now_even_before_the_pointer_names_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Passagem sem queda em andamento: a versão nova já roda e o ponteiro ainda é o da antiga.
    old = make_slot(tmp_path, OLD)
    running = make_slot(tmp_path, NEW)
    pointer.switch_to(tmp_path, old)
    monkeypatch.setenv("UNIOVER_APP_DIR", str(running.app))
    housekeeping.tidy(tmp_path)
    assert running.app.exists()
    assert running.venv.exists()


# ---- pasta do código em uso ----


def test_the_source_folder_is_the_one_the_supervisor_gave_then_the_pointer_then_app(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("UNIOVER_HOME", str(tmp_path))
    monkeypatch.delenv("UNIOVER_APP_DIR", raising=False)
    assert config.agent_source_dir() == tmp_path / "app"
    slot = make_slot(tmp_path, NEW)
    pointer.switch_to(tmp_path, slot)
    assert config.agent_source_dir() == slot.app
    given = tmp_path / "app.staging" / OLD
    monkeypatch.setenv("UNIOVER_APP_DIR", str(given))
    assert config.agent_source_dir() == given
    # Um valor que não é um caminho absoluto não vale.
    monkeypatch.setenv("UNIOVER_APP_DIR", "relativo")
    assert config.agent_source_dir() == slot.app


def test_the_previous_version_comes_from_the_pointer_when_there_is_one(tmp_path: Path) -> None:
    app = tmp_path / "app"
    assert previous_dir(app) == tmp_path / "app.previous"
    first = make_slot(tmp_path, OLD)
    second = make_slot(tmp_path, NEW)
    pointer.write(tmp_path, pointer.Pointer(second, first, explicit=True))
    assert previous_dir(second.app) == first.app
    signals = RuntimeFlagSignals(tmp_path / "runtime")
    assert signals.previous_available() is False  # sem o código de manutenção remota nela


def test_installing_again_starts_from_the_layout_from_before_by_dropping_the_pointer() -> None:
    installer = (Path(__file__).parents[1] / "tools" / "install-windows.ps1").read_text(
        encoding="utf-8"
    )
    assert installer.count("'current.json', 'prepared.json'") == 2
