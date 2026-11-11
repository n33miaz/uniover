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
from datetime import UTC, datetime, timedelta
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
        (self.runtime / "tray-start-request").write_text("", encoding="ascii")
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
            'if "%~1"=="--version" goto version',
            'if "%~1"=="sync" goto sync',
            'if "%~5"=="self-update" goto update',
            'if "%~5"=="tray" goto tray',
            'if "%~5"=="run" goto agent',
            "exit /b 0",
            ":version",
            "if defined UNIOVER_TEST_UV_VERSION echo uv %UNIOVER_TEST_UV_VERSION% (fake)",
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
                "UNIOVER_SUPERVISOR_LOGON_AT": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
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


def test_the_supervisor_creates_the_pulse_file_before_the_agent_and_judges_a_silent_agent(
    pc: Pc,
) -> None:
    # O arquivo nasce no supervisor (com o disco cheio o agente só muda a data de um que já existe)
    # e um agente que nunca o toca é dado por mudo depois da carência.
    assert not pc.alive.exists()
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with pc.running():
        assert wait_for(pc.alive.exists, 30)
        assert wait_for(lambda: pc.starts() >= 2, 60), pc.supervisor_log()
        assert any(i["kind"] == "process.unresponsive" for i in pc.diagnostics())


def test_a_missing_pulse_file_for_longer_than_the_limit_is_silence_not_health(pc: Pc) -> None:
    # Disco cheio ou sem permissão antes de o arquivo existir: o supervisor não consegue criá-lo e o
    # agente também não. Antes, o contador zerava a cada volta e o travado nunca era reiniciado.
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with pc.running(UNIOVER_SUPERVISOR_TEST_NO_PULSE_FILE="1"):
        assert wait_for(lambda: pc.starts() >= 2, 60), pc.supervisor_log()
        assert not pc.alive.exists()
        assert any(i["kind"] == "process.unresponsive" for i in pc.diagnostics())


def test_an_agent_that_has_only_just_started_is_not_judged_before_the_grace_ends(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with pc.running(
        UNIOVER_SUPERVISOR_TEST_NO_PULSE_FILE="1", UNIOVER_SUPERVISOR_HANG_GRACE_SECONDS="30"
    ):
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
    pc.uv(["ping -n 2 127.0.0.1 > nul", "exit /b 9"])
    with pc.running():
        assert wait_for(lambda: "codigo 9" in pc.supervisor_log(), 40)
        assert wait_for(lambda: any(i["kind"] == "process.exited" for i in pc.diagnostics()), 5)
        item = next(i for i in pc.diagnostics() if i["kind"] == "process.exited")
        assert "codigo 9" in item["detail"]


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
        flag.unlink()  # o que o atalho "UniOver" faz
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


def test_startup_shortcut_can_request_the_tray_after_the_supervisor_starts(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    request = pc.runtime / "tray-start-request"
    request.unlink()
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() == 1, 30), pc.supervisor_log()
        time.sleep(2)
        assert pc.tray_starts() == 0
        request.write_text("", encoding="ascii")
        assert wait_for(lambda: pc.tray_starts() == 1, 10), pc.supervisor_log()


def test_previous_logons_tray_request_does_not_open_the_icon(pc: Pc) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    request = pc.runtime / "tray-start-request"
    yesterday = time.time() - 24 * 3600
    os.utime(request, (yesterday, yesterday))
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() == 1, 30), pc.supervisor_log()
        time.sleep(2)
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
    link = pc.roaming / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "UniOver.lnk"
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


def test_a_second_supervisor_of_the_same_installation_exits_and_leaves_the_first_alone(
    pc: Pc,
) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 30)
        second = subprocess.Popen(  # noqa: S603 - Windows PowerShell do sistema; script do repositório
            [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(RUNNER)],
            env=os.environ
            | FAST
            | {
                "LOCALAPPDATA": str(pc.local),
                "PATH": str(pc.bin) + os.pathsep + os.environ["PATH"],
                "UNIOVER_TEST_AGENTS": str(pc.agents),
                "UNIOVER_TEST_TRAYS": str(pc.trays),
                "APPDATA": str(pc.roaming),
            },
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=0x08000000,
        )
        try:
            assert second.wait(timeout=60) == 43, "o segundo supervisor devia sair com 43"
        finally:
            if second.poll() is None:
                second.kill()
        assert "ja existe um supervisor" in pc.supervisor_log()
        time.sleep(3)
        assert pc.starts() == 1, "o segundo supervisor não pode ter subido outro agente"


def test_a_supervisor_killed_by_force_leaves_the_mutex_to_the_next_one(pc: Pc) -> None:
    # O lançador mata o travado com `taskkill /F`: o mutex fica abandonado e o seguinte o assume.
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 30)
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() >= 2, 60), pc.supervisor_log()
        assert "ja existe um supervisor" not in pc.supervisor_log()


