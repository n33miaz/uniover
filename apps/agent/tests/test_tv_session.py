import asyncio

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvChannel, FakeTvRemote
from uniover_agent.core import (
    TV_NOT_PAIRED,
    TV_UNREACHABLE,
    SessionState,
    TvSessionError,
    TvSessionManager,
    TvState,
)
from uniover_agent.ports import TvNotPaired, TvPortClosed, TvUnreachable


def state_of(manager: TvSessionManager) -> SessionState:
    # Função à parte: o mypy estreita `manager.state` depois de um `assert` e acusaria o próximo.
    return manager.state


class Rig:
    """Gerenciador com relógio e controle falsos, mais tudo o que ele publicou."""

    def __init__(self, **kwargs: float) -> None:
        self.clock = FakeClock()
        self.remote = FakeTvRemote()
        self.manager = TvSessionManager(self.clock, self.remote, **kwargs)  # type: ignore[arg-type]
        self.states: list[TvState] = []
        self.repairs = 0
        self.manager.subscribe(self.states.append)
        self.manager.on_needs_repair(self._repair)

    def _repair(self) -> None:
        self.repairs += 1


async def test_first_command_opens_the_session_and_sends_the_key() -> None:
    rig = Rig()
    assert state_of(rig.manager) is SessionState.HIBERNATING
    await rig.manager.send_key("HOME")
    assert state_of(rig.manager) is SessionState.HOT
    assert rig.remote.connects == 1
    assert rig.remote.sent == [("HOME", "SHORT")]
    assert rig.manager.last_warmup_seconds == 0.0


async def test_hibernates_at_300_seconds_and_not_before() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.clock.advance(299.9)
    assert await rig.manager.hibernate_if_idle() is False
    assert state_of(rig.manager) is SessionState.HOT
    assert rig.remote.connected

    rig.clock.advance(0.1)
    assert await rig.manager.hibernate_if_idle() is True
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert not rig.remote.connected
    assert rig.remote.disconnects == 1


async def test_kept_hot_session_does_not_hibernate_until_focus_releases_it() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.manager.set_keep_hot(True)
    rig.clock.advance(600)
    assert await rig.manager.hibernate_if_idle() is False

    rig.manager.set_keep_hot(False)
    assert await rig.manager.hibernate_if_idle() is True


async def test_default_hibernation_is_five_minutes() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.clock.advance(299)
    assert await rig.manager.hibernate_if_idle() is False


async def test_wake_renews_the_idle_clock() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.clock.advance(250)
    await rig.manager.wake()  # o app segue aberto: renova
    rig.clock.advance(250)
    assert await rig.manager.hibernate_if_idle() is False
    rig.clock.advance(50)
    assert await rig.manager.hibernate_if_idle() is True
    assert rig.remote.connects == 1


async def test_a_command_renews_the_idle_clock() -> None:
    rig = Rig()
    await rig.manager.send_key("UP")
    rig.clock.advance(200)
    await rig.manager.send_key("DOWN")
    rig.clock.advance(200)
    assert await rig.manager.hibernate_if_idle() is False


async def test_touch_renews_the_idle_clock() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.clock.advance(290)
    rig.manager.touch()
    rig.clock.advance(290)
    assert await rig.manager.hibernate_if_idle() is False


async def test_custom_hibernate_time_is_respected() -> None:
    rig = Rig(hibernate_seconds=30)
    await rig.manager.wake()
    rig.clock.advance(30)
    assert await rig.manager.hibernate_if_idle() is True


async def test_first_command_after_hibernation_reconnects() -> None:
    rig = Rig()
    await rig.manager.send_key("HOME")
    rig.clock.advance(300)
    await rig.manager.hibernate_if_idle()
    assert not rig.remote.connected

    await rig.manager.send_key("BACK")
    assert rig.remote.connects == 2
    assert state_of(rig.manager) is SessionState.HOT
    assert rig.remote.keys == ["HOME", "BACK"]


