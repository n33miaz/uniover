"""Alarme de disco: um diagnóstico por episódio e outro na volta ao normal."""

import asyncio

import pytest

from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.core.diagnostics import DiagnosticsRecorder
from uniover_agent.core.disk_alarm import DiskAlarm
from uniover_agent.ports.diagnostics import DiagnosticEvent

MIB = 1024 * 1024
WARN = 2048 * MIB
CRITICAL = 600 * MIB


class Store:
    def __init__(self) -> None:
        self.events: list[DiagnosticEvent] = []

    def append(self, event: DiagnosticEvent) -> None:
        self.events.append(event)


class Rig:
    def __init__(self) -> None:
        self.free: int | None = 50_000 * MIB
        self.store = Store()
        clock = FakeClock()
        recorder = DiagnosticsRecorder(self.store, clock)  # type: ignore[arg-type]
        self.alarm = DiskAlarm(
            lambda: self.free, recorder, clock, warn_bytes=WARN, critical_bytes=CRITICAL
        )

    def look(self, free_mb: int | None) -> list[tuple[str, str]]:
        """Confere com `free_mb` livres e devolve (tipo, severidade) do que foi registrado agora."""
        self.free = None if free_mb is None else free_mb * MIB
        before = len(self.store.events)
        self.alarm.check()
        return [(e.kind, e.severity) for e in self.store.events[before:]]


def test_plenty_of_space_records_nothing() -> None:
    rig = Rig()
    assert rig.look(50_000) == [] and rig.look(10_000) == []


def test_one_warning_per_episode_not_one_per_check() -> None:
    rig = Rig()
    assert rig.look(1900) == [("disk.low", "warn")]
    assert rig.look(1800) == [] and rig.look(1700) == [] and rig.look(1000) == []


def test_crossing_the_update_minimum_records_one_error() -> None:
    rig = Rig()
    assert rig.look(1900) == [("disk.low", "warn")]
    assert rig.look(500) == [("disk.low", "error")]
    assert rig.look(300) == [] and rig.look(200) == []


def test_a_disk_that_is_already_critical_goes_straight_to_the_error() -> None:
    rig = Rig()
    assert rig.look(100) == [("disk.low", "error")]


def test_recovery_is_recorded_once_and_a_new_episode_warns_again() -> None:
    rig = Rig()
    rig.look(500)
    assert rig.look(5000) == [("disk.recovered", "info")]
    assert rig.look(6000) == []
    assert rig.look(300) == [("disk.low", "error")]


def test_going_back_above_the_update_minimum_is_noted_while_still_under_the_warning() -> None:
    rig = Rig()
    rig.look(500)
    assert rig.look(1500) == [("disk.low", "info")]
    assert rig.alarm.level == "warn"


def test_a_disk_hovering_on_the_line_does_not_flap() -> None:
    rig = Rig()
    assert rig.look(2000) == [("disk.low", "warn")]
    # Dentro da folga acima do aviso (2048 + 128 MB) ainda é o mesmo episódio.
    assert rig.look(2100) == [] and rig.look(2000) == [] and rig.look(2150) == []
    assert rig.look(2300) == [("disk.recovered", "info")]
    critical = rig.look(590)
    assert critical == [("disk.low", "error")]
    assert rig.look(650) == [] and rig.look(590) == [] and rig.look(690) == []


def test_a_disk_that_cannot_be_read_changes_nothing() -> None:
    rig = Rig()
    rig.look(500)
    assert rig.look(None) == []
    assert rig.alarm.level == "critical"


def test_the_warning_never_sits_below_the_critical_limit() -> None:
    rig = Rig()
    rig.alarm = DiskAlarm(
        lambda: rig.free,
        DiagnosticsRecorder(rig.store, FakeClock()),  # type: ignore[arg-type]
        FakeClock(),
        warn_bytes=100 * MIB,
        critical_bytes=600 * MIB,
    )
    assert rig.look(500) == [("disk.low", "error")]


def test_the_details_carry_the_numbers_and_no_path() -> None:
    rig = Rig()
    rig.look(500)
    rig.look(5000)
    details = [e.detail for e in rig.store.events]
    assert "500 MB" in details[0] and "600 MB" in details[0]
    assert all(":\\" not in d for d in details)
    assert all(e.component == "disk" for e in rig.store.events)


async def test_the_loop_survives_a_failing_check_and_keeps_watching() -> None:
    rig = Rig()
    calls = {"n": 0}

    def flaky() -> int | None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("falha qualquer")
        return 100 * MIB

    clock = FakeClock()
    alarm = DiskAlarm(
        flaky,
        DiagnosticsRecorder(rig.store, clock),  # type: ignore[arg-type]
        clock,
        warn_bytes=WARN,
        critical_bytes=CRITICAL,
        interval=1,
        first_run=1,
    )
    task = asyncio.create_task(alarm.run())
    for _ in range(100):
        await asyncio.sleep(0.01)
        if rig.store.events:
            break
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [(e.kind, e.severity) for e in rig.store.events] == [("disk.low", "error")]
