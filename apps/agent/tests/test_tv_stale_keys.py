"""Teclas que esperaram a sessão abrir não podem mover a TV depois do toque."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvRemote
from uniover_agent.core import (
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ProcessMessage,
    ResultStatus,
    TvSessionManager,
    tv_key_handler,
    tv_text_handler,
)

from .support import AGENT_ID, dump, envelope


class AdvancingClock(FakeClock):
    def __init__(self) -> None:
        super().__init__()
        self.base = datetime(2026, 10, 26, 12, tzinfo=UTC)

    def now(self) -> datetime:
        return self.base + timedelta(seconds=self.monotonic())


class SlowRemote(FakeTvRemote):
    def __init__(self) -> None:
        super().__init__()
        self.opening = asyncio.Event()
        self.release = asyncio.Event()
        self.block_first_send = False
        self.first_send = asyncio.Event()
        self.release_first_send = asyncio.Event()

    async def connect(self) -> None:
        self.opening.set()
        await self.release.wait()
        await super().connect()

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if self.block_first_send and not self.first_send.is_set():
            self.first_send.set()
            await self.release_first_send.wait()
        await super().send_key(key, direction)


def build() -> tuple[ProcessMessage, FakeTransport, SlowRemote, AdvancingClock]:
    clock = AdvancingClock()
    remote = SlowRemote()
    session = TvSessionManager(clock, remote)
    keys = tv_key_handler(session, monotonic=clock.monotonic)
    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand(
            {
                "tv.key.v1": keys,
                "tv.key.v2": keys,
                "tv.key.v3": keys,
                "tv.text.v1": tv_text_handler(session, monotonic=clock.monotonic),
            },
            clock,
        ),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        monotonic=clock.monotonic,
    )
    return process, transport, remote, clock


def message(message_type: str, body: dict[str, Any], clock: AdvancingClock) -> dict[str, Any]:
    return envelope(message_type, body, ts=clock.now().isoformat().replace("+00:00", "Z"))


async def finish_keys(process: ProcessMessage) -> None:
    # Espera só as tarefas de tecla criadas pelo recebimento, sem rede ou TV reais.
    await asyncio.wait_for(asyncio.gather(*tuple(process._tasks)), timeout=1)


async def test_key_sent_when_session_opens_within_age_limit() -> None:
    process, transport, remote, clock = build()
    command = message("tv.key.v3", {"key": "RIGHT"}, clock)
    await process(dump(command))
    await asyncio.wait_for(remote.opening.wait(), timeout=1)
    clock.advance(1.4)
    remote.release.set()
    await finish_keys(process)

    assert remote.sent == [("RIGHT", "SHORT")]
    assert transport.sent[0]["correlationId"] == command["id"]
    assert transport.sent[0]["body"] == {"ok": True}


@pytest.mark.parametrize(
    ("message_type", "key"),
    [
        ("tv.key.v1", "RIGHT"),
        ("tv.key.v2", "VOLUME_UP"),
        ("tv.key.v3", "MEDIA_NEXT"),
    ],
)
async def test_old_navigation_volume_and_media_keys_expire_while_opening(
    message_type: str, key: str, caplog: pytest.LogCaptureFixture
) -> None:
    process, transport, remote, clock = build()
    command = message(message_type, {"key": key}, clock)
    with caplog.at_level(logging.INFO):
        await process(dump(command))
        await asyncio.wait_for(remote.opening.wait(), timeout=1)
        clock.advance(1.6)
        remote.release.set()
        await finish_keys(process)

    assert remote.sent == []
    assert transport.sent[0]["body"]["error"]["code"] == "agent_timeout"
    assert "teclas descartadas por idade: total=1" in caplog.text
    assert "pc-casa" not in caplog.text


@pytest.mark.parametrize("clock_offset", [-120, 120])
async def test_envelope_clock_skew_does_not_expire_a_newly_received_key(
    clock_offset: int,
) -> None:
    process, transport, remote, clock = build()
    remote.release.set()
    command = message("tv.key.v1", {"key": "UP"}, clock)
    command["ts"] = (
        (clock.now() + timedelta(seconds=clock_offset)).isoformat().replace("+00:00", "Z")
    )
    await process(dump(command))
    await finish_keys(process)

    assert remote.sent == [("UP", "SHORT")]
    assert transport.sent[0]["body"] == {"ok": True}


async def test_key_without_envelope_uses_handler_arrival_time() -> None:
    clock = AdvancingClock()
    remote = SlowRemote()
    keys = tv_key_handler(TvSessionManager(clock, remote), monotonic=clock.monotonic)
    task = asyncio.ensure_future(keys(Command("1", "tv.key.v1", {"key": "DOWN"})))
    await asyncio.wait_for(remote.opening.wait(), timeout=1)
    clock.advance(2)
    remote.release.set()
    result = await asyncio.wait_for(task, timeout=1)

    assert (result.status, result.code) == (ResultStatus.FAILED, "agent_timeout")
    assert remote.sent == []


async def test_repeated_keys_while_session_opens_send_only_the_latest() -> None:
    process, transport, remote, clock = build()
    commands = [message("tv.key.v3", {"key": "RIGHT"}, clock) for _ in range(11)]
    await process(dump(commands[0]))
    await asyncio.wait_for(remote.opening.wait(), timeout=1)
    for command in commands[1:]:
        await process(dump(command))
    clock.advance(0.5)
    remote.release.set()
    await finish_keys(process)

    assert remote.sent == [("RIGHT", "SHORT")]
    results = {reply["correlationId"]: reply["body"] for reply in transport.sent}
    assert results[commands[-1]["id"]] == {"ok": True}
    assert all(
        results[command["id"]]["error"]["code"] == "agent_timeout" for command in commands[:-1]
    )


async def test_repeated_keys_with_a_ready_session_all_reach_the_tv() -> None:
    process, transport, remote, clock = build()
    remote.release.set()
    await process(dump(message("tv.key.v3", {"key": "LEFT"}, clock)))
    await finish_keys(process)
    remote.sent.clear()
    transport.sent.clear()

    commands = [message("tv.key.v3", {"key": "RIGHT"}, clock) for _ in range(3)]
    for command in commands:
        await process(dump(command))
    await finish_keys(process)

    assert remote.sent == [("RIGHT", "SHORT")] * 3
    assert [reply["body"] for reply in transport.sent] == [{"ok": True}] * 3


async def test_different_keys_keep_receive_order_while_a_send_is_waiting() -> None:
    process, transport, remote, clock = build()
    remote.release.set()
    remote.block_first_send = True
    commands = [message("tv.key.v3", {"key": key}, clock) for key in ("RIGHT", "RIGHT", "OK")]
    await process(dump(commands[0]))
    await asyncio.wait_for(remote.first_send.wait(), timeout=1)
    for command in commands[1:]:
        await process(dump(command))
    for _ in range(3):
        await asyncio.sleep(0)
    assert remote.sent == []
    remote.release_first_send.set()
    await finish_keys(process)

    assert remote.sent == [("RIGHT", "SHORT"), ("RIGHT", "SHORT"), ("OK", "SHORT")]
    assert {reply["correlationId"] for reply in transport.sent} == {
        command["id"] for command in commands
    }


async def test_text_and_power_keep_their_existing_behavior() -> None:
    process, transport, remote, clock = build()
    remote.release.set()
    old = (clock.now() - timedelta(seconds=3)).isoformat().replace("+00:00", "Z")
    await process(dump(envelope("tv.text.v1", {"text": "oi"}, ts=old)))
    await process(dump(envelope("tv.key.v1", {"key": "POWER"}, ts=old)))

    assert remote.texts == ["oi"]
    assert remote.sent == [("POWER", "SHORT")]
    assert [reply["body"] for reply in transport.sent] == [{"ok": True}, {"ok": True}]