async def test_wake_prewarms_before_the_first_key() -> None:
    rig = Rig()
    await rig.manager.wake()
    assert rig.remote.connects == 1
    assert rig.remote.keys == []
    assert rig.manager.snapshot().connection == "hot"


async def test_hibernating_never_claims_the_tv_is_off() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.remote.push_power(True)
    assert rig.manager.snapshot().power == "on"
    rig.remote.push_power(False)
    assert rig.manager.snapshot().power == "off"

    rig.clock.advance(300)
    await rig.manager.hibernate_if_idle()
    snapshot = rig.manager.snapshot()
    assert snapshot.connection == "hibernating"
    assert snapshot.power == "unknown"
    assert rig.states[-1] == snapshot


async def test_state_is_published_on_every_change_without_repeats() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.remote.push_power(True)
    rig.remote.push_power(True)  # igual: não publica de novo
    rig.remote.push_volume(35)
    rig.remote.push_app("com.netflix.ninja")
    rig.clock.advance(300)
    await rig.manager.hibernate_if_idle()

    assert rig.states == [
        TvState("unknown", None, None, "hot"),
        TvState("on", None, None, "hot"),
        TvState("on", 35, None, "hot"),
        TvState("on", 35, "com.netflix.ninja", "hot"),
        # Dormindo: o poder volta a "unknown"; volume e app ficam como o último valor conhecido.
        TvState("unknown", 35, "com.netflix.ninja", "hibernating"),
    ]


async def test_pushed_values_are_clamped_and_empty_app_becomes_none() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.remote.push_volume(250)
    assert rig.manager.snapshot().volume == 100
    rig.remote.push_app("com.exemplo")
    rig.remote.push_app("")
    assert rig.manager.snapshot().app is None


async def test_backoff_is_one_two_four_seconds_then_tv_unreachable_without_looping() -> None:
    rig = Rig()
    rig.remote.connect_errors = [TvUnreachable("sem resposta") for _ in range(4)]
    with pytest.raises(TvSessionError) as caught:
        await rig.manager.send_key("HOME")
    assert caught.value.code == TV_UNREACHABLE
    assert rig.clock.sleeps == [1.0, 2.0, 4.0]
    assert rig.remote.connects == 4
    # Sem resposta nenhuma é a TV em standby (sem rede): não é serviço morto, então não pede reparo.
    assert rig.repairs == 0
    assert rig.remote.keys == []
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert rig.manager.snapshot().connection == "disconnected"
    # Nada continua tentando sozinho depois de desistir.
    await asyncio.sleep(0)
    assert rig.remote.connects == 4


async def test_recovers_when_the_tv_answers_within_the_backoff() -> None:
    rig = Rig()
    rig.remote.connect_errors = [TvUnreachable("a"), TvUnreachable("b")]
    await rig.manager.send_key("HOME")
    assert rig.clock.sleeps == [1.0, 2.0]
    assert rig.remote.connects == 3
    assert rig.remote.keys == ["HOME"]
    assert rig.manager.last_warmup_seconds == 3.0


async def test_pairing_problem_fails_at_once_with_its_own_code() -> None:
    rig = Rig()
    rig.remote.connect_errors = [TvNotPaired("par ausente")]
    with pytest.raises(TvSessionError) as caught:
        await rig.manager.wake()
    assert caught.value.code == TV_NOT_PAIRED
    assert "tv-pair" in caught.value.message
    assert rig.clock.sleeps == []
    assert rig.remote.connects == 1
    assert rig.repairs == 0


async def test_needs_repair_is_signaled_once_on_the_first_failed_attempt() -> None:
    rig = Rig()
    rig.remote.connect_errors = [TvPortClosed("a"), TvPortClosed("b"), TvPortClosed("c")]
    await rig.manager.wake()
    assert rig.repairs == 1  # três falhas, um só aviso: o vigia não é inundado

    rig.remote.connect_errors = [TvPortClosed("d") for _ in range(4)]
    rig.clock.advance(300)
    await rig.manager.hibernate_if_idle()
    with pytest.raises(TvSessionError):
        await rig.manager.wake()
    assert rig.repairs == 2


