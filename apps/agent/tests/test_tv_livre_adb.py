"""Adaptador ADB do TV Livre: `argv` exato de `shell`, `push` e `install`, sem processo real."""

from pathlib import Path

import pytest

from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.ports import AdbCommandFailed, AdbUnreachable

from .support_adb import ADB, CONNECT, HOST, SERIAL, FakeAdbRunner, ok, shell


def make(runner: FakeAdbRunner) -> AdbTv:
    return AdbTv(ADB, HOST, 5555, timeout=1.0, runner=runner, monotonic=lambda: 0.0)


def authorized() -> FakeAdbRunner:
    runner = FakeAdbRunner()
    runner.connected()
    return runner


async def test_shell_runs_the_fixed_command_and_reports_success() -> None:
    runner = authorized()
    runner.script[shell("pm path br.uniover.launcher")] = ok("package:/data/app/x/base.apk\n")

    result = await make(runner).shell("pm path br.uniover.launcher")

    assert result.ok is True
    assert "package:" in result.text
    assert runner.calls[-1] == ("-s", SERIAL, "shell", "pm path br.uniover.launcher")


async def test_shell_reports_a_non_zero_exit_as_not_ok() -> None:
    runner = authorized()
    runner.script[shell("ls /sdcard/Android/data/br.uniover.launcher/files")] = ok(
        "No such file or directory\n", returncode=1
    )

    result = await make(runner).shell("ls /sdcard/Android/data/br.uniover.launcher/files")

    assert result.ok is False


async def test_push_copies_the_file_with_a_long_timeout(tmp_path: Path) -> None:
    runner = authorized()
    local = tmp_path / "config.json"
    local.write_text("{}", encoding="utf-8")
    remote = "/sdcard/Android/data/br.uniover.launcher/files/config.json.tmp"
    runner.script[("-s", SERIAL, "push", str(local), remote)] = ok("1 file pushed\n")

    await make(runner).push(local, remote)

    assert runner.calls[-1] == ("-s", SERIAL, "push", str(local), remote)


async def test_a_failed_push_raises(tmp_path: Path) -> None:
    runner = authorized()
    local = tmp_path / "config.json"
    remote = "/sdcard/x.tmp"
    runner.script[("-s", SERIAL, "push", str(local), remote)] = ok("adb: error\n", returncode=1)

    with pytest.raises(AdbCommandFailed):
        await make(runner).push(local, remote)


async def test_install_replaces_in_place_and_returns_the_reason_on_failure(tmp_path: Path) -> None:
    runner = authorized()
    apk = tmp_path / "uniover-launcher.apk"
    runner.script[("-s", SERIAL, "install", "-r", str(apk))] = ok(
        "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n", returncode=1
    )

    result = await make(runner).install(apk)

    assert result.ok is False
    assert "INSTALL_FAILED_UPDATE_INCOMPATIBLE" in result.text


async def test_a_tv_that_does_not_answer_raises_before_any_command() -> None:
    runner = FakeAdbRunner({CONNECT: ok("failed to connect to " + SERIAL)})

    with pytest.raises(AdbUnreachable):
        await make(runner).shell("getprop ro.build.version.sdk")

    assert runner.calls == [CONNECT]
