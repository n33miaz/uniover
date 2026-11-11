import logging
from pathlib import Path
from typing import TextIO

import pytest

from uniover_agent.adapters.stall_dump import (
    MAX_FILE_BYTES,
    STALL_FILE,
    DumpBudget,
    StallDumper,
    format_stall_line,
    format_stall_log,
)

# ---- a limitação de taxa ----------------------------------------------------------------------


def test_budget_allows_one_dump_every_ten_minutes() -> None:
    budget = DumpBudget()
    assert budget.allows(0.0, "2026-11-11", 0)
    budget.record(100.0, "2026-11-11")

    assert not budget.allows(100.0, "2026-11-11", 0)
    assert not budget.allows(699.0, "2026-11-11", 0)
    assert budget.allows(700.0, "2026-11-11", 0)


def test_budget_stops_at_twenty_per_day_and_resumes_the_next_day() -> None:
    budget = DumpBudget(min_gap=0.0, per_day=20)
    for index in range(20):
        assert budget.allows(float(index), "2026-11-11", 0)
        budget.record(float(index), "2026-11-11")

    assert not budget.allows(100.0, "2026-11-11", 0)
    assert budget.allows(100.0, "2026-11-12", 0)
    budget.record(101.0, "2026-11-12")
    assert budget.allows(102.0, "2026-11-12", 0)


def test_budget_stops_when_the_file_reaches_the_cap() -> None:
    budget = DumpBudget()

    assert budget.allows(0.0, "d", MAX_FILE_BYTES - 1)
    assert not budget.allows(0.0, "d", MAX_FILE_BYTES)


# ---- o texto -----------------------------------------------------------------------------------


def test_the_stall_lines_carry_the_time_and_the_duration() -> None:
    assert "2026-11-11 10:00:00" in format_stall_line("2026-11-11 10:00:00", 412.6)
    assert "~413 ms" in format_stall_line("2026-11-11 10:00:00", 412.6)
    assert format_stall_log(1234.4) == f"pilha da trava gravada em {STALL_FILE} (1234 ms)"


# ---- a detecção pelo tamanho do arquivo -------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


class Harness:
    """Um cão com o `faulthandler` trocado por um que só anota o armar; o teste 'despeja'."""

    def __init__(self, logs: Path, **options: object) -> None:
        # Os testes fixam o prazo em 0,4 s: o que se prova aqui é a lógica, não o valor de produção.
        options.setdefault("stall", 0.4)
        self.clock = Clock()
        self.arms: list[float] = []
        self.disarms = 0
        self.handle: TextIO | None = None
        self.dumper = StallDumper(
            logs,
            monotonic=self.clock,
            today=lambda: "2026-11-11",
            stamp=lambda: "2026-11-11 10:00:00",
            arm=self._arm,
            disarm=self._disarm,
            **options,  # type: ignore[arg-type]
        )

    def _arm(self, timeout: float, handle: TextIO) -> None:
        self.arms.append(timeout)
        self.handle = handle

    def _disarm(self) -> None:
        self.disarms += 1

    def tick(self, advance: float = 0.1) -> None:
        self.clock.now += advance
        self.dumper.tick()

    def dump(self, text: str = "Thread 0x1 (most recent call first):\n  File x\n") -> None:
        """O que a thread de C do `faulthandler` faz: escreve direto no mesmo arquivo."""
        assert self.handle is not None
        with (Path(self.handle.name)).open("a", encoding="utf-8") as other:
            other.write(text)


