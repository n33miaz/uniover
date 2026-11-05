# ruff: noqa: E501 - scripts de PowerShell em texto
"""Supervisor e lançador: nenhuma espera sem prazo e nenhum travamento sem quem reinicie.

O defeito de 05/11/2026: o supervisor ficou preso horas num `uv run ... self-update` sem filhos (disco
cheio), sem sinal de vida, e ninguém o reiniciou. Aqui os scripts de verdade (Windows PowerShell 5.1)
rodam numa instalação falsa em pasta temporária, com um `uv` falso que trava (`ping` longo), e se
confere: o filho é morto no prazo, o sinal de vida segue, o estado não fica em "atualizando" e um
supervisor mudo é reiniciado pelo lançador. Nada toca a instalação real; só se encerra o que o próprio
teste abriu (pela árvore do PID dele).
"""

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

from .launcher_isolation import isolated_launcher
from .test_launcher_recovery import POWERSHELL, TASKKILL, folder
from .test_supervisor_guardrails import CURRENT, Pc, wait_for

pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

LAUNCHER_TOOLS = Path(__file__).parents[1] / "tools"


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path)


def status(pc: Pc) -> dict[str, object]:
    try:
        loaded: dict[str, object] = json.loads(
            (pc.runtime / "update-status.json").read_text(encoding="utf-8")
        )
    except OSError, ValueError:
        return {}
    return loaded


def pulse(pc: Pc) -> float:
    try:
        return (pc.runtime / "supervisor-alive").stat().st_mtime
    except OSError:
        return 0.0


def hung_children(marker: int) -> int:
    """Quantos `ping -n <marker>` (o filho preso do teste) ainda existem."""
    script = (
        "(Get-CimInstance Win32_Process -Filter \"Name='ping.exe'\" | "
        f"Where-Object {{ $_.CommandLine -like '*-n {marker} *' }} | Measure-Object).Count"
    )
    done = subprocess.run(  # noqa: S603 - PowerShell do sistema; consulta só de leitura
        [str(POWERSHELL), "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        check=False,
        creationflags=0x08000000,
    )
    return int(done.stdout.strip() or 0)


def test_a_hung_update_child_is_killed_at_the_deadline_while_the_pulse_keeps_moving(
    pc: Pc,
) -> None:
    marker = 617
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        update_lines=[f"ping -n {marker} 127.0.0.1 > nul", "exit /b 0"],
    )
    with pc.running(UNIOVER_SUPERVISOR_UPDATE_TIMEOUT_SECONDS="8"):
        assert wait_for(lambda: status(pc).get("outcome") == "updating", 40), pc.supervisor_log()
        pulses: set[float] = set()
        end = time.monotonic() + 40
        while status(pc).get("outcome") == "updating" and time.monotonic() < end:
            pulses.add(pulse(pc))
            time.sleep(0.5)
        # O supervisor esperou o filho dando sinal de vida (o defeito era ficar mudo).
        assert len(pulses) >= 2, f"o sinal de vida parou durante a espera: {pulses}"
        assert status(pc)["outcome"] == "failed"
        assert "passou do prazo" in str(status(pc)["reason"])
        assert wait_for(lambda: "passou de 8 s" in pc.supervisor_log(), 5)
        assert any(i["kind"] == "update.timed_out" for i in pc.diagnostics())
        # Seguiu a vida: o agente subiu depois do prazo, e o filho preso não ficou para trás.
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
        assert hung_children(marker) == 0, "o filho preso sobreviveu ao prazo"


def test_an_update_that_exits_without_recording_a_result_never_stays_updating(pc: Pc) -> None:
    # `uv` falso que termina com 0 e nada grava (o Python não conseguiu escrever, disco cheio).
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with pc.running():
        assert wait_for(lambda: status(pc).get("outcome") == "failed", 40), pc.supervisor_log()
        assert "sem registrar o resultado" in str(status(pc)["reason"])


def test_a_nearly_full_disk_skips_the_update_and_says_why_without_running_the_child(
    pc: Pc,
) -> None:
    ran = pc.bin.parent / "update-ran"
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        update_lines=[f'echo x>"{ran}"', "exit /b 0"],
    )
    with pc.running(UNIOVER_SUPERVISOR_MIN_FREE_MB="999999999"):
        assert wait_for(lambda: status(pc).get("outcome") == "failed", 40), pc.supervisor_log()
        assert "pouco espaco em disco" in str(status(pc)["reason"])
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
        assert any(i["kind"] == "update.low_disk" for i in pc.diagnostics())
    assert not ran.exists(), "o filho de atualização rodou com o disco cheio"


def test_a_failed_sync_with_a_nearly_full_disk_keeps_the_environment_and_starts_the_agent(
    pc: Pc,
) -> None:
    venv = pc.runtime / "venv"
    (venv / "Scripts").mkdir(parents=True)
    (venv / "Scripts" / "python.exe").write_bytes(b"")
    (venv / "keep-me").write_text("x", encoding="ascii")
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=["echo sem espaco 1>&2", "exit /b 1"],
    )
    with pc.running(UNIOVER_SUPERVISOR_MIN_FREE_MB="999999999"):
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
        assert "mantenho o ambiente Python" in pc.supervisor_log()
    assert (venv / "keep-me").exists(), "o ambiente foi apagado com o disco cheio"


