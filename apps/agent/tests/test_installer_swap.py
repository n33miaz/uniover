# ruff: noqa: E501 - scripts de PowerShell em texto
"""Reinstalação: a versão que funciona só sai do lugar depois que o pacote novo está inteiro.

As funções vêm do próprio `install-windows.ps1` (pela árvore sintática) e rodam no Windows PowerShell
5.1, numa pasta temporária; a rede é trocada por funções que entregam um zip do teste. Nada toca a
instalação real nem a tarefa agendada.
"""

import io
import os
import subprocess
import zipfile
from pathlib import Path

import pytest

INSTALLER = Path(__file__).parents[1] / "tools" / "install-windows.ps1"
SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
POWERSHELL = SYSTEM32 / "WindowsPowerShell" / "v1.0" / "powershell.exe"
pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

SHA = "c" * 40
GOOD = {
    "apps/agent/pyproject.toml": b"[project]\n",
    "apps/agent/tools/run-agent.ps1": b"# supervisor novo\n",
    "apps/agent/src/uniover_agent/main.py": b"print('novo')\n",
}

PRELUDE = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:UNIOVER_TEST_INSTALLER, [ref]$tokens, [ref]$errors)
foreach ($name in $env:UNIOVER_TEST_FUNCTIONS.Split(',')) {
    $found = $ast.Find({ param($node) ($node -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($node.Name -eq $name) }, $true)
    Invoke-Expression $found.Extent.Text
}
$taskName = 'UniOver agente teste'
$source = $env:UNIOVER_TEST_DEST
# A rede do teste: o commit e o zip vem do ambiente.
function Invoke-RestMethod { param([switch]$UseBasicParsing, [string]$Uri, $Headers) [pscustomobject]@{ sha = $env:UNIOVER_TEST_SHA } }
function Invoke-WebRequest { param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile) Copy-Item -LiteralPath $env:UNIOVER_TEST_ZIP -Destination $OutFile }
"""


def package(entries: dict[str, bytes], sha: str = SHA) -> bytes:
    """Zip no formato do GitHub: tudo dentro de `uniover-<sha>/`."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for name, data in entries.items():
            bundle.writestr(f"uniover-{sha}/{name}", data)
    return buffer.getvalue()


