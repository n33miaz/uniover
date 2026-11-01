"""Supervisor `run-agent.ps1`: as proteções que mantêm o agente de pé e dizem por que ele caiu.

O laço de verdade (Windows PowerShell 5.1) com um `uv` falso, numa instalação falsa em pasta
temporária (`LOCALAPPDATA` trocado, nada toca a instalação real). Os tempos do pulso são
encurtados pelas variáveis `UNIOVER_SUPERVISOR_*`, que o script lê (sem elas valem os de produção).
"""

import json
import os
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest

from .support import read_text_retrying

SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
POWERSHELL = SYSTEM32 / "WindowsPowerShell" / "v1.0" / "powershell.exe"
TASKKILL = SYSTEM32 / "taskkill.exe"
RUNNER = Path(__file__).parents[1] / "tools" / "run-agent.ps1"
pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

CURRENT = "a" * 40
FAST = {
    "UNIOVER_SUPERVISOR_LAP_SECONDS": "0.3",
    "UNIOVER_SUPERVISOR_HANG_LAPS": "4",
    "UNIOVER_SUPERVISOR_HANG_GRACE_SECONDS": "1",
    "UNIOVER_SUPERVISOR_CONFIRM_SECONDS": "1",
}


class Pc:
    """Instalação falsa com `app` na versão atual e um `uv` falso que decide o que o agente faz."""

    def __init__(self, tmp_path: Path) -> None:
        self.local = tmp_path / "local"
        self.base = self.local / "UniOver"
        self.runtime = self.base / "runtime"
        self.logs = self.base / "logs"
        self.bin = tmp_path / "bin"
        self.agents = tmp_path / "agentes.txt"
        self.trays = tmp_path / "icones.txt"
        self.roaming = tmp_path / "roaming"
        self.bin.mkdir()
        (self.base / "app").mkdir(parents=True)
        (self.base / "app" / ".version").write_text(CURRENT + "\n", encoding="ascii")
        self.runtime.mkdir()
        self.alive = self.runtime / "last-alive"

    def uv(
        self,
        agent_lines: list[str],
        sync_lines: list[str] | None = None,
        tray_lines: list[str] | None = None,
        update_lines: list[str] | None = None,
    ) -> None:
        """`self-update` termina logo, `tray` fica vivo, `sync` e `run` seguem as linhas dadas."""
        lines = [
            "@echo off",
            'if "%~1"=="sync" goto sync',
            'if "%~5"=="self-update" goto update',
            'if "%~5"=="tray" goto tray',
            'if "%~5"=="run" goto agent',
            "exit /b 0",
            ":update",
            *(update_lines or ["exit /b 0"]),
            ":tray",
            'echo x>>"%UNIOVER_TEST_TRAYS%"',
            *(tray_lines or ["ping -n 300 127.0.0.1 > nul", "exit /b 0"]),
            ":sync",
            *(sync_lines or ["exit /b 0"]),
            ":agent",
            'echo x>>"%UNIOVER_TEST_AGENTS%"',
            *agent_lines,
            "",
        ]
        (self.bin / "uv.cmd").write_text("\n".join(lines), encoding="ascii")

    def starts(self) -> int:
        text = self.agents.read_text(encoding="ascii") if self.agents.exists() else ""
        return len(text.splitlines())

    def tray_starts(self) -> int:
        text = self.trays.read_text(encoding="ascii") if self.trays.exists() else ""
        return len(text.splitlines())

    def diagnostics(self) -> list[dict[str, str]]:
        path = self.runtime / "diagnostics.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]

    def supervisor_log(self) -> str:
        path = self.logs / "supervisor.log"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    @contextmanager
    def running(self, **extra: str) -> Iterator[None]:
        environment = (
            os.environ
            | FAST
            | {
                "LOCALAPPDATA": str(self.local),
                "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                "UNIOVER_TEST_AGENTS": str(self.agents),
                "UNIOVER_TEST_TRAYS": str(self.trays),
                "APPDATA": str(self.roaming),
            }
            | extra
        )
        process = subprocess.Popen(  # noqa: S603 - Windows PowerShell do sistema; script do repositório
            [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(RUNNER)],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=0x08000000,
        )
        try:
            yield
        finally:
            subprocess.run(  # noqa: S603 - taskkill do sistema, só para encerrar o que o teste abriu
                [str(TASKKILL), "/PID", str(process.pid), "/T", "/F"],
                check=False,
                capture_output=True,
                creationflags=0x08000000,
            )
            process.wait(timeout=10)


