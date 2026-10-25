# ruff: noqa: E501 - scripts de PowerShell em texto
"""Supervisor `run-agent.ps1`: estado da atualização e volta atrás, no PowerShell de verdade.

As funções são tiradas do próprio script (pela árvore sintática) e rodam no Windows PowerShell 5.1,
o mesmo que o lançador usa, numa instalação falsa em pasta temporária. Nada toca a instalação real.
"""

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

from uniover_agent.adapters.update_status import STATUS_FILE, FileUpdateStatus

RUNNER = Path(__file__).parents[1] / "tools" / "run-agent.ps1"
POWERSHELL = os.path.join(
    os.environ.get("SystemRoot", "C:\\Windows"),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
)
TASKKILL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "taskkill.exe")
pytestmark = pytest.mark.skipif(not Path(POWERSHELL).is_file(), reason="precisa do Windows")

OLD = "a" * 40
BAD = "b" * 40
FUNCTIONS = (
    "Get-Version",
    "Get-UtcStamp",
    "Set-UpdateState",
    "Test-FreshFlag",
    "Invoke-Rollback",
    "Invoke-Update",
    "Schedule-NextUpdate",
)

PRELUDE = r"""
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$base = $env:UNIOVER_TEST_BASE
$source = Join-Path $base 'app'
$previous = Join-Path $base 'app.previous'
$runtime = Join-Path $base 'runtime'
$blocked = Join-Path $runtime '.blocked-versions'
$trial = Join-Path $runtime 'update-trial.txt'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:UNIOVER_TEST_RUNNER, [ref]$tokens, [ref]$errors)
foreach ($name in $env:UNIOVER_TEST_FUNCTIONS.Split(',')) {
    $found = $ast.Find({ param($node) ($node -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($node.Name -eq $name) }, $true)
    Invoke-Expression $found.Extent.Text
}
"""


class Pc:
    """Uma instalação falsa: `app` na versão atual, `runtime` vazio."""

    def __init__(self, base: Path) -> None:
        self.base = base
        self.source = base / "app"
        self.previous = base / "app.previous"
        self.runtime = base / "runtime"
        self.source.mkdir(parents=True)
        self.runtime.mkdir()

    def version(self, folder: Path, sha: str) -> None:
        folder.mkdir(exist_ok=True)
        (folder / ".version").write_text(sha + "\n", encoding="ascii")

    def state(self) -> dict[str, object]:
        loaded: dict[str, object] = json.loads(
            (self.runtime / STATUS_FILE).read_text(encoding="utf-8")
        )
        return loaded

    def run(self, body: str) -> subprocess.CompletedProcess[str]:
        script = self.base.parent / f"{self.base.name}-run.ps1"
        script.write_text(PRELUDE + body, encoding="ascii")
        environment = os.environ | {
            "UNIOVER_TEST_BASE": str(self.base),
            "UNIOVER_TEST_RUNNER": str(RUNNER),
            "UNIOVER_TEST_FUNCTIONS": ",".join(FUNCTIONS),
        }
        return subprocess.run(  # noqa: S603 - PowerShell do Windows e script do próprio teste
            [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
            timeout=120,
        )


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path / "UniOver")


def test_the_supervisor_merges_into_what_the_agent_wrote_and_keeps_accents_intact(pc: Pc) -> None:
    path = pc.runtime / STATUS_FILE
    path.write_text(
        json.dumps(
            {
                "outcome": "failed",
                "reason": "não consegui baixar",
                "latestSha": BAD,
                "checkedAt": "2026-10-24T13:00:00.000Z",
            }
        ),
        encoding="utf-8",
    )
    done = pc.run(
        "Set-UpdateState @{ nextCheckAt = '2026-10-24T19:00:00.000Z'; latestSha = $null; rolledBack = $true } | Out-Null"
    )
    assert done.returncode == 0, done.stderr
    state = pc.state()
    assert state == {
        "outcome": "failed",
        "reason": "não consegui baixar",
        "checkedAt": "2026-10-24T13:00:00.000Z",
        "nextCheckAt": "2026-10-24T19:00:00.000Z",
        "rolledBack": True,
    }
    assert [p.name for p in pc.runtime.iterdir()] == [STATUS_FILE]
    # O agente lê o resultado do supervisor sem estranhar nada.
    read = FileUpdateStatus(path, pc.source).read()
    assert (read.outcome, read.rolled_back, read.reason) == (
        "failed",
        True,
        "não consegui baixar",
    )


