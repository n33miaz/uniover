"""Teclas que esperaram a sessão abrir não podem mover a TV depois do toque."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvRemote
from uniover_agent.core import (
    ClockOffset,
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


def build(
    command_timeout: float | None = None,
    *,
    api_clock: bool = False,
) -> tuple[ProcessMessage, FakeTransport, SlowRemote, AdvancingClock]:
    """`api_clock`: liga a idade desde o envio (o `ClockOffset` dos batimentos da API), como em
    produção; sem ele, a API anterior (a idade conta só desde a chegada)."""
    clock = AdvancingClock()
    offset = ClockOffset(now=clock.now, monotonic=clock.monotonic)
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
        command_timeout_seconds=command_timeout,
        observe_timestamp=offset.observe if api_clock else None,
        timestamp_age=offset.age if api_clock else None,
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


# ---- idade desde o envio: a referência vem dos batimentos da API (`ClockOffset`) ----------------

BEAT_SECONDS = 20.0  # o batimento da API em produção (`ApplicationKeepAliveSeconds`)


def stamp(clock: AdvancingClock, seconds_ago: float = 0.0) -> str:
    """O `ts` da API para algo montado `seconds_ago` s antes de agora (relógios iguais)."""
    return (clock.now() - timedelta(seconds=seconds_ago)).isoformat().replace("+00:00", "Z")


async def api_beats(process: ProcessMessage, clock: AdvancingClock, count: int = 2) -> None:
    """Batimentos da API em dia (0,1 s no caminho): formam a referência de relógio."""
    for _ in range(count):
        clock.advance(BEAT_SECONDS)
        beat = envelope("api.keepalive.v1", {}, ts=stamp(clock, 0.1))
        await process(dump(beat))


def results(transport: FakeTransport) -> list[str]:
    return [
        "ok" if m["body"]["ok"] else m["body"]["error"]["code"]
        for m in transport.sent
        if m["type"] == "command.result.v1"
    ]


async def test_a_key_that_left_the_api_long_ago_expires_even_if_it_just_arrived() -> None:
    process, transport, remote, clock = build(api_clock=True)
    remote.release.set()
    await api_beats(process, clock)

    late = message("tv.key.v3", {"key": "RIGHT"}, clock)
    late["ts"] = stamp(clock, 2.0)
    fresh = message("tv.key.v3", {"key": "LEFT"}, clock)
    await process(dump(late))
    await process(dump(fresh))
    await finish_keys(process)

    assert remote.sent == [("LEFT", "SHORT")]
    # `expired` é o código de comando velho que a tela não mostra.
    assert results(transport) == ["expired", "ok"]


async def test_the_age_since_sending_adds_the_wait_inside_the_agent() -> None:
    process, transport, remote, clock = build(api_clock=True)
    await api_beats(process, clock)

    command = message("tv.key.v3", {"key": "RIGHT"}, clock)
    command["ts"] = stamp(clock, 1.0)  # 0,9 s além da referência: ainda vale ao chegar
    await process(dump(command))
    await asyncio.wait_for(remote.opening.wait(), timeout=1)
    clock.advance(0.7)  # a sessão demora: 1,6 s no total, mas só 0,7 s aqui dentro
    remote.release.set()
    await finish_keys(process)

    assert remote.sent == []
    assert results(transport) == ["expired"]


async def test_an_agent_back_from_a_pause_presses_none_of_the_keys_held_in_the_socket() -> None:
    process, transport, remote, clock = build(api_clock=True)
    remote.release.set()
    await api_beats(process, clock)

    # O agente parou 90 s (paginado): a API seguiu mandando 20 teclas e os batimentos dela, que
    # ficaram represados e chegam todos juntos, na ordem, quando o laço volta. Os 4 batimentos
    # atrasados seguidos refariam a referência se contassem um a um (e as últimas teclas
    # pareceriam novas): de uma rajada, contam como um.
    paused_at = clock.monotonic()
    queued: list[tuple[float, dict[str, Any]]] = []
    for index in range(20):
        sent = paused_at + 1.0 + index * 4.4
        queued.append((sent, envelope("tv.key.v3", {"key": "RIGHT"})))
    for beat in range(1, 5):
        queued.append((paused_at + beat * BEAT_SECONDS, envelope("api.keepalive.v1", {})))
    queued.sort(key=lambda item: item[0])
    clock.advance(90.0)
    for sent, frame in queued:
        frame["ts"] = stamp(clock, clock.monotonic() - sent)
        await process(dump(frame))
    await finish_keys(process)

    assert remote.sent == []
    assert results(transport) == ["expired"] * 20

    # A rajada de batimentos atrasados não mexeu na referência: a próxima tecla vale.
    fresh = message("tv.key.v3", {"key": "OK"}, clock)
    await process(dump(fresh))
    await finish_keys(process)
    assert remote.sent == [("OK", "SHORT")]


async def test_without_a_clock_reference_the_age_counts_from_arrival_as_before() -> None:
    # Sem batimentos da API ainda (recém-conectado, ou uma API anterior): vale como chegou.
    process, transport, remote, clock = build(api_clock=True)
    remote.release.set()
    command = message("tv.key.v3", {"key": "UP"}, clock)
    command["ts"] = stamp(clock, 120.0)

    await process(dump(command))
    await finish_keys(process)

    assert remote.sent == [("UP", "SHORT")]
    assert results(transport) == ["ok"]


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
    await finish_keys(process)

    assert remote.texts == ["oi"]
    assert remote.sent == [("POWER", "SHORT")]
    assert [reply["body"] for reply in transport.sent] == [{"ok": True}, {"ok": True}]


async def test_a_key_stuck_opening_the_session_is_cut_and_does_not_block_the_next_text() -> None:
    process, transport, remote, clock = build(command_timeout=0.05)
    key = message("tv.key.v3", {"key": "RIGHT"}, clock)
    await process(dump(key))
    await asyncio.wait_for(remote.opening.wait(), timeout=1)
    # O texto espera as teclas anteriores: sem o teto, ficaria preso junto com a tecla.
    await process(dump(message("tv.text.v1", {"text": "oi"}, clock)))
    for _ in range(100):
        if transport.sent:
            break
        await asyncio.sleep(0.01)
    assert transport.sent[0]["correlationId"] == key["id"]
    assert transport.sent[0]["body"]["error"]["code"] == "tv_unreachable"
    remote.release.set()
    await finish_keys(process)
    assert remote.sent == []
    assert remote.texts == ["oi"]
