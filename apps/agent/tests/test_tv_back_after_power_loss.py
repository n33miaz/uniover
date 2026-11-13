"""A TV volta sozinha depois de uma queda de energia ou de reiniciar no meio do uso.

Relógio falso, TV e rede de mentira: nenhum teste fala com a rede, com a TV ou com o `adb`. Os
tempos do primeiro cenário são os da queda de luz real de 07/11 (o agente subiu às 21:22:39 e a TV
só atendeu no endereço de sempre às 21:28:21, uns 330 s depois).
"""

import asyncio
import itertools
import logging
from collections.abc import Callable, Collection
from typing import Any

import pytest

from uniover_agent.adapters.adb_authorization import VERIFIED
from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvRemote
from uniover_agent.core import (
    EnvelopeFactory,
    EnvelopeGate,
    SessionState,
    TvRelocator,
    TvSessionManager,
    TvState,
    TvWatchdog,
    WatchdogEvents,
)
from uniover_agent.core.tv.relocator import DEFAULT_FAST_STEPS, AgentStart
from uniover_agent.ports import AdbIdle, AdbUnreachable

from .support import AGENT_ID
from .support_adb import CONNECT, DISCONNECT, GET_STATE, shell
from .test_tv_adb import Clock
from .test_tv_adb_permission import (
    DEVICE,
    OFFLINE,
    UNKNOWN,
    Home,
    home,  # noqa: F401 - fixture
    runner_with,
    script_apps,
)

NEW_HOST = "192.168.0.50"
HOME_NETWORK = ("192.168.0.0/24",)


class House:
    """A TV de mentira (liga num instante) e a sessão de verdade com o controle falso."""

    def __init__(self, *, tv_on_at: float | None = 0.0, clock: FakeClock | None = None) -> None:
        self.clock = clock or FakeClock()
        self.tv_on_at: float | None = tv_on_at
        self.remote = FakeTvRemote()
        self.manager = TvSessionManager(self.clock, self.remote, liveness=self.alive, jitter=0.0)
        self.probes: list[float] = []
        # Quando a sessão abriu (o laço do vigia segue andando no tempo falso depois disso).
        self.hot_at: float | None = None
        self.manager.subscribe(self._note_state)

    def _note_state(self, state: TvState) -> None:
        if state.connection == "hot" and self.hot_at is None:
            self.hot_at = self.clock.monotonic()

    def tv_on(self) -> bool:
        return self.tv_on_at is not None and self.clock.monotonic() >= self.tv_on_at

    async def alive(self) -> bool:
        return self.tv_on()

    def is_hot(self) -> bool:
        return self.manager.snapshot().connection == "hot"

    async def reachable(self) -> bool:
        """A conferência barata do vigia (a porta do controle), contada com o horário."""
        self.probes.append(self.clock.monotonic())
        return self.tv_on()

    def relocator(self, **limits: Any) -> TvRelocator:
        limits.setdefault("rescan", self.no_move)
        limits.setdefault("reachable", self.reachable)
        return TvRelocator(
            self.clock,
            is_hot=self.is_hot,
            on_recovered=self.manager.reopen_unattended,
            **limits,
        )

    async def no_move(self) -> str | None:
        return None


async def run_until(
    relocator: TvRelocator, done: Callable[[], bool], *, limit: int = 20_000
) -> str | None:
    """Roda o laço do vigia (tempo falso) até `done`, ou até ele devolver um endereço novo."""
    task = asyncio.create_task(relocator.run())
    try:
        for _ in range(limit):
            if done() or task.done():
                break
            await asyncio.sleep(0)
        else:
            pytest.fail("o vigia não chegou ao fim esperado")
        return task.result() if task.done() else None
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def comeback_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    messages = [record.getMessage() for record in caplog.records]
    return [message for message in messages if "partida do agente" in message]


# --- TV-09: voltou a energia ---------------------------------------------------------------------


