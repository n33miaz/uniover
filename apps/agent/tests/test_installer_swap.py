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
# O registro tecnico da instalacao (Write-InstallLog) vai para uma pasta so do teste, fora da instalacao falsa.
$base = Join-Path $env:TEMP 'base'
# A rede do teste: o commit e o zip vem do ambiente.
function Invoke-RestMethod { param([switch]$UseBasicParsing, [string]$Uri, $Headers) [pscustomobject]@{ sha = $env:UNIOVER_TEST_SHA } }
function Invoke-WebRequest { param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile) Copy-Item -LiteralPath $env:UNIOVER_TEST_ZIP -Destination $OutFile }
"""


def package(entries: dict[str, bytes], sha: str = SHA, comment: str | None = None) -> bytes:
    """Zip no formato do GitHub: tudo dentro de `uniover-<sha>/` e o commit no comentário do zip."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.comment = (sha if comment is None else comment).encode("ascii")
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
            functions
            or (
                "Get-AgentSource",
                "Get-MoveFailureReason",
                "Move-Folder",
                "Get-ZipComment",
                "Write-InstallLog",
            )
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
    assert "incompleto" in done.stderr
    untouched(app)


def test_a_package_from_another_commit_is_refused_before_anything_is_extracted(
    tmp_path: Path,
) -> None:
    app = installed(tmp_path)
    done = run(tmp_path, "Get-AgentSource $source", package(GOOD, comment="d" * 40))
    assert done.returncode != 0
    assert "nao e da versao esperada" in done.stderr
    untouched(app)


def test_a_package_without_the_commit_comment_is_refused(tmp_path: Path) -> None:
    app = installed(tmp_path)
    done = run(tmp_path, "Get-AgentSource $source", package(GOOD, comment=""))
    assert done.returncode != 0
    assert "nao e da versao esperada" in done.stderr
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
    assert "aberto por outro programa" in done.stderr
    # O motivo tecnico (com o caminho) fica so no registro da instalacao, nao na frase da pessoa.
    assert "HRESULT" in (tmp_path / "T" / "base" / "logs" / "instalacao.log").read_text(
        encoding="utf-8"
    )
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
    assert "Nao consegui colocar a versao nova no lugar" in done.stderr
    # O motivo tecnico fica so no registro da instalacao.
    log = (tmp_path / "T" / "base" / "logs" / "instalacao.log").read_text(encoding="utf-8")
    assert "simulado: a segunda renomeacao falhou" in log
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
    assert "trap { Restore-PreviousVersion; Restore-RunningAgent; break }" in manual
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


def test_a_candidate_that_fails_its_rehearsal_never_replaces_the_working_install(
    tmp_path: Path,
) -> None:
    """O ensaio (preparar e examinar a candidata) roda antes da troca: falhou, nada saiu do lugar."""
    app = installed(tmp_path)
    done = run(
        tmp_path,
        "Get-AgentSource $source { param($Candidate) throw 'a versao baixada nao funciona' }",
        package(GOOD),
    )
    assert done.returncode != 0
    assert "nao funciona" in done.stderr
    untouched(app)


def test_the_rehearsal_receives_the_candidate_folder_and_the_swap_happens_after_it(
    tmp_path: Path,
) -> None:
    app = installed(tmp_path)
    marker = tmp_path / "ensaio.txt"
    body = (
        "Get-AgentSource $source { param($Candidate) "
        f"Set-Content -LiteralPath '{marker}' -Value ((Test-Path -LiteralPath (Join-Path $Candidate 'pyproject.toml')).ToString() "
        "+ '|' + (Test-Path -LiteralPath (Join-Path $source 'marca.txt')).ToString()) }"
    )
    done = run(tmp_path, body, package(GOOD))
    assert done.returncode == 0, done.stderr
    # A candidata estava inteira e a instalação antiga ainda no lugar quando o ensaio rodou.
    assert marker.read_text(encoding="utf-8-sig").strip() == "True|True"
    assert (app / ".version").read_text(encoding="ascii").strip() == SHA


def test_a_failure_after_the_swap_puts_the_previous_version_back(tmp_path: Path) -> None:
    app = installed(tmp_path)
    body = "Get-AgentSource $source\nRestore-PreviousVersion\n"
    done = run(
        tmp_path,
        body,
        package(GOOD),
        "Get-AgentSource",
        "Get-MoveFailureReason",
        "Move-Folder",
        "Get-ZipComment",
        "Write-InstallLog",
        "Restore-PreviousVersion",
    )
    assert done.returncode == 0, done.stderr
    untouched_apart_from_previous = (app / "marca.txt").read_text(encoding="utf-8")
    assert untouched_apart_from_previous == "a que funciona"
    assert (app / ".version").read_text(encoding="ascii").strip() == "a" * 40
    assert sorted(path.name for path in app.parent.iterdir()) == ["app"]


