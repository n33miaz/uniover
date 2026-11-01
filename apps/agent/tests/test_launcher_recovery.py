"""Lançador: refaz a pasta `app` quando o computador caiu no meio da troca da atualização.

A troca é `app -> app.previous` e depois `app.new -> app`. Se a queda vier entre as duas, não existe
`app` e o supervisor não teria de onde subir. O lançador de verdade (Windows PowerShell 5.1), numa
instalação falsa em pasta temporária, com supervisores de mentira que só anotam quem os iniciou.
"""

import json
import os
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from .launcher_isolation import isolated_launcher
from .support import powershell_write_atomic, read_text_retrying

SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
POWERSHELL = SYSTEM32 / "WindowsPowerShell" / "v1.0" / "powershell.exe"
TASKKILL = SYSTEM32 / "taskkill.exe"
pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

OLD = "a" * 40
NEW = "b" * 40
BAD = "d" * 40


def stub(tag: str) -> str:
    """Supervisor de mentira: anota quem foi iniciado e fica vivo até o teste o encerrar."""
    write = powershell_write_atomic("$env:UNIOVER_TEST_MARKER", f"'{tag}'")
    return write + "Start-Sleep -Seconds 120\n"


def folder(base: Path, name: str, tag: str, sha: str | None, *, complete: bool = True) -> Path:
    path = base / name
    (path / "tools").mkdir(parents=True)
    if complete:
        (path / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (path / "tools" / "run-agent.ps1").write_text(stub(tag), encoding="ascii")
    if sha:
        (path / ".version").write_text(sha + "\n", encoding="ascii")
    return path


def run_launcher(tmp_path: Path, *, until: Callable[[], bool] | None = None) -> str:
    """Roda o lançador até um supervisor de mentira anotar quem é; devolve a anotação."""
    base = tmp_path / "UniOver"
    marker = tmp_path / "started.txt"
    launcher = subprocess.Popen(  # noqa: S603 - Windows PowerShell do sistema; script do repositório
        [
            str(POWERSHELL),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(isolated_launcher(tmp_path)),
        ],
        env=os.environ | {"LOCALAPPDATA": str(tmp_path), "UNIOVER_TEST_MARKER": str(marker)},
        creationflags=0x08000000,
    )
    try:
        for _ in range(600):
            if marker.exists() and (until is None or until()):
                break
            time.sleep(0.1)
        assert base.is_dir()
        return read_text_retrying(marker, encoding="utf-8-sig").strip() if marker.exists() else ""
    finally:
        subprocess.run(  # noqa: S603 - taskkill do sistema, só para encerrar o que o teste abriu
            [str(TASKKILL), "/PID", str(launcher.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            creationflags=0x08000000,
        )
        launcher.wait(timeout=10)


def state(base: Path) -> dict[str, object]:
    loaded: dict[str, object] = json.loads(
        (base / "runtime" / "update-status.json").read_text(encoding="utf-8")
    )
    return loaded


def log(base: Path) -> str:
    path = base / "logs" / "supervisor.log"
    return path.read_text(encoding="utf-8") if path.exists() else ""


def test_a_fall_between_the_two_renames_is_repaired_with_the_validated_candidate(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    folder(base, "app.previous", "anterior", OLD)
    folder(base, "app.new", "candidata", NEW)
    assert not (base / "app").exists()

    assert run_launcher(tmp_path) == "candidata"

    assert (base / "app" / ".version").read_text(encoding="ascii").strip() == NEW
    assert not (base / "app.new").exists()
    assert (base / "app.previous" / ".version").read_text(encoding="ascii").strip() == OLD
    # A versão promovida nunca rodou: fica em prova, com a anterior guardada para voltar.
    assert (base / "runtime" / "update-trial.txt").read_text(encoding="ascii") == f"{NEW}|0"
    assert state(base)["outcome"] == "updated"
    assert "promovi app.new" in log(base)


def test_without_a_usable_candidate_the_previous_version_comes_back(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    folder(base, "app.previous", "anterior", OLD)
    # Uma candidata pela metade (sem o .version, que só se grava com ela inteira) não serve.
    folder(base, "app.new", "candidata", None)
    (base / "runtime").mkdir()
    (base / "runtime" / "update-trial.txt").write_text(f"{NEW}|2", encoding="ascii")

    assert run_launcher(tmp_path) == "anterior"

    assert (base / "app" / ".version").read_text(encoding="ascii").strip() == OLD
    assert not (base / "app.previous").exists()
    assert not (base / "runtime" / "update-trial.txt").exists()
    current = state(base)
    assert (current["outcome"], current["rolledBack"]) == ("rolled_back", True)
    assert "restaurei app.previous" in log(base)


def test_an_incomplete_app_folder_is_set_aside_not_deleted_and_its_version_is_blocked(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    folder(base, "app", "quebrada", BAD, complete=False)
    (base / "app" / "resto.txt").write_text("o que sobrou", encoding="utf-8")
    # Com app presente a candidata pode estar sendo escrita: a anterior é a segura.
    folder(base, "app.new", "candidata", NEW)
    folder(base, "app.previous", "anterior", OLD)

    assert run_launcher(tmp_path) == "anterior"

    (aside,) = (base / "runtime").glob("app.incomplete-*")
    assert (aside / "resto.txt").read_text(encoding="utf-8") == "o que sobrou"
    assert (base / "runtime" / ".blocked-versions").read_text(encoding="ascii").split() == [BAD]
    assert state(base)["blockedSha"] == BAD
    assert (base / "app" / ".version").read_text(encoding="ascii").strip() == OLD
    assert (base / "app.new" / ".version").read_text(encoding="ascii").strip() == NEW


def test_an_update_in_progress_is_never_touched_while_app_is_in_place(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    folder(base, "app", "atual", OLD)
    folder(base, "app.new", "candidata", NEW)  # ainda sendo validada pela atualização
    folder(base, "app.previous", "anterior", "e" * 40)

    assert run_launcher(tmp_path) == "atual"

    assert (base / "app.new" / ".version").read_text(encoding="ascii").strip() == NEW
    assert (base / "app" / ".version").read_text(encoding="ascii").strip() == OLD
    assert not (base / "runtime" / "update-status.json").exists()
    assert "promovi" not in log(base)


def test_the_old_layout_is_left_to_the_agents_own_migration(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    legacy = base / "agent-src" / "tools"
    legacy.mkdir(parents=True)
    (legacy / "run-agent.ps1").write_text(stub("legado"), encoding="ascii")
    folder(base, "app.previous", "anterior", OLD)

    assert run_launcher(tmp_path) == "legado"

    assert not (base / "app").exists()
    assert (base / "app.previous").is_dir()


def test_with_nothing_to_restore_the_launcher_goes_on_to_the_fallback_and_says_so_once(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    base.mkdir()
    (base / "run-agent.fallback.ps1").write_text(stub("reserva"), encoding="ascii")

    assert run_launcher(tmp_path) == "reserva"

    assert not (base / "app").exists()
    assert log(base).count("nao ha app.new nem app.previous") == 1
    assert state(base)["outcome"] == "failed"


def _anchor_with_pointer(tmp_path: Path, pointer: str | bytes | None) -> Path:
    anchor = tmp_path / "UniOver"
    anchor.mkdir()
    if isinstance(pointer, str):
        (anchor / "location.txt").write_text(pointer, encoding="utf-8")
    elif isinstance(pointer, bytes):
        (anchor / "location.txt").write_bytes(pointer)
    return anchor


def test_the_launcher_follows_the_pointer_to_the_folder_chosen_at_the_install(
    tmp_path: Path,
) -> None:
    """A tarefa abre o lançador da pasta fixa; ele sobe o supervisor da pasta escolhida."""
    chosen = tmp_path / "Programas Ação" / "UniOver"
    chosen.mkdir(parents=True)
    anchor = _anchor_with_pointer(tmp_path, str(chosen))
    folder(anchor, "app", "da-pasta-fixa", OLD)
    folder(chosen, "app", "da-pasta-escolhida", NEW)

    assert run_launcher(tmp_path) == "da-pasta-escolhida"


def test_the_pointer_may_be_written_with_a_bom_and_extra_lines(tmp_path: Path) -> None:
    chosen = tmp_path / "Outro Lugar" / "UniOver"
    chosen.mkdir(parents=True)
    _anchor_with_pointer(tmp_path, b"\xef\xbb\xbf" + str(chosen).encode("utf-8") + b"\r\nlixo\r\n")
    folder(chosen, "app", "da-pasta-escolhida", NEW)

    assert run_launcher(tmp_path) == "da-pasta-escolhida"


@pytest.mark.parametrize("pointer", ["", r"pasta\relativa", r"ZZ:\nao\existe\UniOver", "   "])
def test_an_invalid_pointer_is_ignored_and_the_fixed_folder_is_used(
    tmp_path: Path, pointer: str
) -> None:
    anchor = _anchor_with_pointer(tmp_path, pointer)
    folder(anchor, "app", "da-pasta-fixa", OLD)

    assert run_launcher(tmp_path) == "da-pasta-fixa"


def test_a_pointer_to_a_folder_that_no_longer_exists_falls_back_to_the_fixed_one(
    tmp_path: Path,
) -> None:
    anchor = _anchor_with_pointer(tmp_path, str(tmp_path / "disco-que-sumiu" / "UniOver"))
    folder(anchor, "app", "da-pasta-fixa", OLD)

    assert run_launcher(tmp_path) == "da-pasta-fixa"


def test_the_launcher_records_what_it_did_in_the_supervisor_log_and_the_diagnostic_queue(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    folder(base, "app.previous", "anterior", OLD)
    assert run_launcher(tmp_path) == "anterior"

    assert "restaurei app.previous" in log(base)
    assert not (base / "logs" / "agent.log").exists()
    lines = (base / "runtime" / "diagnostics.jsonl").read_text(encoding="utf-8").splitlines()
    entry = json.loads(lines[0])
    assert (entry["kind"], entry["component"]) == ("installation.restored", "launcher")
    assert entry["detail"].isascii()
