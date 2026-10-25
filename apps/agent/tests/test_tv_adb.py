"""Adaptador do canal ADB: `argv` exato por operação, estados de conexão, um comando por vez.

O processo é um dublê (`FakeAdbRunner`): nenhum teste roda o `adb` de verdade, exceto o do executor
de processos, que roda o próprio Python para provar tempo esgotado e saída sem passar por shell.
"""

import asyncio
import sys
from pathlib import Path

import pytest

from uniover_agent.adapters.tv_adb import AdbTv, locate_adb, run_process
from uniover_agent.adapters.tv_adb_parsing import AdbOutput
from uniover_agent.ports import (
    AdbCommandFailed,
    AdbNotReady,
    AdbTimeout,
    AdbUnauthorized,
    AdbUnavailable,
    AdbUnreachable,
    LaunchableApp,
)

from .support_adb import (
    ADB,
    CONNECT,
    DISCONNECT,
    GET_STATE,
    HOST,
    LAUNCHER_QUERY,
    LEANBACK_QUERY,
    LEANBACK_SAMPLE,
    NO_ACTIVITIES,
    NOISE,
    PM_THIRD_PARTY,
    SERIAL,
    THIRD_PARTY_SAMPLE,
    FakeAdbRunner,
    ok,
    shell,
)


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def make(runner: FakeAdbRunner, clock: Clock | None = None) -> AdbTv:
    return AdbTv(
        ADB, HOST, 5555, timeout=1.0, runner=runner, monotonic=clock or Clock(), retry_after=30.0
    )


def authorized() -> FakeAdbRunner:
    runner = FakeAdbRunner()
    runner.connected()
    return runner


# --- conexão ------------------------------------------------------------------------------------


async def test_connect_runs_connect_then_get_state_and_nothing_else() -> None:
    runner = authorized()
    adb = make(runner)
    assert not adb.connected
    await adb.connect()
    assert adb.connected
    assert runner.calls == [CONNECT, GET_STATE]
    assert runner.executables == {str(ADB)}


async def test_connect_is_idempotent() -> None:
    runner = authorized()
    adb = make(runner)
    await adb.connect()
    await adb.connect()
    assert adb.connected
    assert runner.calls == [CONNECT, GET_STATE, CONNECT, GET_STATE]


async def test_connect_ignores_the_tvs_noise_lines() -> None:
    runner = FakeAdbRunner(
        {
            CONNECT: ok(NOISE + f"already connected to {SERIAL}\r\n"),
            GET_STATE: ok(NOISE + "device\r\n"),
        }
    )
    await make(runner).connect()


async def test_unauthorized_tv_is_a_clear_error() -> None:
    runner = FakeAdbRunner(
        {
            CONNECT: ok(f"connected to {SERIAL}\r\n"),
            GET_STATE: ok("error: device unauthorized.\r\n", returncode=1),
        }
    )
    adb = make(runner)
    with pytest.raises(AdbUnauthorized) as caught:
        await adb.connect()
    assert caught.value.code == "adb_unauthorized"
    assert not adb.connected


async def test_connect_refused_for_authentication_is_unauthorized() -> None:
    runner = FakeAdbRunner({CONNECT: ok(f"failed to authenticate to {SERIAL}\r\n")})
    with pytest.raises(AdbUnauthorized):
        await make(runner).connect()
    assert runner.calls == [CONNECT]


@pytest.mark.parametrize(
    "state_text", ["error: device offline\r\n", f"error: device '{SERIAL}' not found\r\n", ""]
)
async def test_offline_or_missing_tv_is_unreachable(state_text: str) -> None:
    runner = FakeAdbRunner(
        {CONNECT: ok(f"connected to {SERIAL}\r\n"), GET_STATE: ok(state_text, returncode=1)}
    )
    with pytest.raises(AdbUnreachable) as caught:
        await make(runner).connect()
    assert caught.value.code == "adb_unreachable"


async def test_failed_connect_is_unreachable_and_does_not_leak_adb_output() -> None:
    runner = FakeAdbRunner(
        {CONNECT: ok(f"failed to connect to '{SERIAL}': Connection refused\r\n", returncode=1)}
    )
    with pytest.raises(AdbUnreachable) as caught:
        await make(runner).connect()
    assert SERIAL not in caught.value.message
    assert "refused" not in caught.value.message


