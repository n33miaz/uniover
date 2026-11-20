"""Alguém pede a TV pelo app (tecla ou o app aberto aquecendo o controle) e o PC não a alcança: o
vigia do endereço confere já e procura já, sem esperar as três conferências de um minuto. A
reabertura sozinha não avisa (é o próprio vigia que a pede) e os pedidos repetidos não viram uma
varredura sem fim."""

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.core import TV_UNREACHABLE, TvRelocator, TvSessionError, TvSessionManager
from uniover_agent.core.tv.relocator import DEFAULT_NUDGE_INTERVAL_SECONDS
from uniover_agent.ports import TvUnreachable


class Watch:
    def __init__(self, reachable: bool = False) -> None:
        self.clock = FakeClock()
        self.reachable = reachable
        self.rescans = 0
        self.wakes: list[bool] = []
        self.network = ("192.168.1.0/24",)

    async def is_reachable(self) -> bool:
        return self.reachable

    async def rescan(self) -> str | None:
        self.rescans += 1
        return None

    async def read_network(self) -> tuple[str, ...]:
        return self.network

    def build(self) -> TvRelocator:
        return TvRelocator(
            self.clock,
            is_hot=lambda: False,
            reachable=self.is_reachable,
            rescan=self.rescan,
            network_signature=self.read_network,
            on_network_change=self.wakes.append,
        )


async def test_a_nudge_searches_at_the_next_check_without_waiting_for_three_failures() -> None:
    watch = Watch()
    relocator = watch.build()
    assert await relocator.step() is None
    assert watch.rescans == 0  # uma falha só: sem pedido, a procura ainda espera
    relocator.nudge()
    await relocator.step()
    assert watch.rescans == 1
    assert watch.wakes == [True]  # o localizador esquece os espaçamentos e a procura lenta


async def test_a_nudge_with_the_tv_answering_does_not_search() -> None:
    watch = Watch(reachable=True)
    relocator = watch.build()
    relocator.nudge()
    await relocator.step()
    assert watch.rescans == 0
    assert watch.wakes == []


async def test_nudges_are_spaced_so_an_open_app_on_a_tv_that_is_off_does_not_loop() -> None:
    watch = Watch()
    relocator = watch.build()
    relocator.nudge()
    await relocator.step()
    relocator.nudge()  # logo em seguida: ignorado
    await relocator.step()
    assert watch.wakes == [True]
    watch.clock.advance(DEFAULT_NUDGE_INTERVAL_SECONDS)
    relocator.nudge()
    await relocator.step()
    assert watch.wakes == [True, True]


async def test_a_nudge_cuts_the_wait_for_the_next_check_short() -> None:
    watch = Watch()
    relocator = watch.build()
    await relocator.step()  # leitura de base da rede
    relocator.nudge()
    before = watch.clock.monotonic()
    await relocator._wait_next_check()
    # Volta na primeira fatia da espera (5 s), e não depois do minuto inteiro.
    assert watch.clock.monotonic() - before <= 5.0


def rig() -> tuple[TvSessionManager, FakeTvRemote, list[int]]:
    remote = FakeTvRemote()
    manager = TvSessionManager(FakeClock(), remote)
    calls: list[int] = []
    manager.on_wanted_unreachable(lambda: calls.append(1))
    return manager, remote, calls


async def test_a_key_the_tv_does_not_answer_tells_the_address_watch() -> None:
    manager, remote, calls = rig()
    remote.connect_errors = [TvUnreachable("sem resposta") for _ in range(4)]
    with pytest.raises(TvSessionError) as caught:
        await manager.send_key("HOME")
    assert caught.value.code == TV_UNREACHABLE
    assert calls == [1]


async def test_the_app_warming_the_control_also_tells_the_address_watch() -> None:
    manager, remote, calls = rig()
    remote.connect_errors = [TvUnreachable("sem resposta") for _ in range(4)]
    with pytest.raises(TvSessionError):
        await manager.wake()
    assert calls == [1]


async def test_the_unattended_reopen_and_a_working_tv_do_not_tell_anyone() -> None:
    manager, remote, calls = rig()
    remote.connect_errors = [TvUnreachable("sem resposta") for _ in range(4)]
    with pytest.raises(TvSessionError):
        await manager.reopen_unattended()
    assert calls == []
    working, _, quiet = rig()
    await working.send_key("HOME")
    assert quiet == []


async def test_a_failing_listener_does_not_hide_the_error_from_the_caller() -> None:
    manager, remote, _ = rig()

    def broken() -> None:
        raise RuntimeError("falhou")

    manager.on_wanted_unreachable(broken)
    remote.connect_errors = [TvUnreachable("sem resposta") for _ in range(4)]
    with pytest.raises(TvSessionError):
        await manager.send_key("HOME")
