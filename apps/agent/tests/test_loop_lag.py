import gc
import logging
import sys

import pytest

from uniover_agent.adapters.loop_lag import GcPauseTracker, LoopLagMonitor
from uniover_agent.adapters.process_memory import MemoryCounters, read_memory_counters


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


# ---- memória do processo e pausas do GC junto da linha de atraso -------------------------------


def test_the_lag_line_carries_page_faults_working_set_and_gc(
    caplog: pytest.LogCaptureFixture,
) -> None:
    samples = iter(
        [MemoryCounters(1_000, 80 * 1024 * 1024), MemoryCounters(1_750, 85 * 1024 * 1024)]
    )
    clock = iter([10.0, 10.0, 10.0, 10.0, 10.0, 10.125, 20.0, 20.0, 20.0])
    tracker = GcPauseTracker(clock=lambda: next(clock))
    monitor = LoopLagMonitor(memory=lambda: next(samples), gc_pauses=tracker)
    monitor.report()  # o primeiro minuto: só fixa a base das falhas de página

    tracker.callback("start", {"generation": 2})  # 10.0
    tracker.callback("stop", {"generation": 2})  # 10.0 -> 0 ms
    tracker.callback("start", {"generation": 0})
    tracker.callback("stop", {"generation": 0})
    tracker.callback("start", {"generation": 2})  # 10.0
    tracker.callback("stop", {"generation": 2})  # 10.125 -> 125 ms
    with caplog.at_level(logging.INFO):
        monitor.observe(0.4)
        monitor.report()

    message = caplog.records[0].message
    assert "400 ms" in message and "1 amostras" in message
    assert "falhas de página +750" in message
    assert "conjunto de trabalho 85 MB" in message
    assert "gen2 máx 125.0 ms" in message
    assert "coletas g0/g1/g2 1/0/2" in message


def test_without_a_lag_the_extras_are_read_but_not_logged(caplog: pytest.LogCaptureFixture) -> None:
    reads: list[int] = []

    def memory() -> MemoryCounters:
        reads.append(1)
        return MemoryCounters(5, 1024)

    monitor = LoopLagMonitor(memory=memory)
    with caplog.at_level(logging.INFO):
        monitor.report()
        monitor.report()

    assert caplog.records == []
    assert len(reads) == 2  # a janela do minuto anda mesmo sem atraso


def test_without_a_memory_reading_the_page_faults_are_omitted(
    caplog: pytest.LogCaptureFixture,
) -> None:
    monitor = LoopLagMonitor(memory=lambda: None)

    with caplog.at_level(logging.INFO):
        monitor.observe(0.5)
        monitor.report()

    message = caplog.records[0].message
    assert "falhas de página" not in message and "conjunto de trabalho" not in message
    assert "gc: gen2 máx 0.0 ms" in message


def test_the_gc_tracker_measures_a_real_generation_two_collection() -> None:
    tracker = GcPauseTracker()
    tracker.install()
    try:
        gc.collect()
    finally:
        tracker.uninstall()

    longest, counts = tracker.take()

    assert longest > 0.0 and counts[2] >= 1
    assert tracker.callback not in gc.callbacks
    assert tracker.take() == (0.0, (0, 0, 0))  # a janela zera a cada leitura


def test_the_gc_callback_is_installed_only_while_the_monitor_runs() -> None:
    import asyncio  # noqa: PLC0415

    async def scenario() -> None:
        tracker = GcPauseTracker()
        stop = asyncio.Event()

        async def sleep(_: float) -> None:
            assert tracker.callback in gc.callbacks
            stop.set()
            raise asyncio.CancelledError

        monitor = LoopLagMonitor(sleep=sleep, memory=lambda: None, gc_pauses=tracker)
        with pytest.raises(asyncio.CancelledError):
            await monitor.run()
        assert stop.is_set() and tracker.callback not in gc.callbacks

    asyncio.run(scenario())


def test_the_real_windows_reading_is_sane() -> None:
    sample = read_memory_counters()

    if sys.platform != "win32":
        assert sample is None
    else:
        assert sample is not None and sample.page_faults > 0
        assert sample.working_set_bytes > 1024 * 1024
