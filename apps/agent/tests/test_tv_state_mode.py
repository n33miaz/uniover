"""O modo da TV (`off`, `standby`, `sleep`) e a presença que o agente observa."""

import asyncio
from pathlib import Path
from typing import Any

import pytest

from tests.support_livre import FakeAndroid, FakeApkSource
from tests.test_tv_relocator import OLD_HOST, TV_INFO, Lan, settings_for_old_host
from tests.test_tv_watchdog_composition import probe_answers
from uniover_agent.adapters import tv_samsung
from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvRemote
from uniover_agent.adapters.tv_discovery import PortState
from uniover_agent.adapters.tv_samsung import SamsungTvDriver, power_mode_from_info
from uniover_agent.composition.connection import build_relocator
from uniover_agent.config import Settings
from uniover_agent.core import (
    EnvelopeFactory,
    EnvelopeGate,
    TvSessionError,
    TvSessionManager,
    TvState,
    TvStatePublisher,
)
from uniover_agent.core.api_features import TV_STATE_MODE_FEATURE, WAKING_FEATURE, ApiFeatures
from uniover_agent.core.domain import TvMode
from uniover_agent.core.tv.livre import PACKAGE, LivreError, LivreStateFile, PhotoStaging, TvLivre
from uniover_agent.core.tv.presence import TvPresenceStatus
from uniover_agent.ports import TvNotPaired, TvUnreachable

AGENT_ID = "pc-casa"


class Rig:
    def __init__(self, remote: FakeTvRemote | None = None) -> None:
        self.clock = FakeClock()
        self.remote = remote or FakeTvRemote()
        self.network = True
        self.manager = TvSessionManager(
            self.clock, self.remote, liveness=self._liveness, hibernate_seconds=100_000
        )
        self.states: list[TvState] = []
        self.manager.subscribe(self.states.append)

    async def _liveness(self) -> bool:
        return self.network

    def status(self) -> TvPresenceStatus:
        presence = self.manager.presence
        assert presence is not None
        return presence.status

    def mode(self) -> TvMode | None:
        return self.manager.snapshot().mode


class StandbyRemote(FakeTvRemote):
    power_mode: TvMode | None = "standby"


async def failed_open(rig: Rig) -> None:
    with pytest.raises(TvSessionError):
        await rig.manager.wake()


async def test_nothing_is_reported_before_the_first_probe() -> None:
    assert Rig().manager.presence is None


async def test_an_open_session_is_ready_without_a_mode() -> None:
    rig = Rig()
    await rig.manager.wake()
    assert rig.status() == "ready"
    assert rig.mode() is None
    assert rig.manager.presence is not None
    assert rig.manager.presence.at.tzinfo is not None
    assert rig.manager.presence.reason


async def test_a_tv_off_the_network_is_unreachable_and_has_no_mode() -> None:
    rig = Rig()
    rig.network = False
    await failed_open(rig)
    assert rig.status() == "unreachable"
    assert rig.manager.snapshot().connection == "disconnected"
    assert rig.mode() is None


async def test_a_tv_on_the_network_that_does_not_answer_is_unresponsive() -> None:
    rig = Rig()
    rig.remote.connect_errors = [TvUnreachable("sem resposta") for _ in range(4)]
    await failed_open(rig)
    assert rig.status() == "unresponsive"
    assert rig.mode() is None


async def test_each_failed_probe_cycle_reports_the_current_connection() -> None:
    rig = Rig()
    rig.network = False
    await failed_open(rig)
    rig.states.clear()
    rig.clock.advance(120)
    await failed_open(rig)
    assert [state.connection for state in rig.states] == ["disconnected"]


async def test_a_tv_asking_to_pair_is_unresponsive() -> None:
    rig = Rig()
    rig.remote.connect_errors = [TvNotPaired("sem par")]
    await failed_open(rig)
    assert rig.status() == "unresponsive"
    assert rig.mode() is None

    rig.manager.note_probe("standby")
    assert rig.states[-1].connection == "not_paired"
    assert rig.states[-1].mode == "standby"
    assert rig.status() == "standby"
    rig.manager.note_probe("reachable")
    assert rig.mode() is None
    assert rig.status() == "unresponsive"


async def test_a_dropped_channel_is_unresponsive() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.remote.drop()
    assert rig.status() == "unresponsive"
    assert rig.mode() is None
    await rig.manager.settle()


async def test_a_tv_that_says_it_is_off_reports_the_mode_and_back() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.remote.push_power(False)
    assert rig.states[-1].mode == "off"
    assert rig.status() == "off"
    rig.remote.push_power(True)
    assert rig.states[-1].mode is None
    assert rig.status() == "ready"


