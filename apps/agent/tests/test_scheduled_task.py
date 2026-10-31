"""Tarefa de início automático no Agendador do Windows de verdade (nome único, sempre removida).

A tarefa é da máquina inteira: o teste cria uma de nome `UniOver teste <uuid>`, nunca toca na
`UniOver agente` e remove a sua num `finally`, conferindo no fim que não sobrou nenhuma.
"""

import asyncio
import os
import subprocess
import uuid
from pathlib import Path

import pytest

from uniover_agent.adapters.self_care_checks import query_task, startup_task_check

POWERSHELL = (
    Path(os.environ.get("SystemRoot", r"C:\Windows"))
    / "System32"
    / "WindowsPowerShell"
    / "v1.0"
    / "powershell.exe"
)
windows_only = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")


def scheduler(script: str, name: str) -> str:
    done = subprocess.run(  # noqa: S603 - PowerShell do sistema, script do próprio teste
        [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
        env=os.environ | {"UNIOVER_TEST_TASK": name},
        timeout=120,
        creationflags=0x08000000,
    )
    return done.stdout.strip()


@windows_only
async def test_the_real_scheduler_task_is_seen_flagged_repaired_and_always_removed(
    tmp_path: Path,
) -> None:

    name = f"UniOver teste {uuid.uuid4().hex}"
    anchor = tmp_path / "ancora"
    root = tmp_path / "dados"
    anchor.mkdir()
    root.mkdir()
    (anchor / "launcher.ps1").write_text("# l\n", encoding="ascii")
    try:
        # Tarefa inofensiva que não é o lançador: logon do usuário, ação `cmd /c exit`.
        scheduler(
            "$a=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit';"
            "$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;"
            "Register-ScheduledTask -TaskName $env:UNIOVER_TEST_TASK -Action $a -Trigger $t"
            " -Force | Out-Null",
            name,
        )
        seen = await asyncio.to_thread(query_task, name)
        assert seen is not None and seen.present and seen.execute.lower().endswith("cmd.exe")

        (anchor / "launcher.vbs").write_text("' v\n", encoding="ascii")
        check = startup_task_check(root, anchor, name=name)
        flagged = await check.run()
        assert not flagged.ok and flagged.fixable and "não aponta" in flagged.detail

        assert check.repair is not None
        assert await check.repair() is None
        fixed = await check.run()
        assert fixed.ok, fixed.detail
        again = await asyncio.to_thread(query_task, name)
        assert again is not None and again.enabled and again.triggers == 2
        assert again.execute.lower().endswith("wscript.exe")
    finally:
        scheduler(
            "Unregister-ScheduledTask -TaskName $env:UNIOVER_TEST_TASK -Confirm:$false"
            " -ErrorAction SilentlyContinue",
            name,
        )
        left = scheduler(
            "@(Get-ScheduledTask | Where-Object { $_.TaskName -like 'UniOver teste*' }).Count", name
        )
        assert left == "0"


@windows_only
async def test_asking_about_a_task_that_does_not_exist_says_so() -> None:

    state = await asyncio.to_thread(query_task, "UniOver teste inexistente-xyz")
    assert state is not None and not state.present
