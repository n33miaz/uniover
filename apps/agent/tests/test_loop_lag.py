import logging

import pytest

from uniover_agent.adapters.loop_lag import LoopLagMonitor


def test_loop_lag_logs_only_when_the_threshold_was_exceeded(
    caplog: pytest.LogCaptureFixture,
) -> None:
    monitor = LoopLagMonitor()

    with caplog.at_level(logging.INFO):
        monitor.observe(0.25)
        monitor.report()
        monitor.observe(0.4)
        monitor.observe(0.3)
        monitor.report()

    messages = [record.message for record in caplog.records]
    assert len(messages) == 1
    assert "400 ms" in messages[0] and "2 amostras" in messages[0]
