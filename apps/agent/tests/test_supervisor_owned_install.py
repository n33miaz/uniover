"""Supervisor `run-agent.ps1`: o agente que sai com 5 so encontrou outro dono da instalacao.

Nao e queda: nao conta contra a versao em prova (tres quedas voltam para a versao anterior), nao
enche a fila de diagnostico e a espera e calma, nunca um laco apertado. O laco de verdade, com um
`uv` falso, como em `test_supervisor_guardrails`.
"""

import os
import subprocess
import time
from pathlib import Path

import pytest

from uniover_agent.adapters.single_instance import EXIT_ALREADY_RUNNING

from .support import kill_tree
from .test_supervisor_guardrails import CURRENT, POWERSHELL, RUNNER, Pc, heartbeat, wait_for

pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

OWNED_WAIT = "3"


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path)


def test_the_supervisor_knows_the_exit_code_the_agent_uses() -> None:
    text = RUNNER.read_text(encoding="ascii")
    assert f"$ownedElsewhereCode = {EXIT_ALREADY_RUNNING}" in text


def test_an_agent_that_finds_another_owner_is_no_crash_for_a_version_in_proof(pc: Pc) -> None:
    pc.uv([f"exit /b {EXIT_ALREADY_RUNNING}"])
    trial = pc.runtime / "update-trial.txt"
    # Mais uma queda de verdade e a versao seria rejeitada e a anterior voltaria.
    trial.write_text(CURRENT + "|2", encoding="ascii")
    previous = pc.base / "app.previous"
    previous.mkdir()
    (previous / "marker.txt").write_text("anterior", encoding="ascii")
    with pc.running(UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS=OWNED_WAIT):
        assert wait_for(lambda: pc.starts() >= 3, 90), pc.supervisor_log()
        assert trial.read_text(encoding="ascii") == CURRENT + "|2"
        assert (pc.base / "app" / ".version").exists()
        assert (previous / "marker.txt").exists()
        assert not list(pc.runtime.glob("app.rejected-*"))
        assert not (pc.runtime / ".blocked-versions").exists()
        status = pc.runtime / "update-status.json"
        assert "rolled_back" not in (status.read_text(encoding="utf-8") if status.exists() else "")
        assert not (pc.runtime / "stop-reason.txt").exists()
    log = pc.supervisor_log()
    assert "outro agente ja roda" in log
    assert "caiu" not in log
    assert "terminou (codigo" not in log
    assert not any(i["kind"] == "process.exited" for i in pc.diagnostics())


def test_the_wait_after_finding_another_owner_is_fixed_and_never_a_tight_loop(pc: Pc) -> None:
    pc.uv([f"exit /b {EXIT_ALREADY_RUNNING}"])
    with pc.running(UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS=OWNED_WAIT):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        first = time.monotonic()
        assert wait_for(lambda: pc.starts() >= 3, 60), pc.supervisor_log()
        # Duas esperas de 3 s entre tres subidas: sem a espera seriam dezenas em poucos segundos.
        assert time.monotonic() - first >= 2 * float(OWNED_WAIT) - 1
        # A espera nao cresce (nao dobra a cada volta como a de uma queda).
        assert wait_for(lambda: pc.starts() >= 4, 30), pc.supervisor_log()
        assert time.monotonic() - first < 20 * float(OWNED_WAIT)


def test_the_agent_starts_normally_once_the_other_owner_is_gone(pc: Pc) -> None:
    seen = '"%UNIOVER_TEST_AGENTS%.seen"'
    pc.uv(
        [
            f"if exist {seen} goto stay",
            f"echo x> {seen}",
            f"exit /b {EXIT_ALREADY_RUNNING}",
            ":stay",
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
        ]
    )
    with pc.running(UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS=OWNED_WAIT):
        assert wait_for(lambda: pc.starts() >= 2, 90), pc.supervisor_log()
        time.sleep(float(OWNED_WAIT) + 1)
        assert pc.starts() == 2
    assert not any(i["kind"] == "process.exited" for i in pc.diagnostics())


def test_any_other_short_exit_is_still_a_crash_for_a_version_in_proof(pc: Pc) -> None:
    """Contraprova: so o codigo 5 e tratado como dono de fora; os demais seguem contando."""
    pc.uv(["exit /b 6"])
    trial = pc.runtime / "update-trial.txt"
    trial.write_text(CURRENT + "|0", encoding="ascii")
    with pc.running():
        assert wait_for(
            lambda: trial.exists() and trial.read_text(encoding="ascii") != CURRENT + "|0", 60
        ), pc.supervisor_log()
        assert wait_for(lambda: any(i["kind"] == "process.exited" for i in pc.diagnostics()), 5)


# --- o dono que sobrou: travado e encerrado; vivo e deixado em paz ------------------------------

