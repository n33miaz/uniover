"""Desligar a TV: o que o agente faz, e principalmente o que não faz, depois do `POWER`.

O `POWER` do Remote v2 é um interruptor: a TV desligada volta a ligar com uma segunda tecla, e sem
emissor infravermelho o dono só a liga de novo com o controle original. Então o que se confere aqui
é que o agente envia o `POWER` pedido, publica o estado que a TV informar, e depois **nada** nele
(reabrir a sessão, o aquecimento que o app pede, o vigia de inatividade, uma repetição do pedido)
manda tecla por conta própria.
"""

import asyncio

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.core import (
    Command,
    CommandResult,
    HandleCommand,
    ResultStatus,
    SessionState,
    TvSessionError,
    TvSessionManager,
    TvState,
    tv_app_launch_handler,
    tv_key_handler,
    tv_text_handler,
    tv_wake_handler,
)
from uniover_agent.core.tv.session import POWER_REPEAT_SECONDS
from uniover_agent.ports import TvUnreachable


class StandbyRemote(FakeTvRemote):
    """A TV que, ao receber `POWER`, avisa que desligou, fecha a sessão e deixa de responder."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        await super().send_key(key, direction)
        if key == "POWER":
            self.connect_errors = [TvUnreachable("sem resposta") for _ in range(1000)]
            self.push_power(False)
            self.drop()


class FlappingRemote(FakeTvRemote):
    """Aceita a sessão e a derruba no instante seguinte, toda vez (TV que não quer ficar de pé)."""

    def __init__(self) -> None:
        super().__init__()
        self.flaps = True

    async def connect(self) -> None:
        await super().connect()
        if self.flaps:
            asyncio.get_running_loop().call_soon(self.drop)


class DropsOnFirstSend(FakeTvRemote):
    """Perde o canal no momento do primeiro envio: a tecla não chega à TV."""

    def __init__(self) -> None:
        super().__init__()
        self.failures = 1

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if self.failures:
            self.failures -= 1
            self._connected = False
            raise TvUnreachable("canal fechado")
        await super().send_key(key, direction)


class Rig:
    """Sessão, comandos como o agente os monta e tudo o que ela publicou."""

    def __init__(self, remote: FakeTvRemote | None = None) -> None:
        self.clock = FakeClock()
        self.remote = remote or FakeTvRemote()
        self.manager = TvSessionManager(self.clock, self.remote)
        self.states: list[TvState] = []
        self.manager.subscribe(self.states.append)
        keys = tv_key_handler(self.manager)
        self.handler = HandleCommand(
            {
                "tv.key.v1": keys,
                "tv.key.v2": keys,
                "tv.wake.v1": tv_wake_handler(self.manager),
                "tv.text.v1": tv_text_handler(self.manager),
                "tv.app.launch.v1": tv_app_launch_handler(self.manager),
            },
            self.clock,
        )

    async def power(self) -> CommandResult:
        return await self.handler(Command("p", "tv.key.v2", {"key": "POWER"}))

    async def wake(self) -> CommandResult:
        return await self.handler(Command("w", "tv.wake.v1", {}))

    def kinds(self) -> list[tuple[str, str]]:
        return [(state.power, state.connection) for state in self.states]


def state_of(manager: TvSessionManager) -> SessionState:
    # Função à parte: o mypy estreita `manager.state` depois de um `assert` e acusaria o próximo.
    return manager.state


# --- o que a TV informa depois do POWER ---------------------------------------------------------


async def test_power_reaches_the_tv_and_the_state_says_off_as_soon_as_the_tv_reports_it() -> None:
    rig = Rig(StandbyRemote())
    await rig.wake()
    rig.remote.push_power(True)
    assert (await rig.power()).status is ResultStatus.OK
    assert rig.remote.sent == [("POWER", "SHORT")]
    # O aviso da TV ("desligada") sai com a sessão ainda aberta, antes de a sessão cair.
    kinds = rig.kinds()
    assert ("on", "hot") in kinds
    assert kinds.index(("off", "hot")) < kinds.index(("unknown", "disconnected"))
    await rig.manager.settle()


async def test_after_power_the_dropped_session_is_reopened_once_with_the_usual_backoff() -> None:
    rig = Rig(StandbyRemote())
    await rig.wake()
    await rig.power()
    await rig.manager.settle()
    # Uma abertura inicial e as 4 tentativas da recuperação (1, 2 e 4 s de espera): depois desiste.
    assert rig.remote.connects == 1 + 4
    assert rig.clock.sleeps == [1.0, 2.0, 4.0]
    assert rig.manager.snapshot() == TvState("unknown", None, None, "disconnected")
    # Sem laço: nada tenta de novo sozinho.
    for _ in range(100):
        await asyncio.sleep(0)
    assert rig.remote.connects == 1 + 4
    assert rig.remote.sent == [("POWER", "SHORT")]


# --- nada no agente liga a TV de volta ----------------------------------------------------------


async def test_nothing_the_agent_does_by_itself_sends_a_key_after_power() -> None:
    rig = Rig(StandbyRemote())
    await rig.wake()
    await rig.power()
    await rig.manager.settle()

    # O vigia de inatividade roda e o app segue pedindo para aquecer enquanto a tela está aberta.
    watcher = asyncio.create_task(rig.manager.watch())
    for _ in range(3):
        rig.clock.advance(120)
        result = await rig.wake()
        assert (result.status, result.code) == (ResultStatus.FAILED, "tv_unreachable")
    for _ in range(300):
        await asyncio.sleep(0)
    watcher.cancel()
    await asyncio.gather(watcher, return_exceptions=True)
    await rig.manager.settle()
    assert await rig.manager.hibernate_if_idle() is False

    # O dono liga a TV com o controle original: o próximo aquecimento só abre a sessão.
    rig.remote.connect_errors = []
    assert (await rig.wake()).status is ResultStatus.OK
    rig.remote.push_power(True)
    assert rig.manager.snapshot() == TvState("on", None, None, "hot")

    assert rig.remote.sent == [("POWER", "SHORT")]
    assert rig.remote.links == []
    assert rig.remote.texts == []


async def test_wake_with_the_tv_in_standby_only_tries_to_open_the_session() -> None:
    rig = Rig(StandbyRemote())
    await rig.wake()
    await rig.power()
    await rig.manager.settle()
    connects = rig.remote.connects

    rig.clock.advance(120)  # fora da espera da TV offline
    result = await rig.wake()
    assert (result.status, result.code) == (ResultStatus.FAILED, "tv_unreachable")
    # Uma tentativa de conexão (a TV já estava offline), nenhuma tecla: só abrir a sessão.
    assert rig.remote.connects == connects + 1
    assert rig.remote.sent == [("POWER", "SHORT")]


# --- sem reconexões em laço ---------------------------------------------------------------------


async def test_a_tv_that_keeps_dropping_the_session_is_not_reopened_in_a_loop() -> None:
    rig = Rig(FlappingRemote())
    await rig.wake()
    for _ in range(200):
        await asyncio.sleep(0)
    # A abertura pedida pelo app e uma só reabertura em segundo plano; depois espera o próximo uso.
    assert rig.remote.connects == 2
    await asyncio.wait_for(rig.manager.settle(), timeout=1)
    assert rig.remote.connects == 2
    assert state_of(rig.manager) is SessionState.HIBERNATING
    assert rig.manager.snapshot().connection == "disconnected"
    assert rig.remote.sent == []


async def test_new_use_lets_the_background_recovery_work_again() -> None:
    remote = FlappingRemote()
    rig = Rig(remote)
    await rig.wake()
    for _ in range(200):
        await asyncio.sleep(0)
    assert rig.remote.connects == 2

    # O app volta a pedir (uso novo) e a TV passa a se comportar: reabre e, se cair, recupera.
    remote.flaps = False
    await rig.wake()
    assert rig.remote.connects == 3
    rig.remote.drop()
    await rig.manager.settle()
    assert rig.remote.connects == 4
    assert state_of(rig.manager) is SessionState.HOT


# --- o toque duplo não desfaz o desligamento ----------------------------------------------------


async def test_a_second_power_right_after_the_first_is_not_sent() -> None:
    rig = Rig()
    first = await rig.power()
    second = await rig.handler(Command("2", "tv.key.v1", {"key": "POWER"}))
    assert (first.status, second.status) == (ResultStatus.OK, ResultStatus.OK)
    assert rig.remote.sent == [("POWER", "SHORT")]


async def test_power_goes_again_once_the_repeat_window_has_passed() -> None:
    rig = Rig()
    await rig.manager.send_key("POWER")
    rig.clock.advance(POWER_REPEAT_SECONDS - 0.1)
    await rig.manager.send_key("POWER")
    assert rig.remote.sent == [("POWER", "SHORT")]
    rig.clock.advance(0.1)
    await rig.manager.send_key("POWER")
    assert rig.remote.sent == [("POWER", "SHORT"), ("POWER", "SHORT")]


async def test_the_repeat_window_counts_from_when_the_key_reached_the_tv() -> None:
    rig = Rig()
    # A TV demora a responder: a tecla só chega depois de 1 + 2 s de espera na abertura da sessão.
    rig.remote.connect_errors = [TvUnreachable("a"), TvUnreachable("b")]
    await rig.manager.send_key("POWER")
    assert rig.clock.monotonic() == 3.0
    # 9 s depois da chegada (12 s depois do pedido): ainda é repetição.
    rig.clock.advance(POWER_REPEAT_SECONDS - 1)
    await rig.manager.send_key("POWER")
    assert rig.remote.sent == [("POWER", "SHORT")]


async def test_a_power_that_failed_does_not_block_the_next_try() -> None:
    rig = Rig()
    rig.remote.connect_errors = [TvUnreachable("x") for _ in range(4)]
    with pytest.raises(TvSessionError):
        await rig.manager.send_key("POWER")
    assert rig.remote.sent == []
    rig.clock.advance(6)  # a espera mínima de quem espera a TV
    await rig.manager.send_key("POWER")
    assert rig.remote.sent == [("POWER", "SHORT")]
    assert state_of(rig.manager) is SessionState.HOT


async def test_a_long_press_of_power_is_two_sends_of_one_gesture_and_both_go() -> None:
    rig = Rig()
    await rig.manager.send_key("POWER", "START_LONG")
    await rig.manager.send_key("POWER", "END_LONG")
    assert rig.remote.sent == [("POWER", "START_LONG"), ("POWER", "END_LONG")]


async def test_power_is_delivered_once_when_the_channel_drops_during_the_send() -> None:
    rig = Rig(DropsOnFirstSend())
    result = await rig.power()
    assert result.status is ResultStatus.OK
    # O primeiro envio não chegou (o canal caiu antes): a tecla é repetida uma vez na sessão nova,
    # e chega uma única vez.
    assert rig.remote.connects == 2
    assert rig.remote.keys == ["POWER"]
    await rig.manager.settle()


async def test_other_keys_are_not_held_back_by_the_power_window() -> None:
    rig = Rig()
    await rig.manager.send_key("POWER")
    await rig.manager.send_key("VOLUME_UP")
    await rig.manager.send_key("VOLUME_UP")
    assert rig.remote.keys == ["POWER", "VOLUME_UP", "VOLUME_UP"]
