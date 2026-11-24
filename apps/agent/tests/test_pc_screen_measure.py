"""Limites de custo da tela ao vivo e leituras do desktop, sem abrir a tela de verdade."""

import pytest

from uniover_agent.adapters.pc_screen_measure import Clocks, Measurement, measure
from uniover_agent.adapters.pc_screen_probes import (
    STATE_ELEVATED,
    STATE_LOCKED,
    STATE_OK,
    classify_state,
)
from uniover_agent.adapters.pc_windows import INTEGRITY_HIGH, INTEGRITY_MEDIUM


def test_measure_computes_fps_cpu_and_peak_memory() -> None:
    now = 0.0
    cpu = 0.0

    def clock() -> float:
        return now

    def cpu_clock() -> float:
        return cpu

    def capture() -> None:
        nonlocal now, cpu
        now += 0.125
        cpu += 0.0125

    def pause(delay: float) -> None:
        nonlocal now
        now += delay

    memory = iter([10_000_000, 50_000_000, 30_000_000] * 10)
    result = measure(capture, lambda: next(memory), 2.0, Clocks(clock, cpu_clock, pause))
    assert result.fps == pytest.approx(8)
    assert result.cpu_percent == pytest.approx(10)
    assert result.private_mb == 50
    assert result.failures() == []


def test_measure_never_exceeds_the_target_rate() -> None:
    now = 0.0

    def pause(delay: float) -> None:
        nonlocal now
        now += delay

    result = measure(lambda: None, lambda: 0, 2.0, Clocks(lambda: now, lambda: 0.0, pause))
    assert result.fps == pytest.approx(8)


def test_limits_from_the_design_are_enforced() -> None:
    assert Measurement(4.9, 10, 40).failures() == ["quadros por segundo 4.9 < 5.0"]
    assert len(Measurement(6, 25.1, 80.1).failures()) == 2
    assert Measurement(5, 25, 80).failures() == []


@pytest.mark.parametrize(
    ("desktop", "foreground", "expected"),
    [
        ("Default", INTEGRITY_MEDIUM, STATE_OK),
        ("default", None, STATE_OK),
        ("Winlogon", INTEGRITY_MEDIUM, STATE_LOCKED),
        (None, None, STATE_LOCKED),
        ("Default", INTEGRITY_HIGH, STATE_ELEVATED),
    ],
)
def test_classify_state(desktop: str | None, foreground: int | None, expected: str) -> None:
    assert classify_state(desktop, foreground, INTEGRITY_MEDIUM) == expected
