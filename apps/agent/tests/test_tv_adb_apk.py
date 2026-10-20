"""Cópia de APK pelo ADB: saídas reais, `argv` exato, sem a trava dos comandos curtos."""

import asyncio
from collections.abc import Sequence
from pathlib import Path

import pytest

from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_adb_parsing import (
    AdbOutput,
    is_valid_remote_apk_path,
    parse_package_paths,
    parse_package_versions,
)
from uniover_agent.ports import (
    AdbCommandFailed,
    AdbTimeout,
    AdbUnauthorized,
    AdbUnreachable,
)

from .support_adb import ADB, HOST, SERIAL, FakeAdbRunner, ok, shell

# `pm path` medido na TCL: app com APKs divididos (Spotify) e app de sistema (Configurações).
PM_PATH_SPLIT = (
    "package:/data/app/~~xlDbtkHsq6dwowObXMLAmA==/com.spotify.tv.android-Fb9qP_4XQRuVK_A4t5UC7Q==/"
    "split_config.armeabi_v7a.apk\r\n"
    "package:/data/app/~~xlDbtkHsq6dwowObXMLAmA==/com.spotify.tv.android-Fb9qP_4XQRuVK_A4t5UC7Q==/"
    "base.apk\r\n"
    "package:/data/app/~~xlDbtkHsq6dwowObXMLAmA==/com.spotify.tv.android-Fb9qP_4XQRuVK_A4t5UC7Q==/"
    "split_config.tvdpi.apk\r\n"
)
BASE_PATH = (
    "/data/app/~~xlDbtkHsq6dwowObXMLAmA==/com.spotify.tv.android-Fb9qP_4XQRuVK_A4t5UC7Q==/base.apk"
)
PM_PATH_SYSTEM = "package:/system_ext/priv-app/TvSettings/TvSettings.apk\r\n"

# `pm list packages --show-versioncode` medido na TCL.
VERSIONS_SAMPLE = (
    "Init wrapper sys mutex successful...\r\n"
    "package:com.android.cts.priv.ctsshim versionCode:30\r\n"
    "package:com.android.tv.settings versionCode:1\r\n"
    "package:com.spotify.tv.android versionCode:2340200\r\n"
    "package:com.cnvs.apptv versionCode:50\r\n"
    "package:invalido versionCode:9\r\n"
    "package:com.sem.versao\r\n"
)
PM_VERSIONS = "pm list packages --show-versioncode"


def test_pm_path_with_splits_lists_the_base_apk_first() -> None:
    paths = parse_package_paths(PM_PATH_SPLIT)
    assert paths[0] == BASE_PATH
    assert len(paths) == 3
    # O resto mantém a ordem em que a TV devolveu.
    assert [path.rsplit("/", 1)[1] for path in paths[1:]] == [
        "split_config.armeabi_v7a.apk",
        "split_config.tvdpi.apk",
    ]


def test_pm_path_of_a_system_app() -> None:
    assert parse_package_paths(PM_PATH_SYSTEM) == ["/system_ext/priv-app/TvSettings/TvSettings.apk"]


@pytest.mark.parametrize(
    "text",
    [
        "",
        "package:/data/app/../etc/passwd.apk\n",
        "package:/data/app/a b/base.apk\n",
        "package:/data/app/a;rm/base.apk\n",
        "package:/data/app/$(x)/base.apk\n",
        "package:data/app/base.apk\n",
        "package:/data/app/base.txt\n",
        "package:/data/app/'a'/base.apk\n",
        "Error: package not found\n",
    ],
)
def test_pm_path_ignores_anything_outside_the_strict_format(text: str) -> None:
    assert parse_package_paths(text) == []


def test_remote_path_validation_has_a_length_cap() -> None:
    assert is_valid_remote_apk_path("/data/app/~~a==/com.a.b-c==/base.apk")
    assert not is_valid_remote_apk_path("/" + "a" * 600 + ".apk")


def test_versions_are_read_ignoring_noise_and_bad_lines() -> None:
    assert parse_package_versions(VERSIONS_SAMPLE) == {
        "com.android.cts.priv.ctsshim": 30,
        "com.android.tv.settings": 1,
        "com.spotify.tv.android": 2340200,
        "com.cnvs.apptv": 50,
    }


