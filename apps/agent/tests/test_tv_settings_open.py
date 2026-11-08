"""Abrir a tela de rede ou as configurações da TV: lista fechada e `am start` exato."""

import json
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvAdb, FakeTvRemote
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_adb_parsing import SETTINGS_ACTIONS
from uniover_agent.composition.connection import API_LISTED_CAPABILITIES, declarable_capabilities
from uniover_agent.core import (
    SETTINGS_OPEN_CAPABILITY,
    Command,
    ResultStatus,
    TvSessionManager,
    TvSettings,
    tv_settings_open_handler,
)
from uniover_agent.core.tv.cleanup_schedule import is_user_activity
from uniover_agent.core.tv.settings_open import SETTINGS_SCREENS
from uniover_agent.ports import AdbCommandFailed, AdbUnreachable, TvUnreachable

from .support_adb import ADB, HOST, FakeAdbRunner, ok, open_gate, shell

COMMAND_ID = "0192f1e4-0000-7000-8000-000000000011"


class Env:
    def __init__(self) -> None:
        self.remote = FakeTvRemote()
        self.manager = TvSessionManager(FakeClock(), self.remote)
        self.adb = FakeTvAdb()
        self.handler = tv_settings_open_handler(TvSettings(self.manager, self.adb))

    async def send(self, body: dict[str, Any]) -> Any:
        return await self.handler(Command(COMMAND_ID, "tv.settings.open.v1", body))


# --- o handler ----------------------------------------------------------------------------------


@pytest.mark.parametrize("screen", ["WIFI", "SETTINGS"])
async def test_each_screen_of_the_closed_list_is_opened_through_the_adb(screen: str) -> None:
    env = Env()
    result = await env.send({"screen": screen})
    assert result.status is ResultStatus.OK
    assert env.adb.settings_opened == [screen]
    # Mantém a sessão quente, como a abertura de um app.
    assert env.remote.connects == 1


@pytest.mark.parametrize(
    "body",
    [
        {"screen": "DEVELOPER"},
        {"screen": "wifi"},
        {"screen": " WIFI"},
        {"screen": "android.settings.WIFI_SETTINGS"},
        {"screen": ""},
        {"screen": 3},
        {"screen": None},
        {"action": "android.settings.SETTINGS"},
        {},
    ],
)
async def test_anything_outside_the_closed_list_is_rejected_and_never_touches_the_tv(
    body: dict[str, Any],
) -> None:
    env = Env()
    result = await env.send(body)
    assert result.status is ResultStatus.REJECTED
    assert result.code == "invalid_target"
    assert env.adb.settings_opened == []
    assert env.remote.connects == 0
    assert env.adb.connects == 0


async def test_an_adb_failure_answers_with_its_code_and_does_not_hide_it() -> None:
    env = Env()
    env.adb.errors.append(AdbUnreachable("a conexão ADB com a TV caiu"))
    result = await env.send({"screen": "WIFI"})
    assert result.status is ResultStatus.FAILED
    assert result.code == AdbUnreachable.code


async def test_a_tv_without_the_remote_still_opens_the_screen_through_the_adb() -> None:
    env = Env()
    env.remote.connect_errors.append(TvUnreachable("sem controle"))
    result = await env.send({"screen": "SETTINGS"})
    assert result.status is ResultStatus.OK
    assert env.adb.settings_opened == ["SETTINGS"]


# --- o adaptador: o argv exato ------------------------------------------------------------------


def make_adb(runner: FakeAdbRunner) -> AdbTv:
    return AdbTv(
        ADB,
        HOST,
        5555,
        **open_gate(),
        timeout=1.0,
        runner=runner,
        monotonic=lambda: 0.0,
        retry_after=30.0,
        close_wait_seconds=0.05,
    )


def authorized() -> FakeAdbRunner:
    runner = FakeAdbRunner()
    runner.connected()
    return runner


@pytest.mark.parametrize(
    ("screen", "action"),
    [("WIFI", "android.settings.WIFI_SETTINGS"), ("SETTINGS", "android.settings.SETTINGS")],
)
async def test_the_adapter_runs_exactly_one_am_start_with_the_fixed_action(
    screen: str, action: str
) -> None:
    runner = authorized()
    runner.script[shell(f"am start -a {action}")] = ok(f"Starting: Intent {{ act={action} }}\r\n")
    await make_adb(runner).open_settings(screen)
    assert runner.shell_commands() == [f"am start -a {action}"]


@pytest.mark.parametrize(
    "screen",
    ["", "wifi", "DEVELOPER", "WIFI; reboot", "android.settings.WIFI_SETTINGS", "SETTINGS "],
)
async def test_the_adapter_refuses_a_name_outside_the_table_without_running_a_shell(
    screen: str,
) -> None:
    runner = authorized()
    adb = make_adb(runner)
    with pytest.raises(ValueError, match="desconhecida"):
        await adb.open_settings(screen)
    assert runner.shell_commands() == []
    assert runner.calls == []  # nem conectou


async def test_the_adapter_reports_a_screen_that_the_tv_could_not_start() -> None:
    runner = authorized()
    action = SETTINGS_ACTIONS["WIFI"]
    runner.script[shell(f"am start -a {action}")] = ok(
        f"Error: Activity not started, unable to resolve Intent {{ act={action} }}\r\n"
    )
    with pytest.raises(AdbCommandFailed):
        await make_adb(runner).open_settings("WIFI")


# --- a lista é uma só ---------------------------------------------------------------------------


def test_the_actions_are_the_two_public_android_settings_and_nothing_else() -> None:
    assert SETTINGS_ACTIONS == {
        "WIFI": "android.settings.WIFI_SETTINGS",
        "SETTINGS": "android.settings.SETTINGS",
    }


def test_core_adapter_and_contract_agree_on_the_closed_list() -> None:
    schema_path = (
        Path(__file__).parents[1]
        / "src/uniover_agent/contracts/schemas/messages/tv.settings.open.v1.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    contract = set(schema["properties"]["body"]["properties"]["screen"]["enum"])
    assert contract == set(SETTINGS_SCREENS) == set(SETTINGS_ACTIONS)


# --- capacidade e atividade ---------------------------------------------------------------------


def test_the_capability_only_goes_to_the_hello_after_the_api_lists_it() -> None:
    capabilities = ["tv.remote", "tv.adb", SETTINGS_OPEN_CAPABILITY]
    assert SETTINGS_OPEN_CAPABILITY in API_LISTED_CAPABILITIES
    assert declarable_capabilities(capabilities, lambda _name: False) == ("tv.remote", "tv.adb")
    assert declarable_capabilities(capabilities, lambda name: name == SETTINGS_OPEN_CAPABILITY) == (
        "tv.remote",
        "tv.adb",
        SETTINGS_OPEN_CAPABILITY,
    )


def test_opening_a_screen_counts_as_somebody_using_the_tv() -> None:
    assert is_user_activity("tv.settings.open.v1")
