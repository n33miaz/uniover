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


def mark_pc_use(pc: Installation, seconds_ago: float, *, now: float = NOW) -> Path:
    marker = pc.base / "runtime" / module.PC_LAST_USE_FILE
    marker.write_text("x", encoding="ascii")
    os.utime(marker, (now - seconds_ago, now - seconds_ago))
    return marker


def test_the_pc_control_counts_as_in_use_only_inside_the_window(installed: Installation) -> None:
    assert not module.control_in_use(installed.source, NOW)  # sem nenhuma marca: parado
    mark_pc_use(installed, 30)
    assert module.pc_in_use(installed.source, NOW)
    assert module.control_in_use(installed.source, NOW)
    assert not module.tv_in_use(installed.source, NOW), "a marca da TV continua só da TV"
    mark_pc_use(installed, 601)
    assert not module.control_in_use(installed.source, NOW)


def test_an_update_waits_while_the_pc_is_being_controlled_and_goes_ahead_after(
    installed: Installation,
) -> None:
    mark_pc_use(installed, 20)
    result = update(installed)
    assert not result.updated and result.outcome == "deferred_busy"
    assert installed.downloads == []
    assert read_version(installed) == OLD
    assert update(installed, now=NOW + 20 * 60).updated


def test_update_now_does_not_wait_for_the_pc_control(installed: Installation) -> None:
    mark_pc_use(installed, 5)
    assert update(installed, ignore_deferral=True).updated


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
    assert module.should_wait_for_tv(installed.source, NOW, sha=NEW, in_use=True) is False


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
    await manager.wake()
    clock.advance(10)
    # A tela do controle aberta (o `wake` periódico) só pré-aquece: não é uso, nem a abertura dele.
    assert manager.seconds_since_use() is None
    await manager.send_key("HOME")
    clock.advance(42)
    assert manager.seconds_since_use() == 42.0


async def test_the_background_recovery_after_a_drop_is_not_use() -> None:
    clock = FakeClock()
    remote = FakeTvRemote()
    manager = TvSessionManager(clock, remote)
    await manager.wake()
    remote.drop()  # a TV derrubou a sessão: o vigia de fundo a reabre sozinho
    await manager.settle()
    assert remote.connects == 2
    assert manager.seconds_since_use() is None
    await manager.send_key("HOME")
    remote.drop()
    await manager.settle()
    clock.advance(30)
    assert (
        manager.seconds_since_use() == 30.0
    )  # o comando de antes segue valendo, a recuperação não o renova


async def test_a_session_kept_warm_for_playback_counts_as_use_until_released() -> None:
    clock = FakeClock()
    manager = TvSessionManager(clock, FakeTvRemote())
    await manager.wake()
    manager.set_keep_hot(True)
    clock.advance(600)
    assert manager.seconds_since_use() == 0.0
    manager.set_keep_hot(False)
    assert manager.seconds_since_use() is None


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


def defer(pc: Installation, *returns: bool, ago: int = 3600) -> None:
    """Uma linha em `.deferred-versions` por devolução (True: devolvida por falta de espaço).

    A última devolução foi há `ago` s; as anteriores, uma hora antes uma da outra."""
    runtime = pc.base / "runtime"
    stamps = [int(NOW) - ago - 3600 * (len(returns) - 1 - n) for n in range(len(returns))]
    (runtime / ".deferred-versions").write_text(
        "".join(f"{NEW}|{stamp}\n" for stamp in stamps), encoding="ascii"
    )
    marks = "".join(f"{NEW}|{stamp}\n" for stamp, low in zip(stamps, returns, strict=True) if low)
    if marks:
        (runtime / module.DEFERRED_LOWDISK_FILE).write_text(marks, encoding="ascii")


def test_a_low_disk_deferral_expires_when_the_disk_has_room_again(installed: Installation) -> None:
    defer(installed, True)
    assert module.deferred_versions(installed.source, NOW) == {NEW}
    assert module.deferred_versions(installed.source, NOW, disk_ok=True) == set()