# --- operações do adaptador ---------------------------------------------------------------------


class Clock:
    def __call__(self) -> float:
        return 0.0


def make(runner: FakeAdbRunner) -> AdbTv:
    return AdbTv(ADB, HOST, 5555, timeout=1.0, pull_timeout=77.0, runner=runner, monotonic=Clock())


def authorized() -> FakeAdbRunner:
    runner = FakeAdbRunner()
    runner.connected()
    return runner


async def test_package_versions_is_one_short_shell_command() -> None:
    runner = authorized()
    runner.script[shell(PM_VERSIONS)] = ok(VERSIONS_SAMPLE)
    versions = await make(runner).package_versions()
    assert versions["com.cnvs.apptv"] == 50
    assert runner.shell_commands() == [PM_VERSIONS]


async def test_apk_paths_quotes_the_package_and_returns_the_base_first() -> None:
    runner = authorized()
    runner.script[shell("pm path 'com.spotify.tv.android'")] = ok(PM_PATH_SPLIT)
    paths = await make(runner).apk_paths("com.spotify.tv.android")
    assert paths[0] == BASE_PATH


@pytest.mark.parametrize("package", ["com.a;reboot", "com.a b.c", "$(id).a.b", "sem_ponto", ""])
async def test_apk_paths_refuses_a_bad_package_before_any_process(package: str) -> None:
    runner = authorized()
    with pytest.raises(ValueError, match="pacote"):
        await make(runner).apk_paths(package)
    assert runner.calls == []


async def test_pull_runs_without_a_shell_with_its_own_timeout_and_no_reconnect(
    tmp_path: Path,
) -> None:
    runner = authorized()
    local = tmp_path / "app.apk"
    seen: list[tuple[Sequence[str], float]] = []

    async def run(argv: Sequence[str], seconds: float) -> AdbOutput:
        seen.append((list(argv), seconds))
        if "pull" in argv:
            local.write_bytes(b"apk")
            return ok("1 file pulled, 0 skipped. 5.2 MB/s\r\n")
        return await runner(argv, seconds)

    adb = AdbTv(ADB, HOST, 5555, timeout=1.0, pull_timeout=77.0, runner=run, monotonic=Clock())
    await adb.connect()
    seen.clear()
    await adb.pull_apk(BASE_PATH, local)
    assert seen == [([str(ADB), "-s", SERIAL, "pull", BASE_PATH, str(local)], 77.0)]
    assert adb.connected


async def test_pull_does_not_open_the_connection_itself(tmp_path: Path) -> None:
    runner = authorized()
    adb = make(runner)
    with pytest.raises(AdbUnreachable):
        await adb.pull_apk(BASE_PATH, tmp_path / "a.apk")
    assert runner.calls == []


@pytest.mark.parametrize(
    "remote",
    ["/data/app/../x/base.apk", "/data/app/a b/base.apk", "relativo/base.apk", "/data/x;y.apk"],
)
async def test_pull_refuses_a_bad_remote_path(remote: str, tmp_path: Path) -> None:
    runner = authorized()
    adb = make(runner)
    await adb.connect()
    calls_before = list(runner.calls)
    with pytest.raises(ValueError, match="caminho"):
        await adb.pull_apk(remote, tmp_path / "a.apk")
    assert runner.calls == calls_before


@pytest.mark.parametrize(
    ("reply", "error"),
    [
        (ok("adb: error: failed to stat remote object\r\n", 1), AdbCommandFailed),
        (ok("adb.exe: device offline\r\n", 1), AdbUnreachable),
        (ok("adb.exe: device '192.168.1.6:5555' not found\r\n", 1), AdbUnreachable),
        (ok("error: device unauthorized.\r\n", 1), AdbUnauthorized),
    ],
)
async def test_pull_failures_are_typed_and_a_dropped_channel_is_noticed(
    reply: AdbOutput, error: type[Exception], tmp_path: Path
) -> None:
    runner = authorized()
    adb = make(runner)
    await adb.connect()
    runner.script[("-s", SERIAL, "pull", BASE_PATH, str(tmp_path / "a.apk"))] = reply
    with pytest.raises(error):
        await adb.pull_apk(BASE_PATH, tmp_path / "a.apk")
    assert adb.connected is (error is AdbCommandFailed)


