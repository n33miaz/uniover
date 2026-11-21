"""A faixa da TV num laço próprio: uma parada do laço principal não atrasa as teclas."""

import asyncio
import threading
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import pytest

from uniover_agent.adapters.fakes import FakeTransport, FakeTvRemote
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.composition.tv_lane import (
    TV_LANE_THREAD_NAME,
    MainLoopTransport,
    TvLaneHop,
    build_tv_lane,
)
from uniover_agent.core import (
    Command,
    CommandResult,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ProcessMessage,
    ResultStatus,
    TvSessionManager,
    tv_key_handler,
)
from uniover_agent.core.handle_command import FreshKeyHandler, Handler
from uniover_agent.core.loop_progress import LeastElapsed, LoopProgress

from .support import AGENT_ID, dump, envelope

# A parada do laço principal e o atraso aceito para a tecla do canal direto durante ela.
BLOCK_SECONDS = 1.0
ON_TIME_SECONDS = 0.3


class TimedRemote(FakeTvRemote):
    """Anota em que thread e quando cada tecla chegou ao "driver"."""

    def __init__(self) -> None:
        super().__init__()
        self.arrivals: list[tuple[str, str, float]] = []

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        await super().send_key(key, direction)
        self.arrivals.append((key, threading.current_thread().name, time.monotonic()))


@dataclass
class Lab:
    hop: TvLaneHop
    process: ProcessMessage
    remote: TimedRemote
    session: TvSessionManager
    transport: FakeTransport
    direct_results: list[CommandResult] = field(default_factory=list)

    def submit_direct(self, key: str, command_id: str) -> float:
        """Uma tecla do canal direto, de outra thread (como a da entrada do PC)."""
        sent = time.monotonic()
        self.process.submit_direct_tv(
            Command(command_id, "tv.key.v2", {"key": key}), sent, self.direct_results.append
        )
        return sent


async def wait_for(condition: object, seconds: float = 3.0) -> None:
    deadline = time.monotonic() + seconds
    while not condition():  # type: ignore[operator]
        if time.monotonic() > deadline:
            raise AssertionError("a condição não chegou a tempo")
        await asyncio.sleep(0.01)


@pytest.fixture
async def lab() -> AsyncIterator[Lab]:
    loop = asyncio.get_running_loop()
    clock = SystemClock()
    remote = TimedRemote()
    session = TvSessionManager(clock, remote)
    tv_progress = LoopProgress()
    main_progress = LoopProgress()
    keys = tv_key_handler(session, loop_elapsed=LeastElapsed(tv_progress, main_progress))
    raw: dict[str, Handler] = {"tv.key.v1": keys, "tv.key.v2": keys, "tv.key.v3": keys}
    hop = build_tv_lane(loop, enabled=True)
    hop.start()
    hop.start_jobs([tv_progress.run])
    main_job = asyncio.create_task(main_progress.run())
    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({name: hop.handler(handler) for name, handler in raw.items()}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        tv_host=hop.host,
        tv_sender=MainLoopTransport(loop, transport),
        tv_handle_command=HandleCommand(raw, clock),
    )
    try:
        yield Lab(hop, process, remote, session, transport)
    finally:
        main_job.cancel()
        await asyncio.gather(main_job, return_exceptions=True)
        # A mesma ordem do encerramento do agente.
        await process.aclose()
        await hop.stop_jobs()
        await hop.call(session.aclose)
        await hop.stop()


def lane_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == TV_LANE_THREAD_NAME and t.is_alive()]


async def test_direct_keys_reach_the_tv_on_time_and_in_order_while_the_main_loop_is_blocked(
    lab: Lab,
) -> None:
    await lab.process(dump(envelope("tv.key.v2", {"key": "UP"})))
    await wait_for(lambda: lab.remote.keys == ["UP"])

    blocked = threading.Event()
    submitted: list[float] = []

    def phone() -> None:
        # O canal direto, noutra thread: duas teclas enquanto o laço principal está parado.
        blocked.wait(2)
        time.sleep(0.1)
        submitted.append(lab.submit_direct("DOWN", "d1"))
        time.sleep(0.1)
        submitted.append(lab.submit_direct("LEFT", "d2"))

    sender = threading.Thread(target=phone)
    sender.start()
    blocked.set()
    # O laço principal preso numa chamada síncrona: é a parada que o teste mede.
    time.sleep(BLOCK_SECONDS)  # noqa: ASYNC251
    unblocked = time.monotonic()
    sender.join(2)
    await lab.process(dump(envelope("tv.key.v2", {"key": "RIGHT"})))
    await wait_for(lambda: len(lab.remote.keys) == 4)

    assert lab.remote.keys == ["UP", "DOWN", "LEFT", "RIGHT"]
    by_key = {key: (thread, at) for key, thread, at in lab.remote.arrivals}
    for key, sent in zip(("DOWN", "LEFT"), submitted, strict=True):
        thread, at = by_key[key]
        assert thread == TV_LANE_THREAD_NAME
        assert at - sent < ON_TIME_SECONDS
        assert at < unblocked  # chegou à TV com o laço principal ainda parado
    assert [(r.status, r.command_id) for r in lab.direct_results] == [
        (ResultStatus.OK, "d1"),
        (ResultStatus.OK, "d2"),
    ]
    # As respostas da nuvem saem pelo transporte do laço principal.
    await wait_for(lambda: len(lab.transport.sent) == 2)


