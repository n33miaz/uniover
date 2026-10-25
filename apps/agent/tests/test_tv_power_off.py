"""Desligar com leitura (`tv.power.off.v1`): só aperta `POWER` com a TV lida como ligada.

`POWER` é um interruptor e sem emissor infravermelho a TV desligada só volta com o controle
original. Por isso o que mais se confere aqui é o que o agente **não** faz: não manda tecla sem uma
leitura de "ligada" desta conexão, não usa o Wake-on-LAN, não repete a tecla sem confirmação.
"""

from collections.abc import Awaitable, Callable

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.core import (
    Command,
    HandleCommand,
    PowerOffResult,
    ResultStatus,
    TvSessionManager,
    tv_key_handler,
    tv_power_off_handler,
)
from uniover_agent.core.tv.session import (
    DEFAULT_POWER_OFF_CONFIRMATION_TIMEOUT_SECONDS,
    DEFAULT_POWER_OFF_READ_TIMEOUT_SECONDS,
    POWER_REPEAT_SECONDS,
)
from uniover_agent.ports import TvNotPaired, TvUnreachable


class TurnsOffOnPower(FakeTvRemote):
    """A TV que, ao receber `POWER`, avisa que desligou (a sessão segue aberta)."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        await super().send_key(key, direction)
        if key == "POWER":
            self.push_power(False)


class DropsOnPower(FakeTvRemote):
    """A TV que, ao receber `POWER`, fecha a sessão sem avisar nada e deixa de atender."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        await super().send_key(key, direction)
        if key == "POWER":
            self.connect_errors = [TvUnreachable("sem resposta") for _ in range(100)]
            self.drop()


class FailsToSend(FakeTvRemote):
    """O envio da tecla falha (a tecla pode ou não ter chegado)."""

    def __init__(self, error: Exception) -> None:
        super().__init__()
        self.error = error
        self.attempts = 0

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        self.attempts += 1
        self._connected = False
        raise self.error


class Rig:
    def __init__(
        self,
        remote: FakeTvRemote,
        *,
        on: bool | None = True,
        liveness: Callable[[], Awaitable[bool]] | None = None,
        power_reader: Callable[[], Awaitable[bool | None]] | None = None,
    ) -> None:
        self.clock = FakeClock()
        self.remote = remote
        self.wol_calls = 0

        async def wake_on_lan() -> bool:
            self.wol_calls += 1
            return True

        self.manager = TvSessionManager(
            self.clock,
            remote,
            liveness=liveness,
            wake_on_lan=wake_on_lan,
            power_reader=power_reader,
        )
        self.report(on)
        keys = tv_key_handler(self.manager)
        self.handler = HandleCommand(
            {"tv.key.v2": keys, "tv.power.off.v1": tv_power_off_handler(self.manager)}, self.clock
        )

    def report(self, on: bool | None) -> None:
        """O que a TV informa ao abrir a próxima sessão."""
        remote = self.remote
        remote.on_connect = None if on is None else lambda: remote.push_power(on)

    async def hibernate(self) -> None:
        self.clock.advance(400)
        assert await self.manager.hibernate_if_idle()


def never_alive() -> Callable[[], Awaitable[bool]]:
    async def alive() -> bool:
        return False

    return alive


def alive_until_a_key_is_sent(remote: FakeTvRemote) -> Callable[[], Awaitable[bool]]:
    """A TV atende na rede até receber uma tecla (e some, como uma TV que entrou em standby)."""

    async def alive() -> bool:
        return not remote.keys

    return alive


def always_alive() -> Callable[[], Awaitable[bool]]:
    async def alive() -> bool:
        return True

    return alive


def readings(*values: bool | None) -> Callable[[], Awaitable[bool | None]]:
    """Leitor de energia roteirizado: devolve os valores em ordem e repete o último."""
    pending = list(values)

    async def read() -> bool | None:
        return pending.pop(0) if len(pending) > 1 else pending[0]

    return read


# --- caminho feliz e leituras --------------------------------------------------------------------