def test_both_install_modes_rehearse_the_candidate_and_restore_the_previous_version_on_failure() -> (
    None
):
    installer = INSTALLER.read_text(encoding="utf-8")
    # Ensaio da candidata (preparar no ambiente dela e examinar) acontece dentro de Get-AgentSource, antes da troca.
    assert (
        installer.count(
            "Get-AgentSource $source { param($Candidate) Test-Candidate $uv $Candidate }"
        )
        == 2
    )
    assert "if ($Verify) { & $Verify $candidate }" in installer
    assert installer.index("if ($Verify) { & $Verify $candidate }") < installer.index(
        "Move-Folder $Destination $oldFolder"
    )
    # Falha depois da troca devolve a versão anterior antes de religar o agente, nos dois modos.
    automatic = installer[
        installer.index("if ($automatic) {") : installer.index("# --- Modo manual")
    ]
    assert automatic.index("Restore-PreviousVersion") < automatic.index("Restore-RunningAgent")
    assert "trap { Restore-PreviousVersion; Restore-RunningAgent; break }" in installer


def _fake_uv(tmp_path: Path, *, sync_code: int, check_code: int) -> Path:
    """`uv` de mentira: registra o ambiente com que foi chamado e sai com o código pedido."""
    script = tmp_path / "uv-falso.cmd"
    script.write_text(
        "@echo off\r\n"
        'echo %1 %UV_PROJECT_ENVIRONMENT%>>"%UNIOVER_TEST_RECORD%"\r\n'
        f'if "%1"=="sync" exit /b {sync_code}\r\n'
        f"exit /b {check_code}\r\n",
        encoding="ascii",
    )
    return script