def test_only_the_versions_returned_for_lack_of_space_expire_with_the_disk(
    installed: Installation,
) -> None:
    defer(installed, False)  # devolvida por demora, não por disco
    assert module.deferred_versions(installed.source, NOW, disk_ok=True) == {NEW}


def test_the_deferral_file_keeps_its_old_format(installed: Installation) -> None:
    # A versão anterior (a que volta numa devolução) lê `.deferred-versions` como `sha|epoch`: a
    # causa vai em arquivo à parte, senão ela ignoraria a linha e reinstalaria a devolvida.
    defer(installed, True)
    lines = (installed.base / "runtime" / ".deferred-versions").read_text(encoding="ascii")
    assert [line.count("|") for line in lines.splitlines()] == [1]


def test_the_update_runs_when_the_disk_came_back_with_room(installed: Installation) -> None:
    defer(installed, True)
    # 1 GB livres: acima do mínimo para atualizar, mas ainda sem a folga que a devolvida pede.
    assert update(installed, free=1 * GIB).outcome == "deferred"
    assert installed.downloads == []
    assert update(installed, free=3 * GIB).updated


def test_a_low_disk_deferral_does_not_hide_a_version_while_the_disk_is_still_low(
    installed: Installation,
) -> None:
    defer(installed, True)
    result = update(installed, free=100 * 1024 * 1024)
    assert result.outcome == "deferred"
    assert installed.downloads == []


def test_the_exemption_is_only_for_a_first_return_that_was_for_lack_of_space(
    installed: Installation,
) -> None:
    day = 24 * 3600
    # Uma devolução por disco e, depois, uma por outro motivo: vale o adiamento normal (e cresce).
    defer(installed, True, False)
    assert module.deferred_versions(installed.source, NOW, disk_ok=True) == {NEW}
    assert module.deferred_versions(installed.source, NOW + 2 * day, disk_ok=True) == {NEW}
    assert module.deferred_versions(installed.source, NOW + 4 * day, disk_ok=True) == set()
    # O contrário (a última foi por disco, mas já havia outra devolução): também cresce.
    defer(installed, False, True)
    assert module.deferred_versions(installed.source, NOW, disk_ok=True) == {NEW}


def test_repeated_returns_for_lack_of_space_still_grow_the_deferral(
    installed: Installation,
) -> None:
    day = 24 * 3600
    defer(installed, True, True)  # segunda devolução por disco: 72 h mesmo com o disco livre
    assert module.deferred_versions(installed.source, NOW, disk_ok=True) == {NEW}
    assert module.deferred_versions(installed.source, NOW + 2 * day, disk_ok=True) == {NEW}
    assert module.deferred_versions(installed.source, NOW + 4 * day, disk_ok=True) == set()
    defer(installed, True, True, True)  # terceira: uma semana
    assert module.deferred_versions(installed.source, NOW + 6 * day, disk_ok=True) == {NEW}


def test_a_mark_in_the_old_format_never_exempts_anything(installed: Installation) -> None:
    defer(installed, False)
    (installed.base / "runtime" / module.DEFERRED_LOWDISK_FILE).write_text(
        NEW + "\n", encoding="ascii"
    )
    assert module.deferred_versions(installed.source, NOW, disk_ok=True) == {NEW}


def clock_file(pc: Installation) -> Path:
    return pc.base / "runtime" / module.TV_WAIT_FILE


def clock_start(pc: Installation) -> str:
    """O início guardado no relógio da espera (`sha|epoch[|again]`)."""
    return clock_file(pc).read_text(encoding="ascii").strip().split("|")[1]


def broken_download(_sha: str, _destination: Path) -> None:
    raise module.SelfUpdateError("sem rede")


