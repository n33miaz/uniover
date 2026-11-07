"""Vigia do laço de eventos: um laço parado deixa a pilha de todas as threads em `crash.log`."""

import asyncio
import threading
import time
from pathlib import Path

from uniover_agent.adapters.loop_watchdog import LoopWatchdog, dump_all_threads


class Moment:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_a_stall_is_dumped_once_and_rearmed_when_the_loop_recovers(tmp_path: Path) -> None:
    moment = Moment()
    dumps: list[str] = []

    def dump(logs: Path, header: str) -> bool:
        dumps.append(header)
        return True

    watchdog = LoopWatchdog(tmp_path, stall_after=60, monotonic=moment, dump=dump)
    moment.now = 59
    watchdog.check_now()
    assert dumps == []
    moment.now = 61
    watchdog.check_now()
    moment.now = 200
    watchdog.check_now()
    assert len(dumps) == 1 and "parado há 61 s" in dumps[0]
    # O laço voltou (o carimbo andou); uma nova parada gera outro registro.
    watchdog._stamp = 200
    moment.now = 210
    watchdog.check_now()
    moment.now = 300
    watchdog.check_now()
    assert len(dumps) == 2


def test_the_dump_writes_every_thread_stack_to_crash_log(tmp_path: Path) -> None:
    release = threading.Event()
    thread = threading.Thread(target=release.wait, name="presa-de-teste", daemon=True)
    thread.start()
    try:
        assert dump_all_threads(tmp_path / "logs", "teste de parada")
    finally:
        release.set()
    text = (tmp_path / "logs" / "crash.log").read_text(encoding="utf-8")
    assert "teste de parada" in text
    assert "most recent call first" in text  # o formato do `faulthandler`: uma pilha por thread
    assert text.count("most recent call first") >= 2  # a de teste e a thread presa


async def test_a_loop_blocked_in_a_synchronous_call_is_noticed_from_another_thread(
    tmp_path: Path,
) -> None:
    seen = threading.Event()

    def dump(logs: Path, header: str) -> bool:
        seen.set()
        return True

    watchdog = LoopWatchdog(tmp_path, stall_after=0.2, check_every=0.05, beat=0.05, dump=dump)
    task = asyncio.create_task(watchdog.run())
    try:
        await asyncio.sleep(0.15)
        assert not seen.is_set(), "um laço saudável não é parada"
        time.sleep(0.6)  # noqa: ASYNC251 - o defeito: uma chamada síncrona que prende o laço
        assert seen.wait(2), "o vigia não percebeu o laço parado"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def test_a_dump_that_could_not_be_written_is_tried_again_later(tmp_path: Path) -> None:
    # Disco cheio: o registro da parada não foi gravado, então a próxima conferência tenta de novo
    # (antes, a parada era dada por registrada e nada ficava no arquivo).
    moment = Moment()
    outcomes = iter([False, False, True])
    headers: list[str] = []

    def dump(logs: Path, header: str) -> bool:
        headers.append(header)
        return next(outcomes)

    watchdog = LoopWatchdog(tmp_path, stall_after=60, monotonic=moment, dump=dump)
    moment.now = 61
    watchdog.check_now()
    moment.now = 66
    watchdog.check_now()
    assert len(headers) == 2 and watchdog.dumps == 0
    moment.now = 71
    watchdog.check_now()
    assert len(headers) == 3 and watchdog.dumps == 1
    moment.now = 76
    watchdog.check_now()
    assert len(headers) == 3, "gravado uma vez, não repete enquanto o laço segue parado"


def test_a_wall_clock_jump_after_a_suspend_gives_a_grace_instead_of_a_dump(tmp_path: Path) -> None:
    moment = Moment()
    wall = Moment()
    dumps: list[str] = []

    def dump(logs: Path, header: str) -> bool:
        dumps.append(header)
        return True

    watchdog = LoopWatchdog(
        tmp_path, stall_after=60, check_every=5, monotonic=moment, dump=dump, wall=wall
    )
    # O PC dormiu 2 h: o monotônico (que conta o tempo dormido) e o de parede saltam juntos.
    moment.now = 7200
    wall.now = 7200
    watchdog.tick()
    assert dumps == [], "a suspensão não é um laço parado"
    # Sem suspensão (a parede anda 5 s por volta), um laço que parou de verdade ainda é registrado.
    for step in range(1, 15):
        moment.now = 7200 + step * 5
        wall.now = 7200 + step * 5
        watchdog.tick()
    assert len(dumps) == 1
