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
    TextReconciler,
    TvSessionManager,
    TvState,
    TvStatePublisher,
    tv_app_launch_handler,
    tv_key_handler,
    tv_text_handler,
    tv_wake_handler,
)
from uniover_agent.core.tv.handlers import KEY_BLOCKED, LINK_SCHEME_BLOCKED, UNSUPPORTED
from uniover_agent.ports import TransportError, TvUnreachable

from .support import AGENT_ID


def make() -> tuple[HandleCommand, FakeTvRemote]:
    handler, remote, _ = make_with_clock()
    return handler, remote


def make_with_clock() -> tuple[HandleCommand, FakeTvRemote, FakeClock]:
    clock, remote = FakeClock(), FakeTvRemote()
    session = TvSessionManager(clock, remote)
    keys = tv_key_handler(session)
    handler = HandleCommand(
        {
            "tv.key.v1": keys,
            "tv.key.v2": keys,
            "tv.text.v1": tv_text_handler(session),
            "tv.wake.v1": tv_wake_handler(session),
            "tv.app.launch.v1": tv_app_launch_handler(session),
        },
        clock,
    )
    return handler, remote, clock


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


@pytest.mark.parametrize("message_type", ["tv.key.v1", "tv.key.v2"])
async def test_power_key_goes_to_the_tv_by_default(message_type: str) -> None:
    handler, remote = make()
    result = await handler(Command("1", message_type, {"key": "POWER"}))
    assert result.status is ResultStatus.OK
    assert remote.sent == [("POWER", "SHORT")]


async def test_a_blocked_key_is_refused_and_nothing_is_sent_to_the_tv() -> None:
    clock, remote = FakeClock(), FakeTvRemote()
    keys = tv_key_handler(TvSessionManager(clock, remote), blocked_keys=frozenset({"POWER"}))
    for message_type in ("tv.key.v1", "tv.key.v2"):
        result = await keys(Command("1", message_type, {"key": "POWER"}))
        assert result.status is ResultStatus.REJECTED
        assert result.code == KEY_BLOCKED
        assert "POWER" in result.detail
    # Nem a sessão foi aberta: o pedido morre antes de tocar na TV.
    assert remote.connects == 0
    assert remote.sent == []


async def test_blocking_one_key_leaves_the_others_alone() -> None:
    clock, remote = FakeClock(), FakeTvRemote()
    keys = tv_key_handler(TvSessionManager(clock, remote), blocked_keys=frozenset({"MUTE"}))
    muted = await keys(Command("1", "tv.key.v1", {"key": "MUTE"}))
    power = await keys(Command("2", "tv.key.v1", {"key": "POWER"}))
    assert (muted.status, muted.code) == (ResultStatus.REJECTED, KEY_BLOCKED)
    assert power.status is ResultStatus.OK
    assert remote.sent == [("POWER", "SHORT")]


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


# --- texto em tempo real ------------------------------------------------------------------------


class FlakyTextRemote(FakeTvRemote):
    """O primeiro envio de texto falha com o canal ainda marcado como aberto (queda silenciosa)."""

    def __init__(self) -> None:
        super().__init__()
        self.attempts = 0

    async def send_text(self, text: str) -> None:
        self.attempts += 1
        if self.attempts == 1:
            raise TvUnreachable("a conexão com a TV fechou")
        await super().send_text(text)


async def test_text_reaches_the_remote_and_opens_the_session_on_the_first_command() -> None:
    handler, remote = make()
    assert remote.connects == 0
    result = await handler(Command("1", "tv.text.v1", {"text": "matrix"}))
    assert result.status is ResultStatus.OK
    assert remote.connects == 1
    assert remote.texts == ["matrix"]
    # Texto não é tecla: nenhuma tecla vai junto.
    assert remote.sent == []


async def test_each_text_sends_only_what_was_added() -> None:
    handler, remote = make()
    for index, text in enumerate(["m", "ma", "mat", "matrix"]):
        result = await handler(Command(str(index), "tv.text.v1", {"text": text}))
        assert result.status is ResultStatus.OK
    # Nada de reenviar o campo inteiro (a TV insere, então duplicaria): só o acréscimo.
    assert remote.texts == ["m", "a", "t", "rix"]
    assert remote.sent == []
    assert remote.connects == 1


