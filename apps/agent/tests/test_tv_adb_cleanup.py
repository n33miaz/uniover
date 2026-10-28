"""Limpeza da TV no adaptador: `argv` exato de cada comando e a sequência inteira ponta a ponta.

O processo é o dublê `FakeAdbRunner`: nenhum teste roda o `adb` de verdade. As amostras de
`MemAvailable` e de `ps -A` seguem o formato do Linux e do toybox do Android; **não foram colhidas
da TV real** (a leitura de `query-activities` e de `pm list packages -3` é a amostra real dela).
"""

import asyncio

import pytest

from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.core import TvCleanup
from uniover_agent.ports import AdbCommandFailed, AdbTimeout, AdbUnreachable

from .support_adb import (
    ADB,
    CONNECT,
    GET_STATE,
    HOST,
    LEANBACK_QUERY,
    LEANBACK_SAMPLE,
    NOISE,
    PM_THIRD_PARTY,
    SERIAL,
    THIRD_PARTY_SAMPLE,
    FakeAdbRunner,
    ok,
    shell,
)

MEMINFO = "MemAvailable:     262144 kB\r\n"
MEMINFO_AFTER = "MemAvailable:     655360 kB\r\n"
MEMORY = "grep MemAvailable /proc/meminfo"
HOME_QUERY = (
    "cmd package query-activities --brief -a android.intent.action.MAIN "
    "-c android.intent.category.HOME"
)
HOME_SAMPLE = (
    "1 activities found:\r\n"
    "  Activity #0:\r\n"
    "    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\r\n"
    "    com.google.android.tvlauncher/.MainActivity\r\n"
)
IME = "settings get secure default_input_method"
ACCESSIBILITY = "settings get secure enabled_accessibility_services"
PROCESSES = "ps -A"
PROCESSES_SAMPLE = (
    "USER      PID  PPID     VSZ    RSS WCHAN  ADDR S NAME\r\n"
    "root        1     0   10972   1128 0         0 S init\r\n"
    "root      300     2       0      0 0         0 S [kworker/0:1]\r\n"
    "system   1500   312 1600000  91000 0         0 S system_server\r\n"
    "u0_a12   1700   312 1500000  70000 0         0 S com.google.android.tvlauncher\r\n"
    "u0_a40   2345   312 1523456 148000 0         0 S com.cnvs.apptv\r\n"
    "u0_a41   2400   312 1400000  60000 0         0 S com.spotify.tv.android:service\r\n"
    "u0_a5    2500   312 1300000  50000 0         0 S com.google.android.tv.remote.service\r\n"
    "shell    9000     1   10000   2000 0         0 S sh\r\n"
)
HOME_KEY = "input keyevent KEYCODE_HOME"
KILL_ALL = "am kill-all"


def force_stop(package: str) -> str:
    return f"am force-stop '{package}'"


def make(runner: FakeAdbRunner) -> AdbTv:
    return AdbTv(ADB, HOST, 5555, timeout=1.0, runner=runner, monotonic=lambda: 0.0)


def authorized() -> FakeAdbRunner:
    runner = FakeAdbRunner()
    runner.connected()
    return runner


# --- um comando por operação --------------------------------------------------------------------


async def test_memory_reads_memavailable_in_whole_megabytes() -> None:
    runner = authorized()
    runner.script[shell(MEMORY)] = ok(NOISE + MEMINFO)
    assert await make(runner).memory_available_mb() == 256
    assert runner.calls[-1] == ("-s", SERIAL, "shell", MEMORY)


@pytest.mark.parametrize(
    "text", ["", "grep: /proc/meminfo: Permission denied\r\n", "MemFree: 5 kB"]
)
async def test_unreadable_memory_is_unknown_not_an_error(text: str) -> None:
    runner = authorized()
    runner.script[shell(MEMORY)] = ok(text)
    assert await make(runner).memory_available_mb() is None


async def test_home_packages_come_from_the_tv_home_category() -> None:
    runner = authorized()
    runner.script[shell(HOME_QUERY)] = ok(NOISE + HOME_SAMPLE)
    assert await make(runner).home_packages() == {"com.google.android.tvlauncher"}
    assert runner.shell_commands() == [HOME_QUERY]