async def test_timeout_while_connecting_means_the_tv_did_not_answer() -> None:
    runner = FakeAdbRunner({CONNECT: TimeoutError()})
    with pytest.raises(AdbUnreachable):
        await make(runner).connect()


async def test_missing_adb_executable_is_unavailable_without_the_path() -> None:
    runner = FakeAdbRunner({CONNECT: FileNotFoundError(str(ADB))})
    with pytest.raises(AdbUnavailable) as caught:
        await make(runner).connect()
    assert caught.value.code == "adb_unavailable"
    assert str(ADB) not in caught.value.message
    assert isinstance(caught.value, AdbNotReady)


async def test_disconnect_only_drops_this_tv_and_never_kills_the_server() -> None:
    runner = authorized()
    adb = make(runner)
    await adb.connect()
    await adb.disconnect()
    assert not adb.connected
    assert runner.calls[-1] == DISCONNECT
    assert not any("kill-server" in part for call in runner.calls for part in call)


async def test_disconnect_survives_a_failing_adb() -> None:
    runner = FakeAdbRunner({DISCONNECT: OSError("boom")})
    await make(runner).disconnect()


# --- conexão preguiçosa e pausa depois de falhar ------------------------------------------------


async def test_a_command_without_an_open_channel_connects_first() -> None:
    runner = authorized()
    runner.script[shell("input text 'oi'")] = ok("")
    adb = make(runner)
    await adb.input_text("oi")
    assert runner.calls == [CONNECT, GET_STATE, shell("input text 'oi'")]


async def test_after_a_connection_failure_commands_wait_before_trying_again() -> None:
    clock = Clock()
    runner = FakeAdbRunner({CONNECT: ok("failed to connect\r\n", returncode=1)})
    adb = make(runner, clock)
    with pytest.raises(AdbUnreachable):
        await adb.input_text("a")
    calls_after_first = len(runner.calls)
    with pytest.raises(AdbUnreachable):
        await adb.input_text("b")
    # Dentro da pausa, nenhum processo novo (digitar letra a letra não paga reconexão por tecla).
    assert len(runner.calls) == calls_after_first
    clock.now = 31.0
    with pytest.raises(AdbUnreachable):
        await adb.input_text("c")
    assert len(runner.calls) > calls_after_first


async def test_explicit_connect_always_tries_even_during_the_pause() -> None:
    clock = Clock()
    runner = FakeAdbRunner({CONNECT: ok("failed to connect\r\n", returncode=1)})
    adb = make(runner, clock)
    with pytest.raises(AdbUnreachable):
        await adb.connect()
    runner.connected()
    await adb.connect()
    assert adb.connected


async def test_a_dropped_channel_is_noticed_by_the_failing_command_and_reopened_next_time() -> None:
    runner = authorized()
    runner.script[shell("input text 'a'")] = [
        ok(f"error: device '{SERIAL}' not found\r\n", returncode=1),
        ok(""),
    ]
    adb = make(runner)
    await adb.connect()
    with pytest.raises(AdbUnreachable):
        await adb.input_text("a")
    assert not adb.connected
    # O pedido seguinte reconecta sozinho (a pausa só vale para quem falhou ao conectar).
    await adb.input_text("a")
    assert adb.connected
    assert runner.calls.count(CONNECT) == 2


async def test_unauthorized_in_the_middle_of_a_command() -> None:
    runner = authorized()
    runner.script[shell("input text 'a'")] = ok("error: device unauthorized.\r\n", returncode=1)
    adb = make(runner)
    await adb.connect()
    with pytest.raises(AdbUnauthorized):
        await adb.input_text("a")


async def test_command_timeout_is_typed_and_closes_the_channel_state() -> None:
    runner = authorized()
    runner.script[shell("input text 'a'")] = TimeoutError()
    adb = make(runner)
    await adb.connect()
    with pytest.raises(AdbTimeout) as caught:
        await adb.input_text("a")
    assert caught.value.code == "adb_timeout"
    assert not isinstance(caught.value, AdbNotReady)
    assert not adb.connected


# --- um comando por vez -------------------------------------------------------------------------


