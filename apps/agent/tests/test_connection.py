import asyncio
from collections.abc import Callable
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.core import (
    Backoff,
    BackoffPolicy,
    ConnectionSupervisor,
    EnvelopeFactory,
    EnvelopeGate,
)
from uniover_agent.ports import (
    ConnectionReplaced,
    CredentialRejected,
    ServerRestarting,
    TransportError,
)

from .support import AGENT_ID

POLICY = BackoffPolicy()


def middle() -> float:
    return 0.5  # fator 1,0: sem jitter


def test_backoff_doubles_then_caps_at_thirty() -> None:
    backoff = Backoff(POLICY, middle)
    assert [backoff.next_delay() for _ in range(8)] == [1, 2, 4, 8, 16, 30, 30, 30]


def test_backoff_jitter_stays_within_bounds_and_cap() -> None:
    low = Backoff(POLICY, lambda: 0.0)
    high = Backoff(POLICY, lambda: 1.0)
    assert low.next_delay() == pytest.approx(0.8)
    assert high.next_delay() == pytest.approx(1.2)
    for _ in range(10):
        low.next_delay()
        assert high.next_delay() <= POLICY.cap


def test_backoff_reset_returns_to_start() -> None:
    backoff = Backoff(POLICY, middle)
    for _ in range(4):
        backoff.next_delay()
    backoff.reset()
    assert backoff.next_delay() == 1


class Harness:
    def __init__(self, transport: FakeTransport, stop_after: int | None = None) -> None:
        self.clock = FakeClock()
        self.transport = transport
        self.processed: list[str | bytes] = []
        self.stop_after = stop_after
        gate = EnvelopeGate(AGENT_ID)
        self.supervisor = ConnectionSupervisor(
            transport,
            self._process,
            EnvelopeFactory(AGENT_ID, gate, self.clock),
            self.clock,
            middle,
            agent_version="0.1.0",
            capabilities=["tv.remote"],
        )

    async def _process(self, raw: str | bytes) -> None:
        self.processed.append(raw)

    async def run_until(self, done: Callable[[], bool]) -> None:
        """Roda o laço e o cancela quando `done()` for verdadeiro (o laço não termina sozinho)."""
        task = asyncio.create_task(self.supervisor.run())
        for _ in range(1000):
            if done() or task.done():
                break
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_connects_sends_hello_and_processes_messages() -> None:
    transport = FakeTransport([["a", "b"]])
    harness = Harness(transport)
    await harness.run_until(lambda: transport.connects >= 2)
    (hello, *_) = transport.sent
    assert hello["type"] == "agent.hello.v1"
    assert hello["body"] == {"agentVersion": "0.1.0", "capabilities": ["tv.remote"]}
    assert harness.processed == ["a", "b"]
    assert transport.closes >= 1


async def test_reconnects_with_growing_backoff_without_attempt_limit() -> None:
    transport = FakeTransport()
    transport.connect_error = TransportError("sem rede")
    harness = Harness(transport)
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 8)
    assert harness.clock.sleeps[:8] == [1, 2, 4, 8, 16, 30, 30, 30]


async def test_backoff_resets_after_stable_connection() -> None:
    clock_holder: dict[str, Harness] = {}

    class StableThenDrop(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            await super().send(message)
            # A terceira conexão dura 61 s antes de cair; as outras caem na hora.
            if self.connects == 3:
                clock_holder["h"].clock.advance(61)

    transport = StableThenDrop([[TransportError("cai")]] * 5)
    harness = Harness(transport)
    clock_holder["h"] = harness
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 4)
    # 1, 2 (duas quedas rápidas); a terceira conexão foi estável: volta a 1; depois 2.
    assert harness.clock.sleeps[:4] == [1, 2, 1, 2]


async def test_credential_rejected_stops_without_loop_and_without_sleep() -> None:
    transport = FakeTransport()
    transport.connect_error = CredentialRejected("401")
    harness = Harness(transport)
    await asyncio.wait_for(harness.supervisor.run(), timeout=2)
    assert transport.connects == 1
    assert harness.clock.sleeps == []
    assert transport.closes == 1


