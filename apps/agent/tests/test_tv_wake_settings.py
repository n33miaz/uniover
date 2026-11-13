"""Ajustes de ligar a TV TCL pela rede: a leitura (só leitura), o aviso e o caminho até o app.

O `adb` é sempre o dublê (`FakeAdbRunner` ou `FakeTvAdb`): nenhum teste fala com uma TV. A saída
abaixo segue a forma do comando (uma linha rotulada por leitura); os valores são os lidos numa TCL
C06 em 09/11 (`smart_audio_switch` era `null` antes de ligado, `persist.tcl.powerloss=true`).
"""

from datetime import date

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvAdb
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_adb_parsing import WAKE_SETTINGS_COMMAND, parse_wake_settings
from uniover_agent.contracts.registry import MESSAGE_MODELS
from uniover_agent.core import EnvelopeFactory, EnvelopeGate, TvState, TvStatePublisher
from uniover_agent.core.tv.cleanup import TvCleanup
from uniover_agent.core.tv.cleanup_schedule import TvCleanupScheduler
from uniover_agent.core.tv.wake_settings import REPLUG, SCREENLESS_OFF, WakeSettingsCheck
from uniover_agent.ports import (
    AdbCommandFailed,
    AdbIdle,
    AdbUnauthorized,
    AdbUnreachable,
    WakeSettings,
)

from .support import AGENT_ID
from .support_adb import ADB, HOST, NOISE, SERIAL, FakeAdbRunner, ok, open_gate, shell

TCL_ON = "uniover_maker=TCL\r\nuniover_powerloss=true\r\nuniover_screenless=1\r\n"
TCL_OFF = "uniover_maker=TCL\r\nuniover_powerloss=true\r\nuniover_screenless=null\r\n"
OTHER_BRAND = "uniover_maker=Xiaomi\r\nuniover_powerloss=\r\nuniover_screenless=null\r\n"


def make_tv(runner: FakeAdbRunner) -> AdbTv:
    return AdbTv(ADB, HOST, 5555, **open_gate(), timeout=1.0, runner=runner, monotonic=lambda: 0.0)


async def open_tv(runner: FakeAdbRunner) -> AdbTv:
    """Um canal já aberto (a pessoa o abriu por um pedido): a leitura automática só usa esse."""
    tv = make_tv(runner)
    await tv.connect()
    return tv


def authorized() -> FakeAdbRunner:
    runner = FakeAdbRunner()
    runner.connected()
    return runner


# --- a leitura no adaptador -----------------------------------------------------------------


async def test_one_fixed_read_only_command_reads_the_three_values() -> None:
    runner = authorized()
    runner.script[shell(WAKE_SETTINGS_COMMAND)] = ok(NOISE + TCL_OFF)
    assert await (await open_tv(runner)).wake_settings() == WakeSettings(
        tcl=True, screenless=False, power_restore=True
    )
    assert runner.calls[-1] == ("-s", SERIAL, "shell", WAKE_SETTINGS_COMMAND)
    assert runner.shell_commands() == [WAKE_SETTINGS_COMMAND]


async def test_the_automatic_read_never_opens_a_connection() -> None:
    # Sem canal aberto (a permissão pode ter sido revogada na TV; o estado local não prova o
    # contrário), `adb connect` faria a TV mostrar o aviso sem ninguém ter pedido.
    runner = authorized()
    runner.script[shell(WAKE_SETTINGS_COMMAND)] = ok(NOISE + TCL_OFF)
    with pytest.raises(AdbIdle):
        await make_tv(runner).wake_settings()
    assert runner.calls == []


async def test_a_channel_the_tv_dropped_is_not_reopened_by_the_next_automatic_read() -> None:
    runner = authorized()
    tv = await open_tv(runner)
    runner.script[shell(WAKE_SETTINGS_COMMAND)] = ok("error: device unauthorized.\r\n", 1)
    with pytest.raises(AdbUnauthorized):
        await tv.wake_settings()  # a TV revogou: o transporte caiu
    connects = [call for call in runner.calls if call[0] == "connect"]
    assert len(connects) == 1  # só a abertura da pessoa

    with pytest.raises(AdbIdle):
        await tv.wake_settings()
    assert [call for call in runner.calls if call[0] == "connect"] == connects