async def test_the_driver_can_say_the_tv_is_in_standby() -> None:
    rig = Rig(StandbyRemote())
    await rig.manager.wake()
    rig.remote.push_power(False)
    assert rig.states[-1].mode == "standby"
    assert rig.status() == "standby"


async def test_a_power_reading_from_an_earlier_connection_is_not_a_mode() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.remote.push_power(False)
    rig.clock.advance(100_000)
    await rig.manager.hibernate_if_idle()
    assert rig.mode() is None
    await rig.manager.wake()
    assert rig.mode() is None
    assert rig.manager.snapshot().power == "unknown"
    assert rig.status() == "ready"


async def test_network_loss_after_power_key_does_not_confirm_power_off() -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.remote.push_power(True)
    rig.clock.advance(1)
    await rig.manager.send_key("POWER")
    rig.network = False
    rig.remote.drop()
    await rig.manager.settle()
    assert rig.status() == "unreachable"
    assert rig.manager.snapshot().connection == "disconnected"
    assert rig.mode() is None

    # A TV voltou e caiu de novo sem ninguém pedir: aí é só falta de alcance.
    rig.network = True
    rig.clock.advance(120)
    await rig.manager.wake()
    rig.network = False
    rig.remote.drop()
    await rig.manager.settle()
    assert rig.status() == "unreachable"


async def test_leaving_the_network_after_a_power_key_without_a_power_reading_is_unreachable() -> (
    None
):
    rig = Rig()
    await rig.manager.wake()
    await rig.manager.send_key("POWER")
    rig.network = False
    rig.remote.drop()
    await rig.manager.settle()
    assert rig.status() == "unreachable"
    assert rig.mode() is None


# --- Modo Dormir ---------------------------------------------------------------------------------


async def asleep(minutes: int | None = None) -> Rig:
    rig = Rig()
    await rig.manager.wake()
    rig.manager.sleep_screen_opened(PACKAGE, minutes)
    return rig


async def test_the_sleep_screen_is_reported_as_sleep() -> None:
    rig = await asleep()
    assert rig.states[-1].mode == "sleep"
    assert rig.status() == "sleep"
    rig.remote.push_app(PACKAGE)
    rig.remote.push_power(True)
    await rig.manager.send_key("VOLUME_UP")
    await rig.manager.send_key("PLAY_PAUSE")
    assert rig.mode() == "sleep"
    await rig.manager.settle()


async def test_the_sleep_screen_opened_by_adb_is_reported_while_the_remote_hibernates() -> None:
    rig = Rig()
    rig.manager.sleep_screen_opened(PACKAGE, None)
    assert rig.states[-1].connection == "hibernating"
    assert rig.states[-1].mode == "sleep"
    assert rig.status() == "sleep"
    await rig.manager.wake()
    assert rig.mode() == "sleep"


async def test_sleep_confirmed_by_adb_preserves_a_failed_remote_connection() -> None:
    rig = Rig()
    rig.network = False
    await failed_open(rig)
    rig.manager.sleep_screen_opened(PACKAGE, None)
    assert rig.states[-1].connection == "disconnected"
    assert rig.states[-1].mode == "sleep"
    rig.manager.note_probe("unreachable")
    assert rig.states[-1].mode is None
    assert rig.status() == "unreachable"


@pytest.mark.parametrize("key", ["HOME", "OK", "BACK", "POWER"])
async def test_a_key_that_wakes_the_screen_ends_sleep(key: str) -> None:
    rig = await asleep()
    rig.clock.advance(1)
    await rig.manager.send_key(key)
    assert rig.mode() is None
    assert rig.states[-1].mode is None


async def test_text_and_links_end_sleep() -> None:
    rig = await asleep()
    await rig.manager.send_text("a")
    assert rig.states[-1].mode is None

    rig.manager.sleep_screen_opened(PACKAGE, None)
    await rig.manager.launch_link("https://example.com")
    assert rig.states[-1].mode is None


async def test_another_app_or_a_power_off_ends_sleep() -> None:
    rig = await asleep()
    rig.remote.push_app("com.netflix.ninja")
    assert rig.states[-1].mode is None

    rig.manager.sleep_screen_opened(PACKAGE, None)
    rig.remote.push_power(False)
    assert rig.states[-1].mode == "off"
    rig.remote.push_power(True)
    assert rig.states[-1].mode is None


async def test_hibernating_the_control_keeps_the_sleep_screen() -> None:
    rig = await asleep()
    rig.clock.advance(100_000)
    await rig.manager.hibernate_if_idle()
    assert rig.states[-1].mode == "sleep"
    await rig.manager.wake()
    assert rig.mode() == "sleep"


