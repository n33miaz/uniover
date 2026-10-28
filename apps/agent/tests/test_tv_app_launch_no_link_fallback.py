"""Abrir app por pacote nunca vira link por conta própria.

Um link como `vnd.youtube://` é resolvido pela TV e não garante o pacote pedido; e um erro do ADB
(`adb_unreachable`, `adb_unauthorized`) pode vir depois de o `am start` já ter saído, então repetir
por outro caminho abriria o app duas vezes.
"""

import pytest

from uniover_agent.core import Command, ResultStatus, tv_app_launch_handler
from uniover_agent.core.tv.handlers import UNSUPPORTED
from uniover_agent.ports import (
    AdbCommandFailed,
    AdbError,
    AdbTimeout,
    AdbUnauthorized,
    AdbUnavailable,
    AdbUnreachable,
)

from .test_tv_apps import Env

YOUTUBE = "com.google.android.youtube.tv"


@pytest.mark.parametrize(
    "error",
    [
        AdbUnauthorized("x"),
        AdbUnavailable("x"),
        AdbUnreachable("x"),
        AdbTimeout("x"),
        AdbCommandFailed("x"),
    ],
)
async def test_an_adb_failure_on_a_package_launch_is_reported_and_never_turned_into_a_link(
    error: AdbError,
) -> None:
    env = Env()
    env.adb.errors = [error]
    handler = tv_app_launch_handler(env.manager, packages=env.apps)
    target = {"kind": "package", "value": YOUTUBE}
    result = await handler(Command("1", "tv.app.launch.v1", {"target": target}))
    assert result.status is ResultStatus.FAILED
    assert result.code == error.code
    assert env.remote.links == []


async def test_without_the_adb_channel_a_package_launch_stays_unsupported() -> None:
    env = Env()
    handler = tv_app_launch_handler(env.manager)
    target = {"kind": "package", "value": YOUTUBE}
    result = await handler(Command("1", "tv.app.launch.v1", {"target": target}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, UNSUPPORTED)
    assert env.remote.links == []
