"""A contagem de energia que não terminou no pedido, avisada à API (`pc.power.outcome.v1`)."""

import asyncio
import threading
from collections.abc import Callable
from typing import Any

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.contracts.registry import MESSAGE_MODELS
from uniover_agent.core import EnvelopeFactory, EnvelopeGate
from uniover_agent.core.pc.power_outcomes import KEEP_SECONDS, PowerOutcomes
from uniover_agent.ports import TransportError

from .support import AGENT_ID

ID_A = "0192f1e4-0000-7000-8000-0000000000a1"
ID_B = "0192f1e4-0000-7000-8000-0000000000b2"


def _outcomes(
    transport: FakeTransport | None = None, clock: FakeClock | None = None
) -> tuple[PowerOutcomes, FakeTransport, FakeClock]:
    transport = transport or FakeTransport()
    clock = clock or FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    return PowerOutcomes(transport, envelopes, clock), transport, clock


def _bodies(transport: FakeTransport) -> list[dict[str, Any]]:
    return [m["body"] for m in transport.sent if m["type"] == "pc.power.outcome.v1"]


async def test_nothing_goes_to_an_api_that_does_not_list_the_type() -> None:
    outcomes, transport, _ = _outcomes()
    outcomes.report(ID_A, "SHUTDOWN", "refused", 5)
    await outcomes.flush()
    assert transport.sent == []
    # A API passa a listar: o que ficou guardado sai.
    outcomes.bind_enabled(lambda: True)
    await outcomes.flush()
    assert len(_bodies(transport)) == 1


async def test_a_refusal_goes_with_the_action_and_the_exit_code() -> None:
    outcomes, transport, _ = _outcomes()
    outcomes.bind_enabled(lambda: True)
    outcomes.report(ID_A, "RESTART", "refused", 5)
    outcomes.report(ID_B, "SHUTDOWN", "refused", None)
    await outcomes.flush()
    first, second = (m for m in transport.sent if m["type"] == "pc.power.outcome.v1")
    MESSAGE_MODELS["pc.power.outcome.v1"].model_validate(first)
    MESSAGE_MODELS["pc.power.outcome.v1"].model_validate(second)
    assert first["body"]["action"] == "RESTART"
    assert first["body"]["outcome"] == "refused"
    assert first["body"]["code"] == 5
    assert first["body"]["countdownId"] == ID_A
    assert "code" not in second["body"]
    # Sai uma vez só.
    await outcomes.flush()
    assert len(_bodies(transport)) == 2


async def test_a_dropped_connection_keeps_it_for_the_next_hello() -> None:
    class Broken(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            raise TransportError("caiu")

    outcomes, _, _ = _outcomes(Broken())
    outcomes.bind_enabled(lambda: True)
    outcomes.report(ID_A, "SHUTDOWN", "refused", 5)
    await outcomes.flush()
    working = FakeTransport()
    outcomes._sender = working  # a conexão seguinte
    await outcomes.flush()
    assert len(_bodies(working)) == 1


async def test_an_old_outcome_is_forgotten() -> None:
    outcomes, transport, clock = _outcomes()
    outcomes.report(ID_A, "SHUTDOWN", "refused", 5)
    clock.advance(KEEP_SECONDS + 1)
    outcomes.bind_enabled(lambda: True)
    await outcomes.flush()
    assert transport.sent == []


async def test_a_report_from_the_timer_thread_is_sent_by_the_agent_loop() -> None:
    loop = asyncio.get_running_loop()
    transport = FakeTransport()
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)

    def post(callback: Callable[[], None]) -> None:
        loop.call_soon_threadsafe(callback)

    outcomes = PowerOutcomes(transport, envelopes, clock, post=post)
    outcomes.bind_enabled(lambda: True)
    thread = threading.Thread(target=outcomes.report, args=(ID_A, "SHUTDOWN", "refused", 5))
    thread.start()
    thread.join(5)
    for _ in range(50):
        if transport.sent:
            break
        await asyncio.sleep(0.01)
    assert len(_bodies(transport)) == 1


async def test_two_sends_at_once_never_send_the_same_outcome_twice() -> None:
    class Slow(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            await asyncio.sleep(0.01)
            await super().send(message)

    outcomes, transport, _ = _outcomes(Slow())
    outcomes.bind_enabled(lambda: True)
    outcomes.report(ID_A, "SHUTDOWN", "cancelled")
    await asyncio.gather(outcomes.flush(), outcomes.flush())
    assert [body["outcome"] for body in _bodies(transport)] == ["cancelled"]
