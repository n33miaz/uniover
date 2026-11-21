"""A contagem de energia que não terminou no pedido, avisada à API (`pc.power.outcome.v1`)."""

import asyncio
import threading
from collections.abc import Callable
from typing import Any

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.contracts.registry import MESSAGE_MODELS
from uniover_agent.core import EnvelopeFactory, EnvelopeGate
from uniover_agent.core.pc.power_outcomes import (
    ACKED_KEEP_SECONDS,
    KEEP_SECONDS,
    RESEND_SECONDS,
    PendingOutcomes,
    PowerOutcomes,
)
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


def _acking(
    transport: FakeTransport | None = None,
    clock: FakeClock | None = None,
    pending: PendingOutcomes | None = None,
    settled: list[tuple[str, str]] | None = None,
) -> tuple[PowerOutcomes, FakeTransport, FakeClock]:
    transport = transport or FakeTransport()
    clock = clock or FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    outcomes = PowerOutcomes(
        transport,
        envelopes,
        clock,
        pending=pending,
        on_settled=(lambda cid, outcome: settled.append((cid, outcome)))
        if settled is not None
        else None,
    )
    outcomes.bind_enabled(lambda: True)
    outcomes.bind_acks(lambda: True)
    return outcomes, transport, clock


async def test_with_acks_an_outcome_stays_until_the_api_confirms_it() -> None:
    settled: list[tuple[str, str]] = []
    outcomes, transport, clock = _acking(settled=settled)
    outcomes.report(ID_A, "SHUTDOWN", "lost")
    await outcomes.flush()
    assert len(_bodies(transport)) == 1
    # Sem a confirmação, não sai de novo antes da hora...
    await outcomes.flush()
    assert len(_bodies(transport)) == 1
    # ...mas sai depois dela, com a conexão de pé (a API pode ter falhado ao gravar).
    clock.advance(RESEND_SECONDS)
    await outcomes.flush()
    assert len(_bodies(transport)) == 2
    assert settled == []

    outcomes.acked(ID_A, "lost")
    assert settled == [(ID_A, "lost")]
    clock.advance(RESEND_SECONDS)
    await outcomes.flush()
    assert len(_bodies(transport)) == 2, "confirmado, não sai mais"


async def test_the_connection_dropping_before_the_ack_resends_it_on_the_next_hello() -> None:
    settled: list[tuple[str, str]] = []
    outcomes, transport, _ = _acking(settled=settled)
    outcomes.report(ID_A, "SHUTDOWN", "refused", 5)
    await outcomes.flush()
    assert len(_bodies(transport)) == 1
    # A conexão caiu antes da confirmação: a seguinte manda de novo, logo depois do `hello`.
    following = FakeTransport()
    outcomes._sender = following
    await outcomes.after_hello()
    assert len(_bodies(following)) == 1
    outcomes.acked(ID_A, "refused")
    await outcomes.after_hello()
    assert len(_bodies(following)) == 1
    assert settled == [(ID_A, "refused")]


async def test_an_ack_of_another_countdown_or_outcome_removes_nothing() -> None:
    settled: list[tuple[str, str]] = []
    outcomes, transport, clock = _acking(settled=settled)
    outcomes.report(ID_A, "SHUTDOWN", "lost")
    await outcomes.flush()
    outcomes.acked(ID_B, "lost")
    outcomes.acked(ID_A, "refused")
    clock.advance(RESEND_SECONDS)
    await outcomes.flush()
    assert len(_bodies(transport)) == 2
    assert settled == []


async def test_without_acks_the_outcome_is_settled_once_sent() -> None:
    settled: list[tuple[str, str]] = []
    outcomes, transport, clock = _acking(settled=settled)
    outcomes.bind_acks(lambda: False)  # uma API anterior, que não confirma
    outcomes.report(ID_A, "RESTART", "lost")
    await outcomes.flush()
    assert settled == [(ID_A, "lost")]
    clock.advance(RESEND_SECONDS)
    await outcomes.after_hello()
    assert len(_bodies(transport)) == 1


async def test_the_same_outcome_reported_again_is_kept_once() -> None:
    pending = PendingOutcomes()
    first, transport, _ = _acking(pending=pending)
    first.report(ID_A, "SHUTDOWN", "lost")
    # A remontagem da conexão no mesmo processo lê a marca de novo: o guardado é o mesmo.
    second, _, _ = _acking(transport, pending=pending)
    second.report(ID_A, "SHUTDOWN", "lost")
    await second.flush()
    assert len(_bodies(transport)) == 1


async def test_with_acks_an_outcome_waits_longer_than_without() -> None:
    outcomes, transport, clock = _acking()
    outcomes.report(ID_A, "SHUTDOWN", "refused", 5)
    clock.advance(KEEP_SECONDS + 1)
    await outcomes.flush()
    assert len(_bodies(transport)) == 1
    clock.advance(ACKED_KEEP_SECONDS)
    await outcomes.after_hello()
    assert len(_bodies(transport)) == 1, "passado um dia sem confirmação, desiste"


async def test_with_the_connection_up_an_unacked_outcome_goes_again_by_itself() -> None:
    outcomes, _, _ = _acking()
    outcomes.report(ID_A, "SHUTDOWN", "refused", 5)
    await outcomes.flush()
    retry = outcomes._retry
    assert retry is not None, "o reenvio ficou agendado"
    retry.cancel()
    outcomes.acked(ID_A, "refused")
    await outcomes.flush()
    assert outcomes._retry is None, "sem nada à espera, nada agendado"