async def test_every_package_that_answers_home_is_reported() -> None:
    runner = authorized()
    runner.script[shell(HOME_QUERY)] = ok(
        "2 activities found:\r\n  a.b/.One\r\n  com.tcl.launcher/.Home\r\n"
    )
    assert await make(runner).home_packages() == {"a.b", "com.tcl.launcher"}


@pytest.mark.parametrize("text", ["0 activities found:\r\n", "", "error: device offline\r\n"])
async def test_no_home_screen_named_is_a_failure_because_nothing_could_be_protected(
    text: str,
) -> None:
    runner = authorized()
    runner.script[shell(HOME_QUERY)] = ok(text)
    with pytest.raises(AdbCommandFailed):
        await make(runner).home_packages()


async def test_the_keyboard_in_use_is_the_package_of_the_component() -> None:
    runner = authorized()
    runner.script[shell(IME)] = ok(
        "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME\r\n"
    )
    assert await make(runner).input_method_package() == "com.google.android.inputmethod.latin"


@pytest.mark.parametrize("text", ["null\r\n", "", NOISE + "null\r\n"])
async def test_no_keyboard_defined_is_none(text: str) -> None:
    runner = authorized()
    runner.script[shell(IME)] = ok(text)
    assert await make(runner).input_method_package() is None


async def test_a_failing_settings_command_is_a_failure_not_an_empty_answer() -> None:
    runner = authorized()
    runner.script[shell(IME)] = ok("Exception occurred while executing 'get':\r\n", 255)
    with pytest.raises(AdbCommandFailed):
        await make(runner).input_method_package()
    runner.script[shell(ACCESSIBILITY)] = ok("", 1)
    with pytest.raises(AdbCommandFailed):
        await make(runner).accessibility_packages()


async def test_accessibility_services_are_split_on_colons() -> None:
    runner = authorized()
    runner.script[shell(ACCESSIBILITY)] = ok(
        "com.exemplo.leitor/com.exemplo.leitor.Servico:com.outro.voz/.VozService\r\n"
    )
    assert await make(runner).accessibility_packages() == {"com.exemplo.leitor", "com.outro.voz"}


async def test_no_accessibility_service_is_an_empty_set() -> None:
    runner = authorized()
    runner.script[shell(ACCESSIBILITY)] = ok("null\r\n")
    assert await make(runner).accessibility_packages() == frozenset()


async def test_running_packages_come_from_the_last_column_of_ps() -> None:
    runner = authorized()
    runner.script[shell(PROCESSES)] = ok(NOISE + PROCESSES_SAMPLE)
    assert await make(runner).running_packages() == {
        "com.google.android.tvlauncher",
        "com.cnvs.apptv",
        "com.spotify.tv.android",  # o processo `:service` conta para o pacote
        "com.google.android.tv.remote.service",
    }


@pytest.mark.parametrize("text", ["", "USER PID NAME\r\n", "ps: permission denied\r\n"])
async def test_a_process_list_without_any_app_is_a_failure(text: str) -> None:
    runner = authorized()
    runner.script[shell(PROCESSES)] = ok(text)
    with pytest.raises(AdbCommandFailed):
        await make(runner).running_packages()


async def test_home_key_kill_all_and_force_stop_argv_are_exact() -> None:
    runner = authorized()
    runner.script[shell(HOME_KEY)] = ok("")
    runner.script[shell(KILL_ALL)] = ok(NOISE)
    runner.script[shell(force_stop("com.cnvs.apptv"))] = ok("")
    adb = make(runner)
    await adb.go_home()
    await adb.kill_background()
    await adb.force_stop("com.cnvs.apptv")
    assert runner.calls[2:] == [
        ("-s", SERIAL, "shell", HOME_KEY),
        ("-s", SERIAL, "shell", KILL_ALL),
        ("-s", SERIAL, "shell", force_stop("com.cnvs.apptv")),
    ]
    assert runner.executables == {str(ADB)}


@pytest.mark.parametrize(
    "package",
    ["", "x", "com.x;reboot", "com.x app", "$(id).x", "com.x`id`", "../etc", "com.x\nreboot", "-a"],
)
async def test_force_stop_refuses_names_that_could_reach_the_shell(package: str) -> None:
    runner = authorized()
    with pytest.raises(ValueError, match="pacote"):
        await make(runner).force_stop(package)
    assert runner.calls == []


