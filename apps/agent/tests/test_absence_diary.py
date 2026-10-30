import logging
from pathlib import Path

import pytest

from uniover_agent.adapters.absence_diary import (
    LONG_ABSENCE_SECONDS,
    AbsenceDiary,
    likely_reason,
)
from uniover_agent.adapters.fakes import FakeClock


def test_reason_after_a_reboot_without_logon() -> None:
    reason = likely_reason(3600, 600, process_restarted=True)
    assert "ligado ou reiniciado há 10 min" in reason


def test_reason_when_the_agent_was_stopped_with_the_pc_on() -> None:
    assert "com o PC ligado" in likely_reason(1200, 86400, process_restarted=True)


def test_reason_for_a_long_network_outage() -> None:
    assert "rede ou servidor" in likely_reason(900, 86400, process_restarted=False)


def test_the_diary_explains_a_long_gap_since_the_last_beat(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    clock = FakeClock()
    path = tmp_path / "runtime" / "last-alive"
    path.parent.mkdir()
    path.write_text(f"{clock.now().timestamp() - 7200:.0f}", encoding="ascii")
    diary = AbsenceDiary(path, clock, uptime=lambda: 300.0)
    with caplog.at_level(logging.WARNING):
        diary.start()
    assert len(diary.reasons) == 1
    assert "reiniciado há 5 min" in diary.reasons[0]
    assert "ausência longa" in caplog.text
    # A marca nova substitui a antiga.
    assert abs(float(path.read_text(encoding="ascii")) - clock.now().timestamp()) < 5


def test_the_diary_stays_quiet_for_short_gaps_and_first_runs(tmp_path: Path) -> None:
    clock = FakeClock()
    path = tmp_path / "last-alive"
    first = AbsenceDiary(path, clock, uptime=lambda: None)
    first.start()
    second = AbsenceDiary(path, clock, uptime=lambda: None)
    second.start()
    assert first.reasons == [] and second.reasons == []


def test_the_diary_reports_a_reconnect_after_a_long_outage(tmp_path: Path) -> None:
    clock = FakeClock()
    diary = AbsenceDiary(tmp_path / "last-alive", clock, uptime=lambda: 86400.0)
    diary.disconnected()
    clock.advance(LONG_ABSENCE_SECONDS - 1)
    diary.connected()
    assert diary.reasons == []
    diary.disconnected()
    clock.advance(LONG_ABSENCE_SECONDS + 1)
    diary.connected()
    assert len(diary.reasons) == 1
    assert "rede ou servidor" in diary.reasons[0]