async def test_input_text_records_how_long_it_waited_for_the_lock() -> None:
    clock = Clock()
    runner = authorized()
    runner.script[shell("input text 'a'")] = ok("")
    adb = make(runner, clock)
    await adb.connect()
    assert adb.last_input_wait_seconds == 0.0
    # A lista de apps (ou uma consulta de ícones) segurando a trava enquanto alguém digita.
    async with adb._lock:
        pending = asyncio.create_task(adb.input_text("a"))
        await asyncio.sleep(0)
        clock.now = 2.5
    await pending
    assert adb.last_input_wait_seconds == 2.5
    await adb.input_text("a")
    assert adb.last_input_wait_seconds == 0.0


async def test_commands_never_overlap() -> None:
    runner = authorized()
    runner.delay = 0.01
    for text in ("a", "b", "c", "d"):
        runner.script[shell(f"input text '{text}'")] = ok("")
    adb = make(runner)
    await asyncio.gather(*(adb.input_text(text) for text in "abcd"))
    assert runner.max_running == 1


# --- lista de apps ------------------------------------------------------------------------------


async def test_list_apps_asks_the_tv_launcher_category_and_marks_what_the_owner_installed() -> None:
    runner = authorized()
    runner.script[shell(LEANBACK_QUERY)] = ok(NOISE + LEANBACK_SAMPLE)
    runner.script[shell(PM_THIRD_PARTY)] = ok(NOISE + THIRD_PARTY_SAMPLE)
    apps = await make(runner).list_apps()
    assert runner.shell_commands() == [LEANBACK_QUERY, PM_THIRD_PARTY]
    by_package = {app.package: app for app in apps}
    assert len(apps) == 7
    assert by_package["com.cnvs.apptv"].user_installed
    assert by_package["com.spotify.tv.android"].user_installed
    assert not by_package["com.android.vending"].user_installed
    assert not by_package["com.google.android.youtube.tv"].user_installed


async def test_list_apps_falls_back_to_the_phone_launcher_when_the_tv_one_is_empty() -> None:
    runner = authorized()
    runner.script[shell(LEANBACK_QUERY)] = ok(NO_ACTIVITIES)
    runner.script[shell(LAUNCHER_QUERY)] = ok("1 activities found:\r\n  a.b/.Main\r\n")
    runner.script[shell(PM_THIRD_PARTY)] = ok("")
    apps = await make(runner).list_apps()
    assert apps == [LaunchableApp("a.b", ".Main", user_installed=False)]
    assert runner.shell_commands() == [LEANBACK_QUERY, LAUNCHER_QUERY, PM_THIRD_PARTY]


async def test_list_apps_is_empty_when_neither_category_has_apps() -> None:
    runner = authorized()
    runner.script[shell(LEANBACK_QUERY)] = ok(NO_ACTIVITIES)
    runner.script[shell(LAUNCHER_QUERY)] = ok(NO_ACTIVITIES)
    assert await make(runner).list_apps() == []


async def test_list_apps_survives_a_slow_third_party_query() -> None:
    runner = authorized()
    runner.script[shell(LEANBACK_QUERY)] = ok(LEANBACK_SAMPLE)
    runner.script[shell(PM_THIRD_PARTY)] = TimeoutError()
    apps = await make(runner).list_apps()
    assert len(apps) == 7
    assert not any(app.user_installed for app in apps)


# --- abrir por pacote ---------------------------------------------------------------------------

SPOTIFY_COMPONENT = "'com.spotify.tv.android/.SpotifyTVActivity'"


async def test_launch_resolves_the_activity_and_uses_am_start() -> None:
    runner = authorized()
    runner.script[shell(LEANBACK_QUERY)] = ok(LEANBACK_SAMPLE)
    runner.script[shell(PM_THIRD_PARTY)] = ok(THIRD_PARTY_SAMPLE)
    runner.script[shell(f"am start -n {SPOTIFY_COMPONENT}")] = ok(
        "Starting: Intent { cmp=com.spotify.tv.android/.SpotifyTVActivity }\r\n"
    )
    await make(runner).launch_package("com.spotify.tv.android")
    assert runner.shell_commands()[-1] == f"am start -n {SPOTIFY_COMPONENT}"
    assert not any(command.startswith("monkey") for command in runner.shell_commands())