def wait_for(check: Callable[[], bool], seconds: float) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.2)
    return check()


@contextmanager
def heartbeat(path: Path) -> Iterator[None]:
    """Faz o papel do agente vivo: regrava o `last-alive` o tempo todo."""
    stop = threading.Event()

    def beat() -> None:
        while not stop.is_set():
            path.write_text(str(time.time()), encoding="ascii")
            stop.wait(0.2)

    thread = threading.Thread(target=beat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=5)


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path)


def test_a_live_but_mute_agent_is_killed_and_restarted_and_the_reason_is_left_behind(
    pc: Pc,
) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    pc.alive.write_text("0", encoding="ascii")  # o agente escreveu uma vez ao subir e travou
    with pc.running():
        assert wait_for(lambda: pc.starts() >= 2, 60), pc.supervisor_log()
        kinds = {item["kind"] for item in pc.diagnostics()}
        assert "process.unresponsive" in kinds
        item = next(i for i in pc.diagnostics() if i["kind"] == "process.unresponsive")
        assert (item["severity"], item["component"]) == ("error", "supervisor")
        assert item["detail"].isascii()
        # O motivo fica para o agente novo ler ao subir: uma parada de propósito não é "queda".
        assert (pc.runtime / "stop-reason.txt").read_text(encoding="ascii") == "unresponsive"
        assert "mudo" in pc.supervisor_log()


def test_an_agent_that_keeps_its_pulse_fresh_is_never_killed(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 30)
        time.sleep(8)
        assert pc.starts() == 1
        assert not any(i["kind"] == "process.unresponsive" for i in pc.diagnostics())
        assert not (pc.runtime / "stop-reason.txt").exists()


def test_an_agent_that_never_wrote_a_pulse_is_not_judged_by_it(pc: Pc) -> None:
    # Sem `last-alive` o supervisor não tem como saber: melhor deixar vivo do que reiniciar em laço.
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 30)
        time.sleep(6)
        assert pc.starts() == 1


def test_a_version_in_proof_that_runs_long_enough_is_confirmed(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    trial = pc.runtime / "update-trial.txt"
    trial.write_text(CURRENT + "|0", encoding="ascii")
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: not trial.exists(), 40), pc.supervisor_log()
        assert wait_for(lambda: any(i["kind"] == "update.confirmed" for i in pc.diagnostics()), 5)
        assert "se confirmou" in pc.supervisor_log()


