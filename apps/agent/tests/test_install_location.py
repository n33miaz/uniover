"""Pasta de instalação escolhida: o ponteiro, quem o segue e a arrumação automática dela."""

import os
import time
from pathlib import Path

import pytest

from uniover_agent import config
from uniover_agent.adapters import housekeeping, installation, tray_status
from uniover_agent.adapters.agent_log_file import SUPERVISOR_HEADER, FileLogSource
from uniover_agent.adapters.apk_tools import default_icons_dir


@pytest.fixture
def anchor(tmp_path: Path) -> Path:
    folder = tmp_path / "localappdata" / "UniOver"
    folder.mkdir(parents=True)
    return folder


def point_to(anchor: Path, target: Path) -> None:
    (anchor / installation.LOCATION_FILE).write_text(str(target) + "\r\n", encoding="utf-8")


def test_without_a_pointer_everything_stays_in_the_fixed_folder(anchor: Path) -> None:
    assert installation.anchor_dir() == anchor
    assert installation.chosen_location() is None
    assert installation.installation_base() == anchor


def test_the_pointer_moves_the_base_and_may_hold_accents(anchor: Path, tmp_path: Path) -> None:
    chosen = tmp_path / "Programas à vontade" / "UniOver"
    chosen.mkdir(parents=True)
    point_to(anchor, chosen)
    assert installation.chosen_location() == chosen
    assert installation.installation_base() == chosen


def test_a_pointer_to_a_folder_that_is_gone_or_not_absolute_is_ignored(
    anchor: Path, tmp_path: Path
) -> None:
    point_to(anchor, tmp_path / "sumiu")
    assert installation.installation_base() == anchor
    (anchor / installation.LOCATION_FILE).write_text("pasta\\relativa", encoding="utf-8")
    assert installation.installation_base() == anchor
    (anchor / installation.LOCATION_FILE).write_text("", encoding="utf-8")
    assert installation.installation_base() == anchor


