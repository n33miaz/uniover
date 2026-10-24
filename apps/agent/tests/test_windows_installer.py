"""Guardas estáticas do instalador Windows e do wrapper que ele gera."""

import re
from pathlib import Path

INSTALLER = Path(__file__).parents[1] / "tools" / "install-windows.ps1"


def wrapper_template() -> str:
    text = INSTALLER.read_text(encoding="utf-8")
    found = re.search(r"\$wrapperTemplate = @'\r?\n(.*?)\r?\n'@", text, re.DOTALL)
    assert found is not None
    return found.group(1)


def test_the_generated_wrapper_is_ascii_and_recovers_the_uv_and_venv() -> None:
    wrapper = wrapper_template()
    assert wrapper.isascii()
    assert "Microsoft\\WinGet\\Links\\uv.exe" in wrapper
    assert "Microsoft\\WindowsApps\\uv.exe" in wrapper
    assert ".local\\bin\\uv.exe" in wrapper
    assert "Remove-Item -LiteralPath $venv -Recurse -Force" in wrapper


def test_the_wrapper_checks_for_updates_while_the_agent_is_alive_and_rolls_back_bad_ones() -> None:
    wrapper = wrapper_template()
    assert "AddHours(6)" in wrapper
    assert "Get-Random -Minimum 0 -Maximum 46" in wrapper
    assert "agent-src.previous" in wrapper
    assert ".blocked-versions" in wrapper
    assert "$falls -lt 3" in wrapper
    assert "taskkill.exe /PID $process.Id /T /F" in wrapper


def test_the_task_has_no_battery_or_time_limit_and_keeps_the_repairable_wrapper() -> None:
    installer = INSTALLER.read_text(encoding="utf-8")
    assert "New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME" in installer
    assert "-ExecutionTimeLimit ([TimeSpan]::Zero)" in installer
    assert "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries" in installer
    assert installer.count("Write-AgentWrapper $uv") == 2
