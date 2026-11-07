"""A atualização espera a TV parar; o adiamento por falta de espaço expira quando o disco volta."""

import os
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

from uniover_agent.adapters import self_update as module
from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.adapters.self_update import UpdateResult
from uniover_agent.adapters.tv_use_marker import MARKER_FILE, TvUseMarker
from uniover_agent.adapters.update_status import BUSY_REASON, FileUpdateStatus, record_result
from uniover_agent.core import TvSessionManager

from .test_self_update import NEW, OLD, Installation

GIB = 1024**3
NOW = 1_800_000_000.0


@pytest.fixture
def installed(tmp_path: Path) -> Installation:
    pc = Installation(tmp_path / "UniOver")
    (pc.base / "runtime").mkdir()
    return pc


def mark_use(pc: Installation, seconds_ago: float, *, now: float = NOW) -> Path:
    marker = pc.base / "runtime" / module.TV_LAST_USE_FILE
    marker.write_text("x", encoding="ascii")
    os.utime(marker, (now - seconds_ago, now - seconds_ago))
    return marker


def update(
    pc: Installation, *, now: float = NOW, free: int = 50 * GIB, **kwargs: object
) -> UpdateResult:
    return pc.update(NEW, wall=lambda: now, free_bytes=lambda _folder: free, **kwargs)


def test_the_tv_counts_as_in_use_only_inside_the_window(installed: Installation) -> None:
    assert not module.tv_in_use(installed.source, NOW)  # sem a marca: parada, como antes
    mark_use(installed, 30)
    assert module.tv_in_use(installed.source, NOW)
    mark_use(installed, 599)
    assert module.tv_in_use(installed.source, NOW)
    mark_use(installed, 601)
    assert not module.tv_in_use(installed.source, NOW)
    # A janela zerada desliga a espera.
    mark_use(installed, 1)
    assert not module.tv_in_use(installed.source, NOW, idle_seconds=0)


def test_a_use_stamp_in_the_future_beyond_the_window_proves_nothing(
    installed: Installation,
) -> None:
    mark_use(installed, -3600)  # relógio do PC voltou: a data da marca está uma hora adiante
    assert not module.tv_in_use(installed.source, NOW)


def test_an_update_waits_while_the_tv_is_in_use_and_downloads_nothing(
    installed: Installation,
) -> None:
    mark_use(installed, 60)
    result = update(installed)
    assert not result.updated and result.outcome == "deferred_busy" and result.latest == NEW
    assert installed.downloads == []
    assert read_version(installed) == OLD


def test_the_update_goes_ahead_once_the_tv_is_idle_and_clears_the_wait(
    installed: Installation,
) -> None:
    mark_use(installed, 60)
    assert update(installed).outcome == "deferred_busy"
    waiting = installed.base / "runtime" / module.TV_WAIT_FILE
    assert waiting.is_file()
    later = NOW + 20 * 60  # 21 min depois do último uso
    assert update(installed, now=later).updated
    assert not waiting.exists()


def test_the_wait_has_a_ceiling_and_the_clock_survives_restarts(installed: Installation) -> None:
    marker = mark_use(installed, 0)
    assert update(installed).outcome == "deferred_busy"
    # A TV segue em uso o tempo todo (cada checagem renova a marca); 23 h depois ainda espera.
    for hours in (1, 6, 23):
        moment = NOW + hours * 3600
        os.utime(marker, (moment, moment))
        assert update(installed, now=moment).outcome == "deferred_busy"
    moment = NOW + 24 * 3600 + 1
    os.utime(marker, (moment, moment))
    assert update(installed, now=moment).updated, "passou do teto: atualiza mesmo com a TV em uso"


def test_update_now_does_not_wait_for_the_tv(installed: Installation) -> None:
    mark_use(installed, 5)
    assert update(installed, ignore_deferral=True).updated


def test_a_wait_clock_that_cannot_be_written_does_not_wait(installed: Installation) -> None:
    # Sem como contar o teto de 24 h, esperar poderia nunca acabar: atualiza.
    mark_use(installed, 5)
    runtime = installed.base / "runtime"
    (runtime / module.TV_WAIT_FILE).mkdir()  # uma pasta no lugar do arquivo: gravar falha
    assert module.should_wait_for_tv(installed.source, NOW, in_use=True) is False


def test_an_agent_that_is_already_current_forgets_the_wait(installed: Installation) -> None:
    waiting = installed.base / "runtime" / module.TV_WAIT_FILE
    waiting.write_text(f"{NOW:.0f}\n", encoding="ascii")
    assert installed.update(OLD).outcome == "up_to_date"
    assert not waiting.exists()


def test_the_wait_is_a_neutral_result_in_the_update_status(installed: Installation) -> None:
    status = installed.base / "runtime" / "update-status.json"
    record_result(
        status,
        UpdateResult(False, "x", "deferred_busy", latest=NEW),
        datetime(2026, 11, 7, 12, 0, tzinfo=UTC),
    )
    shown = FileUpdateStatus(status, installed.source).read()
    assert shown.outcome == "up_to_date"
    assert shown.reason == BUSY_REASON