async def test_pull_with_exit_zero_but_no_file_is_a_failure(tmp_path: Path) -> None:
    runner = authorized()
    adb = make(runner)
    await adb.connect()
    runner.script[("-s", SERIAL, "pull", BASE_PATH, str(tmp_path / "a.apk"))] = ok("1 file pulled")
    with pytest.raises(AdbCommandFailed, match="não entregou"):
        await adb.pull_apk(BASE_PATH, tmp_path / "a.apk")


async def test_pull_with_an_empty_file_is_a_failure(tmp_path: Path) -> None:
    runner = authorized()
    local = tmp_path / "a.apk"
    local.write_bytes(b"")
    adb = make(runner)
    await adb.connect()
    runner.script[("-s", SERIAL, "pull", BASE_PATH, str(local))] = ok("1 file pulled")
    with pytest.raises(AdbCommandFailed):
        await adb.pull_apk(BASE_PATH, local)


async def test_a_slow_pull_times_out_without_marking_the_channel_down(tmp_path: Path) -> None:
    runner = authorized()
    adb = make(runner)
    await adb.connect()
    runner.script[("-s", SERIAL, "pull", BASE_PATH, str(tmp_path / "a.apk"))] = TimeoutError()
    with pytest.raises(AdbTimeout):
        await adb.pull_apk(BASE_PATH, tmp_path / "a.apk")
    # Um APK lento não prova que o canal caiu: as teclas e o texto seguem sem reconectar.
    assert adb.connected


class PullGate:
    """Processo falso em que o `pull` fica parado até o teste soltar; o resto responde na hora."""

    def __init__(self, inner: FakeAdbRunner) -> None:
        self.inner = inner
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        self.log: list[str] = []

    async def __call__(self, argv: Sequence[str], seconds: float) -> AdbOutput:
        if "pull" in argv:
            self.started.set()
            await self.release.wait()
            Path(argv[-1]).write_bytes(b"apk")  # noqa: ASYNC240
            self.log.append("pull-fim")
            return ok("1 file pulled\r\n")
        output = await self.inner(argv, seconds)
        self.log.append(argv[-1] if "shell" in argv else argv[1])
        return output


async def test_an_interactive_command_is_not_delayed_by_a_pull_in_progress(tmp_path: Path) -> None:
    inner = authorized()
    inner.script[shell("input text 'abc'")] = ok("")
    gate = PullGate(inner)
    adb = AdbTv(ADB, HOST, 5555, timeout=1.0, runner=gate, monotonic=Clock())
    await adb.connect()
    pulling = asyncio.create_task(adb.pull_apk(BASE_PATH, tmp_path / "a.apk"))
    await asyncio.wait_for(gate.started.wait(), 1.0)
    # O download está preso; o texto digitado passa por cima dele, sem esperar.
    await asyncio.wait_for(adb.input_text("abc"), 1.0)
    assert not pulling.done()
    assert gate.log[-1] == "input text 'abc'"
    gate.release.set()
    await pulling
    assert gate.log[-1] == "pull-fim"
    # Os comandos curtos continuam um por vez entre si.
    assert inner.max_running == 1


async def test_short_commands_still_queue_behind_each_other_while_a_pull_runs(
    tmp_path: Path,
) -> None:
    inner = authorized()
    inner.script[shell("input text 'a'")] = ok("")
    inner.script[shell("input text 'b'")] = ok("")
    inner.delay = 0.01
    gate = PullGate(inner)
    adb = AdbTv(ADB, HOST, 5555, timeout=1.0, runner=gate, monotonic=Clock())
    await adb.connect()
    pulling = asyncio.create_task(adb.pull_apk(BASE_PATH, tmp_path / "a.apk"))
    await asyncio.wait_for(gate.started.wait(), 1.0)
    await asyncio.gather(adb.input_text("a"), adb.input_text("b"))
    assert inner.max_running == 1
    gate.release.set()
    await pulling
