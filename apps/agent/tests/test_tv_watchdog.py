"""Vigia do serviço do controle: reparo limitado, descanso, sessão nunca presa em "reparando".

Relógio falso (as esperas só somam tempo), sessão real com o controle falso e o reparo roteirizado:
nenhum teste fala com a rede nem com o ADB.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvRemote
from uniover_agent.core import (
    EnvelopeFactory,
    EnvelopeGate,
    SessionState,
    TvSessionError,
    TvSessionManager,
    TvWatchdog,
    WatchdogEvents,
)
from uniover_agent.ports import (
    AdbCommandFailed,
    AdbTimeout,
    AdbUnauthorized,
    AdbUnreachable,
    TvPortClosed,
)

from .support import AGENT_ID


def state_of(manager: TvSessionManager) -> SessionState:
    # Função à parte: o mypy estreita `manager.state` depois de um `assert` e acusaria o próximo.
    return manager.state


class Rig:
    """Sessão real, portas e reparo roteirizados, e o transporte falso que recebe os eventos."""

    def __init__(self, **limits: Any) -> None:
        self.clock = FakeClock()
        self.remote = FakeTvRemote()
        self.manager = TvSessionManager(self.clock, self.remote)
        self.transport = FakeTransport()
        envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), self.clock)
        self.events = WatchdogEvents(self.transport, envelopes, self.clock)
        # Cada conferência de portas consome um item (o último se repete): `True` é o serviço de pé.
        self.ports: list[bool | Exception | None] = [False]
        self.checks = 0
        self.restarts = 0
        self.restart_script: list[Exception | None] = [None]
        self.restart_hook: Callable[[], Awaitable[None]] | None = None
        self.watchdog = TvWatchdog(
            self.clock, self.manager, self.ports_open, self.restart, self.events, **limits
        )

    async def ports_open(self) -> bool | None:
        self.checks += 1
        item = self.ports.pop(0) if len(self.ports) > 1 else self.ports[0]
        if isinstance(item, Exception):
            raise item
        return item

    async def restart(self) -> None:
        self.restarts += 1
        if self.restart_hook is not None:
            await self.restart_hook()
        script = self.restart_script
        item = script.pop(0) if len(script) > 1 else script[0]
        if item is not None:
            raise item

    async def sent_kinds(self) -> list[str]:
        await self.transport.connect()
        await self.events.flush()
        return [message["body"]["kind"] for message in self.transport.sent]


async def test_a_dead_service_is_restarted_at_once_and_the_session_is_released() -> None:
    rig = Rig()
    rig.ports = [False, True]
    seen: list[SessionState] = []

    async def spy() -> None:
        seen.append(state_of(rig.manager))

    rig.restart_hook = spy
    await rig.watchdog.handle()
    assert rig.restarts == 1
    assert seen == [SessionState.REPAIRING]  # durante o reparo os comandos são recusados
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert rig.clock.sleeps == [3.0]  # só a espera de o serviço subir: a 1ª tentativa é imediata
    assert await rig.sent_kinds() == ["repair_started", "repaired"]
    assert rig.transport.sent[-1]["body"]["attempts"] == 1


async def test_ports_that_answer_mean_nothing_is_done() -> None:
    rig = Rig()
    rig.ports = [True]
    await rig.watchdog.handle()
    assert rig.restarts == 0
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert await rig.sent_kinds() == []


async def test_a_tv_that_does_not_answer_at_all_is_in_standby_and_is_left_alone() -> None:
    rig = Rig()
    rig.ports = [None]
    await rig.watchdog.handle()
    assert rig.restarts == 0
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert await rig.sent_kinds() == []


async def test_a_tv_that_goes_silent_after_the_restart_is_not_reported_as_repaired() -> None:
    rig = Rig()
    rig.ports = [False, None]
    await rig.watchdog.handle()
    assert await rig.sent_kinds() == ["repair_started", "repair_failed"]


async def test_a_hot_session_is_left_alone() -> None:
    rig = Rig()
    await rig.manager.wake()
    await rig.watchdog.handle()
    assert rig.checks == 0
    assert rig.restarts == 0
    assert state_of(rig.manager) is SessionState.HOT


async def test_no_more_than_three_attempts_then_a_ten_minute_rest() -> None:
    rig = Rig()
    rig.ports = [False]
    await rig.watchdog.handle()
    assert rig.restarts == 3
    assert rig.clock.sleeps == [3.0, 15.0, 3.0, 45.0, 3.0]
    assert await rig.sent_kinds() == ["repair_started", "repair_failed"]
    failed = rig.transport.sent[-1]["body"]
    assert (failed["severity"], failed["attempts"]) == ("error", 3)
    assert state_of(rig.manager) is SessionState.HIBERNATING

    rig.clock.advance(599)
    checks = rig.checks
    await rig.watchdog.handle()  # ainda descansando: nem as portas são conferidas
    assert (rig.restarts, rig.checks) == (3, checks)

    rig.clock.advance(1)
    await rig.watchdog.handle()
    assert rig.restarts == 6


async def test_an_attempt_that_raises_counts_and_the_next_one_can_work() -> None:
    rig = Rig()
    rig.ports = [False, True]
    rig.restart_script = [AdbCommandFailed("x"), None]
    await rig.watchdog.handle()
    assert rig.restarts == 2
    assert await rig.sent_kinds() == ["repair_started", "repaired"]
    assert rig.transport.sent[-1]["body"]["attempts"] == 2


async def test_an_unexpected_error_in_the_restart_is_an_ordinary_failed_attempt() -> None:
    rig = Rig()
    rig.restart_script = [AdbTimeout("y"), RuntimeError("inesperado"), ValueError("z")]
    await rig.watchdog.handle()
    assert rig.restarts == 3
    assert await rig.sent_kinds() == ["repair_started", "repair_failed"]
    assert state_of(rig.manager) is SessionState.HIBERNATING


async def test_an_unauthorized_adb_stops_at_once_and_rests_for_an_hour() -> None:
    rig = Rig()
    rig.restart_script = [AdbUnauthorized("não autorizou")]
    await rig.watchdog.handle()
    assert rig.restarts == 1
    assert rig.clock.sleeps == []
    assert await rig.sent_kinds() == ["repair_started", "adb_unreachable"]
    assert rig.transport.sent[-1]["body"]["severity"] == "warn"
    assert state_of(rig.manager) is SessionState.HIBERNATING

    rig.clock.advance(3599)
    await rig.watchdog.handle()
    assert rig.restarts == 1
    rig.clock.advance(1)
    await rig.watchdog.handle()
    assert rig.restarts == 2


async def test_an_adb_that_never_answers_ends_as_adb_unreachable_after_three_tries() -> None:
    # A TV pode estar subindo depois de uma queda de energia: o ADB demora mais que o serviço.
    rig = Rig()
    rig.restart_script = [AdbUnreachable("a")]
    await rig.watchdog.handle()
    assert rig.restarts == 3
    assert await rig.sent_kinds() == ["repair_started", "adb_unreachable"]
    assert rig.transport.sent[-1]["body"]["attempts"] == 3
    rig.clock.advance(600)
    await rig.watchdog.handle()
    assert rig.restarts == 6  # descanso curto: o ADB pode estar de volta


async def test_unreadable_ports_never_start_a_repair() -> None:
    rig = Rig()
    rig.ports = [OSError("rede")]
    await rig.watchdog.handle()
    assert rig.restarts == 0
    assert state_of(rig.manager) is SessionState.HIBERNATING


async def test_ports_that_cannot_be_read_after_the_restart_do_not_count_as_repaired() -> None:
    rig = Rig()
    rig.ports = [False, OSError("rede")]
    await rig.watchdog.handle()
    assert await rig.sent_kinds() == ["repair_started", "repair_failed"]


async def test_a_hung_repair_hits_the_time_limit_and_frees_the_session() -> None:
    rig = Rig(budget_seconds=0.05)

    async def hang() -> None:
        await asyncio.sleep(30)

    rig.restart_hook = hang
    await rig.watchdog.handle()
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert await rig.sent_kinds() == ["repair_started", "repair_failed"]


async def test_cancelling_the_watchdog_mid_repair_still_frees_the_session() -> None:
    rig = Rig()
    started = asyncio.Event()

    async def hang() -> None:
        started.set()
        await asyncio.sleep(30)

    rig.restart_hook = hang
    task = asyncio.create_task(rig.watchdog.run())
    rig.watchdog.request()
    await asyncio.wait_for(started.wait(), 5)
    assert state_of(rig.manager) is SessionState.REPAIRING
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert state_of(rig.manager) is SessionState.HIBERNATING


async def test_the_loop_survives_a_crash_and_serves_the_next_request() -> None:
    rig = Rig()
    original = rig.watchdog.handle
    calls: list[int] = []

    async def crashing() -> None:
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("falha do vigia")
        await original()

    rig.watchdog.handle = crashing  # type: ignore[method-assign]
    rig.ports = [False, True]
    task = asyncio.create_task(rig.watchdog.run())
    rig.watchdog.request()
    await asyncio.sleep(0.01)
    rig.watchdog.request()
    await asyncio.sleep(0.01)
    assert len(calls) == 2
    assert rig.restarts == 1
    assert not task.done()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_requests_during_a_repair_are_folded_into_it() -> None:
    rig = Rig()
    rig.ports = [False, True]

    async def poke() -> None:
        rig.watchdog.request()
        rig.watchdog.request()

    rig.restart_hook = poke
    task = asyncio.create_task(rig.watchdog.run())
    rig.watchdog.request()
    await asyncio.sleep(0.01)
    assert rig.restarts == 1
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_a_refused_port_while_opening_the_session_triggers_the_repair() -> None:
    rig = Rig()
    rig.ports = [False, True]
    rig.remote.connect_errors = [TvPortClosed("recusou")] * 4
    task = asyncio.create_task(rig.watchdog.run())
    with pytest.raises(TvSessionError) as caught:
        await rig.manager.send_key("HOME")
    assert "religando" in caught.value.message  # a sessão parou de insistir enquanto se repara
    await asyncio.sleep(0.01)
    assert rig.restarts == 1
    assert state_of(rig.manager) is SessionState.HIBERNATING
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    # Reparado: o próximo comando abre a sessão do zero.
    rig.remote.connect_errors = []
    await rig.manager.send_key("HOME")
    assert state_of(rig.manager) is SessionState.HOT