async def test_a_failing_repair_callback_does_not_break_the_command() -> None:
    rig = Rig()

    def broken() -> None:
        raise RuntimeError("falha do vigia")

    rig.manager.on_needs_repair(broken)
    rig.remote.connect_errors = [TvPortClosed("a")]
    await rig.manager.send_key("HOME")
    assert rig.remote.keys == ["HOME"]


async def test_repairing_state_refuses_commands_with_a_hint_and_opens_nothing() -> None:
    rig = Rig()
    rig.manager.mark_repairing()
    assert state_of(rig.manager) is SessionState.REPAIRING
    assert rig.manager.snapshot().connection == "disconnected"
    with pytest.raises(TvSessionError) as caught:
        await rig.manager.send_key("HOME")
    assert caught.value.code == TV_UNREACHABLE
    assert "religando o controle" in caught.value.message
    with pytest.raises(TvSessionError):
        await rig.manager.wake()
    assert rig.remote.connects == 0


async def test_clear_repairing_goes_back_to_sleep_and_the_next_command_reopens() -> None:
    rig = Rig()
    rig.manager.mark_repairing()
    rig.manager.mark_repairing()  # repetir não muda nada
    rig.manager.clear_repairing()
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert rig.manager.snapshot().connection == "hibernating"
    await rig.manager.send_key("HOME")
    assert state_of(rig.manager) is SessionState.HOT


async def test_clear_repairing_outside_repair_is_a_noop() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.manager.clear_repairing()
    assert state_of(rig.manager) is SessionState.HOT


async def test_repairing_taking_over_during_backoff_stops_the_attempts() -> None:
    rig = Rig()
    rig.remote.connect_errors = [TvPortClosed("a"), TvPortClosed("b")]
    rig.manager.on_needs_repair(rig.manager.mark_repairing)  # o vigia assume ao ser avisado
    with pytest.raises(TvSessionError) as caught:
        await rig.manager.send_key("HOME")
    assert "religando" in caught.value.message
    assert rig.remote.connects == 1
    assert state_of(rig.manager) is SessionState.REPAIRING


async def test_only_one_owner_opens_the_connection() -> None:
    rig = Rig()
    await asyncio.gather(*(rig.manager.send_key("VOLUME_UP") for _ in range(6)))
    assert rig.remote.connects == 1
    assert len(rig.remote.keys) == 6


async def test_idle_session_that_drops_goes_back_to_sleep_without_reconnecting() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.clock.advance(400)
    rig.remote.drop()
    await rig.manager.settle()
    assert rig.remote.connects == 1
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert rig.manager.snapshot().connection == "hibernating"


async def test_active_session_that_drops_is_reopened_in_the_background() -> None:
    rig = Rig()
    await rig.manager.send_key("HOME")
    rig.remote.drop()
    assert rig.manager.snapshot().connection == "disconnected"
    await rig.manager.settle()
    assert rig.remote.connects == 2
    assert state_of(rig.manager) is SessionState.HOT
    assert rig.manager.snapshot().connection == "hot"


async def test_failed_background_recovery_gives_up_and_signals_repair() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.remote.connect_errors = [TvPortClosed("x") for _ in range(4)]
    rig.remote.drop()
    await rig.manager.settle()
    assert rig.remote.connects == 5
    assert rig.repairs == 1
    assert rig.manager.snapshot().connection == "disconnected"


async def test_available_true_is_ignored() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.manager._on_available(True)
    assert state_of(rig.manager) is SessionState.HOT