def test_the_command_only_reads() -> None:
    # Nada de `settings put`/`delete`, `setprop` ou `am`: a leitura nunca grava na TV.
    assert "put" not in WAKE_SETTINGS_COMMAND
    assert "delete" not in WAKE_SETTINGS_COMMAND
    assert "setprop" not in WAKE_SETTINGS_COMMAND
    assert "settings get secure smart_audio_switch" in WAKE_SETTINGS_COMMAND
    assert "getprop persist.tcl.powerloss" in WAKE_SETTINGS_COMMAND
    assert "getprop ro.product.manufacturer" in WAKE_SETTINGS_COMMAND
    assert "getprop ro.product.brand" in WAKE_SETTINGS_COMMAND


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (TCL_ON, WakeSettings(tcl=True, screenless=True, power_restore=True)),
        (TCL_OFF, WakeSettings(tcl=True, screenless=False, power_restore=True)),
        (
            "uniover_maker=tcl\r\nuniover_powerloss=false\r\nuniover_screenless=0\r\n",
            WakeSettings(tcl=True, screenless=False, power_restore=False),
        ),
        (OTHER_BRAND, WakeSettings(tcl=False, screenless=False, power_restore=None)),
        # Saída que não se entende é "não sei", nunca "desligado".
        (
            "uniover_maker=TCL\r\nuniover_powerloss=\r\nuniover_screenless=cmd: not found\r\n",
            WakeSettings(tcl=True, screenless=None, power_restore=None),
        ),
        ("uniover_maker=TCL\r\n", WakeSettings(tcl=True, screenless=None, power_restore=None)),
    ],
)
def test_parsing(text: str, expected: WakeSettings) -> None:
    assert parse_wake_settings(text) == expected


@pytest.mark.parametrize("text", ["", "error: closed\r\n", "/system/bin/sh: getprop: x\r\n"])
async def test_an_answer_without_the_maker_is_a_failed_read(text: str) -> None:
    runner = authorized()
    runner.script[shell(WAKE_SETTINGS_COMMAND)] = ok(text)
    with pytest.raises(AdbCommandFailed):
        await (await open_tv(runner)).wake_settings()


async def test_with_fake_adb_a_setting_turned_off_is_a_warning_on_the_next_read() -> None:
    runner = authorized()
    runner.script[shell(WAKE_SETTINGS_COMMAND)] = ok(NOISE + TCL_ON)
    check = WakeSettingsCheck(await open_tv(runner))
    assert await check.check()
    assert not check.hints

    runner.script[shell(WAKE_SETTINGS_COMMAND)] = ok(NOISE + TCL_OFF)
    assert await check.check()
    assert check.hints == (SCREENLESS_OFF,)

    # Nada foi gravado na TV: só a mesma leitura, duas vezes.
    commands = runner.shell_commands()
    assert commands == [WAKE_SETTINGS_COMMAND, WAKE_SETTINGS_COMMAND]
    for word in ("settings put", "settings delete", "setprop", "am ", "input "):
        assert all(word not in command for command in commands)


# --- o aviso --------------------------------------------------------------------------------


async def test_a_setting_turned_off_becomes_a_warning_on_the_next_read() -> None:
    adb = FakeTvAdb()
    adb.wake = WakeSettings(tcl=True, screenless=True, power_restore=True)
    check = WakeSettingsCheck(adb)
    changes: list[tuple[str, ...]] = []
    check.on_change(lambda: changes.append(check.hints))

    await check.check()
    assert not check.hints
    assert changes == []

    adb.wake = WakeSettings(tcl=True, screenless=False, power_restore=True)  # reset de fábrica
    await check.check()
    assert check.hints == (SCREENLESS_OFF,)
    assert changes == [(SCREENLESS_OFF,)]

    await check.check()  # o mesmo valor de novo não avisa outra vez
    assert changes == [(SCREENLESS_OFF,)]

    adb.wake = WakeSettings(tcl=True, screenless=True, power_restore=True)  # o dono religou
    await check.check()
    assert not check.hints
    assert changes == [(SCREENLESS_OFF,), ()]
    # Só leituras: o dublê nunca recebeu outra operação.
    assert adb.cleanup_log == ["wake-settings"] * 4


async def test_another_brand_never_gets_a_warning() -> None:
    adb = FakeTvAdb()
    adb.wake = WakeSettings(tcl=False, screenless=False, power_restore=True)
    check = WakeSettingsCheck(adb)
    await check.check()
    check.wake_failed()
    assert not check.hints


async def test_a_failed_read_keeps_what_was_known() -> None:
    adb = FakeTvAdb()
    adb.wake = WakeSettings(tcl=True, screenless=False, power_restore=True)
    check = WakeSettingsCheck(adb)
    await check.check()
    adb.cleanup_errors["wake-settings"] = AdbUnreachable("a TV não respondeu")
    await check.check()
    assert check.hints == (SCREENLESS_OFF,)


async def test_unplug_is_suggested_only_when_waking_failed_on_a_tv_that_restores_power() -> None:
    adb = FakeTvAdb()
    adb.wake = WakeSettings(tcl=True, screenless=True, power_restore=True)
    check = WakeSettingsCheck(adb)
    check.wake_failed()  # ainda sem leitura: não se sabe se tirar da tomada adianta
    assert not check.hints
    await check.check()
    assert check.hints == (REPLUG,)
    check.tv_answered(3.2)  # a TV respondeu: a sugestão some
    assert not check.hints

    adb.wake = WakeSettings(tcl=True, screenless=True, power_restore=False)
    await check.check()
    check.wake_failed()
    assert not check.hints


