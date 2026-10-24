"""Migração idempotente da pasta que fica no computador da pessoa."""

from pathlib import Path

import pytest

from uniover_agent.adapters import installation
from uniover_agent.adapters.installation import migrate_layout


def test_migrate_layout_organizes_legacy_files_without_overwriting_new_ones(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    base = tmp_path / "UniOver"
    (base / "agent-src").mkdir(parents=True)
    (base / "agent-src" / "pyproject.toml").write_text("old", encoding="utf-8")
    (base / "venv").mkdir()
    (base / "agent.toml").write_text('agent_id = "pc"', encoding="utf-8")
    (base / "agent.log").write_text("registro", encoding="utf-8")
    (base / "conectar.html").write_text("<html>", encoding="utf-8")

    migrate_layout(base)
    migrate_layout(base)

    assert (base / "app" / "pyproject.toml").read_text(encoding="utf-8") == "old"
    assert (base / "runtime" / "venv").is_dir()
    assert (base / "config" / "agent.toml").read_text(encoding="utf-8") == 'agent_id = "pc"'
    assert (base / "logs" / "agent.log").read_text(encoding="utf-8") == "registro"
    assert (base / "web" / "conectar.html").is_file()


def test_migration_can_resume_after_an_interruption_between_the_task_handoff_and_rename(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A troca do código é a única etapa crítica; repetir conclui sem perder o pareamento."""
    base = tmp_path / "UniOver"
    old = base / "agent-src"
    tools = old / "tools"
    tools.mkdir(parents=True)
    for name in ("launcher.ps1", "run-agent.ps1"):
        source = Path(__file__).parents[1] / "tools" / name
        (tools / name).write_bytes(source.read_bytes())
    (old / "pyproject.toml").write_text("old", encoding="utf-8")
    (base / "agent-src.previous").mkdir()
    (base / "agent-src.previous" / "pyproject.toml").write_text("previous", encoding="utf-8")
    (base / "venv").mkdir()
    (base / "agent.toml").write_text('agent_id = "pc"', encoding="utf-8")
    (base / "agent.log").write_text("registro", encoding="utf-8")
    (base / "conectar.html").write_text("<html>", encoding="utf-8")
    (base / ".blocked-versions").write_text("a" * 40, encoding="utf-8")
    (base / "update-trial.txt").write_text("b" * 40 + "|2", encoding="ascii")

    original_move = installation._move_once

    def interrupted(source: Path, destination: Path) -> None:
        if source == old:
            raise PermissionError("simula queda durante a troca")
        original_move(source, destination)

    monkeypatch.setattr(installation, "_move_once", interrupted)
    migrate_layout(base)

    # A tarefa já pode usar o lançador, que ainda sabe abrir o caminho legado; nada foi perdido.
    assert old.is_dir()
    assert (base / "launcher.ps1").is_file()
    assert "agent-src\\tools\\run-agent.ps1" in (base / "launcher.ps1").read_text(encoding="ascii")

    monkeypatch.setattr(installation, "_move_once", original_move)
    migrate_layout(base)

    assert (base / "app" / "pyproject.toml").read_text(encoding="utf-8") == "old"
    assert (base / "app.previous" / "pyproject.toml").read_text(encoding="utf-8") == "previous"
    assert (base / "runtime" / "venv").is_dir()
    assert (base / "config" / "agent.toml").read_text(encoding="utf-8") == 'agent_id = "pc"'
    assert (base / "logs" / "agent.log").read_text(encoding="utf-8") == "registro"
    assert (base / "web" / "conectar.html").is_file()
    assert (base / "runtime" / ".blocked-versions").read_text(encoding="utf-8") == "a" * 40
    assert (base / "runtime" / "update-trial.txt").read_text(encoding="ascii") == "b" * 40 + "|2"
    assert (base / "LEIA-ME.txt").is_file()
