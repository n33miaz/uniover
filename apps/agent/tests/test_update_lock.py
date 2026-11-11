"""A trava de atualização: preparar, aplicar e a passagem do supervisor não se cruzam."""

import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from uniover_agent.adapters import current_pointer as pointer
from uniover_agent.adapters.update_lock import mutex_name, update_lock
from uniover_agent.composition import maintenance as maintenance_module
from uniover_agent.composition.system import EXIT_OK
from uniover_agent.main import main

from .test_current_pointer import NEW, OLD, make_slot

HOLDER = """
import sys, time
from pathlib import Path
from uniover_agent.adapters.update_lock import update_lock
with update_lock(Path(sys.argv[1])) as held:
    print("held" if held else "refused", flush=True)
    time.sleep(60)
"""


@contextmanager
def held_by_another_process(base: Path) -> Iterator[subprocess.Popen[str]]:
    """Um processo de verdade que segura a trava (como o supervisor numa passagem)."""
    holder = subprocess.Popen(  # noqa: S603 - o próprio interpretador do teste
        [sys.executable, "-c", HOLDER, str(base)], stdout=subprocess.PIPE, text=True
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "held"
        yield holder
    finally:
        holder.kill()
        holder.wait(timeout=10)


def test_the_name_depends_only_on_the_installation_folder() -> None:
    first = mutex_name(Path(r"C:\Users\a\AppData\Local\UniOver"))
    assert first == mutex_name(Path(r"c:\users\A\appdata\local\uniover"))
    assert first != mutex_name(Path(r"C:\Users\b\AppData\Local\UniOver"))
    assert first.startswith("Local\\UniOver-Update-")


@pytest.mark.skipif(sys.platform != "win32", reason="a trava é um mutex do Windows")
def test_another_process_holding_the_lock_refuses_this_one_until_it_dies(tmp_path: Path) -> None:
    with held_by_another_process(tmp_path) as holder:
        with update_lock(tmp_path) as held:
            assert held is False
        with update_lock(tmp_path, wait_seconds=0.3) as held:
            assert held is False
        holder.kill()
        holder.wait(timeout=10)
        # O dono morreu: a trava é solta pelo sistema (mutex abandonado) e esta passa.
        deadline = time.monotonic() + 10
        taken = False
        while time.monotonic() < deadline and not taken:
            with update_lock(tmp_path) as held:
                taken = held
            time.sleep(0.2)
        assert taken


def test_two_updates_in_the_same_process_take_turns(tmp_path: Path) -> None:
    with update_lock(tmp_path, wait_seconds=1) as first:
        assert first is True
    with update_lock(tmp_path, wait_seconds=1) as second:
        assert second is True


@pytest.mark.skipif(sys.platform != "win32", reason="a trava é um mutex do Windows")
def test_a_self_update_during_a_handover_waits_then_gives_up_without_touching_anything(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    base = tmp_path / "home"
    monkeypatch.setenv("UNIOVER_HOME", str(base))
    monkeypatch.setattr(maintenance_module, "UPDATE_LOCK_WAIT_SECONDS", 0.3)

    def must_not_run(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a atualização não podia rodar com a trava na mão de outro")

    monkeypatch.setattr(maintenance_module, "self_update", must_not_run)
    monkeypatch.setattr(maintenance_module, "apply_prepared", must_not_run)
    # Uma passagem em andamento: a versão A é a que sobe, a B está só preparada.
    passing = make_slot(base, OLD)
    other = make_slot(base, NEW)
    pointer.write_prepared(base, OLD)
    (base / "runtime" / pointer.HANDOVER_FILE).write_text(OLD, encoding="ascii")
    before = (base / "runtime" / "prepared.json").read_text(encoding="utf-8")
    with held_by_another_process(base):
        assert main(["self-update"]) == EXIT_OK
        assert main(["self-update", "--apply"]) == EXIT_OK
    assert "Outra atualização está em andamento" in capsys.readouterr().out
    # Nada foi apagado nem podado, e o estado de atualização nem foi tocado.
    assert passing.app.is_dir()
    assert passing.venv.is_dir()
    assert other.app.is_dir()
    assert (base / "runtime" / "prepared.json").read_text(encoding="utf-8") == before
    assert not (base / "runtime" / "update-status.json").exists()


def test_pruning_never_removes_the_version_that_is_being_handed_over(tmp_path: Path) -> None:
    current = make_slot(tmp_path, NEW)
    passing = make_slot(tmp_path, OLD)
    stale = make_slot(tmp_path, "c" * 40)
    pointer.switch_to(tmp_path, current)
    # `prepared.json` já aponta para outra: só a marca da passagem protege A.
    pointer.write_prepared(tmp_path, "c" * 40)
    (tmp_path / "runtime" / pointer.HANDOVER_FILE).write_text(OLD, encoding="ascii")
    assert pointer.handover_sha(tmp_path) == OLD
    pointer.prune(tmp_path)
    assert passing.app.exists()
    assert passing.venv.exists()
    assert current.app.exists()
    assert not stale.app.exists(), "o que ninguém usa nem marcou sai"
    (tmp_path / "runtime" / pointer.HANDOVER_FILE).unlink()
    pointer.write_prepared(tmp_path, NEW)
    pointer.prune(tmp_path)
    assert not passing.app.exists(), "sem a marca, a antiga sem uso sai"


def test_a_malformed_handover_mark_protects_nothing(tmp_path: Path) -> None:
    (tmp_path / "runtime").mkdir()
    (tmp_path / "runtime" / pointer.HANDOVER_FILE).write_text(r"..\..\fora", encoding="ascii")
    assert pointer.handover_sha(tmp_path) is None
