"""Pareamento da Android TV pelo app (`tv.pair.v1`): dois passos, sempre por toque do dono."""

import asyncio
import logging
from collections.abc import Awaitable, Callable

import pytest

from uniover_agent.core import (
    TV_NOT_PAIRED,
    TV_UNREACHABLE,
    Command,
    CommandResult,
    ResultStatus,
    TvSessionError,
)
from uniover_agent.core.tv.pairing import TvPairing
from uniover_agent.ports import TvPairingFailed

CODE = "A1B2C3"


class Pairing:
    """Pareamento com o `pair_tv` trocado por um duplo que registra o que recebeu."""

    def __init__(self, *, code_seconds: float = 5.0, step_seconds: float = 2.0) -> None:
        self.runs = 0
        self.codes: list[str] = []
        self.paired = 0
        self.on_run: Callable[[], Awaitable[None]] | None = None
        self.on_paired: Callable[[], Awaitable[None]] | None = None
        self.service = TvPairing(
            self._run, self._paired, code_seconds=code_seconds, step_seconds=step_seconds
        )
        self.handle = self.service.handler()

    async def _run(self, ask_code: Callable[[], Awaitable[str]]) -> None:
        self.runs += 1
        if self.on_run is not None:
            await self.on_run()
        self.codes.append(await ask_code())

    async def _paired(self) -> None:
        self.paired += 1
        if self.on_paired is not None:
            await self.on_paired()

    async def send(self, code: str | None = None) -> CommandResult:
        body = {} if code is None else {"code": code}
        return await self.handle(Command("c-1", "tv.pair.v1", body))


async def test_nothing_talks_to_the_tv_until_the_owner_asks() -> None:
    pairing = Pairing()
    await asyncio.sleep(0.05)
    assert pairing.runs == 0 and pairing.paired == 0


async def test_first_step_shows_the_code_and_answers_ok() -> None:
    pairing = Pairing()
    result = await pairing.send()
    assert result.status is ResultStatus.OK
    assert pairing.runs == 1 and pairing.paired == 0
    await pairing.service.aclose()


async def test_both_steps_pair_the_tv_and_reopen_the_session() -> None:
    pairing = Pairing()
    await pairing.send()
    result = await pairing.send(CODE)
    assert result.status is ResultStatus.OK
    assert pairing.codes == [CODE]
    assert pairing.paired == 1


async def test_a_tv_that_does_not_answer_fails_the_first_step_with_its_reason() -> None:
    pairing = Pairing()

    async def unreachable() -> None:
        raise TvPairingFailed("não consegui falar com a TV", "tv_unreachable")

    pairing.on_run = unreachable
    result = await pairing.send()
    assert result.status is ResultStatus.FAILED
    assert result.code == "tv_unreachable"


async def test_a_tv_that_never_shows_the_code_times_out_the_first_step() -> None:
    pairing = Pairing(step_seconds=0.05)

    async def hang() -> None:
        await asyncio.sleep(30)

    pairing.on_run = hang
    result = await pairing.send()
    assert result.status is ResultStatus.FAILED
    assert result.code == "tv_unreachable"


async def test_the_code_without_a_started_pairing_is_refused() -> None:
    pairing = Pairing()
    result = await pairing.send(CODE)
    assert result.status is ResultStatus.REJECTED
    assert result.code == "pair_not_started"
    assert pairing.paired == 0


async def test_a_code_the_tv_refuses_fails_with_invalid_code_and_does_not_reopen() -> None:
    pairing = Pairing()

    async def run(ask_code: Callable[[], Awaitable[str]]) -> None:
        await ask_code()
        raise TvPairingFailed("a TV não aceitou o código", "invalid_code")

    pairing.service = TvPairing(run, pairing._paired, code_seconds=5, step_seconds=2)
    pairing.handle = pairing.service.handler()
    await pairing.send()
    result = await pairing.send(CODE)
    assert result.status is ResultStatus.FAILED
    assert result.code == "invalid_code"
    assert pairing.paired == 0
    # O pareamento acabou: um novo código exige recomeçar pelo primeiro passo.
    again = await pairing.send(CODE)
    assert again.code == "pair_not_started"


async def test_an_expired_code_asks_to_start_again() -> None:
    pairing = Pairing(code_seconds=0.05)
    await pairing.send()
    await asyncio.sleep(0.2)
    result = await pairing.send(CODE)
    assert result.status is ResultStatus.REJECTED
    assert result.code == "pair_not_started"


async def test_asking_again_replaces_the_previous_pairing() -> None:
    pairing = Pairing()
    await pairing.send()
    await pairing.send()
    assert pairing.runs == 2
    result = await pairing.send(CODE)
    assert result.status is ResultStatus.OK
    assert pairing.codes == [CODE]


async def test_a_session_that_still_refuses_the_certificate_is_a_failed_pairing() -> None:
    pairing = Pairing()

    async def still_refused() -> None:
        raise TvSessionError(TV_NOT_PAIRED, "a TV ainda não foi pareada")

    pairing.on_paired = still_refused
    await pairing.send()
    result = await pairing.send(CODE)
    assert result.status is ResultStatus.FAILED
    assert result.code == "pair_failed"


async def test_a_tv_that_is_off_after_pairing_does_not_undo_it() -> None:
    pairing = Pairing()

    async def off() -> None:
        raise TvSessionError(TV_UNREACHABLE, "a TV não respondeu")

    pairing.on_paired = off
    await pairing.send()
    result = await pairing.send(CODE)
    assert result.status is ResultStatus.OK


async def test_a_code_that_is_not_text_is_rejected() -> None:
    pairing = Pairing()
    result = await pairing.handle(Command("c-1", "tv.pair.v1", {"code": 123456}))
    assert result.status is ResultStatus.REJECTED


async def test_the_code_never_reaches_the_log_or_the_result(
    caplog: pytest.LogCaptureFixture,
) -> None:
    pairing = Pairing()

    async def boom(ask_code: Callable[[], Awaitable[str]]) -> None:
        code = await ask_code()
        raise RuntimeError(f"a biblioteca falhou com o código {code}")

    service = TvPairing(boom, pairing._paired, code_seconds=5, step_seconds=2)
    handle = service.handler()
    with caplog.at_level(logging.DEBUG):
        await handle(Command("c-1", "tv.pair.v1", {}))
        result = await handle(Command("c-2", "tv.pair.v1", {"code": CODE}))
    assert result.status is ResultStatus.FAILED
    assert CODE not in result.detail
    assert CODE not in caplog.text
