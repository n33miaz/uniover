import logging

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.core import (
    Command,
    CommandResult,
    HandleCommand,
    ResultStatus,
    TvSessionManager,
    tv_key_handler,
)


def make() -> tuple[HandleCommand, FakeTvRemote]:
    clock, tv = FakeClock(), FakeTvRemote()
    session = TvSessionManager(clock, tv)
    return HandleCommand({"tv.key.v1": tv_key_handler(session)}, clock), tv


async def test_known_command_executes() -> None:
    use_case, tv = make()
    result = await use_case(Command("1", "tv.key.v1", {"key": "VOLUME_UP"}))
    assert result.status is ResultStatus.OK
    assert tv.keys == ["VOLUME_UP"]


async def test_unknown_command_is_rejected_and_logged(caplog: pytest.LogCaptureFixture) -> None:
    use_case, tv = make()
    with caplog.at_level(logging.WARNING):
        result = await use_case(Command("2", "tv.explode.v1"))
    assert result.status is ResultStatus.REJECTED
    assert "tv.explode.v1" in result.detail
    assert "tipo desconhecido" in caplog.text
    assert tv.keys == []


async def test_missing_key_is_rejected() -> None:
    use_case, _ = make()
    result = await use_case(Command("3", "tv.key.v1", {}))
    assert result.status is ResultStatus.REJECTED


async def test_handler_failure_is_reported() -> None:
    async def boom(command: Command) -> CommandResult:
        raise RuntimeError("tv offline")

    use_case = HandleCommand({"x.v1": boom}, FakeClock())
    result = await use_case(Command("4", "x.v1"))
    assert result.status is ResultStatus.FAILED
    assert result.detail == "tv offline"
