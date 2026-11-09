"""Supervisor: um `uv` anterior a 0.9.8 (que não entende o `exclude-dependencies` do pyproject) é avisado e atualizado.

Os mesmos scripts de verdade dos outros testes do supervisor (Windows PowerShell 5.1, `uv` e `winget` falsos, instalação
falsa em pasta temporária). Medido com o `uv` de verdade: da 0.4.30 à 0.9.7 o `uv sync --frozen` sincroniza o lock do agente
normalmente (só avisa da chave desconhecida); da 0.9.8 em diante a chave é entendida. O que um `uv` antigo faria errado é
qualquer comando SEM --frozen refazer a resolução, trazendo de volta o pacote `av`.
"""

import time
from pathlib import Path

import pytest

from .test_supervisor_guardrails import POWERSHELL, Pc, heartbeat, wait_for

pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

CHECK_SOON = {"UNIOVER_SUPERVISOR_UV_CHECK_SECONDS": "0.5"}


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path)


def fake_winget(pc: Pc, *, installed: bool) -> Path:
    """`winget list` diz se o uv veio dele; `winget upgrade` só anota que foi chamado."""
    marker = pc.bin.parent / "winget-upgrades.txt"
    list_line = (
        "echo astral-sh.uv 0.8.0 & exit /b 0" if installed else "echo Nenhum pacote & exit /b 1"
    )
    (pc.bin / "winget.cmd").write_text(
        "\n".join(
            [
                "@echo off",
                f'if "%~1"=="list" ({list_line})',
                f'if "%~1"=="upgrade" (echo %* >>"{marker}" & exit /b 0)',
                "exit /b 0",
                "",
            ]
        ),
        encoding="ascii",
    )
    return marker


def settle_agent(pc: Pc) -> None:
    assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()


def diagnostic_kinds(pc: Pc) -> list[str]:
    return [entry["kind"] for entry in pc.diagnostics()]


def test_an_old_uv_is_reported_and_winget_is_asked_to_update_it(pc: Pc) -> None:
    marker = fake_winget(pc, installed=True)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running(UNIOVER_TEST_UV_VERSION="0.8.0", **CHECK_SOON):
        settle_agent(pc)
        assert wait_for(marker.exists, 40), pc.supervisor_log()
        time.sleep(2)
    assert "supervisor.old_uv" in diagnostic_kinds(pc)
    detail = next(e["detail"] for e in pc.diagnostics() if e["kind"] == "supervisor.old_uv")
    assert "0.8.0" in detail
    assert "0.9.8" in detail
    assert "astral-sh.uv" in marker.read_text("ascii")
    # Uma vez só por execução, e o agente nunca esperou por isso.
    assert marker.read_text("ascii").count("upgrade") == 1
    assert pc.starts() == 1


def test_the_agent_starts_before_the_uv_is_checked(pc: Pc) -> None:
    fake_winget(pc, installed=True)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    # Prazo longo: a conferência nem chega a rodar, e o agente já está de pé.
    with (
        heartbeat(pc.alive),
        pc.running(UNIOVER_TEST_UV_VERSION="0.8.0", UNIOVER_SUPERVISOR_UV_CHECK_SECONDS="600"),
    ):
        settle_agent(pc)
        time.sleep(3)
    assert "supervisor.old_uv" not in diagnostic_kinds(pc)


def test_an_old_uv_that_did_not_come_from_winget_is_reported_but_left_alone(pc: Pc) -> None:
    marker = fake_winget(pc, installed=False)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running(UNIOVER_TEST_UV_VERSION="0.7.0", **CHECK_SOON):
        settle_agent(pc)
        assert wait_for(lambda: "supervisor.old_uv" in diagnostic_kinds(pc), 40), (
            pc.supervisor_log()
        )
        time.sleep(2)
    assert not marker.exists()
    assert "nao veio do winget" in pc.supervisor_log()
    assert pc.starts() == 1


@pytest.mark.parametrize("version", ["0.9.8", "0.11.19", "1.0.0"])
def test_a_uv_that_understands_the_project_is_left_alone(pc: Pc, version: str) -> None:
    marker = fake_winget(pc, installed=True)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running(UNIOVER_TEST_UV_VERSION=version, **CHECK_SOON):
        settle_agent(pc)
        time.sleep(4)
    assert "supervisor.old_uv" not in diagnostic_kinds(pc)
    assert not marker.exists()


def test_a_uv_that_does_not_say_its_version_is_left_alone(pc: Pc) -> None:
    marker = fake_winget(pc, installed=True)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running(**CHECK_SOON):
        settle_agent(pc)
        time.sleep(4)
    assert "supervisor.old_uv" not in diagnostic_kinds(pc)
    assert not marker.exists()


def test_every_uv_command_of_the_supervisor_runs_frozen(pc: Pc, tmp_path: Path) -> None:
    # `UV_FROZEN`: um `uv run` não refaz a resolução (que, num uv antigo, traria o `av` de volta).
    seen = tmp_path / "frozen.txt"
    pc.uv(
        ['echo [%UV_FROZEN%]>>"%UNIOVER_TEST_FROZEN%"', "ping -n 300 127.0.0.1 > nul", "exit /b 0"]
    )
    with heartbeat(pc.alive), pc.running(UNIOVER_TEST_FROZEN=str(seen)):
        settle_agent(pc)
        assert wait_for(seen.exists, 20)
    assert seen.read_text("ascii").split()[0] == "[1]"
