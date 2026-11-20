"""A rede do PC muda com a conexão abrindo ou aberta (o Wi-Fi do celular cai, a rota padrão passa
para o cabo, a internet de casa volta): o laço não espera os prazos longos do transporte, refaz a
conexão em poucos segundos (com variação sorteada) e não a derruba à toa quando ela segue de pé."""

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.core import ConnectionSupervisor, EnvelopeFactory, EnvelopeGate
from uniover_agent.core.connection import (
    NETWORK_PROBE_TIMEOUT_SECONDS,
    NETWORK_SETTLE_MAX_SECONDS,
    NETWORK_SETTLE_MIN_SECONDS,
    NetworkMoved,
)

from .support import AGENT_ID


class Watcher:
    def __init__(self, on_change: Callable[[], None]) -> None:
        self.notify = on_change

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass


class StuckOpenTransport:
    """A primeira abertura fica presa na rota velha; as seguintes abrem e ficam abertas."""

    def __init__(self, stuck_opens: int = 1) -> None:
        self.stuck_opens = stuck_opens
        self.connects = 0
        self.cancelled_opens = 0
        self.closes = 0
        self.sent: list[dict[str, Any]] = []
        self._open = False
        self._closed = asyncio.Event()

    @property
    def connected(self) -> bool:
        return self._open

    async def connect(self) -> None:
        self.connects += 1
        if self.connects <= self.stuck_opens:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.cancelled_opens += 1
                raise
        self._open = True
        self._closed = asyncio.Event()

    async def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    async def incoming(self) -> AsyncIterator[str | bytes]:
        await self._closed.wait()
        return
        yield b""  # pragma: no cover - torna a função um gerador

    async def close(self) -> None:
        self.closes += 1
        self._open = False
        self._closed.set()


class Scene:
    def __init__(
        self,
        transport: StuckOpenTransport,
        liveness: Callable[[float], Any] | None = None,
        random: float = 0.5,
    ) -> None:
        self.clock = FakeClock()
        self.transport = transport
        self.watcher: Watcher | None = None

        def factory(on_change: Callable[[], None]) -> Watcher:
            self.watcher = Watcher(on_change)
            return self.watcher

        self.supervisor = ConnectionSupervisor(
            transport,
            lambda raw: asyncio.sleep(0),
            EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), self.clock),
            self.clock,
            lambda: random,
            agent_version="0.1.0",
            capabilities=[],
            keepalive_interval=3600,
            network_watcher=factory,
            liveness=liveness,
        )

    def change(self) -> None:
        assert self.watcher is not None
        self.watcher.notify()


async def until(condition: Callable[[], bool]) -> bool:
    for _ in range(500):
        if condition():
            return True
        await asyncio.sleep(0)
    return condition()


async def stop(task: asyncio.Task[None]) -> None:
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_an_open_stuck_on_the_old_route_is_dropped_and_redone_in_seconds() -> None:
    scene = Scene(StuckOpenTransport())
    task = asyncio.create_task(scene.supervisor.run())
    assert await until(lambda: scene.transport.connects == 1)
    scene.clock.advance(10)  # a abertura já estava em curso quando a rede mudou
    scene.change()
    assert await until(lambda: scene.transport.connects == 2)
    assert scene.transport.cancelled_opens == 1
    # Volta sorteada entre os extremos, sem a espera crescente (nem o prazo de 105 s).
    quick = [
        seconds
        for seconds in scene.clock.sleeps
        if NETWORK_SETTLE_MIN_SECONDS <= seconds <= NETWORK_SETTLE_MAX_SECONDS
    ]
    assert len(quick) == 2  # a folga para a abertura acabar e a volta
    assert await until(lambda: scene.transport.connected)
    await stop(task)


async def test_the_change_that_woke_the_open_does_not_abort_it() -> None:
    scene = Scene(StuckOpenTransport())
    task = asyncio.create_task(scene.supervisor.run())
    assert await until(lambda: scene.transport.connects == 1)
    scene.change()  # a mesma troca que acordou a tentativa, logo no começo dela
    assert not await until(lambda: scene.transport.connects > 1)
    assert scene.transport.cancelled_opens == 0
    await stop(task)


async def test_a_flapping_network_aborts_an_open_at_most_once_per_window() -> None:
    scene = Scene(StuckOpenTransport(stuck_opens=2))
    task = asyncio.create_task(scene.supervisor.run())
    assert await until(lambda: scene.transport.connects == 1)
    scene.clock.advance(10)
    scene.change()
    assert await until(lambda: scene.transport.connects == 2)
    scene.clock.advance(1.5)  # logo depois: a rede ainda oscila
    scene.change()
    assert not await until(lambda: scene.transport.connects > 2)
    await stop(task)


async def test_an_open_channel_that_still_answers_is_kept() -> None:
    probes: list[float] = []

    async def alive(within: float) -> bool:
        probes.append(within)
        return True

    scene = Scene(StuckOpenTransport(stuck_opens=0), alive)
    task = asyncio.create_task(scene.supervisor.run())
    assert await until(lambda: len(scene.transport.sent) == 1)  # o hello saiu: sessão aberta
    await asyncio.sleep(0)
    scene.change()
    assert await until(lambda: probes == [NETWORK_PROBE_TIMEOUT_SECONDS])
    assert not await until(lambda: scene.transport.connects > 1)
    assert scene.transport.closes == 0
    await stop(task)


async def test_an_open_channel_left_on_the_dead_card_is_redone_in_seconds() -> None:
    async def dead(within: float) -> bool:
        return False

    scene = Scene(StuckOpenTransport(stuck_opens=0), dead)
    task = asyncio.create_task(scene.supervisor.run())
    assert await until(lambda: len(scene.transport.sent) == 1)  # o hello saiu: sessão aberta
    await asyncio.sleep(0)
    scene.change()
    assert await until(lambda: scene.transport.connects == 2)
    assert scene.transport.closes == 1
    assert all(seconds <= NETWORK_SETTLE_MAX_SECONDS for seconds in scene.clock.sleeps)
    await stop(task)


async def test_a_probe_that_never_returns_counts_as_a_dead_channel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("uniover_agent.core.connection.NETWORK_PROBE_TIMEOUT_SECONDS", 0.01)

    async def hangs(within: float) -> bool:
        await asyncio.Event().wait()
        return True

    scene = Scene(StuckOpenTransport(stuck_opens=0), hangs)
    task = asyncio.create_task(scene.supervisor.run())
    assert await until(lambda: len(scene.transport.sent) == 1)  # o hello saiu: sessão aberta
    await asyncio.sleep(0)
    scene.change()
    # A sonda espera de verdade (0,01 s): num CI lento a troca leva mais que um segundo.
    for _ in range(1000):
        if scene.transport.connects >= 2:
            break
        await asyncio.sleep(0.01)
    assert scene.transport.connects == 2
    await stop(task)


async def test_without_a_liveness_check_an_open_channel_is_left_alone() -> None:
    scene = Scene(StuckOpenTransport(stuck_opens=0))
    task = asyncio.create_task(scene.supervisor.run())
    assert await until(lambda: len(scene.transport.sent) == 1)  # o hello saiu: sessão aberta
    await asyncio.sleep(0)
    scene.change()
    assert not await until(lambda: scene.transport.connects > 1)
    await stop(task)


def test_network_moved_is_a_transient_transport_error() -> None:
    from uniover_agent.ports import TransportError  # noqa: PLC0415

    assert issubclass(NetworkMoved, TransportError)
