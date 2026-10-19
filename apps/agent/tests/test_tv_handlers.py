import asyncio
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvRemote
from uniover_agent.core import (
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ResultStatus,
    TvSessionManager,
    TvState,
    TvStatePublisher,
    tv_app_launch_handler,
    tv_key_handler,
    tv_wake_handler,
)
from uniover_agent.core.tv.handlers import KEY_BLOCKED, LINK_SCHEME_BLOCKED, UNSUPPORTED
from uniover_agent.ports import TransportError, TvUnreachable

from .support import AGENT_ID


def make() -> tuple[HandleCommand, FakeTvRemote]:
    clock, remote = FakeClock(), FakeTvRemote()
    session = TvSessionManager(clock, remote)
    keys = tv_key_handler(session)
    handler = HandleCommand(
        {
            "tv.key.v1": keys,
            "tv.key.v2": keys,
            "tv.wake.v1": tv_wake_handler(session),
            "tv.app.launch.v1": tv_app_launch_handler(session),
        },
        clock,
    )
    return handler, remote


async def test_key_v1_and_v2_are_both_accepted() -> None:
    handler, remote = make()
    v1 = await handler(Command("1", "tv.key.v1", {"key": "VOLUME_UP"}))
    v2 = await handler(Command("2", "tv.key.v2", {"key": "NUM_5", "direction": "START_LONG"}))
    assert (v1.status, v2.status) == (ResultStatus.OK, ResultStatus.OK)
    assert remote.sent == [("VOLUME_UP", "SHORT"), ("NUM_5", "START_LONG")]


async def test_key_v2_without_direction_is_a_short_press() -> None:
    handler, remote = make()
    await handler(Command("1", "tv.key.v2", {"key": "OK"}))
    assert remote.sent == [("OK", "SHORT")]


async def test_power_key_is_refused_and_nothing_is_sent_to_the_tv() -> None:
    handler, remote = make()
    for message_type in ("tv.key.v1", "tv.key.v2"):
        result = await handler(Command("1", message_type, {"key": "POWER"}))
        assert result.status is ResultStatus.REJECTED
        assert result.code == KEY_BLOCKED
    # Nem a sessão foi aberta: o pedido morre antes de tocar na TV.
    assert remote.connects == 0
    assert remote.sent == []


async def test_unreachable_tv_is_reported_with_its_code() -> None:
    handler, remote = make()
    remote.connect_errors = [TvUnreachable("x") for _ in range(4)]
    result = await handler(Command("1", "tv.key.v1", {"key": "HOME"}))
    assert result.status is ResultStatus.FAILED
    assert result.code == "tv_unreachable"
    assert "não respondeu" in result.detail


async def test_wake_prewarms_the_session() -> None:
    handler, remote = make()
    result = await handler(Command("1", "tv.wake.v1", {}))
    assert result.status is ResultStatus.OK
    assert remote.connects == 1
    assert remote.sent == []


async def test_wake_reports_an_unreachable_tv() -> None:
    handler, remote = make()
    remote.connect_errors = [TvUnreachable("x") for _ in range(4)]
    result = await handler(Command("1", "tv.wake.v1", {}))
    assert (result.status, result.code) == (ResultStatus.FAILED, "tv_unreachable")


async def test_launching_a_link_uses_the_remote() -> None:
    handler, remote = make()
    target = {"kind": "link", "value": "https://www.youtube.com/watch?v=abc"}
    result = await handler(Command("1", "tv.app.launch.v1", {"target": target}))
    assert result.status is ResultStatus.OK
    assert remote.links == ["https://www.youtube.com/watch?v=abc"]


async def test_launching_by_package_is_unsupported_without_the_adb_channel() -> None:
    handler, remote = make()
    target = {"kind": "package", "value": "com.netflix.ninja"}
    result = await handler(Command("1", "tv.app.launch.v1", {"target": target}))
    assert result.status is ResultStatus.REJECTED
    assert result.code == UNSUPPORTED
    assert "ADB" in result.detail
    assert remote.connects == 0


@pytest.mark.parametrize(
    "value", ["intent://x#Intent;end", "file:///sdcard/a", "javascript:alert(1)"]
)
async def test_links_with_dangerous_schemes_are_refused(value: str) -> None:
    handler, remote = make()
    target = {"kind": "link", "value": value}
    result = await handler(Command("1", "tv.app.launch.v1", {"target": target}))
    assert result.status is ResultStatus.REJECTED
    assert result.code == LINK_SCHEME_BLOCKED
    assert remote.links == []


@pytest.mark.parametrize(
    "body",
    [{}, {"target": "x"}, {"target": {"kind": "link"}}, {"target": {"kind": "foo", "value": "a"}}],
)
async def test_malformed_launch_targets_are_rejected(body: dict[str, Any]) -> None:
    handler, remote = make()
    result = await handler(Command("1", "tv.app.launch.v1", body))
    assert result.status is ResultStatus.REJECTED
    assert remote.connects == 0


async def test_launch_link_reports_an_unreachable_tv() -> None:
    handler, remote = make()
    remote.connect_errors = [TvUnreachable("x") for _ in range(4)]
    target = {"kind": "link", "value": "https://exemplo.test/a"}
    result = await handler(Command("1", "tv.app.launch.v1", {"target": target}))
    assert (result.status, result.code) == (ResultStatus.FAILED, "tv_unreachable")


# --- publicação do estado ---------------------------------------------------------------------


def make_publisher() -> tuple[TvStatePublisher, FakeTransport]:
    transport = FakeTransport()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock())
    return TvStatePublisher(transport, envelopes), transport


async def test_publisher_sends_a_valid_state_message() -> None:
    publisher, transport = make_publisher()
    await publisher.announce(TvState("unknown", None, None, "hibernating"))
    (message,) = transport.sent
    assert message["type"] == "tv.state.v1"
    assert message["target"] == "api"
    assert message["body"] == {
        "power": "unknown",
        "volume": None,
        "app": None,
        "connection": "hibernating",
    }


async def test_publisher_keeps_only_the_latest_state_while_sending() -> None:
    publisher, transport = make_publisher()
    for volume in range(10, 15):
        publisher.publish(TvState("on", volume, None, "hot"))
    for _ in range(5):
        await asyncio.sleep(0)
    await publisher.aclose()
    volumes = [m["body"]["volume"] for m in transport.sent]
    assert volumes[-1] == 14
    assert len(volumes) < 5


async def test_publisher_drops_the_state_when_the_channel_is_down() -> None:
    publisher, transport = make_publisher()

    async def failing(message: dict[str, Any]) -> None:
        raise TransportError("o canal não está aberto")

    transport.send = failing  # type: ignore[method-assign]
    publisher.publish(TvState("on", 10, None, "hot"))
    for _ in range(3):
        await asyncio.sleep(0)
    await publisher.aclose()
    assert transport.sent == []


async def test_publisher_aclose_is_safe_without_a_task() -> None:
    publisher, _ = make_publisher()
    await publisher.aclose()