def test_a_hung_sync_is_killed_at_its_deadline_and_the_supervisor_goes_on(pc: Pc) -> None:
    marker = 623
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=[f"ping -n {marker} 127.0.0.1 > nul", "exit /b 0"],
    )
    with pc.running(UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="4"):
        assert wait_for(lambda: "uv sync falhou (passou de 4 s" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert wait_for(lambda: hung_children(marker) == 0, 20)
        assert (pc.runtime / "supervisor-alive").exists()


def test_an_update_killed_mid_swap_without_app_asks_the_launcher_to_restore_it(pc: Pc) -> None:
    marker = 631
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        update_lines=[f'rmdir /s /q "{pc.base / "app"}"', f"ping -n {marker} 127.0.0.1 > nul"],
    )
    with pc.running(UNIOVER_SUPERVISOR_UPDATE_TIMEOUT_SECONDS="6"):
        assert wait_for(lambda: "sumiu no meio da troca" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert wait_for((pc.runtime / "stop-reason.txt").exists, 10)
        assert (pc.runtime / "stop-reason.txt").read_text(encoding="ascii") == "update"
        assert wait_for(lambda: hung_children(marker) == 0, 20)


def test_the_supervisor_brings_the_launcher_in_the_fixed_folder_up_to_date(pc: Pc) -> None:
    old = (LAUNCHER_TOOLS / "launcher.ps1").read_text(encoding="ascii") + "\r\n# versao antiga\r\n"
    (pc.base / "launcher.ps1").write_bytes(old.encode("ascii"))
    (pc.base / "app" / "tools").mkdir()
    fresh = (LAUNCHER_TOOLS / "launcher.ps1").read_bytes()
    (pc.base / "app" / "tools" / "launcher.ps1").write_bytes(fresh)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    installed = pc.base / "launcher.ps1"

    def swapped() -> bool:
        # No instante da troca o Windows recusa a leitura por um momento.
        try:
            return installed.read_bytes() == fresh
        except OSError:
            return False

    with pc.running():
        assert wait_for(swapped, 30), pc.supervisor_log()


# --- Lançador: vigia o supervisor ---------------------------------------------------------------


def run_launcher(tmp_path: Path, stale: str) -> subprocess.Popen[bytes]:
    return subprocess.Popen(  # noqa: S603 - Windows PowerShell do sistema; script do repositório
        [
            str(POWERSHELL),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(isolated_launcher(tmp_path)),
        ],
        env=os.environ
        | {
            "LOCALAPPDATA": str(tmp_path),
            "UNIOVER_TEST_MARKER": str(tmp_path / "started.txt"),
            "UNIOVER_LAUNCHER_STALE_SECONDS": stale,
        },
        creationflags=0x08000000,
    )


def stop(launcher: subprocess.Popen[bytes]) -> None:
    subprocess.run(  # noqa: S603 - taskkill do sistema, só para encerrar o que o teste abriu
        [str(TASKKILL), "/PID", str(launcher.pid), "/T", "/F"],
        check=False,
        capture_output=True,
        creationflags=0x08000000,
    )
    launcher.wait(timeout=10)


def counting_supervisor(*, touches: bool) -> str:
    """Supervisor de mentira: anota cada partida; o travado nunca dá sinal, o sadio o renova."""
    body = "Add-Content -LiteralPath $env:UNIOVER_TEST_MARKER -Value 'x'\n"
    if touches:
        body += (
            "$alive = Join-Path $env:LOCALAPPDATA 'UniOver\\runtime\\supervisor-alive'\n"
            "while ($true) { [System.IO.File]::WriteAllText($alive, 'x'); Start-Sleep -Milliseconds 500 }\n"
        )
    else:
        body += "Start-Sleep -Seconds 300\n"
    return body


def starts(tmp_path: Path) -> int:
    marker = tmp_path / "started.txt"
    return len(marker.read_text(encoding="utf-8-sig").split()) if marker.exists() else 0


def test_a_live_supervisor_that_gave_no_sign_for_too_long_is_restarted_by_the_launcher(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(
        counting_supervisor(touches=False), encoding="ascii"
    )
    launcher = run_launcher(tmp_path, stale="4")
    try:
        assert wait_for(lambda: starts(tmp_path) >= 2, 90), (tmp_path / "UniOver" / "logs").exists()
        log = (base / "logs" / "supervisor.log").read_text(encoding="utf-8")
        assert "sem sinal" in log and "vou reinicia-lo" in log
        kinds = (base / "runtime" / "diagnostics.jsonl").read_text(encoding="utf-8")
        assert "supervisor.unresponsive" in kinds
    finally:
        stop(launcher)


def test_a_supervisor_that_keeps_its_pulse_is_never_restarted_by_the_launcher(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (base / "runtime").mkdir()
    (app / "tools" / "run-agent.ps1").write_text(
        counting_supervisor(touches=True), encoding="ascii"
    )
    launcher = run_launcher(tmp_path, stale="4")
    try:
        assert wait_for(lambda: starts(tmp_path) >= 1, 60)
        time.sleep(16)
        assert starts(tmp_path) == 1
    finally:
        stop(launcher)
