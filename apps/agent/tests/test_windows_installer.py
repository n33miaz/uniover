"""Guardas estáticas do instalador Windows e do wrapper que ele gera."""

import os
import subprocess
import time
from pathlib import Path

INSTALLER = Path(__file__).parents[1] / "tools" / "install-windows.ps1"
LAUNCHER = Path(__file__).parents[1] / "tools" / "launcher.ps1"
RUNNER = Path(__file__).parents[1] / "tools" / "run-agent.ps1"
POWERSHELL = os.path.join(
    os.environ["SystemRoot"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
)


def test_the_generated_wrapper_is_ascii_and_recovers_the_uv_and_venv() -> None:
    wrapper = RUNNER.read_text(encoding="utf-8")
    assert wrapper.isascii()
    assert "Microsoft\\WinGet\\Links\\uv.exe" in wrapper
    assert "Microsoft\\WindowsApps\\uv.exe" in wrapper
    assert ".local\\bin\\uv.exe" in wrapper
    assert "Remove-Item -LiteralPath $venv -Recurse -Force" in wrapper


def test_the_wrapper_checks_for_updates_while_the_agent_is_alive_and_rolls_back_bad_ones() -> None:
    wrapper = RUNNER.read_text(encoding="utf-8")
    assert "AddHours(6)" in wrapper
    assert "Get-Random -Minimum 0 -Maximum 46" in wrapper
    assert "app.previous" in wrapper
    assert ".blocked-versions" in wrapper
    assert "$falls -lt 3" in wrapper
    assert "taskkill.exe /PID $process.Id /T /F" in wrapper


def test_the_task_has_no_battery_or_time_limit_and_keeps_the_repairable_launcher() -> None:
    installer = INSTALLER.read_text(encoding="utf-8")
    assert "New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME" in installer
    assert "-ExecutionTimeLimit ([TimeSpan]::Zero)" in installer
    assert "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries" in installer
    assert installer.count("Write-AgentLauncher") == 3
    assert '-File `"$launcher`"' in installer
    assert "run-agent.fallback.ps1" in installer


def test_the_launcher_falls_back_when_the_updated_wrapper_is_absent() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")
    assert launcher.isascii()
    assert "Test-Path -LiteralPath $current" in launcher
    assert "Test-Path -LiteralPath $legacy" in launcher
    assert "Test-Path -LiteralPath $fallback" in launcher
    assert "run-agent.fallback.ps1" in launcher


def test_launcher_runs_its_fallback_when_updated_wrapper_is_missing(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    base.mkdir()
    marker = tmp_path / "fallback.txt"
    (base / "run-agent.fallback.ps1").write_text(
        "Set-Content -LiteralPath $env:UNIOVER_TEST_MARKER -Value fallback\n",
        encoding="ascii",
    )
    environment = os.environ | {
        "LOCALAPPDATA": str(tmp_path),
        "UNIOVER_TEST_MARKER": str(marker),
    }
    process = subprocess.Popen(  # noqa: S603 - executável e argumentos fixos do Windows
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(LAUNCHER)],
        env=environment,
    )
    try:
        for _ in range(100):
            if marker.exists():
                break
            time.sleep(0.1)
        assert marker.read_text(encoding="utf-8").strip() == "fallback"
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_installer_migrates_the_old_layout_and_creates_the_user_facing_files() -> None:
    installer = INSTALLER.read_text(encoding="utf-8")
    for old, new in (
        ("agent-src", "app"),
        ("agent.toml", "config\\agent.toml"),
        ("agent.log", "logs\\agent.log"),
        ("conectar.html", "web\\conectar.html"),
        (".blocked-versions", "runtime\\.blocked-versions"),
        ("update-trial.txt", "runtime\\update-trial.txt"),
    ):
        assert old in installer and new in installer
    assert "LEIA-ME.txt" in installer
    assert "UniOver.lnk" in installer


def test_powershell_scripts_are_ascii_and_parse_in_windows_powershell() -> None:
    for script in (INSTALLER, LAUNCHER, RUNNER):
        assert script.read_bytes().isascii()
        escaped = str(script).replace("'", "''")
        command = (
            "$tokens=$null;$errors=$null;"
            "[System.Management.Automation.Language.Parser]::ParseFile("
            f"'{escaped}',[ref]$tokens,[ref]$errors)|Out-Null;"
            "if($errors.Count){$errors|ForEach-Object {$_.ToString()};exit 1}"
        )
        result = subprocess.run(  # noqa: S603 - executável fixo; script é arquivo do repositório
            [POWERSHELL, "-NoProfile", "-Command", command],
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr or result.stdout
