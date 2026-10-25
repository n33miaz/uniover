"""Eventos do vigia: contrato, repetição, fila em memória e entrega sem derrubar ninguém."""

import asyncio
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.core import EnvelopeFactory, EnvelopeGate, WatchdogEvents
from uniover_agent.core.tv import watchdog_events
from uniover_agent.ports import TransportError

from .support import AGENT_ID


class FlakyTransport(FakeTransport):
    """Transporte que falha no envio enquanto `failing` estiver ligado."""

    def __init__(self) -> None:
        super().__init__()
        self.failing = False

    async def send(self, message: dict[str, Any]) -> None:
        if self.failing:
            raise TransportError("caiu")
        await super().send(message)


def make(transport: FakeTransport | None = None) -> tuple[WatchdogEvents, FakeTransport, FakeClock]:
    clock = FakeClock()
    transport = transport or FakeTransport()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    return WatchdogEvents(transport, envelopes, clock), transport, clock


async def test_events_wait_in_memory_until_there_is_a_connection_and_leave_in_order() -> None:
    events, transport, _ = make()
    assert events.emit("repair_started", "info", "Religando o controle da TV.")
    assert events.emit("repaired", "info", "Controle remoto da TV religado.", 2)
    await events.flush()
    assert transport.sent == []
    assert events.pending == 2

    await transport.connect()
    await events.flush()
    await events.flush()  # nada a repetir
    assert [m["body"]["kind"] for m in transport.sent] == ["repair_started", "repaired"]
    assert events.pending == 0


async def test_the_envelope_follows_the_contract() -> None:
    events, transport, _ = make()
    events.emit("repair_failed", "error", "x" * 500, 3)
    await transport.connect()
    await events.flush()
    (message,) = transport.sent
    assert message["type"] == "tv.watchdog.v1"
    assert message["source"] == f"agent:{AGENT_ID}"
    assert message["body"]["severity"] == "error"
    assert message["body"]["attempts"] == 3
    assert len(message["body"]["detail"]) == 200  # o limite do contrato
    assert message["body"]["at"].endswith("Z")


async def test_the_same_kind_inside_a_minute_is_dropped_and_after_it_goes_again() -> None:
    events, _, clock = make()
    assert events.emit("repaired", "info", "a")
    clock.advance(59)
    assert not events.emit("repaired", "info", "b")
    assert events.emit("repair_started", "info", "outro tipo")
    clock.advance(1)
    assert events.emit("repaired", "info", "c")
    assert events.pending == 3


async def test_the_queue_keeps_the_newest_hundred() -> None:
    events, transport, clock = make()
    for number in range(130):
        clock.advance(61)
        events.emit("repaired", "info", f"evento {number}", number % 1000)
    assert events.pending == 100
    await transport.connect()
    await events.flush()
    assert [m["body"]["attempts"] for m in transport.sent] == list(range(30, 130))


async def test_a_failed_send_keeps_the_event_for_the_next_connection() -> None:
    transport = FlakyTransport()
    events, _, _ = make(transport)
    events.emit("repaired", "info", "a")
    await transport.connect()
    transport.failing = True
    await events.flush()  # não levanta
    assert events.pending == 1
    transport.failing = False
    await events.flush()
    assert [m["body"]["kind"] for m in transport.sent] == ["repaired"]
    assert events.pending == 0


async def test_an_event_that_cannot_be_built_is_dropped_without_raising(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events, _, _ = make()

    def boom(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise ValueError("fora do contrato")

    monkeypatch.setattr(EnvelopeFactory, "tv_watchdog", boom)
    assert not events.emit("repaired", "info", "a")
    assert events.pending == 0


async def test_a_send_that_never_returns_gives_up_and_keeps_the_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Hanging(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            await asyncio.sleep(30)

    monkeypatch.setattr(watchdog_events, "SEND_TIMEOUT_SECONDS", 0.01)
    transport = Hanging()
    events, _, _ = make(transport)
    events.emit("repaired", "info", "a")
    await transport.connect()
    await events.flush()
    assert events.pending == 1