def test_ticks_rearm_the_watchdog_and_make_no_noise(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    harness = Harness(tmp_path)
    with caplog.at_level(logging.INFO):
        for _ in range(10):
            harness.tick()

    assert harness.arms == [0.4] * 10
    assert harness.dumper.dumps == 0
    assert caplog.records == []
    assert (tmp_path / STALL_FILE).stat().st_size == 0


def test_a_dump_is_detected_by_the_file_size_once_it_stops_growing(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    harness = Harness(tmp_path)
    harness.tick()
    harness.tick()
    harness.dump()  # o laço parou 0,6 s e o cão gravou a pilha

    with caplog.at_level(logging.INFO):
        harness.tick(0.6)  # primeiro tick depois da parada: o arquivo ainda pode estar crescendo
        assert harness.dumper.dumps == 0
        harness.tick(0.1)  # o tamanho se manteve: confirmado

    assert harness.dumper.dumps == 1
    assert "pilha da trava gravada em stalls.log (600 ms)" in caplog.text
    text = (tmp_path / STALL_FILE).read_text(encoding="utf-8")
    assert "most recent call first" in text
    assert "parada detectada às 2026-11-11 10:00:00" in text and "~600 ms" in text
    # Um tick sem parada não conta de novo (o arquivo cresceu só pela linha do próprio cão).
    harness.tick()
    harness.tick()
    assert harness.dumper.dumps == 1


def test_a_dump_still_being_written_waits_for_the_next_tick(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    harness.tick()
    harness.dump("Thread 0x1:\n")
    harness.tick(0.5)
    harness.dump("  File y\n")  # a thread de C ainda estava gravando
    harness.tick(0.1)
    assert harness.dumper.dumps == 0

    harness.tick(0.1)

    assert harness.dumper.dumps == 1


def test_after_a_dump_it_stops_arming_until_the_gap_passes(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    harness.tick()
    harness.dump()
    harness.tick(0.5)
    harness.tick(0.1)
    assert harness.dumper.dumps == 1
    arms = len(harness.arms)

    harness.tick(300.0)
    assert len(harness.arms) == arms
    assert not harness.dumper.armed
    harness.tick(301.0)

    assert len(harness.arms) == arms + 1
    assert harness.dumper.armed


def test_a_full_file_is_never_armed_again(tmp_path: Path) -> None:
    (tmp_path / STALL_FILE).write_bytes(b"x" * (MAX_FILE_BYTES - 1))
    harness = Harness(tmp_path)
    harness.tick()
    assert harness.arms == [0.4]
    harness.dump("yy")

    harness.tick(0.5)
    harness.tick(0.1)
    harness.tick(1_000.0)

    assert harness.dumper.dumps == 1
    assert len(harness.arms) == 2  # nenhum re-arme depois que o arquivo passou de 2 MB


def test_an_oversized_old_file_is_rotated_on_the_next_run(tmp_path: Path) -> None:
    (tmp_path / STALL_FILE).write_bytes(b"x" * MAX_FILE_BYTES)

    harness = Harness(tmp_path)
    harness.tick()

    assert (tmp_path / (STALL_FILE + ".1")).stat().st_size == MAX_FILE_BYTES
    assert harness.arms == [0.4]


def test_close_disarms_and_releases_the_file(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    harness.tick()

    harness.dumper.close()

    assert harness.disarms == 1
    assert not harness.dumper.armed
    assert harness.handle is not None and harness.handle.closed


def test_an_unwritable_folder_only_disables_the_watchdog(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    blocker = tmp_path / "logs"
    blocker.write_text("não é uma pasta", encoding="utf-8")
    harness = Harness(blocker)

    with caplog.at_level(logging.WARNING):
        harness.tick()
        harness.tick()

    assert harness.arms == []
    assert caplog.text.count("não consegui abrir") == 1


async def test_run_ticks_until_cancelled_and_disarms(tmp_path: Path) -> None:
    import asyncio  # noqa: PLC0415

    harness = Harness(tmp_path)
    harness.dumper._sleep = lambda seconds: asyncio.sleep(0)
    task = asyncio.create_task(harness.dumper.run())
    for _ in range(5):
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert len(harness.arms) >= 2
    assert harness.disarms == 1


def test_the_real_faulthandler_writes_every_thread_into_the_file(tmp_path: Path) -> None:
    """Sem trocar nada: o cão do `faulthandler` dispara de verdade se o laço para."""
    import faulthandler  # noqa: PLC0415
    import time  # noqa: PLC0415

    dumper = StallDumper(tmp_path, stall=0.15)
    try:
        dumper.tick()
        time.sleep(0.5)  # o laço parado, e o GIL preso por esta thread
        assert (tmp_path / STALL_FILE).stat().st_size > 0
        assert "test_the_real_faulthandler" in (tmp_path / STALL_FILE).read_text(encoding="utf-8")
    finally:
        dumper.close()
        faulthandler.cancel_dump_traceback_later()


def test_the_setting_is_on_by_default_and_the_environment_turns_it_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from uniover_agent.config import Settings  # noqa: PLC0415

    monkeypatch.delenv("UNIOVER_STALL_DUMP")
    assert Settings().stall_dump is True
    monkeypatch.setenv("UNIOVER_STALL_DUMP", "0")
    assert Settings().stall_dump is False


def test_the_input_loop_gets_the_dumper_only_when_a_folder_is_given(tmp_path: Path) -> None:
    from uniover_agent.composition.pc import build_pc  # noqa: PLC0415
    from uniover_agent.config import Settings  # noqa: PLC0415
    from uniover_agent.core import EnvelopeFactory, EnvelopeGate  # noqa: PLC0415

    class Clock:
        def now(self) -> float:
            return 0.0

        def monotonic(self) -> float:
            return 0.0

        async def sleep(self, seconds: float) -> None:
            return None

    async def scenario(logs: Path | None) -> int:
        gate = EnvelopeGate("a")
        pc = build_pc(
            Settings(pc_control=True, pc_direct=False),
            None,  # type: ignore[arg-type]
            EnvelopeFactory("a", gate, Clock()),  # type: ignore[arg-type]
            platform="win32",
            isolate_input=True,
            gate=gate,
            agent_id="a",
            stall_logs=logs,
        )
        assert pc is not None and pc.host is not None
        return len(pc.host._background)

    import asyncio  # noqa: PLC0415

    assert asyncio.run(scenario(None)) == 1
    assert asyncio.run(scenario(tmp_path)) == 2