async def test_revocation_during_session_stops() -> None:
    transport = FakeTransport([["x", CredentialRejected("revogado")]])
    harness = Harness(transport)
    await asyncio.wait_for(harness.supervisor.run(), timeout=2)
    assert transport.connects == 1
    assert harness.processed == ["x"]


async def test_replaced_waits_longer_than_backoff_cap() -> None:
    transport = FakeTransport([[ConnectionReplaced("outra")]])
    harness = Harness(transport)
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 1)
    assert harness.clock.sleeps[0] == POLICY.replaced_wait
    assert POLICY.replaced_wait > POLICY.cap


async def test_cancellation_closes_the_transport() -> None:
    gate_open = asyncio.Event()

    class Blocking(FakeTransport):
        async def incoming(self):  # type: ignore[no-untyped-def]
            await gate_open.wait()
            yield "nunca"

    transport = Blocking()
    harness = Harness(transport)
    task = asyncio.create_task(harness.supervisor.run())
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert transport.closes == 1
    assert not transport.connected


async def test_on_connected_runs_after_the_hello_on_every_connection() -> None:
    clock = FakeClock()
    transport = FakeTransport([[TransportError("caiu")], []])
    order: list[str] = []

    async def announce() -> None:
        # Quando roda, o `hello` já saiu; o que vier depois dele é o estado atual.
        order.append(f"hello={len(transport.sent)}")

    supervisor = ConnectionSupervisor(
        transport,
        lambda raw: asyncio.sleep(0),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        middle,
        agent_version="0.1.0",
        capabilities=[],
        on_connected=announce,
    )
    task = asyncio.create_task(supervisor.run())
    for _ in range(200):
        if len(order) >= 2:
            break
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert order[:2] == ["hello=1", "hello=2"]


async def test_server_restart_reconnects_fast_without_growing_the_backoff() -> None:
    script: list[list[str | bytes | Exception]] = [
        [ServerRestarting("código 1012")] for _ in range(3)
    ]
    script.append([TransportError("cai")])
    transport = FakeTransport(script)
    harness = Harness(transport)
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 4)
    # Três avisos de reinício: espera curta e fixa; a primeira queda comum ainda começa em 1 s.
    assert harness.clock.sleeps[:4] == [POLICY.restart_wait] * 3 + [1]
    assert POLICY.restart_wait < 1


async def test_unexpected_exception_in_the_loop_does_not_kill_the_agent() -> None:
    transport = FakeTransport([[RuntimeError("bug")], ["ok"]])
    harness = Harness(transport)
    await harness.run_until(lambda: transport.connects >= 2 and harness.processed == ["ok"])
    assert harness.processed == ["ok"]
    assert harness.clock.sleeps[0] == 1


async def test_exception_from_message_processing_reconnects() -> None:
    transport = FakeTransport([["ruim"], ["bom"]])
    harness = Harness(transport)
    original = harness._process

    async def explode_once(raw: str | bytes) -> None:
        if raw == "ruim":
            raise ValueError("falha ao processar")
        await original(raw)

    harness.supervisor._process = explode_once
    await harness.run_until(lambda: harness.processed == ["bom"])
    assert harness.processed == ["bom"]


async def test_keepalive_send_failure_closes_the_channel_so_the_loop_reconnects() -> None:
    release = asyncio.Event()

    class BrokenKeepalive(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            if message["type"] == "agent.keepalive.v1":
                raise TransportError("canal quebrado")
            await super().send(message)

        async def incoming(self):  # type: ignore[no-untyped-def]
            # Fica aberto como uma conexão meio morta, até o laço fechá-la.
            await release.wait()
            raise TransportError("fechado")
            yield

        async def close(self) -> None:
            release.set()
            await super().close()

    transport = BrokenKeepalive()
    clock = FakeClock()
    supervisor = ConnectionSupervisor(
        transport,
        lambda raw: asyncio.sleep(0),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        middle,
        agent_version="0.1.0",
        capabilities=[],
        keepalive_interval=0.01,
    )
    task = asyncio.create_task(supervisor.run())
    for _ in range(300):
        if transport.connects >= 2:
            break
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert transport.connects >= 2