def test_a_version_in_proof_with_a_mute_pulse_is_not_confirmed(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    trial = pc.runtime / "update-trial.txt"
    trial.write_text(CURRENT + "|0", encoding="ascii")
    with pc.running():  # sem `last-alive`: nada prova que está bem
        assert wait_for(lambda: pc.starts() >= 1, 30)
        time.sleep(5)
        assert trial.exists()


def test_the_exit_code_of_the_agent_is_logged_and_reported(pc: Pc) -> None:
    pc.uv(["ping -n 2 127.0.0.1 > nul", "exit /b 7"])
    with pc.running():
        assert wait_for(lambda: "codigo 7" in pc.supervisor_log(), 40)
        assert wait_for(lambda: any(i["kind"] == "process.exited" for i in pc.diagnostics()), 5)
        item = next(i for i in pc.diagnostics() if i["kind"] == "process.exited")
        assert "codigo 7" in item["detail"]


def test_a_failed_sync_writes_why_in_the_supervisor_log(pc: Pc) -> None:
    pc.uv(
        ["exit /b 0"],
        sync_lines=["echo erro de teste: disco cheio 1>&2", "exit /b 1"],
    )
    with pc.running():
        assert wait_for(lambda: "uv sync falhou" in pc.supervisor_log(), 40)
        text = pc.supervisor_log()
        assert "disco cheio" in text
        assert "codigo 1" in text
    assert pc.starts() == 0  # sem ambiente nao ha agente


def test_the_supervisor_signals_it_is_alive_and_starts_the_agent_with_a_supervised_marker(
    pc: Pc,
) -> None:
    pc.uv(
        [
            'echo %UNIOVER_SUPERVISED% > "%UNIOVER_TEST_AGENTS%.env.tmp"',
            'move /y "%UNIOVER_TEST_AGENTS%.env.tmp" "%UNIOVER_TEST_AGENTS%.env" > nul',
            "ping -n 300 127.0.0.1 > nul",
        ]
    )
    with pc.running():
        assert wait_for((pc.runtime / "supervisor-alive").exists, 30)
        assert wait_for(lambda: pc.starts() >= 1, 30)
        marker = Path(str(pc.agents) + ".env")
        assert wait_for(marker.exists, 10)
        assert read_text_retrying(marker, encoding="ascii").strip() == "1"


# --- icone da bandeja: "Sair" so fecha o icone, e ele nao entra em laco ------------------------


def test_the_tray_opens_with_the_agent_when_nobody_closed_it(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with pc.running():
        assert wait_for(lambda: pc.tray_starts() >= 1, 90), pc.supervisor_log()
        assert wait_for(lambda: pc.starts() >= 1, 90)


def test_a_closed_tray_is_not_reopened_but_the_agent_keeps_running(pc: Pc) -> None:
    """O sinal que o "Sair" deixa: o supervisor segue vigiando o agente e nao abre o icone."""
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    (pc.runtime / "tray-closed").write_text("", encoding="ascii")
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 90), pc.supervisor_log()
        time.sleep(4)
        assert pc.tray_starts() == 0
        assert pc.starts() == 1
        assert (pc.runtime / "tray-closed").exists()


def test_the_tray_comes_back_a_few_seconds_after_the_shortcut_clears_the_signal(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    flag = pc.runtime / "tray-closed"
    flag.write_text("", encoding="ascii")
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 90)
        assert pc.tray_starts() == 0
        flag.unlink()  # o que o atalho "UniOver Agente" faz
        assert wait_for(lambda: pc.tray_starts() == 1, 10), pc.supervisor_log()
        assert pc.starts() == 1  # o agente nem piscou


def test_a_signal_left_before_this_logon_is_stale_and_the_tray_returns(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    flag = pc.runtime / "tray-closed"
    flag.write_text("", encoding="ascii")
    yesterday = time.time() - 24 * 3600
    os.utime(flag, (yesterday, yesterday))
    # O logon foi há uma hora e o sinal é de ontem (relativo a agora: não depende da hora do dia).
    logon = datetime.fromtimestamp(time.time() - 3600, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    with pc.running(UNIOVER_SUPERVISOR_LOGON_AT=logon):
        assert wait_for(lambda: pc.tray_starts() >= 1, 90), pc.supervisor_log()
        assert not flag.exists()


def test_a_signal_left_after_this_logon_is_kept(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    (pc.runtime / "tray-closed").write_text("", encoding="ascii")
    with heartbeat(pc.alive), pc.running(UNIOVER_SUPERVISOR_LOGON_AT="2020-01-01T00:00:00Z"):
        assert wait_for(lambda: pc.starts() >= 1, 90)
        time.sleep(3)
        assert pc.tray_starts() == 0


def test_a_tray_that_crashes_on_open_is_backed_off_and_reported(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"], tray_lines=["exit /b 3"])
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: any(i["kind"] == "tray.exited" for i in pc.diagnostics()), 30)
        item = next(i for i in pc.diagnostics() if i["kind"] == "tray.exited")
        assert (item["severity"], item["component"]) == ("error", "supervisor")
        assert "codigo 3" in item["detail"]
        time.sleep(4)
        # Sem a espera crescente seriam dezenas de aberturas em poucos segundos.
        assert pc.tray_starts() <= 2
        assert pc.starts() == 1


def test_an_update_that_fails_is_reported_as_an_error_diagnostic(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"], update_lines=["exit /b 9"])
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: any(i["kind"] == "update.failed" for i in pc.diagnostics()), 30), (
            pc.supervisor_log()
        )
        item = next(i for i in pc.diagnostics() if i["kind"] == "update.failed")
        assert (item["severity"], item["component"]) == ("error", "supervisor")
        assert "codigo 9" in item["detail"]
        assert item["detail"].isascii()


def test_a_sync_that_fails_twice_is_reported_as_an_error_diagnostic(pc: Pc) -> None:
    pc.uv(["exit /b 0"], sync_lines=["exit /b 1"])
    with pc.running():
        assert wait_for(
            lambda: any(i["kind"] == "update.sync_failed" for i in pc.diagnostics()), 40
        )
        item = next(i for i in pc.diagnostics() if i["kind"] == "update.sync_failed")
        assert item["severity"] == "error"


def test_the_start_menu_shortcut_is_created_once_and_points_at_the_open_script(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    tools = pc.base / "app" / "tools"
    tools.mkdir(parents=True)
    script = tools / "tray-open.vbs"
    script.write_bytes((RUNNER.parent / "tray-open.vbs").read_bytes())
    link = pc.roaming / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "UniOver Agente.lnk"
    with pc.running():
        assert wait_for(link.exists, 30), pc.supervisor_log()
        assert wait_for(lambda: pc.starts() >= 1, 90)
        # O atalho aparece antes de ser gravado: o horario so vale depois do agente subir.
        first = link.stat().st_mtime_ns
    # Um supervisor novo (depois de uma atualizacao) nao refaz o que ja esta certo.
    with pc.running():
        assert wait_for(lambda: pc.starts() >= 2, 30)
        time.sleep(2)
    assert link.stat().st_mtime_ns == first
    read = subprocess.run(  # noqa: S603 - PowerShell do sistema lendo o atalho que o teste criou
        [
            str(POWERSHELL),
            "-NoProfile",
            "-Command",
            "$l = (New-Object -ComObject WScript.Shell).CreateShortcut($env:UNIOVER_TEST_LINK);"
            " $l.TargetPath; $l.Arguments",
        ],
        env=os.environ | {"UNIOVER_TEST_LINK": str(link)},
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
        creationflags=0x08000000,
    )
    target, arguments = read.stdout.strip().splitlines()[:2]
    assert target.lower().endswith("wscript.exe")
    assert arguments == f'"{script}"'


def test_without_the_open_script_no_shortcut_is_made(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 90)
        time.sleep(1)
    assert not (pc.roaming / "Microsoft").exists()


def test_the_open_script_clears_the_closed_signal(tmp_path: Path) -> None:
    """O atalho: apaga `tray-closed` (o supervisor abre o icone) e nao mexe em mais nada."""
    base = tmp_path / "UniOver"
    (base / "app" / "tools").mkdir(parents=True)
    (base / "runtime").mkdir()
    script = base / "app" / "tools" / "tray-open.vbs"
    script.write_bytes((RUNNER.parent / "tray-open.vbs").read_bytes())
    flag = base / "runtime" / "tray-closed"
    flag.write_text("", encoding="ascii")
    other = base / "runtime" / "restart-now"
    other.write_text("", encoding="ascii")

    done = subprocess.run(  # noqa: S603 - wscript do sistema; script do repositorio
        [str(SYSTEM32 / "wscript.exe"), str(script)],
        env=os.environ | {"LOCALAPPDATA": str(tmp_path / "local")},
        check=False,
        timeout=60,
        creationflags=0x08000000,
    )

    assert done.returncode == 0
    assert wait_for(lambda: not flag.exists(), 10)
    assert other.exists()
