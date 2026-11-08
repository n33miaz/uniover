"""Movimentos numerados que chegam fora de ordem, e a faixa que não espera o envio de resultados."""

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.core import (
    Command,
    CommandResult,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ProcessMessage,
    ResultStatus,
)
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.pc.handlers import merge_pointer_commands
from uniover_agent.core.pc.pointer_order import (
    IDLE_RESET_SECONDS,
    RESTART_GAP,
    PointerSequence,
)
from uniover_agent.core.process_message import LATE_POINTER_WARNING, MAX_PENDING_RESULTS

from .support import AGENT_ID, dump, envelope


class TestPointerSequence:
    def test_without_a_number_a_move_is_never_late_and_leaves_the_mark_alone(self) -> None:
        order = PointerSequence()
        assert not order.is_late(10, 0.0)
        assert not order.is_late(None, 0.1)
        assert not order.is_late(None, 0.2)
        assert order.is_late(9, 0.3)  # a marca (10) continua valendo

    def test_a_move_after_a_newer_one_is_late_and_a_newer_one_is_not(self) -> None:
        order = PointerSequence()
        assert not order.is_late(5, 0.0)
        assert not order.is_late(7, 0.01)
        assert order.is_late(6, 0.02)
        assert order.is_late(7, 0.03)  # repetido
        assert not order.is_late(8, 0.04)

    def test_the_mark_is_forgotten_after_a_pause_so_a_reload_is_never_flagged(self) -> None:
        order = PointerSequence()
        assert not order.is_late(900, 0.0)
        assert order.is_late(899, 1.0)
        assert not order.is_late(1, IDLE_RESET_SECONDS + 1.0)  # contador novo
        assert not order.is_late(2, IDLE_RESET_SECONDS + 1.1)

    def test_a_counter_that_restarted_far_below_the_mark_is_a_new_session(self) -> None:
        order = PointerSequence()
        assert not order.is_late(5000, 0.0)
        assert not order.is_late(5000 - RESTART_GAP - 1, 0.01)
        assert not order.is_late(5000 - RESTART_GAP, 0.02)  # agora é a nova marca: segue em frente

    def test_reset_forgets_the_mark(self) -> None:
        order = PointerSequence()
        assert not order.is_late(100, 0.0)
        order.reset()
        assert not order.is_late(3, 0.01)


class Recorder:
    def __init__(self) -> None:
        self.moved: list[int] = []
        self.scrolled: list[int] = []
        self.send_gate = asyncio.Event()

    async def pointer(self, command: Command) -> CommandResult:
        if command.body.get("scrollY"):
            self.scrolled.append(int(command.body["scrollY"]))
        else:
            self.moved.append(int(command.body["dx"]))
        return CommandResult(command.id, ResultStatus.OK)

    async def click(self, command: Command) -> CommandResult:
        self.moved.append(-1)
        return CommandResult(command.id, ResultStatus.OK)


class SlowSendTransport(FakeTransport):
    """O envio de resultado só termina quando o teste manda (rede lenta)."""

    def __init__(self, gate: asyncio.Event) -> None:
        super().__init__()
        self._gate = gate

    async def send(self, message: dict[str, Any]) -> None:
        await self._gate.wait()
        await super().send(message)


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def move(dx: int, seq: int | None = None) -> str:
    body: dict[str, Any] = {"dx": dx, "dy": 0}
    if seq is not None:
        body["seq"] = seq
    return dump(envelope("pc.pointer.v1", body, ts=now()))


def click() -> str:
    return dump(envelope("pc.click.v1", {"button": "LEFT", "action": "CLICK"}, ts=now()))


def build(rec: Recorder, transport: FakeTransport) -> ProcessMessage:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    handlers: dict[str, Handler] = {"pc.pointer.v1": rec.pointer, "pc.click.v1": rec.click}
    return ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand(handlers, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        silent_types={"pc.pointer.v1"},
    )


async def settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


async def test_a_batch_that_arrives_after_a_newer_one_is_still_applied() -> None:
    rec = Recorder()
    process = build(rec, FakeTransport())
    for dx, seq in ((1, 1), (3, 3), (2, 2), (4, 4)):
        await process(move(dx, seq))
    await settle()
    # O deslocamento é relativo: nada se perde, só a ordem muda.
    assert rec.moved == [1, 3, 2, 4]
    assert sum(rec.moved) == 10
    await process.aclose()


