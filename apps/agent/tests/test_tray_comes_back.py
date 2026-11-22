"""O ícone da bandeja volta sozinho e em segundos; reiniciar nunca exige matar processos."""

import errno
import os
import subprocess
import time
from pathlib import Path

import pytest

from uniover_agent.adapters import tray_host
from uniover_agent.main import main

from .test_supervisor_guardrails import Pc, heartbeat, wait_for

TOOLS = Path(__file__).parents[1] / "tools"
RUNNER = TOOLS / "run-agent.ps1"
HOST = TOOLS / "tray-host.ps1"
POWERSHELL = (
    Path(os.environ.get("SystemRoot", r"C:\Windows"))
    / "System32"
    / "WindowsPowerShell"
    / "v1.0"
    / "powershell.exe"
)


def _sharing_violation() -> OSError:
    error = OSError(errno.EACCES, "O arquivo já está sendo usado por outro processo")
    error.winerror = 32
    return error


def test_state_swap_retries_while_another_process_holds_the_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[str, str]] = []
    failures = [_sharing_violation(), PermissionError("Acesso negado"), _sharing_violation()]
    real_replace = os.replace

    def flaky_replace(source: str, target: str) -> None:
        calls.append((str(source), str(target)))
        if failures:
            raise failures.pop(0)
        real_replace(source, target)

    monkeypatch.setattr("os.replace", flaky_replace)
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    temporary = tmp_path / "estado.json.1.new"
    temporary.write_text("{}", encoding="utf-8")
    target = tmp_path / "estado.json"
    tray_host._replace_with_retry(temporary, target)
    assert target.read_text(encoding="utf-8") == "{}"
    assert len(calls) == 4