def installed(tmp_path: Path) -> Path:
    """Uma instalação que funciona: `app` com a versão antiga e um arquivo de identificação."""
    app = tmp_path / "UniOver" / "app"
    (app / "tools").mkdir(parents=True)
    (app / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (app / "tools" / "run-agent.ps1").write_text("# supervisor antigo\n", encoding="ascii")
    (app / ".version").write_text("a" * 40 + "\n", encoding="ascii")
    (app / "marca.txt").write_text("a que funciona", encoding="utf-8")
    return app


def run(
    tmp_path: Path, body: str, archive: bytes = b"", *functions: str, app: Path | None = None
) -> subprocess.CompletedProcess[str]:
    destination = app or tmp_path / "UniOver" / "app"
    zipped = tmp_path / "pacote.zip"
    zipped.write_bytes(archive)
    script = tmp_path / "ensaio.ps1"
    script.write_text(PRELUDE + body, encoding="ascii")
    (tmp_path / "T").mkdir(exist_ok=True)
    environment = os.environ | {
        "UNIOVER_TEST_INSTALLER": str(INSTALLER),
        "UNIOVER_TEST_FUNCTIONS": ",".join(
            functions or ("Get-AgentSource", "Get-MoveFailureReason", "Move-Folder")
        ),
        "UNIOVER_TEST_DEST": str(destination),
        "UNIOVER_TEST_ZIP": str(zipped),
        "UNIOVER_TEST_SHA": SHA,
        "TEMP": str(tmp_path / "T"),
    }
    return subprocess.run(  # noqa: S603 - Windows PowerShell do sistema e script do próprio teste
        [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        timeout=120,
    )


def untouched(app: Path) -> None:
    """A instalação que funcionava ficou exatamente como estava, sem restos ao lado."""
    assert (app / "marca.txt").read_text(encoding="utf-8") == "a que funciona"
    assert (app / ".version").read_text(encoding="ascii").strip() == "a" * 40
    assert sorted(path.name for path in app.parent.iterdir()) == ["app"]


def test_a_reinstall_puts_the_new_package_in_place_and_keeps_the_old_one_as_previous(
    tmp_path: Path,
) -> None:
    app = installed(tmp_path)
    done = run(tmp_path, "Get-AgentSource $source", package(GOOD))
    assert done.returncode == 0, done.stderr
    assert (app / ".version").read_text(encoding="ascii").strip() == SHA
    assert (app / "tools" / "run-agent.ps1").read_text(encoding="ascii") == "# supervisor novo\n"
    assert not (app / "marca.txt").exists()
    previous = app.parent / "app.previous"
    assert (previous / "marca.txt").read_text(encoding="utf-8") == "a que funciona"
    assert (previous / ".version").read_text(encoding="ascii").strip() == "a" * 40
    assert sorted(path.name for path in app.parent.iterdir()) == ["app", "app.previous"]


def test_a_first_install_has_nothing_to_keep(tmp_path: Path) -> None:
    app = tmp_path / "UniOver" / "app"
    app.parent.mkdir()
    done = run(tmp_path, "Get-AgentSource $source", package(GOOD))
    assert done.returncode == 0, done.stderr
    assert (app / "pyproject.toml").is_file()
    assert sorted(path.name for path in app.parent.iterdir()) == ["app"]


def test_a_stale_previous_folder_gives_way_to_the_one_that_is_leaving(tmp_path: Path) -> None:
    app = installed(tmp_path)
    stale = app.parent / "app.previous"
    stale.mkdir()
    (stale / "velha.txt").write_text("de outra vez", encoding="utf-8")
    done = run(tmp_path, "Get-AgentSource $source", package(GOOD))
    assert done.returncode == 0, done.stderr
    assert not (stale / "velha.txt").exists()
    assert (stale / "marca.txt").is_file()


def test_a_download_that_is_not_a_zip_leaves_the_working_install_untouched(tmp_path: Path) -> None:
    app = installed(tmp_path)
    done = run(tmp_path, "Get-AgentSource $source", b"isto nao e um zip")
    assert done.returncode != 0
    untouched(app)


def test_a_zip_without_the_agent_leaves_the_working_install_untouched(tmp_path: Path) -> None:
    app = installed(tmp_path)
    done = run(tmp_path, "Get-AgentSource $source", package({"README.md": b"so isto\n"}))
    assert done.returncode != 0
    assert "apps" in done.stderr
    untouched(app)


def test_a_package_that_breaks_halfway_through_the_extraction_leaves_it_untouched(
    tmp_path: Path,
) -> None:
    app = installed(tmp_path)
    # `tools` chega como arquivo e depois como pasta: a extração cai no meio, com a candidata já pela metade.
    broken = {
        "apps/agent/pyproject.toml": b"[project]\n",
        "apps/agent/tools": b"arquivo onde deveria haver pasta",
        "apps/agent/tools/run-agent.ps1": b"# nunca chega\n",
    }
    done = run(tmp_path, "Get-AgentSource $source", package(broken))
    assert done.returncode != 0
    untouched(app)


def test_a_path_that_escapes_the_folder_is_refused_without_touching_the_install(
    tmp_path: Path,
) -> None:
    app = installed(tmp_path)
    escaping = {"apps/agent/pyproject.toml": b"[project]\n", "apps/agent/../../fora.txt": b"x"}
    done = run(tmp_path, "Get-AgentSource $source", package(escaping))
    assert done.returncode != 0
    untouched(app)
    assert not (tmp_path / "fora.txt").exists()


def test_a_folder_in_use_is_not_renamed_and_the_install_stays_as_it_was(tmp_path: Path) -> None:
    app = installed(tmp_path)
    # Arquivo aberto sem compartilhar a exclusão: o Windows não deixa renomear a pasta que o contém.
    with (app / "marca.txt").open("rb"):
        done = run(tmp_path, "Get-AgentSource $source", package(GOOD))
    assert done.returncode != 0
    assert "em uso" in done.stderr
    untouched(app)


def test_a_transient_lock_on_a_new_folder_is_retried_before_the_rename(tmp_path: Path) -> None:
    body = r"""
$from = Join-Path $env:TEMP 'candidata'
$to = Join-Path $env:TEMP 'destino'
New-Item -ItemType Directory -Path $from | Out-Null
$file = Join-Path $from 'marca.txt'
[System.IO.File]::WriteAllText($file, 'nova')
$stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
$script:waits = 0
function Start-Sleep {
    param([int]$Milliseconds)
    $script:waits++
    $stream.Dispose()
}
Move-Folder $from $to
"$script:waits $(Test-Path -LiteralPath $to)"
"""
    done = run(tmp_path, body, b"", "Move-Folder")
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "1 True"


def test_when_the_second_rename_fails_the_old_install_comes_back(tmp_path: Path) -> None:
    app = installed(tmp_path)
    body = r"""
$script:moves = 0
function Move-Folder {
    param([string]$From, [string]$To)
    $script:moves++
    if ($script:moves -eq 2) { throw 'simulado: a segunda renomeacao falhou' }
    [System.IO.Directory]::Move($From, $To)
}
Get-AgentSource $source
"""
    done = run(tmp_path, body, package(GOOD))
    assert done.returncode != 0
    assert "simulado: a segunda renomeacao falhou" in done.stderr
    untouched(app)


def restore(tmp_path: Path, *, run_agent: bool, task: bool) -> list[str]:
    """`Restore-RunningAgent` com o Agendador trocado por funções que só anotam o que foi pedido."""
    app = tmp_path / "UniOver" / "app"
    (app / "tools").mkdir(parents=True)
    tmp_path.mkdir(exist_ok=True)
    if run_agent:
        (app / "tools" / "run-agent.ps1").write_text("# supervisor\n", encoding="ascii")
    body = f"""
$script:calls = @()
function Get-ScheduledTask {{ param($TaskName, $ErrorAction) if ('{task}' -eq 'True') {{ [pscustomobject]@{{ TaskName = $TaskName }} }} }}
function Start-ScheduledTask {{ param($TaskName, $ErrorAction) $script:calls += $TaskName }}
Restore-RunningAgent
$script:calls
"""
    done = run(tmp_path, body, b"", "Restore-RunningAgent", app=app)
    assert done.returncode == 0, done.stderr
    return done.stdout.split("\n")[:-1] if done.stdout.strip() else []


def test_a_failed_install_starts_the_scheduled_task_again_when_there_is_an_install(
    tmp_path: Path,
) -> None:
    assert [line.strip() for line in restore(tmp_path, run_agent=True, task=True)] == [
        "UniOver agente teste"
    ]


def test_a_failed_install_does_not_start_anything_without_an_install_or_a_task(
    tmp_path: Path,
) -> None:
    assert restore(tmp_path / "a", run_agent=False, task=True) == []
    assert restore(tmp_path / "b", run_agent=True, task=False) == []


def test_the_failure_paths_of_the_installer_restart_the_agent() -> None:
    installer = INSTALLER.read_text(encoding="utf-8")
    automatic = installer[
        installer.index("if ($automatic) {") : installer.index("# --- Modo manual")
    ]
    assert "Restore-RunningAgent" in automatic
    manual = installer[installer.index("# --- Modo manual") :]
    assert "trap { Restore-RunningAgent; break }" in manual
    assert manual.index("trap {") < manual.index("$uv = Find-Uv")


def test_the_elevated_programs_come_from_absolute_system_paths_that_exist() -> None:
    installer = INSTALLER.read_text(encoding="utf-8")
    start = installer.index("$elevated = @'")
    block = installer[start : installer.index("'@", start + 20)]
    assert "& powercfg" not in block
    assert block.count("& $powercfg /change") == 2
    after = installer[installer.index("function Set-SystemSettings") :]
    assert "-FilePath 'powershell.exe'" not in after
    assert "-FilePath $systemShell -Verb RunAs" in after
    # As duas atribuições, avaliadas no PowerShell de verdade: os arquivos existem e estão em System32.
    lines = [
        line.strip()
        for line in after.splitlines()  # `after` já contém o bloco elevado
        if line.strip().startswith(("$powercfg = ", "$systemShell = "))
    ]
    assert len(lines) == 2
    command = ";".join(
        [*lines, "$powercfg;(Test-Path $powercfg);$systemShell;(Test-Path $systemShell)"]
    )
    done = subprocess.run(  # noqa: S603 - Windows PowerShell do sistema; só monta e confere dois caminhos
        [str(POWERSHELL), "-NoProfile", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    powercfg, found_powercfg, shell, found_shell = done.stdout.split()
    assert Path(powercfg) == SYSTEM32 / "powercfg.exe"
    assert Path(shell) == POWERSHELL
    assert (found_powercfg, found_shell) == ("True", "True")