async def test_out_of_order_scroll_keeps_its_total_too() -> None:
    rec = Recorder()
    process = build(rec, FakeTransport())
    for amount, seq in ((120, 2), (240, 1), (-120, 3)):
        body = {"dx": 0, "dy": 0, "scrollY": amount, "seq": seq}
        await process(dump(envelope("pc.pointer.v1", body, ts=now())))
    await settle()
    assert rec.scrolled == [120, 240, -120]
    await process.aclose()


async def test_moves_without_a_number_are_applied_as_always() -> None:
    rec = Recorder()
    process = build(rec, FakeTransport())
    await process(move(5, 50))
    await process(move(0))
    await process(move(6, 49))
    await process(move(7))
    await settle()
    assert rec.moved == [5, 0, 6, 7]
    await process.aclose()


async def test_after_the_connection_drops_the_counter_may_start_over() -> None:
    rec = Recorder()
    process = build(rec, FakeTransport())
    await process(move(1, 100))
    await settle()
    process.connection_lost()
    await process(move(2, 1))
    await settle()
    assert rec.moved == [1, 2]
    await process.aclose()


async def test_the_lane_does_not_wait_for_a_slow_result_to_go_out() -> None:
    rec = Recorder()
    transport = SlowSendTransport(rec.send_gate)
    process = build(rec, transport)
    await process(click())  # tem resultado, e o envio dele está preso
    await process(move(8, 1))
    await settle()
    assert rec.moved == [-1, 8]  # o movimento passou na frente do envio preso
    assert transport.sent == []
    rec.send_gate.set()
    await settle()
    (reply,) = transport.sent
    assert reply["body"] == {"ok": True}
    await process.aclose()


async def test_closing_the_agent_cancels_a_result_that_is_still_going_out() -> None:
    rec = Recorder()
    transport = SlowSendTransport(rec.send_gate)
    process = build(rec, transport)
    await process(click())
    await settle()
    await asyncio.wait_for(process.aclose(), 1)
    assert transport.sent == []


def _command(dx: int, seq: int | None) -> Command:
    body: dict[str, Any] = {"dx": dx, "dy": 0}
    if seq is not None:
        body["seq"] = seq
    return Command(f"id{dx}", "pc.pointer.v1", body, None, None)


def test_merging_two_moves_keeps_the_highest_number() -> None:
    merged = merge_pointer_commands(_command(1, 5), _command(2, 4))
    assert merged is not None
    assert merged.body == {"dx": 3, "dy": 0, "scrollX": 0, "scrollY": 0, "seq": 5}


def test_merging_without_numbers_adds_none() -> None:
    merged = merge_pointer_commands(_command(1, None), _command(2, None))
    assert merged is not None
    assert "seq" not in merged.body


async def test_a_long_run_of_out_of_order_moves_is_warned_once_and_all_are_applied(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rec = Recorder()
    process = build(rec, FakeTransport())
    await process(move(1, 1000))
    with caplog.at_level(logging.WARNING):
        for seq in range(1, LATE_POINTER_WARNING * 2 + 1):
            await process(move(1, 1000 - seq))
    warnings = [r for r in caplog.records if "fora de ordem" in r.getMessage()]
    assert len(warnings) == 1
    await settle()
    assert len(rec.moved) == 1 + LATE_POINTER_WARNING * 2
    await process.aclose()


async def test_result_sends_are_bounded_and_the_oldest_is_abandoned(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rec = Recorder()
    transport = SlowSendTransport(rec.send_gate)
    process = build(rec, transport)
    with caplog.at_level(logging.WARNING):
        for _ in range(MAX_PENDING_RESULTS + 10):
            await process(click())
        await settle()
        await settle()
    assert len(process._result_tasks) == MAX_PENDING_RESULTS
    assert len([r for r in caplog.records if "acumulado" in r.getMessage()]) == 1
    rec.send_gate.set()
    await settle()
    assert len(transport.sent) == MAX_PENDING_RESULTS
    assert not process._result_tasks
    await process.aclose()


async def test_losing_the_connection_cancels_the_result_sends_still_going_out() -> None:
    rec = Recorder()
    transport = SlowSendTransport(rec.send_gate)
    process = build(rec, transport)
    await process(click())
    await settle()
    process.connection_lost()
    rec.send_gate.set()
    await settle()
    assert transport.sent == []
    await process.aclose()