@pytest.mark.parametrize("text", ["Error: something\r\n", "Exception occurred while executing\r\n"])
async def test_the_tv_reporting_an_error_is_a_failed_step(text: str) -> None:
    runner = authorized()
    runner.script[shell(force_stop("com.x.app"))] = ok(text)
    runner.script[shell(HOME_KEY)] = ok("", 1)
    adb = make(runner)
    with pytest.raises(AdbCommandFailed):
        await adb.force_stop("com.x.app")
    with pytest.raises(AdbCommandFailed):
        await adb.go_home()


async def test_a_dropped_connection_in_a_cleanup_command_is_reported_as_unreachable() -> None:
    runner = authorized()
    runner.script[shell(KILL_ALL)] = ok("error: device offline\r\n", 1)
    adb = make(runner)
    with pytest.raises(AdbUnreachable):
        await adb.kill_background()
    assert not adb.connected


async def test_a_cleanup_command_without_an_open_channel_connects_first() -> None:
    runner = authorized()
    runner.script[shell(MEMORY)] = ok(MEMINFO)
    await make(runner).memory_available_mb()
    assert runner.calls[:2] == [CONNECT, GET_STATE]


async def test_cleanup_commands_take_the_same_lock_as_the_others() -> None:
    runner = authorized()
    runner.delay = 0.01
    runner.script[shell(MEMORY)] = ok(MEMINFO)
    runner.script[shell(HOME_KEY)] = ok("")
    runner.script[shell(KILL_ALL)] = ok("")
    adb = make(runner)
    await asyncio.gather(adb.memory_available_mb(), adb.go_home(), adb.kill_background())
    assert runner.max_running == 1


# --- a sequência inteira, do núcleo ao `argv` -------------------------------------------------


def full_cleanup_runner() -> FakeAdbRunner:
    runner = authorized()
    runner.script[shell(MEMORY)] = [ok(MEMINFO), ok(MEMINFO_AFTER)]
    runner.script[shell(LEANBACK_QUERY)] = ok(NOISE + LEANBACK_SAMPLE)
    runner.script[shell(PM_THIRD_PARTY)] = ok(NOISE + THIRD_PARTY_SAMPLE)
    runner.script[shell(HOME_QUERY)] = ok(HOME_SAMPLE)
    runner.script[shell(IME)] = ok("com.google.android.inputmethod.latin/.LatinIME\r\n")
    runner.script[shell(ACCESSIBILITY)] = ok("null\r\n")
    runner.script[shell(PROCESSES)] = ok(PROCESSES_SAMPLE)
    runner.script[shell(HOME_KEY)] = ok("")
    runner.script[shell(KILL_ALL)] = ok("")
    runner.script[shell(force_stop("com.cnvs.apptv"))] = ok("")
    runner.script[shell(force_stop("com.spotify.tv.android"))] = ok("")
    return runner


# Tudo o que a limpeza pode pedir ao `adb`, e nada além disto.
FORBIDDEN = (
    "kill-server",
    "disconnect",
    "reboot",
    "pm clear",
    "uninstall",
    "disable",
    "drop_caches",
    "trim-caches",
    "su ",
    "svc ",
)


async def test_the_whole_cleanup_runs_exactly_these_adb_commands() -> None:
    runner = full_cleanup_runner()
    report = await TvCleanup(make(runner), FakeClock(), allow_app_closing=True).run()
    assert runner.calls == [
        CONNECT,
        GET_STATE,
        shell(MEMORY),
        shell(LEANBACK_QUERY),
        shell(PM_THIRD_PARTY),
        shell(HOME_QUERY),
        shell(IME),
        shell(ACCESSIBILITY),
        shell(PROCESSES),
        shell(HOME_KEY),
        shell(KILL_ALL),
        shell(force_stop("com.cnvs.apptv")),
        shell(force_stop("com.spotify.tv.android")),
        shell(MEMORY),
    ]
    # CineVS e Spotify estão abertos e são do dono. O lançador, o serviço do controle e as peças da
    # TCL (`com.tcl.*`), mesmo vivos e iniciáveis, ficam como estão; Configurações e YouTube não
    # estavam rodando.
    assert report.closed_apps == 2
    assert (report.memory_before_mb, report.memory_after_mb, report.freed_mb) == (256, 640, 384)
    assert report.failed_steps == ()


