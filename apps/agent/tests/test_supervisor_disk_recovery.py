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


def rollback_after_an_unwritable_trial(
    pc: Pc, tmp_path: Path, *, disk_fills: bool
) -> tuple[str, str]:
    """Uma versão nova entra, a prova dela não grava e o supervisor volta para a anterior.

    A prova não grava porque o caminho dela é uma pasta (o antivírus ou o disco cheio fazem igual).
    Com `disk_fills`, o espaço livre cai durante a atualização. Devolve o conteúdo de
    `.deferred-versions` e de `.deferred-lowdisk` ("" se o arquivo não existe)."""
    previous = pc.base / "app.previous"
    (previous / "tools").mkdir(parents=True)
    (previous / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (previous / "tools" / "run-agent.ps1").write_text("exit 0\n", encoding="ascii")
    (previous / ".version").write_text("c" * 40 + "\n", encoding="ascii")
    (pc.runtime / "update-trial.txt").mkdir()
    free = tmp_path / "free-mb.txt"
    free.write_text("5000", encoding="ascii")
    lines = ["echo " + "d" * 40 + '>"%UNIOVER_TEST_APP%\\.version"']
    if disk_fills:
        lines.append('echo 10>"%UNIOVER_TEST_FREE%"')
    lines.append("exit /b 0")
    pc.uv(["exit /b 0"], update_lines=lines)
    deferred = pc.runtime / ".deferred-versions"
    with pc.running(
        UNIOVER_TEST_APP=str(pc.base / "app"),
        UNIOVER_TEST_FREE=str(free),
        UNIOVER_SUPERVISOR_TEST_FREE_MB_FILE=str(free),
    ):
        assert wait_for(deferred.exists, 90), pc.supervisor_log()
    lowdisk = pc.runtime / ".deferred-lowdisk"
    return (
        deferred.read_text(encoding="ascii"),
        lowdisk.read_text(encoding="ascii") if lowdisk.exists() else "",
    )


def test_a_trial_that_cannot_be_written_with_plenty_of_disk_is_a_normal_deferral(
    pc: Pc, tmp_path: Path
) -> None:
    deferred, lowdisk = rollback_after_an_unwritable_trial(pc, tmp_path, disk_fills=False)
    assert deferred.startswith("d" * 40 + "|")
    assert lowdisk == ""  # o espaço não faltou: o adiamento que cresce vale, sem a isenção do disco


def test_a_trial_that_cannot_be_written_because_the_disk_filled_is_marked_with_the_same_epoch(
    pc: Pc, tmp_path: Path
) -> None:
    deferred, lowdisk = rollback_after_an_unwritable_trial(pc, tmp_path, disk_fills=True)
    assert deferred.startswith("d" * 40 + "|")
    assert lowdisk.strip() == deferred.strip()  # `sha|epoch`, o mesmo da linha do adiamento


def test_an_update_that_cannot_import_on_the_kept_environment_is_noted_once_then_waits(
    pc: Pc, tmp_path: Path
) -> None:
    venv_python(pc)
    free = tmp_path / "free-mb.txt"
    free.write_text("100", encoding="ascii")
    seen = tmp_path / "updates.txt"
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=["echo sem espaco 1>&2", "exit /b 1"],
        update_lines=[
            'echo x>>"%UNIOVER_TEST_UPDATES%"',
            "echo ModuleNotFoundError: No module named httpx 1>&2",
            "exit /b 1",
        ],
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
        free.write_text("5000", encoding="ascii")
        assert wait_for(seen.exists, 40), pc.supervisor_log()
        time.sleep(12)  # várias checagens de 3 s: nenhuma repete o update
    assert len(seen.read_text("ascii").split()) == 1
    kinds = [item["kind"] for item in pc.diagnostics()]
    assert kinds.count("update.kept_env_unusable") == 1
    assert pc.starts() == 1  # sem reinício e sem apagar o ambiente