# --- a carona na avaliação diária -----------------------------------------------------------


def make_scheduler(
    adb: FakeTvAdb, check: WakeSettingsCheck
) -> tuple[TvCleanupScheduler, FakeClock]:
    clock = FakeClock()
    scheduler = TvCleanupScheduler(
        TvCleanup(adb, clock, allow_app_closing=False),
        adb,
        clock,
        FakeTransport(),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        lambda: None,
        wake_check=check.check,
    )
    return scheduler, clock


async def test_the_read_rides_on_the_first_session_of_the_day_only() -> None:
    adb = FakeTvAdb()
    adb.wake = WakeSettings(tcl=True, screenless=False, power_restore=True)
    check = WakeSettingsCheck(adb)
    scheduler, _ = make_scheduler(adb, check)

    await scheduler.run_pending()  # nenhuma sessão ainda: nada é lido
    assert adb.cleanup_log == []

    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    assert adb.cleanup_log == ["wake-settings"]
    assert check.hints == (SCREENLESS_OFF,)

    scheduler.note_session_opened(1)  # outra sessão no mesmo dia: sem leitura nova
    await scheduler.run_pending()
    assert adb.cleanup_log == ["wake-settings"]


async def test_a_read_refused_while_nobody_uses_the_tv_is_retried_the_same_day() -> None:
    adb = FakeTvAdb()
    adb.wake = WakeSettings(tcl=True, screenless=False, power_restore=True)
    adb.cleanup_errors["wake-settings"] = AdbIdle("ninguém usando a TV agora")
    check = WakeSettingsCheck(adb)
    scheduler, _ = make_scheduler(adb, check)

    scheduler.note_session_opened(1)  # o pré-aquecimento da tela, sem ninguém tocar
    await scheduler.run_pending()
    assert not check.hints

    del adb.cleanup_errors["wake-settings"]
    scheduler.note_session_opened(1)  # outra sessão no mesmo dia: tenta de novo
    await scheduler.run_pending()
    assert adb.cleanup_log == ["wake-settings", "wake-settings"]
    assert check.hints == (SCREENLESS_OFF,)


async def test_the_next_day_reads_again(monkeypatch: pytest.MonkeyPatch) -> None:
    adb = FakeTvAdb()
    adb.wake = WakeSettings(tcl=True, screenless=True, power_restore=True)
    check = WakeSettingsCheck(adb)
    scheduler, _ = make_scheduler(adb, check)
    days = iter([date(2026, 11, 12), date(2026, 11, 12), date(2026, 11, 13), date(2026, 11, 13)])
    monkeypatch.setattr(scheduler, "_today", lambda: next(days))

    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    assert not check.hints

    adb.wake = WakeSettings(tcl=True, screenless=False, power_restore=True)
    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    assert adb.cleanup_log == ["wake-settings", "wake-settings"]
    assert check.hints == (SCREENLESS_OFF,)


# --- até o app ------------------------------------------------------------------------------


def make_publisher(
    check: WakeSettingsCheck, *, supported: bool
) -> tuple[TvStatePublisher, FakeTransport]:
    transport = FakeTransport()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock())
    publisher = TvStatePublisher(
        transport,
        envelopes,
        reports_wake_hints=lambda: supported,
        wake_hints=lambda: check.hints,
    )
    return publisher, transport


async def test_the_state_carries_the_hints_and_matches_the_contract() -> None:
    adb = FakeTvAdb()
    adb.wake = WakeSettings(tcl=True, screenless=False, power_restore=True)
    check = WakeSettingsCheck(adb)
    publisher, transport = make_publisher(check, supported=True)
    state = TvState("off", None, None, "disconnected")

    await publisher.announce(state)  # sem leitura: o campo não sai
    await check.check()
    check.wake_failed()
    await publisher.announce(state)

    assert "wakeHints" not in transport.sent[0]["body"]
    assert transport.sent[1]["body"]["wakeHints"] == [SCREENLESS_OFF, REPLUG]
    for message in transport.sent:
        MESSAGE_MODELS["tv.state.v1"].model_validate(message)


async def test_an_older_api_never_gets_the_field() -> None:
    adb = FakeTvAdb()
    adb.wake = WakeSettings(tcl=True, screenless=False, power_restore=True)
    check = WakeSettingsCheck(adb)
    await check.check()
    publisher, transport = make_publisher(check, supported=False)
    await publisher.announce(TvState("on", 10, None, "hot"))
    assert "wakeHints" not in transport.sent[0]["body"]