async def test_the_sleep_time_limit_is_published_by_the_watch_loop() -> None:
    rig = await asleep(minutes=1)
    rig.clock.advance(59)
    assert rig.mode() == "sleep"
    runner = asyncio.create_task(rig.manager.watch())
    for _ in range(5):
        await asyncio.sleep(0)
    runner.cancel()
    await asyncio.gather(runner, return_exceptions=True)
    assert rig.states[-1].mode is None
    assert rig.status() == "ready"


async def test_tv_livre_tells_the_session_about_the_sleep_screen(tmp_path: Path) -> None:
    rig = Rig()
    livre = TvLivre(
        FakeAndroid(),
        FakeApkSource(tmp_path, None),
        LivreStateFile(tmp_path / "state" / "tv-livre.json"),
        PhotoStaging(rig.clock),
        rig.clock,
        remote_guard=rig.manager,
    )
    await rig.manager.wake()
    await livre.run({"action": "sleep"})
    assert rig.states[-1].mode == "sleep"
    await livre.run({"action": "set-home"})
    assert rig.states[-1].mode is None
    await rig.manager.settle()


@pytest.mark.parametrize(
    ("level", "configured", "expires_after"),
    [
        (None, 0, None),  # launcher antigo, sono ilimitado: o pedido de 1 minuto é ignorado
        (None, 5, 300),
        (2, 0, 60),
        (2, 5, 60),
    ],
)
async def test_the_reported_sleep_time_is_the_one_the_launcher_applies(
    tmp_path: Path, level: int | None, configured: int, expires_after: int | None
) -> None:
    rig = Rig()
    android = FakeAndroid()
    android.level = level
    livre = TvLivre(
        android,
        FakeApkSource(tmp_path, None),
        LivreStateFile(tmp_path / "tv-livre.json"),
        PhotoStaging(rig.clock),
        rig.clock,
        remote_guard=rig.manager,
    )
    await livre.run({"action": "install"})
    config = f'{{"sleep":{{"maxMinutes":{configured}}}}}'
    await livre.run({"action": "apply", "revision": 1, "configJson": config})
    await livre.run({"action": "sleep", "minutes": 1})
    if expires_after is None:
        rig.clock.advance(100_000)
        assert rig.mode() == "sleep"
    else:
        rig.clock.advance(expires_after - 1)
        assert rig.mode() == "sleep"
        rig.clock.advance(1)
        assert rig.mode() is None
    await rig.manager.settle()


@pytest.mark.parametrize("recovery", ["probe", "open"])
async def test_an_idle_session_that_drops_stays_unresponsive_until_proven_ready(
    recovery: str,
) -> None:
    rig = Rig()
    await rig.manager.wake()
    rig.clock.advance(100_000)
    rig.remote.drop()
    await rig.manager.settle()
    assert rig.manager.snapshot().connection == "hibernating"
    assert rig.status() == "unresponsive"

    if recovery == "probe":
        rig.manager.note_probe("reachable")
    else:
        await rig.manager.wake()
    assert rig.status() == "ready"


async def test_sleep_with_no_requested_time_uses_the_applied_launcher_config(
    tmp_path: Path,
) -> None:
    rig = Rig()
    android = FakeAndroid()
    state = LivreStateFile(tmp_path / "tv-livre.json")

    livre = TvLivre(
        android,
        FakeApkSource(tmp_path, None),
        state,
        PhotoStaging(rig.clock),
        rig.clock,
        remote_guard=rig.manager,
    )

    await livre.run({"action": "install"})
    await livre.run({"action": "apply", "revision": 1, "configJson": '{"sleep":{"maxMinutes":1}}'})
    # Uma nova instância continua usando o prazo que chegou à TV.
    livre = TvLivre(
        android,
        FakeApkSource(tmp_path),
        state,
        PhotoStaging(rig.clock),
        rig.clock,
        remote_guard=rig.manager,
    )
    android.fail.add("mv -f")
    with pytest.raises(LivreError):
        await livre.run(
            {"action": "apply", "revision": 2, "configJson": '{"sleep":{"maxMinutes":5}}'}
        )
    android.fail.clear()
    await livre.run({"action": "sleep"})
    rig.clock.advance(59)
    assert rig.mode() == "sleep"
    rig.clock.advance(1)
    assert rig.mode() is None

    await livre.run({"action": "sleep", "minutes": 0})
    rig.clock.advance(60)
    assert rig.mode() == "sleep"


# --- Samsung -------------------------------------------------------------------------------------