async def test_text_renews_the_hibernation_clock() -> None:
    clock, remote = FakeClock(), FakeTvRemote()
    session = TvSessionManager(clock, remote, hibernate_seconds=300)
    handler = tv_text_handler(session)
    await handler(Command("1", "tv.text.v1", {"text": "a"}))
    clock.advance(200)
    await handler(Command("2", "tv.text.v1", {"text": "ab"}))
    clock.advance(200)
    # 400 s desde o primeiro texto, mas só 200 s desde o segundo: ainda não é hora de dormir.
    assert not await session.hibernate_if_idle()
    clock.advance(100)
    assert await session.hibernate_if_idle()


async def test_text_after_hibernation_reconnects() -> None:
    clock, remote = FakeClock(), FakeTvRemote()
    session = TvSessionManager(clock, remote, hibernate_seconds=300)
    handler = tv_text_handler(
        session, reconciler=TextReconciler(session, monotonic=clock.monotonic)
    )
    await handler(Command("1", "tv.text.v1", {"text": "a"}))
    clock.advance(301)
    assert await session.hibernate_if_idle()
    assert not remote.connected
    result = await handler(Command("2", "tv.text.v1", {"text": "ab"}))
    assert result.status is ResultStatus.OK
    assert remote.connects == 2
    # Mesmo depois da pausa longa, "ab" continua "a": só o "b" vai (sem duplicar).
    assert remote.texts == ["a", "b"]
    assert remote.sent == []


async def test_text_to_an_unreachable_tv_is_reported_with_its_code() -> None:
    handler, remote = make()
    remote.connect_errors = [TvUnreachable("x") for _ in range(4)]
    result = await handler(Command("1", "tv.text.v1", {"text": "oi"}))
    assert (result.status, result.code) == (ResultStatus.FAILED, "tv_unreachable")
    assert remote.texts == []


async def test_text_is_resent_on_a_new_session_when_the_channel_dropped_unnoticed() -> None:
    remote = FlakyTextRemote()
    handler = tv_text_handler(TvSessionManager(FakeClock(), remote))
    result = await handler(Command("1", "tv.text.v1", {"text": "oi"}))
    assert result.status is ResultStatus.OK
    assert remote.texts == ["oi"]
    assert remote.attempts == 2
    assert remote.connects == 2


async def test_empty_text_is_ok_but_never_sent_to_the_tv() -> None:
    handler, remote = make()
    result = await handler(Command("1", "tv.text.v1", {"text": ""}))
    assert result.status is ResultStatus.OK
    assert remote.texts == []
    assert remote.connects == 0


@pytest.mark.parametrize("body", [{}, {"text": 5}, {"text": None}])
async def test_text_without_a_string_is_rejected(body: dict[str, Any]) -> None:
    handler, remote = make()
    result = await handler(Command("1", "tv.text.v1", body))
    assert result.status is ResultStatus.REJECTED
    assert remote.connects == 0


async def test_texts_arriving_together_are_sent_in_order_and_the_last_wins() -> None:
    clock, remote = FakeClock(), FakeTvRemote()
    session = TvSessionManager(clock, remote)
    reconciler = TextReconciler(session, monotonic=clock.monotonic)
    handler = tv_text_handler(session, reconciler=reconciler)
    commands = [
        Command(str(index), "tv.text.v1", {"text": text})
        for index, text in enumerate(["a", "ab", "abc"])
    ]
    results = await asyncio.gather(*(handler(command) for command in commands))
    assert [r.status for r in results] == [ResultStatus.OK] * 3
    # O intermediário que ainda esperava a vez é descartado; o diff é contra o último texto pedido,
    # então o campo termina com "abc" sem nada duplicado.
    assert "".join(remote.texts) == "abc"
    assert reconciler.last_text == "abc"
    assert remote.connects == 1


async def test_a_failed_text_does_not_block_the_next_one() -> None:
    handler, remote, clock = make_with_clock()
    remote.connect_errors = [TvUnreachable("x") for _ in range(4)]
    failed = await handler(Command("1", "tv.text.v1", {"text": "a"}))
    assert failed.status is ResultStatus.FAILED
    # A TV ficou offline: um pedido logo em seguida falha na hora, sem tocar na TV.
    too_soon = await handler(Command("2", "tv.text.v1", {"text": "a"}))
    assert (too_soon.status, remote.connects) == (ResultStatus.FAILED, 4)
    clock.advance(6)  # passada a espera mínima de quem está esperando a TV, ela é tentada de novo
    recovered = await handler(Command("3", "tv.text.v1", {"text": "ab"}))
    assert recovered.status is ResultStatus.OK
    assert remote.texts == ["ab"]


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