# Agente falso: espera o dono aparecer (arquivo com o numero do processo) e sai com 5 enquanto vive.
WAIT_FOR_OWNER = [
    ":wait",
    'if exist "%UNIOVER_TEST_AGENTS%.owner" goto check',
    "ping -n 2 127.0.0.1 > nul",
    "goto wait",
    ":check",
    'set /p OWNER=<"%UNIOVER_TEST_AGENTS%.owner"',
    'tasklist /FI "PID eq %OWNER%" /NH 2>nul | "%SystemRoot%\\System32\\find.exe" "%OWNER%" > nul',
    f"if not errorlevel 1 exit /b {EXIT_ALREADY_RUNNING}",
    "ping -n 300 127.0.0.1 > nul",
    "exit /b 0",
]
SYNC_COUNTED = ['echo x>>"%UNIOVER_TEST_AGENTS%.sync"', "exit /b 0"]


def start_owner(pc: Pc) -> subprocess.Popen[bytes]:
    """Um processo de verdade que o supervisor reconhece como usuario desta instalacao."""
    source = pc.base / "app"
    owner = subprocess.Popen(  # noqa: S603 - cmd do sistema, so espera; o teste o encerra
        f'cmd.exe /d /c "ping -n 300 127.0.0.1 > nul & rem uniover-agent {source}"',
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=0x08000000,
    )
    Path(str(pc.agents) + ".owner").write_text(str(owner.pid), encoding="ascii")
    return owner


def stop_owner(owner: subprocess.Popen[bytes]) -> None:
    kill_tree(owner)


def syncs(pc: Pc) -> int:
    path = Path(str(pc.agents) + ".sync")
    return len(path.read_text(encoding="ascii").splitlines()) if path.exists() else 0


def make_stale(path: Path) -> None:
    path.write_text("0", encoding="ascii")
    old = time.time() - 3600
    os.utime(path, (old, old))


def test_a_stalled_owner_is_stopped_and_the_agent_comes_back(pc: Pc) -> None:
    pc.uv(WAIT_FOR_OWNER, sync_lines=SYNC_COUNTED)
    with pc.running(UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS=OWNED_WAIT):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        owner = start_owner(pc)
        try:
            assert wait_for(lambda: "outro agente ja roda" in pc.supervisor_log(), 60)
            make_stale(pc.alive)  # o dono parou de dar sinal de vida
            assert wait_for(lambda: owner.poll() is not None, 90), pc.supervisor_log()
            kinds = {i["kind"] for i in pc.diagnostics()}
            assert "process.unresponsive" in kinds
            assert wait_for(lambda: "mudo" in pc.supervisor_log(), 5)
            # Sem o dono, o agente sobe de verdade (e fica).
            before = pc.starts()
            assert wait_for(lambda: pc.starts() > before, 60), pc.supervisor_log()
            time.sleep(float(OWNED_WAIT) + 1)
            assert pc.starts() == before + 1
        finally:
            stop_owner(owner)


def test_a_live_owner_is_left_alone_and_nothing_is_synced_meanwhile(pc: Pc) -> None:
    pc.uv(WAIT_FOR_OWNER, sync_lines=SYNC_COUNTED)
    with heartbeat(pc.alive), pc.running(UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS=OWNED_WAIT):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        owner = start_owner(pc)
        try:
            assert wait_for(lambda: pc.starts() >= 4, 90), pc.supervisor_log()
            assert owner.poll() is None
            assert not any(i["kind"] == "process.unresponsive" for i in pc.diagnostics())
            assert syncs(pc) == 1  # so o do primeiro laco; as tentativas seguintes nao sincronizam
        finally:
            stop_owner(owner)


def test_a_restart_request_is_honored_while_waiting_for_the_owner(pc: Pc) -> None:
    pc.uv(WAIT_FOR_OWNER)
    flag = pc.runtime / "restart-now"
    with heartbeat(pc.alive), pc.running(UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS=OWNED_WAIT):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        owner = start_owner(pc)
        try:
            assert wait_for(lambda: "outro agente ja roda" in pc.supervisor_log(), 60)
            flag.write_text("", encoding="ascii")
            assert wait_for(lambda: not flag.exists(), 30), pc.supervisor_log()
            assert wait_for(lambda: owner.poll() is not None, 30), pc.supervisor_log()
            assert (pc.runtime / "stop-reason.txt").read_text(encoding="ascii") == "restart"
            assert "reinicio pedido" in pc.supervisor_log()
        finally:
            stop_owner(owner)


def test_a_rollback_request_is_honored_while_waiting_for_the_owner(pc: Pc) -> None:
    pc.uv(WAIT_FOR_OWNER)
    previous = pc.base / "app.previous"
    previous.mkdir()
    (previous / "marker.txt").write_text("anterior", encoding="ascii")
    flag = pc.runtime / "rollback-now"
    with heartbeat(pc.alive), pc.running(UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS=OWNED_WAIT):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        owner = start_owner(pc)
        try:
            assert wait_for(lambda: "outro agente ja roda" in pc.supervisor_log(), 60)
            flag.write_text("", encoding="ascii")
            assert wait_for(lambda: not flag.exists(), 30), pc.supervisor_log()
            assert wait_for((pc.base / "app" / "marker.txt").exists, 30), pc.supervisor_log()
            assert owner.poll() is not None
            assert not previous.exists()
        finally:
            stop_owner(owner)