def test_the_supervisor_starts_a_state_file_when_there_is_none_and_survives_a_corrupt_one(
    pc: Pc,
) -> None:
    assert pc.run("Set-UpdateState @{ outcome = 'updating' } | Out-Null").returncode == 0
    assert pc.state() == {"outcome": "updating"}
    (pc.runtime / STATUS_FILE).write_text("{lixo", encoding="utf-8")
    assert pc.run("Set-UpdateState @{ outcome = 'failed' } | Out-Null").returncode == 0
    assert pc.state() == {"outcome": "failed"}


def test_a_state_that_cannot_be_written_never_stops_the_supervisor(pc: Pc) -> None:
    (pc.runtime / STATUS_FILE).mkdir()  # um diretório no lugar do arquivo
    done = pc.run("Set-UpdateState @{ outcome = 'failed' } | Out-Null; 'seguiu'")
    assert done.returncode == 0 and "seguiu" in done.stdout


def test_rolling_back_swaps_the_folders_blocks_the_bad_version_and_says_so(pc: Pc) -> None:
    pc.version(pc.source, BAD)
    pc.version(pc.previous, OLD)
    (pc.runtime / "update-trial.txt").write_text(BAD + "|1", encoding="ascii")
    done = pc.run("Invoke-Rollback")
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == ["True"]  # um único valor: o `if` do laço principal depende disso
    assert (pc.source / ".version").read_text(encoding="ascii").strip() == OLD
    assert not pc.previous.exists()
    assert (pc.runtime / f"app.rejected-{BAD[:12]}" / ".version").is_file()
    assert (pc.runtime / ".blocked-versions").read_text(encoding="ascii").split() == [BAD]
    assert not (pc.runtime / "update-trial.txt").exists()
    state = pc.state()
    assert (state["outcome"], state["rolledBack"], state["blockedSha"]) == (
        "rolled_back",
        True,
        BAD,
    )
    read = FileUpdateStatus(pc.runtime / STATUS_FILE, pc.source).read()
    assert (read.installed_sha, read.blocked_sha, read.rolled_back) == (OLD, BAD, True)


def test_there_is_no_rolling_back_without_a_previous_version(pc: Pc) -> None:
    pc.version(pc.source, BAD)
    done = pc.run("Invoke-Rollback")
    assert done.stdout.split() == ["False"]
    assert (pc.source / ".version").read_text(encoding="ascii").strip() == BAD
    assert not (pc.runtime / ".blocked-versions").exists()


def test_a_flag_left_behind_is_only_good_for_ten_minutes(pc: Pc) -> None:
    fresh = pc.runtime / "rollback-now"
    fresh.touch()
    stale = pc.runtime / "old-rollback"
    stale.touch()
    old = time.time() - 11 * 60
    os.utime(stale, (old, old))
    done = pc.run(
        "Test-FreshFlag (Join-Path $runtime 'rollback-now'); Test-FreshFlag (Join-Path $runtime 'old-rollback');"
        "Test-FreshFlag (Join-Path $runtime 'nao-existe')"
    )
    assert done.stdout.split() == ["True", "False", "False"]


def fake_uv(pc: Pc, *commands: str) -> str:
    """Um `uv.cmd` falso que roda os comandos (o `write_text` do Windows já põe CRLF)."""
    uv = pc.base / "uv.cmd"
    uv.write_text("\n".join(["@echo off", *commands, ""]), encoding="ascii")
    return str(uv)


