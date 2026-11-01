"""Nome de usuário com acento (`C:\\Users\\João`): o caminho da atualização não exige ASCII.

Os testes usam uma pasta temporária de nome acentuado; a instalação real do computador não é tocada.
"""

import ast
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from uniover_agent.adapters import installation

from .support import powershell_write_atomic, read_text_retrying

TOOLS = Path(__file__).parents[1] / "tools"
SOURCE = Path(__file__).parents[1] / "src" / "uniover_agent"
SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
POWERSHELL = SYSTEM32 / "WindowsPowerShell" / "v1.0" / "powershell.exe"
WSCRIPT = SYSTEM32 / "wscript.exe"
NO_WINDOW = 0x08000000
ACCENTED = "João Ção"
pytestmark = pytest.mark.skipif(not WSCRIPT.is_file(), reason="precisa do Windows Script Host")


def test_the_script_host_probe_works_when_the_folder_has_accents(tmp_path: Path) -> None:
    root = tmp_path / ACCENTED / "UniOver"
    assert installation._windows_script_host_works(root) is True
    # A prova não deixa nada para trás.
    assert sorted(path.name for path in (root / "runtime").iterdir()) == []


def test_the_probe_script_itself_is_ascii_and_carries_no_path() -> None:
    assert installation.WSH_PROBE_VBS.isascii()
    assert ":\\" not in installation.WSH_PROBE_VBS
    assert "WScript.Arguments(0)" in installation.WSH_PROBE_VBS


def test_no_script_written_by_the_agent_embeds_a_path_through_an_ascii_only_encoding() -> None:
    """Só texto fixo (constantes) pode ser gravado em ASCII; um caminho do usuário nunca."""
    tree = ast.parse((SOURCE / "adapters" / "installation.py").read_text(encoding="utf-8"))
    receivers = [
        ast.unparse(node.func.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "encode"
        and node.args
        and ast.unparse(node.args[0]) in {"'ascii'", '"ascii"'}
    ]
    assert receivers
    assert set(receivers) <= {"LAUNCHER_VBS", "WSH_PROBE_VBS"}


def test_the_task_action_keeps_the_accented_path_exactly_as_the_scheduler_receives_it(
    tmp_path: Path,
) -> None:
    """O texto que vai ao Agendador, avaliado no Windows PowerShell 5.1 (sem tocar em tarefas)."""
    root = tmp_path / ACCENTED / "UniOver"
    script = installation.launcher_task_script(root)
    # As quatro primeiras linhas só atribuem variáveis (`$exe`, `$arg`, `$name`).
    header = script.split("\n")[:4]
    assert header[2].startswith("$arg=")
    out = tmp_path / "arg.txt"
    utf8 = "(New-Object System.Text.UTF8Encoding($false))"
    command = "\n".join(
        [*header, f"[System.IO.File]::WriteAllText('{out}', $arg, {utf8})"],
    )
    done = subprocess.run(  # noqa: S603 - Windows PowerShell do sistema; só atribui e grava um arquivo do teste
        [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        creationflags=NO_WINDOW,
    )
    assert done.returncode == 0, done.stderr
    assert out.read_text(encoding="utf-8") == f'//B //Nologo "{root / "launcher.vbs"}"'


def test_the_shipped_launcher_vbs_starts_the_launcher_under_an_accented_local_app_data(
    tmp_path: Path,
) -> None:
    """O arquivo que a tarefa abre, de verdade, com `LOCALAPPDATA` acentuado."""
    local = tmp_path / ACCENTED / "Local"
    base = local / "UniOver"
    base.mkdir(parents=True)
    shutil.copyfile(TOOLS / "launcher.vbs", base / "launcher.vbs")
    marker = tmp_path / "started.txt"
    (base / "launcher.ps1").write_text(
        powershell_write_atomic("$env:UNIOVER_TEST_MARKER", "$PSCommandPath"),
        encoding="ascii",
    )
    subprocess.run(  # noqa: S603 - Windows Script Host do sistema e o .vbs do repositório
        [str(WSCRIPT), "//B", "//Nologo", str(base / "launcher.vbs")],
        check=True,
        env=os.environ | {"LOCALAPPDATA": str(local), "UNIOVER_TEST_MARKER": str(marker)},
        timeout=60,
        creationflags=NO_WINDOW,
    )
    for _ in range(300):
        if marker.exists():
            break
        time.sleep(0.1)
    assert read_text_retrying(marker, encoding="utf-8-sig").strip() == str(base / "launcher.ps1")