async def test_the_power_loss_of_07_11_brings_the_tv_back_seconds_after_it_answers(
    caplog: pytest.LogCaptureFixture,
) -> None:
    house = House(tv_on_at=330.0)
    start = AgentStart(at=0.0)
    relocator = house.relocator(start=start, fast_window_seconds=600.0, check_seconds=60.0)
    with caplog.at_level(logging.INFO):
        await run_until(relocator, house.is_hot)
    # O teto da fase próxima é 20 s: no pior caso a TV espera 20 s, e não um minuto.
    assert house.hot_at is not None
    assert 330.0 <= house.hot_at <= 330.0 + max(DEFAULT_FAST_STEPS)
    probes_until_back = [moment for moment in house.probes if moment <= house.hot_at]
    assert house.manager.state is SessionState.HOT
    assert house.remote.keys == []  # nada de tecla: reabrir a sessão não liga nem desliga a TV
    # Sem martelar: a conferência barata, uma por passo da espera crescente (5, 10, 20, 20...).
    assert len(probes_until_back) <= 20
    gaps = [b - a for a, b in itertools.pairwise(probes_until_back)]
    assert gaps == sorted(gaps)
    assert max(gaps) == max(DEFAULT_FAST_STEPS)
    [line] = comeback_lines(caplog)
    assert line.startswith("TV de volta em ")
    assert "achada em" in line
    assert start.reported


async def test_after_the_tv_is_found_the_checks_go_back_to_the_usual_spacing() -> None:
    house = House(tv_on_at=0.0)
    relocator = house.relocator(
        start=AgentStart(at=0.0), fast_window_seconds=600.0, check_seconds=60.0
    )
    await run_until(relocator, lambda: len(house.probes) >= 4)
    assert house.clock.sleeps[:4] == [5.0, 60.0, 60.0, 60.0]
    # A TV estava lá: um reinício comum do agente não abre sessão nenhuma.
    assert house.remote.connects == 0


async def test_a_healthy_restart_only_logs_when_the_tv_was_found(
    caplog: pytest.LogCaptureFixture,
) -> None:
    house = House(tv_on_at=0.0)
    house.clock.advance(7.5)  # a partida foi antes: o preparo leva uns segundos
    relocator = house.relocator(start=AgentStart(at=0.0))
    with caplog.at_level(logging.INFO):
        await relocator.step()
        await relocator.step()
    assert comeback_lines(caplog) == ["TV encontrada 7.5 s depois da partida do agente"]
    assert house.remote.connects == 0


