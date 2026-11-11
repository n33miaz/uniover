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


def test_each_loop_reports_under_its_own_name(caplog: pytest.LogCaptureFixture) -> None:
    main = LoopLagMonitor()
    entry = LoopLagMonitor(name="entrada")

    with caplog.at_level(logging.INFO):
        main.observe(0.5)
        entry.observe(0.9)
        main.report()
        entry.report()

    messages = [record.message for record in caplog.records]
    assert "laço principal" in messages[0] and "500 ms" in messages[0]
    assert "laço entrada" in messages[1] and "900 ms" in messages[1]