# --- o que o agente grava: a data da marca é o instante do último uso ---------------------


async def test_the_session_reports_only_real_use() -> None:
    clock = FakeClock()
    manager = TvSessionManager(clock, FakeTvRemote())
    assert manager.seconds_since_use() is None  # nada o usou desde que o agente subiu
    await manager.reopen_unattended()
    clock.advance(10)
    assert manager.seconds_since_use() is None  # a reabertura sozinha não é uso
    manager.set_keep_hot(True)
    assert manager.seconds_since_use() is None  # nem o modo foco
    await manager.send_key("HOME")
    clock.advance(42)
    assert manager.seconds_since_use() == 42.0


def test_the_marker_carries_the_last_use_into_the_file_date(tmp_path: Path) -> None:
    path = tmp_path / MARKER_FILE
    path.write_text("x", encoding="ascii")
    old = NOW - 86400
    os.utime(path, (old, old))
    age: dict[str, float | None] = {"value": None}
    marker = TvUseMarker(path, lambda: age["value"], FakeClock(), wall=lambda: NOW)
    assert marker.sync() is False  # sem uso nesta execução, a data de antes vale
    assert path.stat().st_mtime == pytest.approx(old)
    age["value"] = 90.0
    assert marker.sync() is True
    assert path.stat().st_mtime == pytest.approx(NOW - 90)
    assert marker.sync() is False  # o mesmo uso não é gravado de novo


def test_the_marker_creates_the_file_when_it_is_missing_and_survives_failure(
    tmp_path: Path,
) -> None:
    path = tmp_path / "runtime" / MARKER_FILE
    marker = TvUseMarker(path, lambda: 5.0, FakeClock(), wall=lambda: NOW)
    assert marker.sync() is True and path.is_file()
    blocked = TvUseMarker(tmp_path / "file" / MARKER_FILE, lambda: 5.0, FakeClock(), wall=time.time)
    (tmp_path / "file").write_text("não é pasta", encoding="utf-8")
    assert blocked.sync() is False  # falhar é o mesmo que "TV parada": nada levanta


# --- espaço em disco: o adiamento por falta de espaço expira quando o disco volta ---------


def defer(pc: Installation, *, lowdisk: bool, returns: int = 1) -> None:
    runtime = pc.base / "runtime"
    (runtime / ".deferred-versions").write_text(
        f"{NEW}|{int(NOW) - 3600}\n" * returns, encoding="ascii"
    )
    if lowdisk:
        (runtime / module.DEFERRED_LOWDISK_FILE).write_text(NEW + "\n", encoding="ascii")


def test_a_low_disk_deferral_expires_when_the_disk_has_room_again(installed: Installation) -> None:
    defer(installed, lowdisk=True)
    assert module.deferred_versions(installed.source, NOW) == {NEW}
    assert module.deferred_versions(installed.source, NOW, disk_ok=True) == set()


def test_only_the_versions_returned_for_lack_of_space_expire_with_the_disk(
    installed: Installation,
) -> None:
    defer(installed, lowdisk=False)  # devolvida por demora, não por disco
    assert module.deferred_versions(installed.source, NOW, disk_ok=True) == {NEW}


def test_the_deferral_file_keeps_its_old_format(installed: Installation) -> None:
    # A versão anterior (a que volta numa devolução) lê `.deferred-versions` como `sha|epoch`: a
    # causa vai em arquivo à parte, senão ela ignoraria a linha e reinstalaria a devolvida.
    defer(installed, lowdisk=True)
    lines = (installed.base / "runtime" / ".deferred-versions").read_text(encoding="ascii")
    assert [line.count("|") for line in lines.splitlines()] == [1]


def test_the_update_runs_when_the_disk_came_back_with_room(installed: Installation) -> None:
    defer(installed, lowdisk=True)
    # 1 GB livres: acima do mínimo para atualizar, mas ainda sem a folga que a devolvida pede.
    assert update(installed, free=1 * GIB).outcome == "deferred"
    assert installed.downloads == []
    assert update(installed, free=3 * GIB).updated


def test_a_low_disk_deferral_does_not_hide_a_version_while_the_disk_is_still_low(
    installed: Installation,
) -> None:
    defer(installed, lowdisk=True)
    result = update(installed, free=100 * 1024 * 1024)
    assert result.outcome == "deferred"
    assert installed.downloads == []


def read_version(pc: Installation) -> str | None:
    return module.read_version(pc.source)


def test_only_the_limits_the_configuration_changed_reach_the_update() -> None:
    from uniover_agent.composition.maintenance import _update_limits  # noqa: PLC0415
    from uniover_agent.config import Settings  # noqa: PLC0415

    assert _update_limits(None) == {}
    assert _update_limits(Settings()) == {}
    changed = _update_limits(Settings(update_tv_idle_seconds=30, disk_warn_mb=4096))
    assert changed == {"tv_idle_seconds": 30.0, "resume_free_bytes": 4096 * 1024 * 1024}
