"""Supervisor: o disco que volta depois de cheio atualiza na checagem normal, sem reiniciar.

Os mesmos scripts de verdade dos outros testes do supervisor (Windows PowerShell 5.1, `uv` falso,
instalação falsa em pasta temporária). O espaço livre é simulado por um arquivo reescrito.
"""

import os
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

from .test_supervisor_guardrails import (
    CURRENT,
    POWERSHELL,
    Pc,
    heartbeat,
    trial_with_previous,
    wait_for,
)

pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path)


def venv_python(pc: Pc) -> Path:
    python = pc.runtime / "venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_text("", encoding="ascii")
    return python


def test_an_environment_kept_for_lack_of_space_updates_when_the_space_comes_back(
    pc: Pc, tmp_path: Path
) -> None:
    python = venv_python(pc)
    free = tmp_path / "free-mb.txt"
    free.write_text("100", encoding="ascii")  # disco cheio: abaixo dos 600 MB do supervisor
    seen = tmp_path / "update-env.txt"
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=["echo sem espaco 1>&2", "exit /b 1"],
        update_lines=['echo [%UV_NO_SYNC%]>>"%UNIOVER_TEST_UPDATES%"', "exit /b 0"],
    )
    with (
        heartbeat(pc.alive),
        pc.running(
            UNIOVER_SUPERVISOR_TEST_FREE_MB_FILE=str(free),
            UNIOVER_SUPERVISOR_KEPT_RETRY_SECONDS="3",
            UNIOVER_TEST_UPDATES=str(seen),
        ),
    ):
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
        time.sleep(8)  # o disco segue cheio: várias voltas, e o update não roda
        assert not seen.exists(), "atualizou com o disco ainda cheio"
        free.write_text("5000", encoding="ascii")  # o espaço voltou
        assert wait_for(seen.exists, 40), pc.supervisor_log()
        time.sleep(3)
    # Na checagem normal, sem sync implícito (UV_NO_SYNC) e sem pedido do dono.
    assert seen.read_text("ascii").split()[0] == "[1]"
    # Nenhum reinício só para sincronizar, e o ambiente que rodava nunca foi apagado.
    assert pc.starts() == 1
    assert "o agente terminou" not in pc.supervisor_log()
    assert python.is_file()


def test_an_environment_kept_because_the_sync_was_slow_still_waits_for_a_full_sync(
    pc: Pc, tmp_path: Path
) -> None:
    # A relaxação vale só para o ambiente mantido por FALTA DE ESPAÇO: o mantido por demora do sync
    # segue esperando o sync completo (o `uv run` do update refaria o sync, sem prazo).
    venv_python(pc)
    seen = tmp_path / "update-env.txt"
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=["ping -n 60 127.0.0.1 > nul", "exit /b 0"],
        update_lines=['echo [%UV_NO_SYNC%]>>"%UNIOVER_TEST_UPDATES%"', "exit /b 0"],
    )
    with (
        heartbeat(pc.alive),
        pc.running(
            UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="2",
            UNIOVER_SUPERVISOR_KEPT_RETRY_SECONDS="3",
            UNIOVER_TEST_UPDATES=str(seen),
        ),
    ):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        time.sleep(10)
        assert not seen.exists()


def test_a_still_low_disk_never_runs_the_update_on_a_kept_environment(
    pc: Pc, tmp_path: Path
) -> None:
    venv_python(pc)
    seen = tmp_path / "update-env.txt"
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=["echo sem espaco 1>&2", "exit /b 1"],
        update_lines=['echo [%UV_NO_SYNC%]>>"%UNIOVER_TEST_UPDATES%"', "exit /b 0"],
    )
    with (
        heartbeat(pc.alive),
        pc.running(
            UNIOVER_SUPERVISOR_MIN_FREE_MB="999999999",
            UNIOVER_SUPERVISOR_KEPT_RETRY_SECONDS="3",
            UNIOVER_TEST_UPDATES=str(seen),
        ),
    ):
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
        time.sleep(10)
        assert not seen.exists()


def test_a_version_returned_for_lack_of_space_is_marked_apart_from_the_old_format(pc: Pc) -> None:
    trial_with_previous(pc)
    pc.uv(["exit /b 0"], sync_lines=["echo sem espaco 1>&2", "exit /b 1"])
    with pc.running(UNIOVER_SUPERVISOR_MIN_FREE_MB="999999999"):
        assert wait_for(lambda: "voltei para a versao anterior" in pc.supervisor_log(), 120), (
            pc.supervisor_log()
        )
    marks = (pc.runtime / ".deferred-versions").read_text(encoding="ascii").split()
    # O formato que a versão anterior lê: `sha|epoch`, sem campo a mais (ela o ignoraria).
    assert len(marks) == 1 and marks[0].startswith(CURRENT + "|") and marks[0].count("|") == 1
    assert CURRENT in (pc.runtime / ".deferred-lowdisk").read_text(encoding="ascii")


def test_a_version_returned_for_a_real_sync_error_is_not_marked_as_lack_of_space(pc: Pc) -> None:
    trial_with_previous(pc)
    pc.uv(["exit /b 0"], sync_lines=["echo erro de dependencia 1>&2", "exit /b 1"])
    with pc.running(UNIOVER_SUPERVISOR_MIN_FREE_MB="1"):
        assert wait_for(lambda: "voltei para a versao anterior" in pc.supervisor_log(), 120), (
            pc.supervisor_log()
        )
    assert not (pc.runtime / ".deferred-lowdisk").exists()


def test_the_supervisor_creates_the_tv_use_marker_with_an_old_date_and_keeps_an_existing_one(
    pc: Pc,
) -> None:
    marker = pc.runtime / "tv-last-use"
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running():
        assert wait_for(marker.exists, 30), pc.supervisor_log()
    # Nunca usada: a data é antiga (a TV conta como parada), mas o arquivo já existe para o agente.
    assert datetime.fromtimestamp(marker.stat().st_mtime, UTC).year == 2000
    used = time.time() - 30
    os.utime(marker, (used, used))
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
    assert marker.stat().st_mtime == pytest.approx(used, abs=1)