class FlakyRemote(FakeTvRemote):
    """Perde o canal uma vez no momento do envio (a tecla é descartada)."""

    def __init__(self) -> None:
        super().__init__()
        self.failures = 1

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if self.failures:
            self.failures -= 1
            self._connected = False
            raise TvUnreachable("canal fechado")
        await super().send_key(key, direction)


async def test_key_is_retried_once_when_the_channel_drops_during_the_send() -> None:
    clock, remote = FakeClock(), FlakyRemote()
    manager = TvSessionManager(clock, remote)
    await manager.send_key("HOME")
    assert remote.keys == ["HOME"]
    assert remote.connects == 2


async def test_key_fails_with_tv_unreachable_when_the_retry_also_fails() -> None:
    clock, remote = FakeClock(), FlakyRemote()
    remote.failures = 2
    manager = TvSessionManager(clock, remote)
    with pytest.raises(TvSessionError) as caught:
        await manager.send_key("HOME")
    assert caught.value.code == TV_UNREACHABLE
    await manager.settle()


async def test_link_goes_through_the_session() -> None:
    rig = Rig()
    await rig.manager.launch_link("https://www.youtube.com/watch?v=x")
    assert rig.remote.links == ["https://www.youtube.com/watch?v=x"]


async def test_extra_channels_open_and_close_with_the_session() -> None:
    rig = Rig()
    adb = FakeTvChannel()
    rig.manager.add_channel(adb)
    await rig.manager.wake()
    assert adb.connected
    rig.clock.advance(300)
    await rig.manager.hibernate_if_idle()
    assert adb.disconnects == 1
    assert not adb.connected


async def test_optional_channel_failure_does_not_block_the_remote() -> None:
    rig = Rig()
    adb = FakeTvChannel()
    adb.connect_error = TvUnreachable("adb fora")
    rig.manager.add_channel(adb)
    await rig.manager.send_key("HOME")
    assert state_of(rig.manager) is SessionState.HOT
    assert rig.remote.keys == ["HOME"]


async def test_required_channel_failure_counts_as_a_failed_attempt() -> None:
    rig = Rig()
    adb = FakeTvChannel()
    adb.connect_error = TvUnreachable("adb fora")
    rig.manager.add_channel(adb, required=True)
    with pytest.raises(TvSessionError):
        await rig.manager.wake()
    assert rig.remote.connects == 4
    # O canal já aberto (o remoto) é fechado a cada tentativa que falha.
    assert not rig.remote.connected


async def test_watch_loop_hibernates_an_idle_session() -> None:
    rig = Rig()
    await rig.manager.wake()
    watcher = asyncio.create_task(rig.manager.watch())
    for _ in range(300):
        await asyncio.sleep(0)
    watcher.cancel()
    await asyncio.gather(watcher, return_exceptions=True)
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert rig.clock.monotonic() >= 300


async def test_aclose_closes_the_channels() -> None:
    rig = Rig()
    await rig.manager.wake()
    await rig.manager.aclose()
    assert not rig.remote.connected
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert rig.manager.snapshot().connection == "hibernating"


async def test_aclose_keeps_the_repairing_state() -> None:
    rig = Rig()
    rig.manager.mark_repairing()
    await rig.manager.aclose()
    assert state_of(rig.manager) is SessionState.REPAIRING


async def test_a_listener_that_raises_does_not_stop_the_others() -> None:
    rig = Rig()

    def broken(state: TvState) -> None:
        raise RuntimeError("ouvinte quebrado")

    rig.manager.subscribe(broken)
    await rig.manager.wake()
    assert rig.states[-1].connection == "hot"


async def test_unexpected_error_while_opening_does_not_leave_the_session_warming() -> None:
    rig = Rig()
    rig.remote.connect_errors = [RuntimeError("defeito inesperado")]
    with pytest.raises(RuntimeError):
        await rig.manager.wake()
    assert state_of(rig.manager) is SessionState.HIBERNATING
    await rig.manager.wake()  # a próxima tentativa segue normalmente
    assert state_of(rig.manager) is SessionState.HOT