def test_the_oldest_start_of_the_wait_is_kept_when_the_candidate_changes(
    installed: Installation,
) -> None:
    other = "c" * 40
    marker = mark_use(installed, 0)
    assert update(installed).outcome == "deferred_busy"
    started = clock_start(installed)
    moment = NOW + 23 * 3600
    os.utime(marker, (moment, moment))
    first = installed.update(other, wall=lambda: moment, free_bytes=lambda _f: 50 * GIB)
    assert first.outcome == "deferred_busy"
    assert clock_start(installed) == started  # o commit novo só troca o sha informativo
    # 25 h depois da primeira espera o teto vale, mesmo com um commit novo no meio.
    later = NOW + 25 * 3600
    os.utime(marker, (later, later))
    final = installed.update(other, wall=lambda: later, free_bytes=lambda _f: 50 * GIB)
    assert final.outcome != "deferred_busy"
    assert installed.downloads[-1] == other  # o teto venceu: seguiu para o download


def test_a_failed_check_keeps_the_wait_clock(installed: Installation) -> None:
    marker = mark_use(installed, 0)
    assert update(installed).outcome == "deferred_busy"
    started = clock_start(installed)
    later = NOW + 25 * 3600  # passou do teto: a checagem segue e o download falha
    os.utime(marker, (later, later))
    result = update(installed, now=later, download=broken_download)
    assert result.outcome == "failed"
    assert clock_file(installed).is_file() and clock_start(installed) == started


def test_a_tv_in_constant_use_updates_after_24_hours_even_with_a_failure_in_between(
    installed: Installation,
) -> None:
    marker = mark_use(installed, 0)
    assert update(installed).outcome == "deferred_busy"
    hour = 3600
    for hours in (3, 12, 23):  # a TV segue em uso: espera
        os.utime(marker, (NOW + hours * hour, NOW + hours * hour))
        assert update(installed, now=NOW + hours * hour).outcome == "deferred_busy"
    # Passou do teto: o download falha uma vez...
    moment = NOW + 24 * hour + 60
    os.utime(marker, (moment, moment))
    assert update(installed, now=moment, download=broken_download).outcome == "failed"
    # ...e a checagem seguinte, com a TV ainda em uso, atualiza (o relógio não recomeçou).
    after = moment + 12 * 60
    os.utime(marker, (after, after))
    assert update(installed, now=after).updated
    assert not clock_file(installed).exists()  # apagado só depois da troca


def test_an_idle_tv_at_the_start_of_a_check_clears_the_clock(installed: Installation) -> None:
    mark_use(installed, 0)
    assert update(installed).outcome == "deferred_busy"
    assert clock_file(installed).is_file()
    result = update(installed, now=NOW + 3600, download=broken_download)  # TV parada há 1 h
    assert result.outcome == "failed"
    assert not clock_file(installed).exists()


def test_after_the_tv_returned_during_preparation_the_clock_survives_the_next_idle_start(
    installed: Installation,
) -> None:
    # Check 1: a TV estava parada, foi usada durante a preparação: não troca e marca o retorno.
    def used_meanwhile(_candidate: Path) -> None:
        mark_use(installed, 1)

    assert update(installed, run_check=used_meanwhile).outcome == "deferred_busy"
    started = clock_start(installed)
    assert clock_file(installed).read_text(encoding="ascii").strip().endswith("|again")
    # Check 2, 20 min depois: a TV passou a janela inteira parada. Não apaga o relógio só por isso.
    later = NOW + 20 * 60
    result = update(installed, now=later, download=broken_download)
    assert result.outcome == "failed"
    assert clock_file(installed).is_file() and clock_start(installed) == started
    assert not clock_file(installed).read_text(encoding="ascii").strip().endswith("|again")
    # Check 3, com a TV parada e sem retorno na anterior: agora sim recomeça do zero.
    assert update(installed, now=later + 20 * 60, download=broken_download).outcome == "failed"
    assert not clock_file(installed).exists()


def fetch_fails() -> str:
    raise module.SelfUpdateError("sem rede")