def test_after_an_update_timeout_the_first_lap_starts_the_agent_without_repeating_it(
    pc: Pc, tmp_path: Path
) -> None:
    updates = tmp_path / "updates.txt"
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        update_lines=['echo x>>"%UNIOVER_TEST_UPDATES%"', "exit /b 0"],
    )
    (pc.runtime / "update-timed-out").write_text("2026-11-05T12:00:00.000Z", encoding="ascii")
    with heartbeat(pc.alive), pc.running(UNIOVER_TEST_UPDATES=str(updates)):
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
        time.sleep(3)
        assert not updates.exists(), "a primeira volta repetiu o update que tinha estourado"
        assert not (pc.runtime / "update-timed-out").exists()
        assert "sem repeti-lo" in pc.supervisor_log()


def test_without_a_timed_out_mark_the_first_lap_checks_for_an_update(
    pc: Pc, tmp_path: Path
) -> None:
    updates = tmp_path / "updates.txt"
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        update_lines=['echo x>>"%UNIOVER_TEST_UPDATES%"', "exit /b 0"],
    )
    with heartbeat(pc.alive), pc.running(UNIOVER_TEST_UPDATES=str(updates)):
        assert wait_for(updates.exists, 40), pc.supervisor_log()


def test_a_sync_that_only_timed_out_keeps_the_environment(pc: Pc) -> None:
    # Um sync que passou do prazo (rede lenta, antivírus) não é um ambiente estragado: apagar o
    # venv jogaria fora o que o cache do uv já andou.
    venv = pc.runtime / "venv"
    venv.mkdir()
    sentinel = venv / "sentinela.txt"
    sentinel.write_text("vivo", encoding="ascii")
    pc.uv(["exit /b 0"], sync_lines=["ping -n 60 127.0.0.1 > nul", "exit /b 0"])
    with pc.running(UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="3"):
        assert wait_for(lambda: "o ambiente foi mantido" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert sentinel.exists(), "o venv foi apagado por um sync que só estourou o prazo"


def test_three_sync_timeouts_roll_back_without_blocking_the_version(pc: Pc) -> None:
    # A falha foi do PC (lento, disco), não da versão: voltar para a anterior sim, bloquear não.
    previous = pc.base / "app.previous"
    (previous / "tools").mkdir(parents=True)
    (previous / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (previous / "tools" / "run-agent.ps1").write_text("exit 0\n", encoding="ascii")
    (previous / ".version").write_text("c" * 40 + "\n", encoding="ascii")
    (pc.runtime / "update-trial.txt").write_text(CURRENT + "|0", encoding="ascii")
    pc.uv(["exit /b 0"], sync_lines=["ping -n 60 127.0.0.1 > nul", "exit /b 0"])
    with pc.running(
        UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="2", UNIOVER_SUPERVISOR_LAP_SECONDS="0.3"
    ):
        assert wait_for(lambda: "voltei para a versao anterior" in pc.supervisor_log(), 120), (
            pc.supervisor_log()
        )
    blocked = pc.runtime / ".blocked-versions"
    assert not blocked.exists() or CURRENT not in blocked.read_text(encoding="ascii")
    assert (pc.base / "app" / ".version").read_text(encoding="ascii").strip() == "c" * 40
    # Não bloqueada, mas adiada por 24 h (o self-update não a reinstala a cada checagem).
    assert CURRENT in (pc.runtime / ".deferred-versions").read_text(encoding="ascii")


def test_the_update_uses_no_sync_after_a_real_sync_and_update_now_forces_it(
    pc: Pc, tmp_path: Path
) -> None:
    seen = tmp_path / "update-env.txt"
    venv_python = pc.runtime / "venv" / "Scripts" / "python.exe"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("", encoding="ascii")
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        update_lines=[
            'echo [%UV_NO_SYNC%][%UNIOVER_UPDATE_FORCE%]>>"%UNIOVER_TEST_UPDATES%"',
            "exit /b 0",
        ],
    )
    with heartbeat(pc.alive), pc.running(UNIOVER_TEST_UPDATES=str(seen)):
        assert wait_for(seen.exists, 40), pc.supervisor_log()
        assert wait_for(lambda: pc.starts() >= 1, 40)
        (pc.runtime / "update-now").write_text("", encoding="ascii")
        assert wait_for(lambda: len(seen.read_text("ascii").split()) >= 2, 60), pc.supervisor_log()
    lines = seen.read_text("ascii").split()
    # O sync da primeira volta vem ANTES do update: já nela o `self-update` roda com UV_NO_SYNC,
    # sem forçar nada; o pedido do dono (`update-now`) passa a ordem de ignorar o adiamento.
    assert lines[0] == "[1][]"
    assert lines[1] == "[1][1]"


def test_a_lap_whose_environment_was_only_kept_runs_no_update_at_all(
    pc: Pc, tmp_path: Path
) -> None:
    # Volta 1: sync de verdade (o update roda com UV_NO_SYNC). Volta 2: o sync estoura o prazo e o
    # ambiente existente é só mantido: o update NÃO roda (sem UV_NO_SYNC nem sync implícito).
    seen = tmp_path / "update-env.txt"
    flag = tmp_path / "sync-flag.txt"
    python = pc.runtime / "venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="ascii")
    pc.uv(
        ["ping -n 3 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=[
            'if exist "%UNIOVER_TEST_FLAG%" ping -n 60 127.0.0.1 > nul',
            'echo x>"%UNIOVER_TEST_FLAG%"',
            "exit /b 0",
        ],
        update_lines=['echo [%UV_NO_SYNC%]>>"%UNIOVER_TEST_UPDATES%"', "exit /b 0"],
    )
    with pc.running(
        UNIOVER_TEST_UPDATES=str(seen),
        UNIOVER_TEST_FLAG=str(flag),
        UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="2",
    ):
        assert wait_for(lambda: "o agente terminou" in pc.supervisor_log(), 60), pc.supervisor_log()
        # Só agora (a volta 1 acabou) o dono pede o update da volta 2.
        (pc.runtime / "update-now").write_text("", encoding="ascii")
        assert wait_for(lambda: pc.starts() >= 2, 90), pc.supervisor_log()
        time.sleep(4)
        # O pedido do dono continua lá, para quando o ambiente estiver sincronizado.
        assert (pc.runtime / "update-now").exists()
    assert seen.read_text("ascii").split() == ["[1]"], "a volta de ambiente mantido rodou um update"


def test_a_kept_environment_on_the_first_lap_starts_the_agent_before_any_update(
    pc: Pc, tmp_path: Path
) -> None:
    order = tmp_path / "order.txt"
    python = pc.runtime / "venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="ascii")
    pc.uv(
        ['echo agent>>"%UNIOVER_TEST_ORDER%"', "ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=["ping -n 60 127.0.0.1 > nul", "exit /b 0"],
        update_lines=['echo update>>"%UNIOVER_TEST_ORDER%"', "exit /b 0"],
    )
    with (
        heartbeat(pc.alive),
        pc.running(UNIOVER_TEST_ORDER=str(order), UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="2"),
    ):
        assert wait_for(order.exists, 60), pc.supervisor_log()
        time.sleep(6)
        assert "apenas mantido" in pc.supervisor_log()
    assert order.read_text("ascii").split() == ["agent"], "o update rodou antes (ou sem) o agente"


def test_repeated_quick_crashes_on_a_kept_environment_leave_one_clear_diagnostic(pc: Pc) -> None:
    python = pc.runtime / "venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="ascii")
    pc.uv(["exit /b 1"], sync_lines=["ping -n 60 127.0.0.1 > nul", "exit /b 0"])
    with pc.running(UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="2"):
        assert wait_for(
            lambda: any(i["kind"] == "agent.env_unusable" for i in pc.diagnostics()), 120
        ), pc.supervisor_log()
    kinds = [i["kind"] for i in pc.diagnostics()]
    assert kinds.count("agent.env_unusable") == 1
    # A primeira queda ainda é uma queda comum; dali em diante não há um `process.exited` por volta.
    assert kinds.count("process.exited") <= 1


def test_the_agent_and_the_tray_start_without_an_implicit_sync_after_a_good_sync(
    pc: Pc, tmp_path: Path
) -> None:
    # `uv run` sem UV_NO_SYNC faria um sync implícito (sem prazo nem --frozen): o `uv` falso o
    # simula.
    agent_env = tmp_path / "agent-env.txt"
    tray_env = tmp_path / "tray-env.txt"
    note = 'if "%UV_NO_SYNC%"=="1" (echo nosync>>"{f}") else (echo implicit-sync>>"{f}")'
    pc.uv(
        [note.format(f="%UNIOVER_TEST_AGENT_ENV%"), "ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        tray_lines=[note.format(f="%UNIOVER_TEST_TRAY_ENV%"), "ping -n 300 127.0.0.1 > nul"],
    )
    with (
        heartbeat(pc.alive),
        pc.running(UNIOVER_TEST_AGENT_ENV=str(agent_env), UNIOVER_TEST_TRAY_ENV=str(tray_env)),
    ):
        assert wait_for(agent_env.exists, 40), pc.supervisor_log()
        assert wait_for(tray_env.exists, 40), pc.supervisor_log()
    assert agent_env.read_text("ascii").split() == ["nosync"]
    assert tray_env.read_text("ascii").split() == ["nosync"]


def trial_with_previous(pc: Pc) -> None:
    previous = pc.base / "app.previous"
    (previous / "tools").mkdir(parents=True)
    (previous / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (previous / "tools" / "run-agent.ps1").write_text("exit 0\n", encoding="ascii")
    (previous / ".version").write_text("c" * 40 + "\n", encoding="ascii")
    (pc.runtime / "update-trial.txt").write_text(CURRENT + "|0", encoding="ascii")


def test_the_first_lap_syncs_before_it_updates(pc: Pc, tmp_path: Path) -> None:
    order = tmp_path / "order.txt"
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=['echo sync>>"%UNIOVER_TEST_ORDER%"', "exit /b 0"],
        update_lines=['echo update>>"%UNIOVER_TEST_ORDER%"', "exit /b 0"],
    )
    with heartbeat(pc.alive), pc.running(UNIOVER_TEST_ORDER=str(order)):
        assert wait_for(lambda: order.exists() and "update" in order.read_text("ascii"), 40), (
            pc.supervisor_log()
        )
    assert order.read_text("ascii").split()[:2] == ["sync", "update"]


def test_a_sync_that_times_out_on_a_full_disk_still_starts_the_agent_without_a_new_sync(
    pc: Pc, tmp_path: Path
) -> None:
    # O incidente: disco cheio e `uv sync` preso. Havendo um ambiente que já rodou (versão estável),
    # o agente sobe com ele, e sem UV_NO_SYNC o `uv run` dele refaria o mesmo sync, sem prazo: o
    # `uv` falso simula esse sync implícito e o teste confere o que o `run` recebe.
    agent_env = tmp_path / "agent-env.txt"
    python = pc.runtime / "venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="ascii")
    target = '"%UNIOVER_TEST_AGENT_ENV%"'
    note = f'if "%UV_NO_SYNC%"=="1" (echo nosync>>{target}) else (echo implicit-sync>>{target})'
    pc.uv(
        [note, "ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=["ping -n 60 127.0.0.1 > nul", "exit /b 0"],
    )
    with pc.running(
        UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="2",
        UNIOVER_SUPERVISOR_MIN_FREE_MB="999999999",
        UNIOVER_TEST_AGENT_ENV=str(agent_env),
    ):
        assert wait_for(agent_env.exists, 60), pc.supervisor_log()
        assert wait_for(lambda: any(i["kind"] == "update.low_disk" for i in pc.diagnostics()), 10)
    assert agent_env.read_text("ascii").split() == ["nosync"]


def test_the_low_disk_diagnostic_is_not_repeated_on_every_lap(pc: Pc) -> None:
    python = pc.runtime / "venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="ascii")
    pc.uv(["exit /b 0"], sync_lines=["ping -n 60 127.0.0.1 > nul", "exit /b 0"])
    with pc.running(
        UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="2", UNIOVER_SUPERVISOR_MIN_FREE_MB="999999999"
    ):
        # O agente sai logo e o laço volta várias vezes no intervalo.
        assert wait_for(lambda: pc.starts() >= 3, 90), pc.supervisor_log()
    low = [i for i in pc.diagnostics() if i["kind"] == "update.low_disk"]
    assert len(low) == 1, "o diagnóstico de pouco espaço foi repetido a cada volta"


def test_three_sync_failures_from_a_full_disk_roll_back_without_blocking(pc: Pc) -> None:
    trial_with_previous(pc)
    pc.uv(["exit /b 0"], sync_lines=["echo sem espaco 1>&2", "exit /b 1"])
    with pc.running(UNIOVER_SUPERVISOR_MIN_FREE_MB="999999999"):
        assert wait_for(lambda: "voltei para a versao anterior" in pc.supervisor_log(), 120), (
            pc.supervisor_log()
        )
    blocked = pc.runtime / ".blocked-versions"
    assert not blocked.exists() or CURRENT not in blocked.read_text(encoding="ascii")
    assert CURRENT in (pc.runtime / ".deferred-versions").read_text(encoding="ascii")


def test_three_real_sync_errors_roll_back_and_block_the_version(pc: Pc) -> None:
    trial_with_previous(pc)
    pc.uv(["exit /b 0"], sync_lines=["echo erro de dependencia 1>&2", "exit /b 1"])
    with pc.running(UNIOVER_SUPERVISOR_MIN_FREE_MB="1"):
        assert wait_for(lambda: "voltei para a versao anterior" in pc.supervisor_log(), 120), (
            pc.supervisor_log()
        )
    assert CURRENT in (pc.runtime / ".blocked-versions").read_text(encoding="ascii")
    assert not (pc.runtime / ".deferred-versions").exists()