async def test_periodic_probe_reports_each_cycle_without_opening_the_remote(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rig = Rig()
    asked = probe_answers(monkeypatch, PortState.SILENT, PortState.REFUSED, PortState.OPEN)
    locator = build_relocator(
        Settings(tv_host=OLD_HOST, tv_kind="android"),
        rig.clock,
        lambda: rig.manager.state == "hot",
        on_probe=rig.manager.note_probe,
    )
    assert locator is not None
    for status in ("unreachable", "unresponsive", "ready"):
        await locator.step()
        assert rig.status() == status
    assert [state.connection for state in rig.states] == [
        "disconnected",
        "disconnected",
        "hibernating",
    ]
    await rig.manager.wake()
    rig.remote.push_power(False)
    rig.states.clear()
    await locator.step()
    await locator.step()
    assert [state.mode for state in rig.states] == ["off", "off"]
    assert len(asked) == 3


async def test_periodic_probe_reads_samsung_mode_and_identity_from_the_same_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rig = Rig()
    lan = Lan()
    lan.install(monkeypatch)
    locator = build_relocator(
        settings_for_old_host(tv_mac=TV_INFO["device"]["wifiMac"]),
        rig.clock,
        lambda: False,
        on_probe=rig.manager.note_probe,
    )
    assert locator is not None
    for power in ("standby", "off", "on"):
        lan.rest[OLD_HOST] = {"device": {**TV_INFO["device"], "PowerState": power}}
        await locator.step()
        assert rig.mode() == (None if power == "on" else power)
    lan.rest[OLD_HOST] = {
        "device": {"type": "Samsung SmartTV", "duid": "other", "PowerState": "off"}
    }
    await locator.step()
    assert rig.states[-1].connection == "disconnected"
    assert rig.mode() is None
    assert lan.contacted == [OLD_HOST] * 4


@pytest.mark.parametrize(
    ("value", "expected"),
    [("on", None), ("standby", "standby"), ("Standby", "standby"), ("off", "off"), ("?", None)],
)
def test_samsung_power_state_keeps_standby_apart_from_off(value: str, expected: str | None) -> None:
    assert power_mode_from_info({"device": {"PowerState": value}}) == expected


async def test_the_samsung_driver_remembers_the_last_power_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answers: list[dict[str, Any] | None] = [{"device": {"PowerState": "standby"}}, None]

    async def info(_host: str) -> dict[str, Any] | None:
        return answers.pop(0)

    monkeypatch.setattr(tv_samsung, "fetch_samsung_info", info)
    driver = SamsungTvDriver("192.168.0.11", "token", "UniOver")
    assert await driver.read_power() is False
    assert driver.power_mode == "standby"
    assert await driver.read_power() is None
    assert driver.power_mode is None


# --- o campo no `tv.state.v1` --------------------------------------------------------------------


async def test_new_agent_with_old_api_omits_mode() -> None:
    async def fetch() -> frozenset[str]:
        return frozenset({WAKING_FEATURE})

    clock = FakeClock()
    features = ApiFeatures(fetch, clock)
    transport = FakeTransport()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    publisher = TvStatePublisher(
        transport, envelopes, reports_mode=lambda: features.supports(TV_STATE_MODE_FEATURE)
    )
    assert await features.refresh()
    await publisher.announce(TvState("off", None, None, "hot", mode="standby"))
    assert transport.sent[0]["body"] == {
        "power": "off",
        "volume": None,
        "app": None,
        "connection": "hot",
    }


@pytest.mark.parametrize("mode", ["off", "standby", "sleep"])
async def test_mode_is_sent_when_accepted(mode: TvMode) -> None:
    advertised: frozenset[str] = frozenset({TV_STATE_MODE_FEATURE})

    async def fetch() -> frozenset[str]:
        return advertised

    clock = FakeClock()
    features = ApiFeatures(fetch, clock)
    transport = FakeTransport()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    publisher = TvStatePublisher(
        transport, envelopes, reports_mode=lambda: features.supports(TV_STATE_MODE_FEATURE)
    )
    state = TvState("unknown", None, None, "hot", mode=mode)
    await publisher.announce(state)
    assert "mode" not in transport.sent[0]["body"]
    assert await features.refresh()
    await publisher.announce(state)
    assert transport.sent[1]["body"]["mode"] == mode
    await publisher.announce(TvState("unknown", None, None, "hot"))
    assert "mode" not in transport.sent[2]["body"]
    advertised = frozenset()
    assert await features.refresh()
    await publisher.announce(state)
    assert "mode" not in transport.sent[3]["body"]