async def test_launch_with_a_known_activity_skips_the_lookup() -> None:
    runner = authorized()
    runner.script[shell("am start -n 'com.x.app/.Main'")] = ok("Starting: Intent { }\r\n")
    await make(runner).launch_package("com.x.app", ".Main")
    assert runner.shell_commands() == ["am start -n 'com.x.app/.Main'"]


async def test_launch_falls_back_to_monkey_when_am_start_reports_an_error() -> None:
    runner = authorized()
    runner.script[shell("am start -n 'com.x.app/.Main'")] = ok(
        "Starting: Intent { }\r\nError type 3\r\nError: Activity class does not exist.\r\n"
    )
    monkey = "monkey -p 'com.x.app' -c android.intent.category.LAUNCHER 1"
    runner.script[shell(monkey)] = ok("Events injected: 1\r\n")
    await make(runner).launch_package("com.x.app", ".Main")
    assert runner.shell_commands() == ["am start -n 'com.x.app/.Main'", monkey]


async def test_launch_of_an_unknown_package_uses_monkey_and_reports_when_it_fails() -> None:
    runner = authorized()
    runner.script[shell(LEANBACK_QUERY)] = ok(LEANBACK_SAMPLE)
    runner.script[shell(PM_THIRD_PARTY)] = ok("")
    monkey = "monkey -p 'com.nao.existe' -c android.intent.category.LAUNCHER 1"
    runner.script[shell(monkey)] = ok("** No activities found to run, monkey aborted.\r\n")
    with pytest.raises(AdbCommandFailed) as caught:
        await make(runner).launch_package("com.nao.existe")
    assert caught.value.code == "adb_failed"
    assert "monkey" not in caught.value.message


@pytest.mark.parametrize(
    "package",
    ["", "com.app; reboot", "com.app$(id)", "com.app`id`", "com.app && id", "x", "com.app'"],
)
async def test_launch_rejects_packages_that_could_reach_the_shell(package: str) -> None:
    runner = authorized()
    with pytest.raises(ValueError, match="pacote"):
        await make(runner).launch_package(package)
    assert runner.calls == []


@pytest.mark.parametrize("activity", ["a b", ".Main;id", "$(id)", "../x", "a'b"])
async def test_launch_rejects_activities_that_could_reach_the_shell(activity: str) -> None:
    runner = authorized()
    with pytest.raises(ValueError, match="atividade"):
        await make(runner).launch_package("com.x.app", activity)
    assert runner.calls == []


async def test_an_inner_class_activity_stays_inert_inside_single_quotes() -> None:
    runner = authorized()
    runner.script[shell("am start -n 'com.x.app/.Main$Inner'")] = ok("Starting: Intent { }\r\n")
    await make(runner).launch_package("com.x.app", ".Main$Inner")


# --- digitar ------------------------------------------------------------------------------------


async def test_input_text_argv_is_exact() -> None:
    runner = authorized()
    runner.script[shell("input text 'ola%smundo'")] = ok("")
    await make(runner).input_text("ola mundo")
    assert runner.calls[-1] == ("-s", SERIAL, "shell", "input text 'ola%smundo'")


async def test_input_text_quotes_shell_metacharacters() -> None:
    runner = authorized()
    hostile = "a;rm -rf /|b&c$(id)`id`'x'"
    quoted = "input text 'a;rm%s-rf%s/|b&c$(id)`id`'\\''x'\\'''"
    runner.script[shell(quoted)] = ok("")
    await make(runner).input_text(hostile)
    assert runner.shell_commands()[-1] == quoted


@pytest.mark.parametrize("text", ["", "ação", "50%", "a\nb", "x" * 201])
async def test_input_text_refuses_what_it_cannot_type_faithfully(text: str) -> None:
    runner = authorized()
    with pytest.raises(ValueError, match="texto"):
        await make(runner).input_text(text)
    assert runner.calls == []


# --- executor de processos de verdade (o próprio Python faz de `adb`) ---------------------------


