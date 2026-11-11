"""Pareamento da Android TV pelo app (`tv.pair.v1`): dois passos, sempre por toque do dono."""

import asyncio
import logging
from collections.abc import Awaitable, Callable

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.core import (
    TV_UNREACHABLE,
    Command,
    CommandResult,
    ResultStatus,
    TvSessionError,
    TvSessionManager,
)
from uniover_agent.core.tv.pairing import TvPairing
from uniover_agent.ports import TvCertificateRefused, TvPairingFailed

CODE = "A1B2C3"


class Pairing:
    """Pareamento com o `pair_tv` trocado por um duplo que registra o que recebeu."""

    def __init__(
        self, *, code_seconds: float = 5.0, step_seconds: float = 2.0, lock_seconds: float = 2.0
    ) -> None:
        self.runs = 0
        self.codes: list[str] = []
        self.paired = 0
        self.on_run: Callable[[], Awaitable[None]] | None = None
        self.on_paired: Callable[[], Awaitable[None]] | None = None
        self.service = TvPairing(
            self._run,
            self._paired,
            code_seconds=code_seconds,
            step_seconds=step_seconds,
            lock_seconds=lock_seconds,
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

    async def send(self, code: str | None = None, *, cancel: bool = False) -> CommandResult:
        body: dict[str, object] = {"cancel": True} if cancel else {}
        if code is not None:
            body["code"] = code
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
    await pairing.service.settled()
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


async def test_an_expired_code_keeps_its_cause_and_then_asks_to_start_again() -> None:
    pairing = Pairing(code_seconds=0.05)
    await pairing.send()
    await asyncio.sleep(0.2)
    result = await pairing.send(CODE)
    assert result.status is ResultStatus.FAILED
    assert result.code == "pair_timeout"
    # A causa vale uma vez; depois disso é um pedido sem pareamento esperando.
    again = await pairing.send(CODE)
    assert again.code == "pair_not_started"


async def test_asking_again_replaces_the_previous_pairing() -> None:
    pairing = Pairing()
    await pairing.send()
    await pairing.send()
    assert pairing.runs == 2
    result = await pairing.send(CODE)
    assert result.status is ResultStatus.OK
    assert pairing.codes == [CODE]


async def test_a_tv_that_still_refuses_after_pairing_ends_up_not_paired_never_paired() -> None:
    # O caminho de verdade: o gerenciador de sessão real, com a TV recusando o certificado.
    clock = FakeClock()
    remote = FakeTvRemote()
    manager = TvSessionManager(clock, remote)
    remote.connect_errors = [TvCertificateRefused("recusado") for _ in range(50)]
    for _ in range(3):
        with pytest.raises(TvSessionError):
            await manager.wake()
        clock.advance(30)
    assert manager.snapshot().connection == "not_paired"

    async def run(ask_code: Callable[[], Awaitable[str]]) -> None:
        await ask_code()

    service = TvPairing(run, manager.pairing_done, step_seconds=2, lock_seconds=2)
    handle = service.handler()
    await handle(Command("1", "tv.pair.v1", {}))
    result = await handle(Command("2", "tv.pair.v1", {"code": CODE}))
    await service.settled()
    # O par foi aceito, mas a sessão não abriu: o app confere pelo estado, que segue `not_paired`.
    assert result.status is ResultStatus.OK
    assert manager.snapshot().connection == "not_paired"
    assert remote.keys == []

    # Agora a TV aceita: a mesma sequência abre a sessão e o estado sai de `not_paired`.
    remote.connect_errors.clear()
    await handle(Command("3", "tv.pair.v1", {}))
    await handle(Command("4", "tv.pair.v1", {"code": CODE}))
    await service.settled()
    assert manager.snapshot().connection == "hot"


async def test_the_answer_comes_as_soon_as_the_pairing_succeeds_and_the_reopen_follows() -> None:
    pairing = Pairing()
    release = asyncio.Event()

    async def slow_reopen() -> None:
        await release.wait()

    pairing.on_paired = slow_reopen
    await pairing.send()
    result = await asyncio.wait_for(pairing.send(CODE), 1)
    assert result.status is ResultStatus.OK
    await asyncio.sleep(0)
    assert pairing.paired == 1  # a reabertura começou e ainda não acabou
    release.set()
    await pairing.service.settled()


async def test_a_tv_that_is_off_after_pairing_does_not_undo_it() -> None:
    pairing = Pairing()

    async def off() -> None:
        raise TvSessionError(TV_UNREACHABLE, "a TV não respondeu")

    pairing.on_paired = off
    await pairing.send()
    result = await pairing.send(CODE)
    await pairing.service.settled()
    assert result.status is ResultStatus.OK


async def test_cancel_drops_the_waiting_pairing_and_the_code_is_no_longer_taken() -> None:
    pairing = Pairing()
    await pairing.send()
    cancelled = await pairing.send(cancel=True)
    assert cancelled.status is ResultStatus.OK
    result = await pairing.send(CODE)
    assert result.code == "pair_not_started"
    assert pairing.codes == [] and pairing.paired == 0


async def test_cancel_with_nothing_pending_is_harmless() -> None:
    pairing = Pairing()
    assert (await pairing.send(cancel=True)).status is ResultStatus.OK
    assert pairing.runs == 0


async def test_a_second_request_waits_a_little_and_then_says_busy() -> None:
    pairing = Pairing(lock_seconds=0.05)
    gate = asyncio.Event()

    async def hang() -> None:
        await gate.wait()

    pairing.on_run = hang
    first = asyncio.create_task(pairing.send())
    await asyncio.sleep(0.01)
    second = await pairing.send(cancel=True)
    assert second.status is ResultStatus.REJECTED
    assert second.code == "pair_busy"
    gate.set()
    await first
    await pairing.service.aclose()


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