def test_a_real_error_is_not_retried(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls = 0

    def broken(_source: str, _target: str) -> None:
        nonlocal calls
        calls += 1
        raise FileNotFoundError("sumiu")

    monkeypatch.setattr("os.replace", broken)
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    with pytest.raises(FileNotFoundError):
        tray_host._replace_with_retry(tmp_path / "a.new", tmp_path / "a.json")
    assert calls == 1


def test_each_process_writes_its_own_temporary_file() -> None:
    source = Path(tray_host.__file__).read_text(encoding="utf-8")
    assert 'path.with_name(f"{path.name}.{os.getpid()}.new")' in source
    assert '".json.new"' not in source


def test_the_visual_host_leaves_with_the_agent_that_opened_it() -> None:
    source = Path(tray_host.__file__).read_text(encoding="utf-8")
    assert '"-ParentPid",\n                    str(os.getpid()),' in source
    host = HOST.read_text(encoding="ascii")
    assert "[int]$ParentPid = 0" in host
    assert "Get-Process -Id $ParentPid" in host
    assert "$context.ExitThread(); return" in host


@pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")
def test_the_visual_host_still_parses_in_windows_powershell() -> None:
    escaped = str(HOST).replace("'", "''")
    command = (
        "$tokens=$null;$errors=$null;"
        "[System.Management.Automation.Language.Parser]::ParseFile("
        f"'{escaped}',[ref]$tokens,[ref]$errors)|Out-Null;"
        "if($errors.Count){$errors|ForEach-Object {$_.ToString()};exit 1}"
    )
    result = subprocess.run(  # noqa: S603 - executável fixo; script é arquivo do repositório
        [str(POWERSHELL), "-NoProfile", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        creationflags=0x08000000,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_an_open_tray_counts_as_this_session_request_for_a_restarted_supervisor() -> None:
    runner = RUNNER.read_text(encoding="ascii")
    update = runner[
        runner.index("function Update-Tray") : runner.index("function Test-OwnerStalled")
    ]
    start = update.index("$script:tray = Start-Tray $Uv")
    assert "tray-start-request" in update[start:]


def test_the_session_start_does_not_move_when_the_desktop_restarts() -> None:
    runner = RUNNER.read_text(encoding="ascii")
    logon = runner[
        runner.index("function Get-LogonTime") : runner.index("function Test-TrayClosed")
    ]
    assert "Get-Process -Name sihost, explorer" in logon


def test_a_long_lived_tray_that_dies_comes_back_on_the_next_check() -> None:
    # A espera crescente vale so para o icone que cai logo ao abrir; o que viveu mais de 2 minutos
    # volta na hora,
    # e o laco de espera confere o icone a cada segundo (`Wait-Lap`).
    runner = RUNNER.read_text(encoding="ascii")
    update = runner[
        runner.index("function Update-Tray") : runner.index("function Test-OwnerStalled")
    ]
    assert "if ($lived -ge 120) { $script:trayFalls = 0 }" in update
    lap = runner[runner.index("function Wait-Lap") : runner.index("function Move-StartupApproval")]
    assert "[Math]::Min(1000," in lap
    assert "Update-Tray $Uv" in lap


def test_restart_command_asks_the_supervisor_and_kills_nothing(
    isolated_env: Path,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    home = tmp_path / "UniOver"
    monkeypatch.setenv("UNIOVER_HOME", str(home))

    def no_kill(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("reiniciar não pode matar processo")

    monkeypatch.setattr(subprocess, "run", no_kill)
    monkeypatch.setattr(subprocess, "Popen", no_kill)
    assert main(["restart"]) == 0
    assert (home / "runtime" / "restart-now").is_file()
    assert "ícone da bandeja continua" in capsys.readouterr().out


# --- o laço de verdade (Windows PowerShell 5.1) com um `uv` falso numa instalação temporária ------

# Primeira abertura do ícone cai na hora; as seguintes ficam de pé.
_TRAY_FALLS_ONCE = [
    'if exist "%UNIOVER_TEST_TRAYS%.once" goto tray_alive',
    'echo x>"%UNIOVER_TEST_TRAYS%.once"',
    "exit /b 3",
    ":tray_alive",
    "ping -n 300 127.0.0.1 > nul",
    "exit /b 0",
]
# Primeira abertura vive uns segundos e sai; as seguintes ficam de pé.
_TRAY_DIES_SOON = [
    'if exist "%UNIOVER_TEST_TRAYS%.once" goto tray_alive',
    'echo x>"%UNIOVER_TEST_TRAYS%.once"',
    "ping -n 4 127.0.0.1 > nul",
    "exit /b 0",
    ":tray_alive",
    "ping -n 300 127.0.0.1 > nul",
    "exit /b 0",
]
_AGENT_STAYS = ["ping -n 300 127.0.0.1 > nul", "exit /b 0"]


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path)


@pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")
def test_restart_brings_the_agent_back_and_never_touches_the_tray(pc: Pc) -> None:
    pc.uv(_AGENT_STAYS)
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() == 1 and pc.tray_starts() == 1, 60), pc.supervisor_log()
        (pc.runtime / "restart-now").write_text("", encoding="ascii")
        assert wait_for(lambda: pc.starts() == 2, 30), pc.supervisor_log()
        time.sleep(3)
        assert pc.tray_starts() == 1, "o ícone segue o mesmo processo, sem fechar e abrir"


@pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")
def test_a_tray_that_falls_right_after_opening_is_back_in_seconds(pc: Pc) -> None:
    pc.uv(_AGENT_STAYS, tray_lines=_TRAY_FALLS_ONCE)
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.tray_starts() == 1, 60), pc.supervisor_log()
        assert wait_for(lambda: pc.tray_starts() == 2, 12), "a primeira volta é em segundos"


@pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")
def test_the_tray_is_watched_while_the_supervisor_waits(pc: Pc) -> None:
    # O agente sai com "outro agente já é dono desta instalação": o supervisor espera um minuto.
    pc.uv(["exit /b 5"], tray_lines=_TRAY_DIES_SOON)
    with heartbeat(pc.alive), pc.running(UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS="60"):
        assert wait_for(lambda: pc.tray_starts() == 1, 60), pc.supervisor_log()
        assert wait_for(lambda: pc.tray_starts() == 2, 20), "a espera não deixa o ícone de fora"
        assert pc.starts() == 1


def test_the_supervisor_restart_signal_stops_only_the_agent() -> None:
    runner = RUNNER.read_text(encoding="ascii")
    start = runner.index("if (Test-Path (Join-Path $runtime 'restart-now'))")
    block = runner[start : runner.index("$rollbackFlag", start)]
    # Encerra a árvore do agente acompanhado (e espera ela sair); o ícone não entra.
    assert "Stop-TrackedAgent $process" in block
    assert "$tray" not in block
