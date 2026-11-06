"""Supervisor `run-agent.ps1`: o agente que sai com 5 so encontrou outro dono da instalacao.

Nao e queda: nao conta contra a versao em prova (tres quedas voltam para a versao anterior), nao
enche a fila de diagnostico e a espera e calma, nunca um laco apertado. O laco de verdade, com um
`uv` falso, como em `test_supervisor_guardrails`.
"""

import time
from pathlib import Path

import pytest

from uniover_agent.adapters.single_instance import EXIT_ALREADY_RUNNING

from .test_supervisor_guardrails import CURRENT, POWERSHELL, RUNNER, Pc, wait_for

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
