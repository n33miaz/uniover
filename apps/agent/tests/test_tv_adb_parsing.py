"""Leitura da saída do `adb` e escape do que vai ao shell da TV (amostras reais da TCL)."""

import pytest

from uniover_agent.adapters.tv_adb_parsing import (
    DeviceState,
    am_start_succeeded,
    clean_lines,
    connect_was_refused_for_auth,
    input_text_command,
    is_valid_activity,
    is_valid_package,
    monkey_succeeded,
    parse_connect,
    parse_device_state,
    parse_launchable,
    parse_package_list,
    quote_for_device_shell,
)
from uniover_agent.ports import LaunchableApp, is_adb_typable

from .support_adb import LEANBACK_SAMPLE, NO_ACTIVITIES, NOISE, THIRD_PARTY_SAMPLE


def test_noise_lines_and_crlf_are_dropped() -> None:
    assert clean_lines(NOISE + "device\r\n\r\n") == ["device"]


def test_launchable_apps_from_the_real_tv_output() -> None:
    apps = parse_launchable(LEANBACK_SAMPLE)
    assert [app.package for app in apps] == [
        "com.android.tv.settings",
        "com.android.vending",
        "com.google.android.youtube.tv",
        "com.tcl.suspension",
        "com.tcl.partnercustomizer",
        "com.cnvs.apptv",
        "com.spotify.tv.android",
    ]
    assert apps[0] == LaunchableApp("com.android.tv.settings", ".MainSettings")
    assert apps[2].activity == "com.google.android.apps.youtube.tv.activity.ShellActivity"
    assert apps[5].activity == ".ui.LoginActivity"


def test_launchable_apps_ignore_noise_before_and_between_lines() -> None:
    noisy = NOISE + LEANBACK_SAMPLE.replace("  Activity #2:", NOISE + "  Activity #2:")
    assert len(parse_launchable(noisy)) == 7


def test_launchable_apps_have_one_entry_per_package() -> None:
    text = "2 activities found:\r\n  a.b/.One\r\n  a.b/.Two\r\n"
    assert parse_launchable(text) == [LaunchableApp("a.b", ".One")]


def test_no_activities_and_garbage_give_an_empty_list() -> None:
    assert parse_launchable(NO_ACTIVITIES) == []
    assert parse_launchable("error: device offline\r\n") == []
    assert parse_launchable("") == []


def test_third_party_package_list() -> None:
    packages = parse_package_list(NOISE + THIRD_PARTY_SAMPLE + "package:\r\npackage:x;y\r\n")
    assert packages == {"com.spotify.tv.android", "com.cnvs.apptv"}


@pytest.mark.parametrize(
    ("text", "state"),
    [
        ("device\r\n", DeviceState.DEVICE),
        (NOISE + "device\r\n", DeviceState.DEVICE),
        (
            "error: device unauthorized.\r\nThis adbd's $ADB_VENDOR_KEYS is not set\r\n",
            DeviceState.UNAUTHORIZED,
        ),
        ("error: device offline\r\n", DeviceState.OFFLINE),
        ("error: device '192.168.1.99:5555' not found\r\n", DeviceState.NOT_FOUND),
        ("error: no devices/emulators found\r\n", DeviceState.NOT_FOUND),
        ("", DeviceState.UNKNOWN),
        ("qualquer outra coisa\r\n", DeviceState.UNKNOWN),
    ],
)
def test_device_state(text: str, state: DeviceState) -> None:
    assert parse_device_state(text) is state


def test_connect_output() -> None:
    assert parse_connect("connected to 192.168.1.6:5555\r\n")
    assert parse_connect("already connected to 192.168.1.6:5555\r\n")
    assert parse_connect(NOISE + "connected to 192.168.1.6:5555\r\n")
    assert not parse_connect("failed to connect to '192.168.1.6:5555': Connection refused\r\n")
    assert not parse_connect("cannot connect to 192.168.1.6:5555: timed out\r\n")
    assert connect_was_refused_for_auth("failed to authenticate to 192.168.1.6:5555\r\n")
    assert not connect_was_refused_for_auth("connected to 192.168.1.6:5555\r\n")


def test_am_start_exits_zero_even_when_it_fails_so_only_the_text_counts() -> None:
    assert am_start_succeeded(
        "Starting: Intent { cmp=com.spotify.tv.android/.SpotifyTVActivity }\r\n"
    )
    assert not am_start_succeeded(
        "Starting: Intent { cmp=x/.A }\r\nError type 3\r\n"
        "Error: Activity class {x/.A} does not exist.\r\n"
    )
    assert not am_start_succeeded("Error: Activity not started, unable to resolve Intent\r\n")
    assert not am_start_succeeded("")


def test_monkey_output() -> None:
    assert monkey_succeeded("Events injected: 1\r\n## Network stats: elapsed time=5ms\r\n")
    assert not monkey_succeeded("** No activities found to run, monkey aborted.\r\n")
    assert not monkey_succeeded("")


# --- o que vai ao shell da TV -------------------------------------------------------------------


@pytest.mark.parametrize("package", ["com.netflix.ninja", "a.b", "com.Example_1.app2"])
def test_valid_packages(package: str) -> None:
    assert is_valid_package(package)


@pytest.mark.parametrize(
    "package",
    [
        "",
        "semponto",
        "com.app; reboot",
        "com.app && id",
        "com.app$(id)",
        "com.app`id`",
        "com.app com.x",
        "com.app\nid",
        "com..app",
        "1com.app",
        "com.app'",
        'com.app"',
        "com.app|id",
        "a." + "b" * 300,
    ],
)
def test_packages_that_could_reach_the_shell_are_refused(package: str) -> None:
    assert not is_valid_package(package)


@pytest.mark.parametrize(
    "activity", [".Main", "Main", ".ui.Login", "com.x.Main", "com.x.Main$Inner"]
)
def test_valid_activities(activity: str) -> None:
    assert is_valid_activity(activity)


@pytest.mark.parametrize(
    "activity", ["", "a b", ".Main;id", "../x", "a/b", "Main'", "$(id)", "a\nb"]
)
def test_invalid_activities(activity: str) -> None:
    assert not is_valid_activity(activity)


def test_single_quotes_make_the_device_shell_inert() -> None:
    assert quote_for_device_shell("com.x/.Main$Inner") == "'com.x/.Main$Inner'"
    assert quote_for_device_shell("it's") == "'it'\\''s'"


def test_input_text_command_uses_percent_s_for_spaces_and_quotes_everything() -> None:
    assert input_text_command("ola mundo") == "input text 'ola%smundo'"
    assert input_text_command('a;b|c&d$HOME`x`(y)<z>*~#!\\"') == (
        "input text 'a;b|c&d$HOME`x`(y)<z>*~#!\\\"'"
    )
    assert input_text_command("it's") == "input text 'it'\\''s'"


@pytest.mark.parametrize("text", ["", "ação", "olá", "😀", "50%", "a\nb", "a\tb", "x\x7f"])
def test_text_the_adb_cannot_type_faithfully_is_refused(text: str) -> None:
    assert not is_adb_typable(text)
    with pytest.raises(ValueError, match="fidelidade"):
        input_text_command(text)