async def test_the_tv_back_at_another_address_is_reopened_by_the_watch_after_the_restart(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = FakeClock()
    start = AgentStart(at=0.0)
    before = House(tv_on_at=90.0, clock=clock)

    async def find_new_host() -> str | None:
        return NEW_HOST if before.tv_on() else None

    async def old_address_is_empty() -> bool:
        before.probes.append(clock.monotonic())
        return False  # o IP velho ficou vazio: o DHCP deu outro à TV

    relocator = before.relocator(
        start=start,
        fast_window_seconds=600.0,
        reachable=old_address_is_empty,
        rescan=find_new_host,
    )
    assert await run_until(relocator, lambda: False) == NEW_HOST
    assert clock.monotonic() <= 90.0 + max(DEFAULT_FAST_STEPS)
    assert start.tv_missing and not start.reported
    # `main` recomeça `run` com o endereço novo: sessão e vigia novos, a mesma partida.
    after = House(tv_on_at=0.0, clock=clock)
    restarted = after.relocator(start=start, fast_window_seconds=600.0)
    with caplog.at_level(logging.INFO):
        assert await restarted.step() is None
        await restarted.step()
    assert after.manager.state is SessionState.HOT
    assert after.remote.keys == []
    [line] = comeback_lines(caplog)
    assert line.startswith("TV de volta em ")


async def test_a_tv_that_shows_up_hours_later_is_not_reported_as_back_from_the_start(
    caplog: pytest.LogCaptureFixture,
) -> None:
    house = House(tv_on_at=None)
    start = AgentStart(at=0.0)
    relocator = house.relocator(start=start)
    await relocator.step()
    house.clock.advance(4 * 3600)
    house.tv_on_at = 0.0
    with caplog.at_level(logging.INFO):
        await relocator.step()
    assert comeback_lines(caplog) == []
    # A volta comum segue valendo: a sessão reabre sozinha, como antes.
    assert house.manager.state is SessionState.HOT


class Network:
    """As redes do PC: vazio enquanto o roteador não volta (`back_at`, no relógio falso)."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.current: Collection[str] = HOME_NETWORK
        self.back_at: float | None = None

    async def signature(self) -> Collection[str]:
        if self.back_at is not None and self.clock.monotonic() >= self.back_at:
            self.current = HOME_NETWORK
        return self.current


async def test_the_network_coming_back_checks_the_tv_at_once_and_restarts_the_quick_phase(
    caplog: pytest.LogCaptureFixture,
) -> None:
    house = House(tv_on_at=None)
    network = Network(house.clock)
    relocator = house.relocator(
        fast_window_seconds=600.0,
        network_signature=network.signature,
        network_poll_seconds=5.0,
        check_seconds=60.0,
    )
    house.clock.advance(1000)  # a fase próxima da partida já passou: espaçamento de sempre
    await relocator.step()
    network.current = ()  # o roteador caiu e volta 47 s depois
    back_at = house.clock.monotonic() + 47.0
    network.back_at = back_at
    with caplog.at_level(logging.INFO):
        await run_until(relocator, lambda: len(house.probes) >= 4)
    # Conferida já na leitura de rede seguinte à volta (5 s), e não no minuto cheio.
    assert house.probes[1] - back_at <= 5.0
    # E a fase próxima recomeçou: 5, 10 s em vez de 60.
    assert house.probes[2] - house.probes[1] == 5.0
    assert house.probes[3] - house.probes[2] == 10.0
    assert "a rede do PC voltou; confiro a TV já" in caplog.text
    assert "o PC mudou de rede" not in caplog.text


async def test_a_network_that_drops_all_night_wakes_the_watch_at_most_once_per_interval(
    caplog: pytest.LogCaptureFixture,
) -> None:
    house = House(tv_on_at=None)
    network = Network(house.clock)
    relocator = house.relocator(
        fast_window_seconds=600.0,
        network_signature=network.signature,
        failures=1000,
        network_burst_interval_seconds=900.0,
    )
    await relocator.step()
    with caplog.at_level(logging.INFO):
        for number in range(80):  # 80 quedas e voltas em 13 minutos
            network.current = () if number % 2 == 0 else HOME_NETWORK
            house.clock.advance(10)
            await relocator.step()
    assert caplog.text.count("a rede do PC voltou") == 1
    assert house.remote.connects == 0


async def test_a_tv_still_refusing_the_port_while_booting_never_leaves_the_watchdog_stuck() -> None:
    """TV ligando: na rede, porta recusada por um tempo; o ADB não abre sem ninguém usando."""
    house = House(tv_on_at=0.0)
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), house.clock)
    events = WatchdogEvents(FakeTransport(), envelopes, house.clock)
    restarts: list[float] = []
    booting_until = 80.0

    async def ports_open() -> bool | None:
        return house.clock.monotonic() >= booting_until

    async def restart() -> None:
        restarts.append(house.clock.monotonic())
        raise AdbIdle("o ADB só abre conexão nova enquanto alguém usa a TV pelo app")

    watchdog = TvWatchdog(house.clock, house.manager, ports_open, restart, events)

    async def reachable() -> bool:
        house.probes.append(house.clock.monotonic())
        if house.clock.monotonic() < booting_until:
            watchdog.request()  # porta recusada: o mesmo aviso que a composição dá ao vigia
            return False
        return True

    start = AgentStart(at=0.0)
    relocator = house.relocator(start=start, fast_window_seconds=600.0, reachable=reachable)
    guard = asyncio.create_task(watchdog.run())
    try:
        await run_until(relocator, house.is_hot)
    finally:
        guard.cancel()
        await asyncio.gather(guard, return_exceptions=True)
    assert house.hot_at is not None
    assert house.hot_at <= booting_until + max(DEFAULT_FAST_STEPS)
    # O descanso curto do vigia segura as conferências próximas: no máximo uma tentativa por minuto.
    assert len(restarts) <= 2
    assert house.remote.keys == []
    assert start.reported


# --- TV-21: a TV cai ou reinicia no meio do uso ---------------------------------------------------


async def open_in_use(house: House) -> None:
    await house.manager.wake()
    house.manager.touch()  # alguém está usando: a queda não é hora de hibernar
    assert house.manager.state is SessionState.HOT


async def test_a_tv_that_reboots_in_the_middle_of_use_comes_back_alone_without_keys() -> None:
    house = House(tv_on_at=0.0)
    await open_in_use(house)
    relocator = house.relocator(check_seconds=60.0)
    house.tv_on_at = None
    house.remote.drop()  # a TV reiniciou: a sessão cai
    await house.manager.settle()
    assert house.manager.offline  # a reabertura rápida não achou a TV e entrou na espera
    for _ in range(3):
        house.clock.advance(60)
        await relocator.step()
    assert not house.is_hot()
    house.tv_on_at = house.clock.monotonic()  # voltou
    house.clock.advance(60)
    await relocator.step()
    assert house.is_hot()
    assert not house.manager.offline
    assert house.remote.keys == []


async def test_a_reopen_nobody_used_then_a_reboot_comes_back_on_the_first_command() -> None:
    house = House(tv_on_at=0.0)
    relocator = house.relocator(check_seconds=60.0)
    await house.manager.reopen_unattended()  # reaberta sozinha (a TV voltou) e ninguém usou
    house.tv_on_at = None
    house.remote.drop()
    await house.manager.settle()
    house.clock.advance(60)
    await relocator.step()
    house.tv_on_at = house.clock.monotonic()
    house.clock.advance(60)
    await relocator.step()
    # A guarda contra laço de aberturas segura a sessão fechada até alguém usar...
    assert not house.is_hot()
    started = house.clock.monotonic()
    await house.manager.send_key("HOME")  # ...e o primeiro comando a abre na hora
    assert house.remote.keys == ["HOME"]
    assert house.clock.monotonic() - started < 5.0


# --- TV-21: o ADB volta sem abrir o aviso de permissão na TV --------------------------------------


async def test_after_a_tv_reboot_an_idle_agent_never_sends_connect_and_reuses_the_transport(
    home: Home,  # noqa: F811 - fixture
) -> None:
    home.verify(settled=True)  # a permissão foi dada uma vez e provada, vencimento desligado
    runner = runner_with()
    script_apps(runner)
    clock = Clock()
    adb = home.adb(runner, clock)
    await adb.connect()
    home.active = False  # ninguém usa a TV pelo app (noite, partida do agente)
    runner.calls.clear()
    memory = shell("grep MemAvailable /proc/meminfo")
    runner.script[memory] = OFFLINE  # a TV reiniciou no meio
    with pytest.raises(AdbUnreachable):
        await adb.memory_available_mb()
    assert DISCONNECT not in runner.calls  # com a permissão provada o canal fica para religar
    runner.script[GET_STATE] = UNKNOWN  # TV desligada: o servidor do `adb` ainda não a vê
    for seconds in (31, 62, 93, 600):
        clock.now = seconds
        with pytest.raises((AdbIdle, AdbUnreachable)):
            await adb.list_apps()
    # O servidor do `adb` religou a TV sozinho (a chave dela já está gravada): o agente usa.
    runner.script[GET_STATE] = DEVICE
    clock.now = 700
    assert await adb.list_apps() == []
    assert CONNECT not in runner.calls  # o único comando que pode abrir o aviso nunca saiu
    assert home.authorization().record.state == VERIFIED


async def test_after_a_pc_reboot_the_adb_waits_for_use_and_then_connects_once_without_prompt(
    home: Home,  # noqa: F811 - fixture
) -> None:
    home.verify(settled=True)
    runner = runner_with(state=UNKNOWN)  # PC religado: servidor do `adb` novo, sem a TV
    script_apps(runner)
    clock = Clock()
    home.active = False
    adb = home.adb(runner, clock)
    with pytest.raises(AdbIdle):
        await adb.connect()  # a partida do agente: espera alguém usar a TV pelo app
    assert CONNECT not in runner.calls
    runner.script[GET_STATE] = DEVICE
    home.active = True  # o dono abriu a tela da TV no app
    clock.now = 31
    assert await adb.list_apps() == []
    assert runner.calls.count(CONNECT) == 1  # permissão desta TV provada: sem aviso
    assert home.authorization().record.state == VERIFIED