def early_outcome(pc: Installation, kind: str, now: float) -> str:
    """Uma checagem com a TV parada que termina antes da espera pela TV; devolve o desfecho."""
    runtime = pc.base / "runtime"
    if kind == "fetch":
        result = module.self_update(
            pc.source,
            fetch_latest=fetch_fails,
            wall=lambda: now,
            free_bytes=lambda _f: 50 * GIB,
        )
        return result.outcome or ""
    if kind == "blocked":
        (runtime / module.BLOCKED_VERSIONS_FILE).write_text(NEW + "\n", encoding="ascii")
        return update(pc, now=now).outcome or ""
    if kind == "deferred":
        defer(pc, False, ago=60)
        return update(pc, now=now).outcome or ""
    return update(pc, now=now, free=100 * 1024 * 1024).outcome or ""  # pouco espaço


@pytest.mark.parametrize(
    ("kind", "outcome"),
    [("fetch", "failed"), ("blocked", "blocked"), ("deferred", "deferred"), ("lowdisk", "failed")],
)
def test_an_idle_tv_clears_the_clock_even_when_the_check_ends_early(
    installed: Installation, kind: str, outcome: str
) -> None:
    mark_use(installed, 0)
    assert update(installed).outcome == "deferred_busy"
    assert clock_file(installed).is_file()
    assert early_outcome(installed, kind, NOW + 3600) == outcome  # a TV parou há 1 h
    assert not clock_file(installed).exists()


def test_the_return_mark_is_settled_even_when_the_check_ends_early(
    installed: Installation,
) -> None:
    def used_meanwhile(_candidate: Path) -> None:
        mark_use(installed, 1)

    assert update(installed, run_check=used_meanwhile).outcome == "deferred_busy"
    started = clock_start(installed)
    assert early_outcome(installed, "fetch", NOW + 20 * 60) == "failed"
    # O relógio segue (a checagem anterior terminou com a TV voltando) e a marca caiu.
    assert clock_start(installed) == started
    assert not clock_file(installed).read_text(encoding="ascii").strip().endswith("|again")
    assert early_outcome(installed, "fetch", NOW + 40 * 60) == "failed"
    assert not clock_file(installed).exists()


def test_the_tv_is_not_released_before_the_whole_idle_window_after_a_return(
    installed: Installation,
) -> None:
    def used_meanwhile(_candidate: Path) -> None:
        mark_use(installed, 1)

    assert update(installed, run_check=used_meanwhile).outcome == "deferred_busy"
    # 5 min depois do último uso: a janela de 10 min não fechou, nada é baixado.
    result = update(installed, now=NOW + 5 * 60)
    assert result.outcome == "deferred_busy"
    assert len(installed.downloads) == 1  # só a primeira preparação baixou


def test_the_tv_is_checked_again_right_before_the_swap(installed: Installation) -> None:
    # Baixar e montar leva minutos: a TV foi usada enquanto a candidata era preparada.
    def used_meanwhile(_candidate: Path) -> None:
        mark_use(installed, 1)

    result = update(installed, run_check=used_meanwhile)
    assert result.outcome == "deferred_busy" and not result.updated
    assert read_version(installed) == OLD  # nada foi trocado
    assert installed.leftovers() == []  # a candidata não ficou pelo caminho
    assert not (installed.base / "runtime" / "update-trial.txt").exists()
    assert clock_file(installed).is_file()


def read_version(pc: Installation) -> str | None:
    return module.read_version(pc.source)


def test_only_the_limits_the_configuration_changed_reach_the_update() -> None:
    from uniover_agent.composition.maintenance import _update_limits  # noqa: PLC0415
    from uniover_agent.config import Settings  # noqa: PLC0415

    assert _update_limits(None) == {}
    assert _update_limits(Settings()) == {}
    changed = _update_limits(Settings(update_tv_idle_seconds=30, disk_warn_mb=4096))
    assert changed == {"tv_idle_seconds": 30.0, "resume_free_bytes": 4096 * 1024 * 1024}