def test_an_update_process_that_crashes_is_reported_as_a_failure_with_its_code(pc: Pc) -> None:
    pc.version(pc.source, OLD)
    uv = fake_uv(pc, "exit /b 3")
    done = pc.run(f"Invoke-Update '{uv}'")
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == ["False"]
    state = pc.state()
    assert state["outcome"] == "failed" and "codigo 3" in str(state["reason"])
    assert FileUpdateStatus(pc.runtime / STATUS_FILE, pc.source).read().outcome == "failed"


def test_an_update_that_installs_a_new_version_returns_true_and_keeps_the_agents_result(
    pc: Pc,
) -> None:
    pc.version(pc.source, OLD)
    # Faz o que o `self-update` faz no fim: troca o `.version` e deixa o resultado.
    prepared = pc.base / "resultado.json"
    prepared.write_text(json.dumps({"outcome": "updated", "latestSha": BAD}), encoding="ascii")
    uv = fake_uv(
        pc,
        f'echo {BAD}> "{pc.source / ".version"}"',
        f'copy /y "{prepared}" "{pc.runtime / STATUS_FILE}" > nul',
        "exit /b 0",
    )
    done = pc.run(f"Invoke-Update '{uv}'")
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == ["True"]
    assert (pc.runtime / "update-trial.txt").read_text(encoding="ascii") == f"{BAD}|0"
    assert pc.state()["outcome"] == "updated"


def test_scheduling_the_next_check_writes_it_down_and_still_returns_one_date(pc: Pc) -> None:
    done = pc.run("$when = Schedule-NextUpdate; $when.GetType().Name")
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == ["DateTime"]
    next_check = str(pc.state()["nextCheckAt"])
    assert next_check.endswith("Z") and len(next_check) == len("2026-10-24T19:00:00.000Z")


def test_the_real_supervisor_loop_goes_back_when_the_owner_asks_and_restarts_itself(
    tmp_path: Path,
) -> None:
    """O laço de verdade, com um `uv` falso: o pedido de volta atrás vira troca de pastas e saída 42."""
    base = tmp_path / "local" / "UniOver"
    pc = Pc(base)
    pc.version(pc.source, BAD)
    pc.version(pc.previous, OLD)
    fakes = tmp_path / "bin"
    fakes.mkdir()
    # `self-update` e `sync` terminam logo; `run` e `tray` ficam vivos até o supervisor matá-los.
    (fakes / "uv.cmd").write_text(
        "\n".join(
            [
                "@echo off",
                "echo %* | findstr /c:self-update > nul && exit /b 0",
                "echo %* | findstr /c:sync > nul && exit /b 0",
                "ping -n 300 127.0.0.1 > nul",
                "",
            ]
        ),
        encoding="ascii",
    )
    (pc.runtime / "rollback-now").touch()
    environment = os.environ | {
        "LOCALAPPDATA": str(tmp_path / "local"),
        "PATH": str(fakes) + os.pathsep + os.environ["PATH"],
    }
    process = subprocess.Popen(  # noqa: S603 - PowerShell do Windows e o script do repositório
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(RUNNER)],
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        code = process.wait(timeout=90)
    finally:
        if process.poll() is None:
            subprocess.run(  # noqa: S603 - taskkill do Windows
                [TASKKILL, "/PID", str(process.pid), "/T", "/F"],
                check=False,
                capture_output=True,
            )
    assert code == 42
    assert (pc.source / ".version").read_text(encoding="ascii").strip() == OLD
    assert not pc.previous.exists()
    assert (pc.runtime / ".blocked-versions").read_text(encoding="ascii").split() == [BAD]
    assert not (pc.runtime / "rollback-now").exists()
    assert pc.state()["outcome"] == "rolled_back"