def _rehearse(
    tmp_path: Path, *, sync_code: int, check_code: int
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    candidate = tmp_path / "UniOver" / "app.new"
    candidate.mkdir(parents=True)
    record = tmp_path / "chamadas.txt"
    uv = _fake_uv(tmp_path, sync_code=sync_code, check_code=check_code)
    body = (
        "$env:UV_PROJECT_ENVIRONMENT = 'ambiente-do-agente'\n"
        f"Test-Candidate '{uv}' '{candidate}'\n"
        "Write-Output ('ambiente depois: ' + $env:UV_PROJECT_ENVIRONMENT)\n"
    )
    environment_record = {"UNIOVER_TEST_RECORD": str(record)}
    os.environ.update(environment_record)
    try:
        done = run(tmp_path, body, b"", "Test-Candidate", "Write-InstallLog")
    finally:
        for key in environment_record:
            os.environ.pop(key, None)
    return done, candidate, record


def test_the_rehearsal_syncs_and_checks_the_candidate_in_its_own_throwaway_environment(
    tmp_path: Path,
) -> None:
    done, candidate, record = _rehearse(tmp_path, sync_code=0, check_code=0)
    assert done.returncode == 0, done.stderr
    calls = record.read_text(encoding="utf-8").splitlines()
    # Os dois comandos usam o ambiente ao lado da candidata, nunca o do agente em uso.
    assert [line.split()[0] for line in calls] == ["sync", "run"]
    assert all(str(candidate) + ".venv" in line for line in calls)
    assert "ambiente depois: ambiente-do-agente" in done.stdout


def test_a_candidate_that_cannot_sync_is_refused_with_a_simple_sentence(tmp_path: Path) -> None:
    done, _, record = _rehearse(tmp_path, sync_code=1, check_code=0)
    assert done.returncode != 0
    assert "Nao consegui preparar a versao nova" in done.stderr
    assert [line.split()[0] for line in record.read_text(encoding="utf-8").splitlines()] == ["sync"]


def test_a_candidate_that_fails_its_self_check_is_refused_with_a_simple_sentence(
    tmp_path: Path,
) -> None:
    done, _, _ = _rehearse(tmp_path, sync_code=0, check_code=1)
    assert done.returncode != 0
    assert "nao funciona neste computador" in done.stderr


_ENVIRONMENT_FUNCTIONS = (
    "Get-AgentSource",
    "Get-MoveFailureReason",
    "Move-Folder",
    "Get-ZipComment",
    "Write-InstallLog",
    "Backup-Environment",
    "Remove-EnvironmentBackup",
    "Restore-PreviousVersion",
)


def _with_environment(tmp_path: Path) -> tuple[Path, Path]:
    app = installed(tmp_path)
    venv = tmp_path / "UniOver" / "runtime" / "venv"
    venv.mkdir(parents=True)
    (venv / "marca-do-ambiente.txt").write_text("o ambiente que funcionava", encoding="utf-8")
    return app, venv


def test_a_failure_after_the_swap_puts_back_the_python_environment_with_the_code(
    tmp_path: Path,
) -> None:
    app, venv = _with_environment(tmp_path)
    body = (
        f"$base = '{tmp_path / 'UniOver'}'\n"
        "Backup-Environment\n"
        "Get-AgentSource $source\n"
        # O preparo do ambiente definitivo mexe no ambiente: aqui ele é recriado com outro conteúdo.
        f"New-Item -ItemType Directory -Path '{venv}' -Force | Out-Null\n"
        f"Set-Content -LiteralPath '{venv / 'marca-nova.txt'}' -Value 'ambiente da candidata'\n"
        "Restore-PreviousVersion\n"
    )
    done = run(tmp_path, body, package(GOOD), *_ENVIRONMENT_FUNCTIONS)
    assert done.returncode == 0, done.stderr
    assert (venv / "marca-do-ambiente.txt").read_text(
        encoding="utf-8"
    ) == "o ambiente que funcionava"
    assert not (venv / "marca-nova.txt").exists()
    assert not (venv.parent / "venv.previous").exists()
    assert (app / "marca.txt").read_text(encoding="utf-8") == "a que funciona"


def test_a_failure_before_the_swap_also_puts_the_environment_back(tmp_path: Path) -> None:
    app, venv = _with_environment(tmp_path)
    body = (
        f"$base = '{tmp_path / 'UniOver'}'\n"
        "Backup-Environment\n"
        "try { Get-AgentSource $source { param($Candidate) throw 'ensaio falhou' } } catch { }\n"
        "Restore-PreviousVersion\n"
    )
    done = run(tmp_path, body, package(GOOD), *_ENVIRONMENT_FUNCTIONS)
    assert done.returncode == 0, done.stderr
    assert (venv / "marca-do-ambiente.txt").is_file()
    assert (app / "marca.txt").is_file()
    assert sorted(path.name for path in venv.parent.iterdir()) == ["venv"]


def test_the_backup_is_a_rename_and_it_is_dropped_when_the_install_succeeds(tmp_path: Path) -> None:
    _, venv = _with_environment(tmp_path)
    body = (
        f"$base = '{tmp_path / 'UniOver'}'\n"
        "Backup-Environment\n"
        f"Write-Output ('guardado: ' + (Test-Path -LiteralPath '{venv.parent / 'venv.previous' / 'marca-do-ambiente.txt'}'))\n"
        f"Write-Output ('venv no lugar: ' + (Test-Path -LiteralPath '{venv}'))\n"
        "Remove-EnvironmentBackup\n"
        f"Write-Output ('depois: ' + (Test-Path -LiteralPath '{venv.parent / 'venv.previous'}'))\n"
    )
    done = run(tmp_path, body, b"", *_ENVIRONMENT_FUNCTIONS)
    assert done.returncode == 0, done.stderr
    assert "guardado: True" in done.stdout
    assert "venv no lugar: False" in done.stdout
    assert "depois: False" in done.stdout


def test_a_first_install_has_no_environment_to_back_up(tmp_path: Path) -> None:
    (tmp_path / "UniOver" / "runtime").mkdir(parents=True)
    body = f"$base = '{tmp_path / 'UniOver'}'\nBackup-Environment\nRestore-PreviousVersion\n"
    done = run(tmp_path, body, b"", *_ENVIRONMENT_FUNCTIONS)
    assert done.returncode == 0, done.stderr
    assert sorted(path.name for path in (tmp_path / "UniOver" / "runtime").iterdir()) == []


def test_both_install_modes_back_up_the_environment_before_the_swap_and_drop_it_on_success() -> (
    None
):
    installer = INSTALLER.read_text(encoding="utf-8")
    assert installer.count("Backup-Environment\n") + installer.count("Backup-Environment\r\n") == 2
    for marker in ("    Backup-Environment", "\nBackup-Environment"):
        assert installer.index(marker) < installer.index(
            "Get-AgentSource $source {", installer.index(marker)
        )
    assert installer.count("Remove-EnvironmentBackup") >= 3