async def test_run_process_collects_output_without_a_shell() -> None:
    # `&&` e `$HOME` chegam ao programa como texto puro: nada interpretou o argv.
    output = await run_process(
        [
            sys.executable,
            "-c",
            "import sys; print(sys.argv[1]); print('erro', file=sys.stderr)",
            "a && $HOME",
        ],
        10.0,
    )
    assert output.returncode == 0
    assert "a && $HOME" in output.text
    assert "erro" in output.text


async def test_run_process_kills_the_process_when_time_runs_out() -> None:
    with pytest.raises(TimeoutError):
        await run_process([sys.executable, "-c", "import time; time.sleep(30)"], 0.5)


async def test_run_process_reports_the_exit_code() -> None:
    output = await run_process([sys.executable, "-c", "raise SystemExit(3)"], 10.0)
    assert output.returncode == 3


async def test_run_process_with_a_missing_executable_raises_file_not_found(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        await run_process([str(tmp_path / "nao-existe.exe")], 5.0)


# --- onde está o adb ----------------------------------------------------------------------------


def test_locate_adb_prefers_the_configured_file(tmp_path: Path) -> None:
    fake = tmp_path / "meu-adb.exe"
    fake.write_text("x")
    assert locate_adb(str(fake)) == fake


def test_a_wrong_configured_path_does_not_fall_back_to_the_search(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("shutil.which", lambda name: str(tmp_path / "adb"))
    assert locate_adb(str(tmp_path / "nao-existe")) is None


def test_locate_adb_searches_the_path_then_the_android_sdk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("shutil.which", lambda name: None)
    assert locate_adb(None) is None
    sdk = tmp_path / "localappdata" / "Android" / "Sdk" / "platform-tools"
    sdk.mkdir(parents=True)
    exe = sdk / ("adb.exe" if sys.platform == "win32" else "adb")
    exe.write_text("x")
    assert locate_adb(None) == exe
    on_path = tmp_path / "bin-adb"
    monkeypatch.setattr("shutil.which", lambda name: str(on_path))
    assert locate_adb(None) == on_path


# --- religar o serviço do controle (vigia) -------------------------------------------------------

REMOTE_SERVICE = "com.google.android.tv.remote.service"
SHIELD = (
    f"dumpsys deviceidle whitelist +{REMOTE_SERVICE}",
    f"cmd appops set {REMOTE_SERVICE} RUN_ANY_IN_BACKGROUND allow",
    f"am set-standby-bucket {REMOTE_SERVICE} active",
)
START = (
    "am start-foreground-service -a com.android.athome.START_SERVICE "
    f"-n {REMOTE_SERVICE}/.RemoteService"
)


def restart_script(start_reply: AdbOutput | None = None) -> FakeAdbRunner:
    runner = authorized()
    for command in SHIELD:
        runner.script[shell(command)] = ok("")
    runner.script[shell(START)] = start_reply or ok("Starting service: Intent { act=x }\r\n")
    return runner


async def test_restart_remote_service_reconnects_then_shields_then_starts_it() -> None:
    runner = restart_script()
    adb = make(runner)
    await adb.restart_remote_service()
    assert runner.calls == [CONNECT, GET_STATE, *(shell(c) for c in (*SHIELD, START))]
    assert runner.executables == {str(ADB)}


async def test_restart_remote_service_does_not_trust_a_connection_from_before_a_reboot() -> None:
    runner = restart_script()
    adb = make(runner)
    await adb.connect()
    runner.calls.clear()
    await adb.restart_remote_service()
    assert runner.calls[:2] == [CONNECT, GET_STATE]


async def test_restart_remote_service_ignores_a_shield_that_fails_but_not_a_failed_start() -> None:
    runner = restart_script(ok("Error: Not found; no service started.\r\n"))
    runner.script[shell(SHIELD[1])] = ok("Unknown option: RUN_ANY_IN_BACKGROUND", returncode=255)
    with pytest.raises(AdbCommandFailed):
        await make(runner).restart_remote_service()
    assert runner.shell_commands() == [*SHIELD, START]


async def test_restart_remote_service_without_authorization_runs_no_shell_command() -> None:
    runner = FakeAdbRunner(
        {CONNECT: ok(f"failed to authenticate to {SERIAL}\r\n"), GET_STATE: ok("unauthorized")}
    )
    with pytest.raises(AdbUnauthorized):
        await make(runner).restart_remote_service()
    assert runner.shell_commands() == []
