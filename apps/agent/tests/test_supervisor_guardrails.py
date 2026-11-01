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
from pathlib import Path

import pytest

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
        self.bin.mkdir()
        (self.base / "app").mkdir(parents=True)
        (self.base / "app" / ".version").write_text(CURRENT + "\n", encoding="ascii")
        self.runtime.mkdir()
        self.alive = self.runtime / "last-alive"

    def uv(self, agent_lines: list[str], sync_lines: list[str] | None = None) -> None:
        """`self-update` termina logo, `tray` fica vivo, `sync` e `run` seguem as linhas dadas."""
        lines = [
            "@echo off",
            'if "%~1"=="sync" goto sync',
            'if "%~5"=="self-update" exit /b 0',
            'if "%~5"=="tray" goto tray',
            'if "%~5"=="run" goto agent',
            "exit /b 0",
            ":tray",
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
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
        ['echo %UNIOVER_SUPERVISED% > "%UNIOVER_TEST_AGENTS%.env"', "ping -n 300 127.0.0.1 > nul"]
    )
    with pc.running():
        assert wait_for((pc.runtime / "supervisor-alive").exists, 30)
        assert wait_for(lambda: pc.starts() >= 1, 30)
        marker = Path(str(pc.agents) + ".env")
        assert wait_for(marker.exists, 10)
        assert marker.read_text(encoding="ascii").strip() == "1"