async def test_no_forbidden_command_ever_reaches_the_adb() -> None:
    runner = full_cleanup_runner()
    await TvCleanup(make(runner), FakeClock(), allow_app_closing=True).run()
    commands = [" ".join(call) for call in runner.calls]
    for call in commands:
        assert not any(word in call for word in FORBIDDEN), call
    # Fora a abertura do canal (`connect` e `get-state`), tudo é um comando de shell da TV.
    assert [call for call in runner.calls if call[2:3] != ("shell",)] == [CONNECT, GET_STATE]
    assert all(len(call) == 4 for call in runner.calls if call[2:3] == ("shell",))


def trim_memory(package: str) -> str:
    return f"am send-trim-memory '{package}' RUNNING_CRITICAL"


def mutating_app_commands(runner: FakeAdbRunner) -> list[str]:
    """Comandos que fecham, matam ou alteram app. `pm list packages` só lê a lista: fica de fora."""
    return [
        command
        for command in runner.shell_commands()
        if command.startswith(("am force-stop", "am kill", "am start", "input keyevent"))
        or (command.startswith("pm ") and not command.startswith("pm list packages"))
    ]


async def test_with_the_option_off_no_command_stops_kills_or_changes_an_app() -> None:
    """Regra do dono: apps da TV dele não são tocados. O padrão do `TvCleanup` é desligado."""
    for trim_only_run in ("manual", "light", "light-without-foreground"):
        runner = full_cleanup_runner()
        runner.script[shell(trim_memory("com.cnvs.apptv"))] = ok("")
        runner.script[shell(trim_memory("com.spotify.tv.android"))] = ok("")
        cleanup = TvCleanup(make(runner), FakeClock())
        if trim_only_run == "manual":
            report = await cleanup.run()
        elif trim_only_run == "light":
            report = await cleanup.run_light("com.spotify.tv.android")
        else:
            report = await cleanup.run_light(None)
        assert mutating_app_commands(runner) == [], trim_only_run
        assert report.closed_apps == 0, trim_only_run
        assert report.closed_packages == (), trim_only_run
    # A limpeza manual com a opção desligada ainda alivia a memória, só que sem encerrar nada.
    runner = full_cleanup_runner()
    runner.script[shell(trim_memory("com.cnvs.apptv"))] = ok("")
    runner.script[shell(trim_memory("com.spotify.tv.android"))] = ok("")
    await TvCleanup(make(runner), FakeClock()).run()
    assert [c for c in runner.shell_commands() if "send-trim-memory" in c] == [
        trim_memory("com.cnvs.apptv"),
        trim_memory("com.spotify.tv.android"),
    ]


async def test_with_the_option_on_the_light_cleanup_still_never_stops_the_foreground_app() -> None:
    runner = full_cleanup_runner()
    runner.script[shell(trim_memory("com.cnvs.apptv"))] = ok("")
    await TvCleanup(make(runner), FakeClock(), allow_app_closing=True).run_light(
        "com.spotify.tv.android"
    )
    commands = runner.shell_commands()
    assert force_stop("com.cnvs.apptv") in commands
    assert force_stop("com.spotify.tv.android") not in commands
    assert HOME_KEY not in commands


async def test_a_tv_that_goes_silent_mid_cleanup_stops_the_sequence_there() -> None:
    runner = full_cleanup_runner()
    runner.script[shell(KILL_ALL)] = TimeoutError()
    report = await TvCleanup(make(runner), FakeClock(), allow_app_closing=True).run()
    assert runner.shell_commands()[-1] == KILL_ALL
    assert report.failed_steps == ("kill-background", "adb-lost")
    assert report.closed_apps == 0
    assert report.memory_after_mb is None


async def test_a_timeout_in_a_cleanup_command_is_typed() -> None:
    runner = authorized()
    runner.script[shell(MEMORY)] = TimeoutError()
    with pytest.raises(AdbTimeout):
        await make(runner).memory_available_mb()
