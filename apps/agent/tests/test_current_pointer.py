r"""O ponteiro da versão em uso (`runtime\current.json`) e a versão preparada (`prepared.json`)."""

import json
from pathlib import Path

import pytest

from uniover_agent.adapters import current_pointer as pointer
from uniover_agent.adapters.current_pointer import Pointer, Slot

OLD = "a" * 40
NEW = "b" * 40
OLDER = "c" * 40


def make_slot(base: Path, sha: str, *, venv: bool = True) -> Slot:
    """Uma versão preparada inteira: código, supervisor dela, marca da versão e ambiente."""
    app = pointer.staged_app(base, sha)
    (app / "tools").mkdir(parents=True)
    (app / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (app / "tools" / "run-agent.ps1").write_text("# supervisor\n", encoding="ascii")
    (app / ".version").write_text(sha + "\n", encoding="ascii")
    environment = pointer.staged_venv(base, sha)
    if venv:
        (environment / "Scripts").mkdir(parents=True)
        (environment / "Scripts" / "python.exe").write_bytes(b"")
    return Slot(sha, app, environment)


def test_without_the_file_the_layout_is_the_one_from_before(tmp_path: Path) -> None:
    resolved = pointer.resolve(tmp_path)
    assert resolved.explicit is False
    assert resolved.current == Slot(None, tmp_path / "app", tmp_path / "runtime" / "venv")
    assert resolved.previous is None
    assert pointer.current_app(tmp_path) == tmp_path / "app"
    assert pointer.previous_app(tmp_path) == tmp_path / "app.previous"


def test_the_pointer_round_trips_with_relative_paths(tmp_path: Path) -> None:
    current = make_slot(tmp_path, NEW)
    written = Pointer(current, pointer.legacy_slot(tmp_path), explicit=True)
    pointer.write(tmp_path, written)
    text = (tmp_path / "runtime" / "current.json").read_text(encoding="utf-8")
    body = json.loads(text)
    assert body["current"]["app"] == f"app.staging\\{NEW}"
    assert body["current"]["venv"] == f"runtime\\venv-{NEW}"
    assert body["previous"] == {"sha": None, "app": "app", "venv": "runtime\\venv"}
    assert tmp_path.as_posix() not in text.replace("\\", "/")
    assert pointer.read(tmp_path) == written
    assert pointer.current_app(tmp_path) == current.app
    assert pointer.previous_app(tmp_path) == tmp_path / "app"


@pytest.mark.parametrize(
    "app",
    ["C:\\Windows\\System32", "\\\\servidor\\pasta", "..\\fora", "app\\..\\..\\fora", "/etc", ""],
)
def test_a_pointer_with_an_unsafe_path_is_ignored(tmp_path: Path, app: str) -> None:
    body = {"v": 1, "current": {"sha": NEW, "app": app, "venv": "runtime\\venv"}}
    (tmp_path / "runtime").mkdir()
    (tmp_path / "runtime" / "current.json").write_text(json.dumps(body), encoding="utf-8")
    assert pointer.read(tmp_path) is None
    assert pointer.current_app(tmp_path) == tmp_path / "app"


@pytest.mark.parametrize("text", ["", "nao e json", "[]", '{"v": 1}', '{"current": "x"}'])
def test_an_unreadable_pointer_means_the_layout_from_before(tmp_path: Path, text: str) -> None:
    (tmp_path / "runtime").mkdir()
    (tmp_path / "runtime" / "current.json").write_text(text, encoding="utf-8")
    assert pointer.resolve(tmp_path).explicit is False


def test_an_oversized_pointer_file_is_not_ours(tmp_path: Path) -> None:
    (tmp_path / "runtime").mkdir()
    (tmp_path / "runtime" / "current.json").write_text(" " * 5000, encoding="utf-8")
    assert pointer.read(tmp_path) is None


def test_switching_keeps_the_one_that_was_in_use_as_the_previous(tmp_path: Path) -> None:
    first = make_slot(tmp_path, NEW)
    second = make_slot(tmp_path, OLDER)
    pointer.switch_to(tmp_path, first)
    after = pointer.switch_to(tmp_path, second)
    assert after.current == second
    assert after.previous == first
    assert pointer.read(tmp_path) == after


def test_a_slot_is_ready_only_with_code_supervisor_version_and_environment(tmp_path: Path) -> None:
    assert pointer.slot_ready(make_slot(tmp_path, NEW))
    assert not pointer.slot_ready(make_slot(tmp_path, OLDER, venv=False))
    ready = make_slot(tmp_path, OLD)
    (ready.app / "tools" / "run-agent.ps1").unlink()
    assert not pointer.slot_ready(ready)


def test_a_prepared_version_must_be_whole_and_live_in_its_own_folder(tmp_path: Path) -> None:
    assert pointer.read_prepared(tmp_path) is None
    make_slot(tmp_path, NEW)
    pointer.write_prepared(tmp_path, NEW)
    slot = pointer.read_prepared(tmp_path)
    assert slot is not None
    assert slot.sha == NEW
    assert slot.app == pointer.staged_app(tmp_path, NEW)
    # Ambiente apagado: já não está inteira, então não vale.
    (pointer.staged_venv(tmp_path, NEW) / "Scripts" / "python.exe").unlink()
    assert pointer.read_prepared(tmp_path) is None
    pointer.clear_prepared(tmp_path)
    assert not pointer.prepared_path(tmp_path).exists()


def test_a_prepared_file_pointing_somewhere_else_is_ignored(tmp_path: Path) -> None:
    make_slot(tmp_path, NEW)
    other = make_slot(tmp_path, OLDER)
    body = {"sha": NEW, "app": f"app.staging\\{OLDER}", "venv": f"runtime\\venv-{OLDER}"}
    path = pointer.prepared_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body), encoding="utf-8")
    assert pointer.read_prepared(tmp_path) is None
    assert pointer.slot_ready(other)


def test_the_folder_of_the_installation_comes_from_either_kind_of_source(tmp_path: Path) -> None:
    assert pointer.base_of(tmp_path / "app") == tmp_path
    assert pointer.base_of(pointer.staged_app(tmp_path, NEW)) == tmp_path


def test_pruning_keeps_the_current_the_previous_and_the_one_waiting(tmp_path: Path) -> None:
    current = make_slot(tmp_path, NEW)
    waiting = make_slot(tmp_path, OLD)
    stale = make_slot(tmp_path, OLDER)
    (tmp_path / "app").mkdir()
    (tmp_path / "runtime" / "venv").mkdir(parents=True, exist_ok=True)
    pointer.switch_to(tmp_path, current)
    removed = pointer.prune(tmp_path, keep_extra=frozenset({OLD}))
    assert len(removed) == 2  # a pasta e o ambiente da antiga
    assert not stale.app.exists()
    assert not stale.venv.exists()
    assert current.app.exists()
    assert current.venv.exists()
    assert waiting.app.exists()
    assert waiting.venv.exists()
    # O layout de sempre nunca é tocado.
    assert (tmp_path / "app").is_dir()
    assert (tmp_path / "runtime" / "venv").is_dir()


def test_pruning_keeps_the_previous_one_in_the_pointer(tmp_path: Path) -> None:
    previous = make_slot(tmp_path, OLD)
    current = make_slot(tmp_path, NEW)
    pointer.write(tmp_path, Pointer(current, previous, explicit=True))
    assert pointer.prune(tmp_path) == []
    assert previous.app.exists()
    assert previous.venv.exists()
