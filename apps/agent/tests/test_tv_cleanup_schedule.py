"""Agendamento da limpeza automática só com relógio e ADB falsos."""

import asyncio

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvAdb
from uniover_agent.core.envelope_gate import EnvelopeGate
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.tv.cleanup import TvCleanup
from uniover_agent.core.tv.cleanup_schedule import TvCleanupScheduler, is_user_activity
from uniover_agent.ports import LaunchableApp

AGENT_ID = "pc-tv"
FOREGROUND = "com.example.video"


def make(
    foreground: str | None = FOREGROUND,
) -> tuple[TvCleanupScheduler, FakeTvAdb, FakeTransport, FakeClock]:
    clock = FakeClock()
    adb = FakeTvAdb([LaunchableApp(FOREGROUND, ".Main")])
    adb.running = frozenset({FOREGROUND})
    transport = FakeTransport()
    scheduler = TvCleanupScheduler(
        TvCleanup(adb, clock, allow_app_closing=False),
        adb,
        clock,
        transport,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        lambda: foreground,
    )
    return scheduler, adb, transport, clock


async def test_first_responsive_session_of_the_day_runs_a_light_cleanup_without_stopping_apps() -> (
    None
):
    scheduler, adb, transport, _ = make()
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    assert len(transport.sent) == 1
    assert transport.sent[0]["body"]["kind"] == "light"
    assert not any(
        step == "kill-background" or step.startswith("force-stop:") for step in adb.cleanup_log
    )


async def test_slow_remote_session_schedules_light_cleanup_after_it_opens() -> None:
    scheduler, _, transport, _ = make()
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(10.1)

    await scheduler.run_pending()

    assert transport.sent[0]["body"]["kind"] == "light"
    assert transport.sent[0]["body"]["sessionOpenMs"] == 10100


async def test_deep_cleanup_is_skipped_when_media_is_playing() -> None:
    scheduler, adb, transport, _ = make()
    scheduler.configure(False, True, 500, True)
    adb.media_playing_value = True
    scheduler.note_session_opened(11)

    await scheduler.run_pending()

    body = transport.sent[-1]["body"]
    assert body["kind"] == "deep"
    assert body["result"] == "skipped"
    assert body["reason"] == "media-in-use"


async def test_deep_cleanup_records_recent_command_before_waiting_the_quiet_window() -> None:
    scheduler, _, transport, _ = make(foreground=None)
    scheduler.configure(False, True, 500, True)
    scheduler.note_session_opened(11)
    scheduler.note_command()

    await scheduler.run_pending()

    assert [m["body"].get("reason") for m in transport.sent] == ["recent-command"]
    # Nada dormiu dentro do ciclo; o alarme acorda o temporizador e, passada a janela quieta, a
    # TV segue ociosa e a profunda roda de verdade (sem repetir a linha de "pulada").
    for _ in range(3):
        await asyncio.sleep(0)
    await scheduler.run_pending()
    assert [m["body"]["result"] for m in transport.sent] == ["skipped", "completed"]


async def test_deep_cleanup_without_the_tv_option_is_skipped_and_touches_no_app() -> None:
    scheduler, adb, transport, _ = make()
    scheduler.configure(False, True, 500)  # a opção por TV de fechar apps fica desligada
    scheduler.note_session_opened(11)

    await scheduler.run_pending()

    body = transport.sent[-1]["body"]
    assert (body["kind"], body["result"], body["reason"]) == (
        "deep",
        "skipped",
        "app-closing-disabled",
    )
    assert not any(
        step in {"go-home", "kill-background"} or step.startswith("force-stop:")
        for step in adb.cleanup_log
    )


async def test_deep_cleanup_with_the_tv_option_on_closes_apps_when_nobody_is_using_the_tv() -> None:
    scheduler, adb, transport, clock = make(foreground=None)
    scheduler.configure(False, True, 500, True)
    adb.media_playing_value = False
    # Passou da janela sem comando do usuário.
    clock.advance(20 * 60)
    scheduler.note_session_opened(11)

    await scheduler.run_pending()

    body = transport.sent[-1]["body"]
    assert (body["kind"], body["result"]) == ("deep", "completed")
    assert "kill-background" in adb.cleanup_log


async def test_a_new_configuration_without_the_option_turns_app_closing_off_again() -> None:
    scheduler, adb, transport, _ = make()
    scheduler.configure(True, False, 160, True)
    scheduler.configure(True, False, 160, False)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    assert transport.sent[0]["body"]["kind"] == "light"
    assert not any(
        step.startswith("force-stop:") or step == "kill-background" for step in adb.cleanup_log
    )


def test_only_messages_that_mean_somebody_is_using_the_tv_open_the_quiet_window() -> None:
    assert is_user_activity("tv.key.v3")
    assert is_user_activity("tv.text.v1")
    assert is_user_activity("tv.app.launch.v1")
    for ignored in (
        "api.keepalive.v1",
        "tv.cleanup.config.v1",
        "tv.cleanup.v1",
        "agent.logs.request.v1",
    ):
        assert not is_user_activity(ignored)


async def test_a_keepalive_never_moves_the_quiet_window() -> None:
    scheduler, _, transport, clock = make(foreground=None)
    scheduler.configure(False, True, 500, True)
    scheduler.note_session_opened(11)
    clock.advance(20 * 60)

    scheduler.note_message("api.keepalive.v1")  # chega a cada poucos segundos
    await scheduler.run_pending()

    assert [m["body"]["result"] for m in transport.sent] == ["completed"]


async def test_a_deep_cleanup_waiting_for_quiet_does_not_hold_back_the_light_one() -> None:
    scheduler, _, transport, _ = make(foreground=None)
    scheduler.configure(True, True, 500, True)
    scheduler.note_session_opened(11)  # sessão lenta: pede a leve e a profunda
    scheduler.note_command()

    await scheduler.run_pending()

    sent = [(m["body"]["kind"], m["body"]["result"]) for m in transport.sent]
    assert sent == [("light", "completed"), ("deep", "skipped")]


async def test_cleanup_waits_while_focus_is_active_and_runs_after_it_releases() -> None:
    clock = FakeClock()
    adb = FakeTvAdb([LaunchableApp(FOREGROUND, ".Main")])
    transport = FakeTransport()
    focused = [True]
    scheduler = TvCleanupScheduler(
        TvCleanup(adb, clock, allow_app_closing=False),
        adb,
        clock,
        transport,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        lambda: FOREGROUND,
        lambda: focused[0],
    )
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()
    assert transport.sent == []

    focused[0] = False
    scheduler.resume()
    await scheduler.run_pending()
    assert transport.sent[0]["body"]["kind"] == "light"