async def test_on_then_confirmed_off_sends_power_exactly_once() -> None:
    rig = Rig(TurnsOffOnPower())
    assert await rig.manager.power_off() is PowerOffResult.OFF
    assert rig.remote.sent == [("POWER", "SHORT")]
    assert rig.wol_calls == 0


async def test_the_handler_answers_ok_only_when_the_turn_off_was_confirmed() -> None:
    rig = Rig(TurnsOffOnPower())
    result = await rig.handler(Command("1", "tv.power.off.v1", {}))
    assert (result.status, result.code) == (ResultStatus.OK, "")


async def test_already_off_sends_nothing() -> None:
    rig = Rig(TurnsOffOnPower(), on=False)
    assert await rig.manager.power_off() is PowerOffResult.ALREADY_OFF
    assert rig.remote.keys == []


async def test_a_second_request_after_the_tv_reported_off_sends_nothing() -> None:
    rig = Rig(TurnsOffOnPower())
    assert await rig.manager.power_off() is PowerOffResult.OFF
    assert await rig.manager.power_off() is PowerOffResult.ALREADY_OFF
    assert rig.remote.keys == ["POWER"]


async def test_without_a_reading_the_state_is_uncertain_and_no_key_is_sent() -> None:
    rig = Rig(TurnsOffOnPower(), on=None)
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == []
    # Esperou a leitura pelo limite combinado, e não mais que isso.
    assert sum(rig.clock.sleeps) == pytest.approx(DEFAULT_POWER_OFF_READ_TIMEOUT_SECONDS)


async def test_a_reading_from_an_older_connection_never_authorizes_the_key() -> None:
    rig = Rig(TurnsOffOnPower())
    await rig.manager.wake()
    assert rig.manager.snapshot().power == "on"
    await rig.hibernate()
    rig.report(None)
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == []


async def test_the_reading_from_before_an_unconfirmed_key_does_not_authorize_another_one() -> None:
    # A TV não avisou nada depois do POWER: não se sabe se desligou. Passado o tempo de repetição,
    # o aviso velho de "ligada" não pode valer, ou a segunda tecla ligaria a TV.
    rig = Rig(FakeTvRemote())
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == ["POWER"]
    rig.clock.advance(POWER_REPEAT_SECONDS + 1)
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == ["POWER"]


async def test_no_confirmation_is_uncertain_and_the_key_is_not_repeated() -> None:
    rig = Rig(FakeTvRemote())
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == ["POWER"]
    assert sum(rig.clock.sleeps) >= DEFAULT_POWER_OFF_CONFIRMATION_TIMEOUT_SECONDS


async def test_a_new_on_reading_after_an_unconfirmed_key_allows_a_new_request() -> None:
    # A TV mostra que está ligada de novo (alguém a ligou, ou o POWER não pegou): é leitura nova.
    rig = Rig(FakeTvRemote())
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    rig.clock.advance(POWER_REPEAT_SECONDS + 1)
    rig.remote.push_power(True)
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == ["POWER", "POWER"]


async def test_a_request_right_after_a_key_is_not_a_second_key_even_with_a_new_reading() -> None:
    rig = Rig(FakeTvRemote())
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    rig.remote.push_power(True)
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == ["POWER"]


# --- nunca liga a TV -----------------------------------------------------------------------------


async def test_an_offline_tv_is_offline_and_never_woken_by_the_network() -> None:
    remote = TurnsOffOnPower()
    remote.connect_errors = [TvUnreachable("sem resposta") for _ in range(10)]
    rig = Rig(remote, liveness=never_alive())
    assert await rig.manager.power_off() is PowerOffResult.OFFLINE
    assert rig.remote.keys == []
    assert rig.wol_calls == 0


async def test_the_plain_power_key_still_wakes_an_offline_tv_but_power_off_does_not() -> None:
    remote = TurnsOffOnPower()
    remote.connect_errors = [TvUnreachable("sem resposta") for _ in range(10)]
    rig = Rig(remote, liveness=never_alive())
    result = await rig.handler(Command("1", "tv.key.v2", {"key": "POWER"}))
    assert result.status is ResultStatus.OK
    assert rig.wol_calls == 1
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.wol_calls == 1
    assert rig.remote.keys == []