def test_the_home_variable_wins_only_when_it_is_absolute(
    anchor: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(installation.HOME_ENV, str(tmp_path / "casa"))
    assert installation.installation_base() == tmp_path / "casa"
    monkeypatch.setenv(installation.HOME_ENV, "relativa")
    assert installation.installation_base() == anchor


def test_every_path_the_agent_derives_follows_the_chosen_folder(
    anchor: Path, tmp_path: Path
) -> None:
    chosen = tmp_path / "dados"
    chosen.mkdir()
    point_to(anchor, chosen)
    assert config.default_config_path() == chosen / "config" / "agent.toml"
    assert config.tv_cert_dir("sala") == chosen / "tv" / "sala"
    assert config.agent_source_dir() == chosen / "app"
    assert default_icons_dir() == chosen / "icons"
    assert tray_status.status_path() == chosen / "runtime" / "tray-status.json"


def test_the_migration_keeps_the_launcher_in_the_fixed_folder_and_the_rest_in_the_chosen_one(
    anchor: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `migrate_layout` aponta variáveis do processo para a instalação: o pytest as devolve.
    for name in ("UNIOVER_LOG_FILE", "UV_PROJECT_ENVIRONMENT", "UNIOVER_CONFIG_FILE"):
        monkeypatch.setenv(name, "antes")
    chosen = tmp_path / "dados"
    (chosen / "app" / "tools").mkdir(parents=True)
    (chosen / "app" / "tools" / "launcher.ps1").write_text("# lançador\n", encoding="utf-8")
    (chosen / "app" / "tools" / "run-agent.ps1").write_text("# supervisor\n", encoding="utf-8")
    point_to(anchor, chosen)

    assert installation.migrate_layout() == chosen

    assert (anchor / "launcher.ps1").read_text(encoding="utf-8") == "# lançador\n"
    assert (chosen / "run-agent.fallback.ps1").is_file()
    assert not (chosen / "launcher.ps1").exists()
    assert {"runtime", "config", "logs", "web"} <= {p.name for p in chosen.iterdir()}
    assert not (anchor / "runtime").exists()
    assert os.environ["UNIOVER_LOG_FILE"] == str(chosen / "logs" / "agent.log")
    assert os.environ["UV_PROJECT_ENVIRONMENT"] == str(chosen / "runtime" / "venv")


# --- arrumação ----------------------------------------------------------------------------------


def old(path: Path, hours: float) -> None:
    stamp = time.time() - hours * 3600
    os.utime(path, (stamp, stamp))


def test_tidy_creates_the_standard_folders_once(tmp_path: Path) -> None:
    first = housekeeping.tidy(tmp_path)
    assert sorted(first) == sorted(f"pasta {name} criada" for name in housekeeping.STANDARD_FOLDERS)
    assert housekeeping.tidy(tmp_path) == []


def test_tidy_keeps_only_the_two_newest_rejected_versions_of_each_kind(tmp_path: Path) -> None:
    housekeeping.tidy(tmp_path)
    runtime = tmp_path / "runtime"
    for prefix in ("app.rejected-", "app.incomplete-"):
        for index in range(4):
            folder = runtime / f"{prefix}{index}"
            folder.mkdir()
            (folder / "x.txt").write_text("x", encoding="utf-8")
            old(folder, 10 - index)  # o 3 é o mais novo
    done = housekeeping.tidy(tmp_path)
    assert len(done) == 4
    assert sorted(p.name for p in runtime.iterdir()) == [
        "app.incomplete-2",
        "app.incomplete-3",
        "app.rejected-2",
        "app.rejected-3",
    ]


def test_tidy_removes_the_leftovers_of_an_update_that_never_finished_after_a_day(
    tmp_path: Path,
) -> None:
    housekeeping.tidy(tmp_path)
    stale = [tmp_path / "app.new", tmp_path / "app.new.venv", tmp_path / "uniover-update-abc"]
    for folder in stale:
        folder.mkdir()
        old(folder, 30)
    fresh = tmp_path / "uniover-update-em-andamento"
    fresh.mkdir()
    (tmp_path / "runtime" / "diagnostics.jsonl.tmp").write_text("x", encoding="utf-8")
    old(tmp_path / "runtime" / "diagnostics.jsonl.tmp", 30)
    housekeeping.tidy(tmp_path)
    assert not any(folder.exists() for folder in stale)
    assert fresh.exists()  # uma atualização que está acontecendo agora não é resto
    assert not (tmp_path / "runtime" / "diagnostics.jsonl.tmp").exists()


def test_tidy_never_touches_what_it_does_not_know(tmp_path: Path) -> None:
    housekeeping.tidy(tmp_path)
    keep = {
        "app": tmp_path / "app",
        "previous": tmp_path / "app.previous",
        "tv": tmp_path / "tv" / "sala",
        "config": tmp_path / "config" / "agent.toml",
        "log": tmp_path / "logs" / "agent.log",
        "pairing": tmp_path / "runtime" / "update-trial.txt",
        "page": tmp_path / "web" / "conectar.html",
    }
    for path in keep.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix:
            path.write_text("x", encoding="utf-8")
        else:
            path.mkdir()
        old(path, 500)
    housekeeping.tidy(tmp_path)
    assert all(path.exists() for path in keep.values())


# --- registro do supervisor junto ao do agente --------------------------------------------------


def test_the_end_of_the_supervisor_log_goes_with_the_agent_log_without_passing_the_limit(
    tmp_path: Path,
) -> None:
    agent = tmp_path / "agent.log"
    supervisor = tmp_path / "supervisor.log"
    agent.write_text("\n".join(f"agente {i}" for i in range(100)), encoding="utf-8")
    supervisor.write_text("\n".join(f"supervisor {i}" for i in range(100)), encoding="utf-8")
    source = FileLogSource(agent, supervisor=supervisor)
    lines = source.tail(40)
    assert len(lines) <= 40
    assert SUPERVISOR_HEADER in lines
    split = lines.index(SUPERVISOR_HEADER)
    assert lines[split - 1] == "agente 99" and lines[-1] == "supervisor 99"
    assert all(line.startswith("agente") for line in lines[:split])


def test_without_a_supervisor_log_or_for_tiny_requests_only_the_agent_log_comes(
    tmp_path: Path,
) -> None:
    agent = tmp_path / "agent.log"
    agent.write_text("a\nb\nc", encoding="utf-8")
    assert FileLogSource(agent, supervisor=tmp_path / "nao-existe.log").tail(2) == ["b", "c"]
    supervisor = tmp_path / "supervisor.log"
    supervisor.write_text("s", encoding="utf-8")
    assert FileLogSource(agent, supervisor=supervisor).tail(3) == ["a", "b", "c"]
