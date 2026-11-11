"""A entrada do PC no laço próprio: não espera o laço principal, e tudo o que cruza é seguro."""

import asyncio
import logging
import threading
import time
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime
from functools import partial
from typing import Any

import pytest

from uniover_agent.adapters import pc_input_thread, windows_scheduling
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.pc_input_thread import MainLoopCaller, MainLoopSender, PcInputThread
from uniover_agent.composition.pc import PcSetup, build_pc
from uniover_agent.config import Settings
from uniover_agent.core import (
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ProcessMessage,
)

from .support import AGENT_ID, FakeAudio, dump, envelope
from .test_pc_composition import FakeLauncher, FakePower

LANE_THREAD = "uniover-pc-input"
# As funções de verdade, guardadas antes de o `conftest` trocá-las por dublês.
REAL_PROTECT = windows_scheduling.protect_working_set
REAL_PRIORITY = windows_scheduling.raise_thread_priority


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RecordingInput:
    """O PC de mentira: anota em que thread e quando cada chamada chegou."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.threads: set[str] = set()
        self.at: list[float] = []
        self.applied = threading.Event()

    def _note(self, *call: object) -> None:
        self.calls.append(call)
        self.threads.add(threading.current_thread().name)
        self.at.append(time.monotonic())
        self.applied.set()

    def move(self, dx: int, dy: int) -> None:
        self._note("move", dx, dy)

    def scroll(self, horizontal: int, vertical: int) -> None:
        self._note("scroll", horizontal, vertical)

    def zoom(self, steps: int) -> None:
        self._note("zoom", steps)

    def click(self, button: str, action: str, modifiers: Sequence[str] = ()) -> None:
        self._note("click", button, action)

    def key(
        self, key: str, modifiers: Sequence[str], *, repeat: int = 1, action: str = "PRESS"
    ) -> None:
        self._note("key", key)

    def type_text(self, text: str) -> None:
        self._note("text")

    def edit_text(self, erase: int, text: str, key: str | None = None) -> None:
        self._note("edit")

    def media(self, action: str, steps: int) -> None:
        self._note("media", action)

    def release_all(self) -> None:
        self._note("release_all")


class ThreadedTransport(FakeTransport):
    """Anota em que thread cada envio rodou: o transporte vive no laço principal."""

    def __init__(self) -> None:
        super().__init__()
        self.send_threads: list[str] = []

    async def send(self, message: dict[str, Any]) -> None:
        self.send_threads.append(threading.current_thread().name)
        await super().send(message)


class Rig:
    """O agente montado como em produção: laço principal (o do teste) e laço da entrada."""

    def __init__(self, *, isolate: bool = True, settings: Settings | None = None) -> None:
        self.input = RecordingInput()
        self.transport = ThreadedTransport()
        self.gate = EnvelopeGate(AGENT_ID)
        self.envelopes = EnvelopeFactory(AGENT_ID, self.gate, FakeClock())
        self.priority_calls: list[str] = []
        self.memory_calls: list[int] = []
        self.skews: list[tuple[str, float]] = []
        pc = build_pc(
            settings or Settings(pc_control=True, pc_direct=False),
            self.transport,
            self.envelopes,
            platform="win32",
            pc_input=self.input,
            power=FakePower(),
            launcher=FakeLauncher(),
            audio=FakeAudio(),
            gate=self.gate,
            agent_id=AGENT_ID,
            isolate_input=isolate,
            prioritize=self._prioritize,
            protect_memory=self._protect,
            on_clock_skew=self._skewed,
        )
        assert pc is not None
        self.pc: PcSetup = pc
        self.process = ProcessMessage(
            AGENT_ID,
            self.gate,
            HandleCommand({}, FakeClock()),
            self.envelopes,
            self.transport,
            observe_timestamp=pc.clock.observe,
            pc_lane=pc.lane,
            pc_host=pc.host,
        )

    def _prioritize(self) -> bool:
        self.priority_calls.append(threading.current_thread().name)
        return True

    def _protect(self, minimum_mb: int) -> bool:
        self.memory_calls.append(minimum_mb)
        return True

    def _skewed(self, difference: float) -> None:
        self.skews.append((threading.current_thread().name, difference))

    async def aclose(self) -> None:
        await self.process.aclose()
        await self.pc.stop_input()


@pytest.fixture
async def rig() -> AsyncIterator[Rig]:
    instance = Rig()
    instance.pc.start()
    yield instance
    await instance.aclose()


def pointer(dx: int) -> str:
    return dump(envelope("pc.pointer.v1", {"dx": dx, "dy": 0}, ts=now()))


def click(action: str = "CLICK") -> str:
    return dump(envelope("pc.click.v1", {"button": "LEFT", "action": action}, ts=now()))


async def wait_for(predicate: Any, seconds: float = 3.0) -> None:
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, "a condição não ficou verdadeira a tempo"
        await asyncio.sleep(0.005)


# ---- a causa medida: o laço principal parado não para o mouse ---------------------------------


async def test_the_pointer_is_applied_while_the_main_loop_is_blocked(rig: Rig) -> None:
    await rig.process(pointer(7))
    # O laço principal parado (como uma falha de página): `sleep` libera o GIL, como a E/S.
    time.sleep(0.4)  # noqa: ASYNC251
    finished = time.monotonic()

    assert rig.input.calls == [("move", 7, 0)]
    assert rig.input.at[0] < finished - 0.15  # aplicado antes de o laço principal voltar
    assert rig.input.threads == {LANE_THREAD}


async def test_the_same_blockage_stops_the_pointer_when_the_input_shares_the_main_loop() -> None:
    inline = Rig(isolate=False)
    try:
        await inline.process(pointer(7))
        time.sleep(0.2)  # noqa: ASYNC251

        assert inline.input.calls == []  # contraprova: no mesmo laço ele só anda depois da parada
        await wait_for(lambda: bool(inline.input.calls))
    finally:
        await inline.aclose()


async def test_clicks_arrive_in_order_and_their_results_go_back_through_the_main_loop(
    rig: Rig,
) -> None:
    await rig.process(click("DOWN"))
    await rig.process(pointer(3))
    await rig.process(click("UP"))
    time.sleep(0.2)  # noqa: ASYNC251

    assert rig.input.calls == [("click", "LEFT", "DOWN"), ("move", 3, 0), ("click", "LEFT", "UP")]
    await wait_for(lambda: len(rig.transport.sent) == 2)
    assert {m["type"] for m in rig.transport.sent} == {"command.result.v1"}
    # O WebSocket vive no laço principal: os resultados saem de lá, nunca da thread da entrada.
    assert set(rig.transport.send_threads) == {threading.current_thread().name}


async def test_a_flood_of_moves_keeps_its_order_across_the_two_loops(rig: Rig) -> None:
    for step in range(1, 201):
        await rig.process(pointer(step))
    # Somados e espalhados em passos, mas o caminho é o mesmo: o total que o app mandou.
    await wait_for(lambda: sum(call[1] for call in rig.input.calls) == sum(range(1, 201)))

    assert {call[0] for call in rig.input.calls} == {"move"}
    assert {call[2] for call in rig.input.calls} == {0}


async def test_connection_lost_releases_what_was_held_on_the_input_loop(rig: Rig) -> None:
    await rig.process(click("DOWN"))
    await wait_for(lambda: ("click", "LEFT", "DOWN") in rig.input.calls)

    rig.process.connection_lost()

    await wait_for(lambda: ("release_all",) in rig.input.calls)
    assert rig.input.threads == {LANE_THREAD}


async def test_the_clock_warnings_come_back_to_the_main_loop(rig: Rig) -> None:
    # `on_skew` roda onde a diferença de relógio é medida (a thread da entrada pode medi-la), mas
    # o aviso (diagnóstico, disco) é levado ao laço principal.
    assert rig.pc.host is not None
    for _ in range(2):  # dois batimentos que concordam firmam a estimativa (e o aviso)
        rig.pc.host.post(lambda: rig.pc.clock.observe("2020-01-01T00:00:00.000Z"))
    await wait_for(lambda: bool(rig.skews))

    assert {thread for thread, _ in rig.skews} == {threading.current_thread().name}


# ---- partida, memória e encerramento ----------------------------------------------------------


async def test_start_raises_the_thread_priority_and_asks_for_the_working_set_once() -> None:
    rig = Rig(settings=Settings(pc_control=True, pc_direct=False, pc_working_set_min_mb=48))
    try:
        rig.pc.start()

        assert rig.priority_calls == [LANE_THREAD]  # a prioridade é da thread da entrada
        assert rig.memory_calls == [48]
        assert rig.pc.host is not None and rig.pc.host.prioritized
    finally:
        await rig.aclose()


async def test_a_zero_working_set_turns_the_request_off() -> None:
    rig = Rig(settings=Settings(pc_control=True, pc_direct=False, pc_working_set_min_mb=0))
    try:
        rig.pc.start()

        assert rig.memory_calls == []
    finally:
        await rig.aclose()


async def test_a_refused_priority_or_working_set_does_not_stop_the_agent(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = Rig()
    caplog.set_level(logging.INFO)
    try:
        rig.pc.protect_memory = lambda mb: False
        assert rig.pc.host is not None
        rig.pc.host._prioritize = lambda: False
        rig.pc.start()
        await rig.process(pointer(1))
        await wait_for(lambda: bool(rig.input.calls))  # o controle funciona do mesmo jeito

        assert "seguindo sem a proteção do conjunto de trabalho" in caplog.text
        assert "prioridade normal" in caplog.text
    finally:
        await rig.aclose()


async def test_without_the_isolation_nothing_starts_a_thread() -> None:
    rig = Rig(isolate=False)
    try:
        before = {t.name for t in threading.enumerate()}
        rig.pc.start()

        assert rig.pc.host is None
        assert {t.name for t in threading.enumerate()} == before
        assert rig.memory_calls == [] and rig.priority_calls == []
    finally:
        await rig.aclose()


async def test_stopping_closes_the_lane_and_joins_the_thread() -> None:
    rig = Rig()
    rig.pc.start()
    await rig.process(click("DOWN"))
    await wait_for(lambda: ("click", "LEFT", "DOWN") in rig.input.calls)

    await rig.aclose()

    assert ("release_all",) in rig.input.calls  # o que ficou apertado é solto ao encerrar
    assert rig.pc.host is not None and not rig.pc.host.alive
    assert LANE_THREAD not in {t.name for t in threading.enumerate()}


# ---- a thread em si ----------------------------------------------------------------------------


async def test_posted_callbacks_run_in_order_on_the_thread_and_never_block_the_caller() -> None:
    host = PcInputThread(name="teste-entrada")
    host.start()
    seen: list[tuple[int, str]] = []
    gate = threading.Event()
    try:

        def hold() -> None:
            gate.wait(1)

        def note(n: int) -> None:
            seen.append((n, threading.current_thread().name))

        host.post(hold)  # a primeira trava o laço da entrada
        began = time.monotonic()
        for n in range(50):
            host.post(partial(note, n))
        assert time.monotonic() - began < 0.1  # postar nunca espera a thread

        gate.set()
        await asyncio.sleep(0.1)
        assert [n for n, _ in seen] == list(range(50))
        assert {name for _, name in seen} == {"teste-entrada"}
    finally:
        await asyncio.to_thread(host.stop)


async def test_call_runs_a_coroutine_on_the_thread_and_returns_or_raises() -> None:
    host = PcInputThread(name="teste-entrada")
    host.start()
    try:

        async def where() -> str:
            await asyncio.sleep(0)
            return threading.current_thread().name

        async def boom() -> None:
            raise ValueError("falhou na entrada")

        assert await host.call(where) == "teste-entrada"
        with pytest.raises(ValueError, match="falhou na entrada"):
            await host.call(boom)
    finally:
        await asyncio.to_thread(host.stop)


async def test_call_with_a_deadline_gives_up_without_stopping_the_thread() -> None:
    host = PcInputThread(name="teste-entrada")
    host.start()
    try:

        async def slow() -> None:
            await asyncio.sleep(5)

        with pytest.raises(TimeoutError):
            await host.call(slow, wait_seconds=0.05)

        async def quick() -> int:
            return 1

        assert await host.call(quick) == 1  # a thread segue de pé
    finally:
        await asyncio.to_thread(host.stop)


async def test_a_failing_callback_does_not_kill_the_loop(caplog: pytest.LogCaptureFixture) -> None:
    host = PcInputThread(name="teste-entrada")
    host.start()
    done = threading.Event()
    try:

        def boom() -> None:
            raise RuntimeError("erro no callback")

        host.post(boom)
        host.post(done.set)

        assert await asyncio.to_thread(done.wait, 2)
        assert host.alive
    finally:
        await asyncio.to_thread(host.stop)


async def test_a_background_job_that_fails_is_restarted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pc_input_thread, "RESTART_DELAY_SECONDS", 0.01)
    runs: list[int] = []
    finished = threading.Event()

    async def flaky() -> None:
        runs.append(1)
        if len(runs) < 3:
            raise RuntimeError("falha")
        finished.set()

    host = PcInputThread(name="teste-entrada", background=[flaky])
    host.start()
    try:
        assert await asyncio.to_thread(finished.wait, 3)
        assert len(runs) == 3
    finally:
        await asyncio.to_thread(host.stop)


async def test_posting_after_stop_is_dropped_quietly() -> None:
    host = PcInputThread(name="teste-entrada")
    host.start()
    await asyncio.to_thread(host.stop)

    host.post(lambda: pytest.fail("não deveria rodar"))  # sem erro
    with pytest.raises(RuntimeError):
        await host.call(lambda: asyncio.sleep(0))


async def test_the_loop_monitor_runs_in_its_own_loop_under_its_own_name(
    caplog: pytest.LogCaptureFixture,
) -> None:
    from uniover_agent.adapters.loop_lag import LoopLagMonitor  # noqa: PLC0415

    caplog.set_level(logging.INFO)
    monitor = LoopLagMonitor(name="entrada", interval=0.01, threshold=0.05, report_every=0.2)
    host = PcInputThread(name="teste-entrada", background=[monitor.run])
    host.start()
    try:
        host.post(lambda: time.sleep(0.3))  # o laço da entrada parado
        await asyncio.sleep(0.8)

        assert "laço entrada" in caplog.text
    finally:
        await asyncio.to_thread(host.stop)


# ---- as pontes entre os laços ------------------------------------------------------------------


async def test_the_main_loop_sender_delivers_on_the_main_loop_and_reports_errors() -> None:
    transport = ThreadedTransport()
    sender = MainLoopSender(asyncio.get_running_loop(), transport)

    await asyncio.to_thread(lambda: asyncio.run(sender.send({"a": 1})))

    assert transport.sent == [{"a": 1}]
    assert transport.send_threads == [threading.current_thread().name]


async def test_the_main_loop_caller_ignores_a_closed_loop() -> None:
    loop = asyncio.new_event_loop()
    caller = MainLoopCaller(loop)
    loop.close()

    caller(lambda: None)  # não levanta


def test_the_scheduling_helpers_refuse_quietly_outside_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("uniover_agent.adapters.windows_scheduling.sys.platform", "linux")

    assert REAL_PROTECT(64) is False
    assert REAL_PRIORITY() is False