async def test_a_direct_key_waits_behind_an_earlier_cloud_key_even_with_the_main_loop_blocked(
    lab: Lab,
) -> None:
    release = threading.Event()
    original = lab.remote.connect

    async def slow_connect() -> None:
        # A abertura da sessão demora (na faixa): a tecla da nuvem segura a fila.
        await asyncio.to_thread(release.wait, 2)
        await original()

    lab.remote.connect = slow_connect  # type: ignore[method-assign]
    await lab.process(dump(envelope("tv.key.v2", {"key": "OK"})))

    def phone() -> None:
        time.sleep(0.05)
        lab.submit_direct("BACK", "d1")
        time.sleep(0.05)
        release.set()

    sender = threading.Thread(target=phone)
    sender.start()
    # O laço principal parado enquanto tudo acontece na faixa.
    time.sleep(0.4)  # noqa: ASYNC251
    sender.join(2)
    await wait_for(lambda: len(lab.remote.keys) == 2)

    assert lab.remote.keys == ["OK", "BACK"]


async def test_stopping_the_lane_leaves_no_thread_behind() -> None:
    hop = build_tv_lane(asyncio.get_running_loop(), enabled=True)
    hop.start()
    ticks: list[int] = []

    async def job() -> None:
        while True:
            ticks.append(1)
            await asyncio.sleep(0.01)

    hop.start_jobs([job])
    await wait_for(lambda: bool(ticks))
    assert lane_threads()

    await hop.stop_jobs()
    await hop.stop()

    assert lane_threads() == []
    assert hop.host is not None and not hop.host.alive


async def test_the_hop_runs_tv_handlers_on_the_lane_and_callbacks_on_the_main_loop() -> None:
    hop = build_tv_lane(asyncio.get_running_loop(), enabled=True)
    hop.start()
    seen: list[str] = []
    try:

        async def handle(command: Command) -> CommandResult:
            seen.append(threading.current_thread().name)
            return CommandResult(command.id, ResultStatus.OK)

        key = hop.handler(FreshKeyHandler(handle))
        assert isinstance(key, FreshKeyHandler)
        result = await key(Command("c1", "tv.key.v2", {"key": "UP"}))
        assert result.status is ResultStatus.OK

        # Sem resposta (a presença): volta na hora e roda na faixa depois.
        silent = hop.handler(handle, silent=True)
        await silent(Command("c2", "tv.presence.v1", {}))
        await wait_for(lambda: len(seen) == 2)
        assert seen == [TV_LANE_THREAD_NAME, TV_LANE_THREAD_NAME]

        main: list[str] = []
        notify = hop.to_main(
            lambda value: main.append(f"{threading.current_thread().name}:{value}")
        )
        hop.post(lambda: notify("x"))
        await wait_for(lambda: bool(main))
        assert main == [f"{threading.current_thread().name}:x"]
    finally:
        await hop.stop_jobs()
        await hop.stop()


async def test_without_the_lane_everything_stays_on_the_main_loop() -> None:
    hop = build_tv_lane(asyncio.get_running_loop(), enabled=False)
    calls: list[str] = []

    def note(value: str) -> None:
        calls.append(value)

    assert hop.host is None
    hop.post(lambda: calls.append("post"))
    hop.to_tv(note)("tv")
    hop.to_main(note)("main")

    async def value() -> int:
        return 7

    assert await hop.call(value) == 7
    assert calls == ["post", "tv", "main"]
    await hop.stop()


def test_the_key_age_discounts_a_stall_of_either_loop() -> None:
    now = [100.0]
    first = LoopProgress(monotonic=lambda: now[0])
    second = LoopProgress(monotonic=lambda: now[0])
    first.observe()
    second.observe()
    # O primeiro laço segue carimbando; o segundo fica parado 2 s.
    for _ in range(20):
        now[0] += 0.1
        first.observe()
    second.observe()

    combined = LeastElapsed(first, second)

    assert first.elapsed_since(100.0) == pytest.approx(2.0)
    assert combined(100.0) == pytest.approx(second.elapsed_since(100.0))
    assert combined(100.0) < 0.5