async def test_a_tv_not_paired_is_a_failure_not_offline() -> None:
    remote = TurnsOffOnPower()
    remote.connect_errors = [TvNotPaired("sem certificado")]
    rig = Rig(remote)
    assert await rig.manager.power_off() is PowerOffResult.FAILED
    assert rig.remote.keys == []


async def test_a_session_being_repaired_is_uncertain() -> None:
    rig = Rig(TurnsOffOnPower())
    rig.manager.mark_repairing()
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == []


# --- a tecla não chega ou se perde ---------------------------------------------------------------


async def test_a_channel_error_while_sending_is_uncertain_and_not_retried() -> None:
    remote = FailsToSend(TvUnreachable("canal fechado"))
    rig = Rig(remote)
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert remote.attempts == 1
    # Nem o pedido seguinte, logo depois, repete a tecla.
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert remote.attempts == 1


async def test_an_unexpected_error_while_sending_is_a_failure_without_retry() -> None:
    remote = FailsToSend(RuntimeError("falha qualquer"))
    rig = Rig(remote)
    assert await rig.manager.power_off() is PowerOffResult.FAILED
    assert remote.attempts == 1


async def test_the_session_dropping_after_the_key_counts_as_off_when_the_network_agrees() -> None:
    remote = DropsOnPower()
    rig = Rig(remote, liveness=alive_until_a_key_is_sent(remote))
    assert await rig.manager.power_off() is PowerOffResult.OFF
    assert rig.remote.keys == ["POWER"]


async def test_the_session_dropping_after_the_key_is_uncertain_when_the_tv_still_answers() -> None:
    rig = Rig(DropsOnPower(), liveness=always_alive())
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == ["POWER"]


async def test_the_session_dropping_after_the_key_is_uncertain_without_a_network_check() -> None:
    rig = Rig(DropsOnPower())
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN


# --- driver que só lê a energia ao abrir a sessão (Samsung) --------------------------------------


async def test_a_cached_on_is_ignored_when_the_reader_says_standby() -> None:
    rig = Rig(FakeTvRemote(), on=True, power_reader=readings(False))
    await rig.manager.wake()
    assert rig.manager.snapshot().power == "on"
    assert await rig.manager.power_off() is PowerOffResult.ALREADY_OFF
    assert rig.remote.keys == []
    assert rig.manager.snapshot().power == "off"


async def test_the_reader_confirms_on_and_then_off_with_one_key() -> None:
    rig = Rig(FakeTvRemote(), on=None, power_reader=readings(True, True, False))
    assert await rig.manager.power_off() is PowerOffResult.OFF
    assert rig.remote.keys == ["POWER"]


async def test_the_reader_never_confirming_is_uncertain_with_one_key() -> None:
    rig = Rig(FakeTvRemote(), on=None, power_reader=readings(True))
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == ["POWER"]


async def test_a_reader_without_answer_is_uncertain_and_sends_no_key() -> None:
    rig = Rig(FakeTvRemote(), on=True, power_reader=readings(None))
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == []


async def test_a_reader_that_fails_is_uncertain_and_sends_no_key() -> None:
    async def broken() -> bool | None:
        raise OSError("sem rede")

    rig = Rig(FakeTvRemote(), on=True, power_reader=broken)
    assert await rig.manager.power_off() is PowerOffResult.UNCERTAIN
    assert rig.remote.keys == []


# --- o que o handler devolve à API ---------------------------------------------------------------


@pytest.mark.parametrize(
    "outcome",
    [
        PowerOffResult.ALREADY_OFF,
        PowerOffResult.UNCERTAIN,
        PowerOffResult.OFFLINE,
        PowerOffResult.FAILED,
    ],
)
async def test_every_other_outcome_is_a_failure_with_its_stable_code(
    outcome: PowerOffResult,
) -> None:
    class Control:
        async def power_off(self) -> PowerOffResult:
            return outcome

    handler = tv_power_off_handler(Control())  # type: ignore[arg-type]
    result = await handler(Command("1", "tv.power.off.v1", {}))
    assert result.status is ResultStatus.FAILED
    assert result.code == outcome.value
    assert result.detail
