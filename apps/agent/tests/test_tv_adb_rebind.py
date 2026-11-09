"""A saída do bloqueio "outro aparelho no endereço": só quando a pessoa confirma que é a mesma TV.

Nada aqui fala com uma TV nem roda o `adb`: chave, pasta de instalação e MAC são de mentira, e o
processo é o `FakeAdbRunner`. O agente nunca conecta sozinho a um MAC trocado: os testes conferem
que o refazer do registro não conecta e que, sem ele, nenhum caminho (nem o da pessoa) conecta.
"""

import asyncio
from pathlib import Path

import pytest

from uniover_agent.adapters.adb_authorization import (
    GRANTED,
    NEEDS_USER,
    REBIND_DONE,
    REBIND_KEY_CHANGED,
    REBIND_NO_MAC,
    VERIFIED,
)
from uniover_agent.adapters.fakes import FakeTvAdb
from uniover_agent.composition.connection import declarable_capabilities
from uniover_agent.core import Command, ResultStatus, tv_adb_rebind_handler
from uniover_agent.ports import (
    AdbDeviceChanged,
    AdbIdentityUnconfirmed,
    AdbPermissionState,
    AdbUnauthorized,
    AdbUnreachable,
    user_initiated_adb,
)

from .support_adb import CONNECT, DISCONNECT, GET_STATE
from .test_tv_adb_permission import (
    MAC,
    OTHER_MAC,
    PAIRING,
    REFUSED,
    UNKNOWN,
    Home,
    fake_key,
    runner_with,
)


class Sink:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    def report(self, state: AdbPermissionState, reason: str, detail: str = "") -> None:
        self.events.append((state, reason))


@pytest.fixture
def home(tmp_path: Path) -> Home:
    house = Home(tmp_path)
    house.write_key()
    return house


# --- o registro ----------------------------------------------------------------------------------


def test_the_registration_moves_to_the_device_of_now_and_asks_for_a_new_proof(home: Home) -> None:
    authorization = home.verify(settled=True)
    authorization.note_serial("SN-ANTIGO")
    assert authorization.rebind(OTHER_MAC) == REBIND_DONE
    record = home.authorization().record
    assert record.state == GRANTED  # sem prova: o pedido da pessoa que vem depois a refaz
    assert record.mac == OTHER_MAC
    assert record.serial == ""
    assert not record.timeout_disabled and record.timeout_attempts == 0
    assert record.fingerprint == authorization.keys.fingerprint()


def test_rebinding_needs_a_mac_that_was_read(home: Home) -> None:
    authorization = home.verify()
    assert authorization.rebind("") == REBIND_NO_MAC
    assert home.authorization().record.mac == MAC


def test_a_registration_that_never_had_the_grant_does_not_gain_one(home: Home) -> None:
    authorization = home.authorization()
    assert authorization.rebind(OTHER_MAC)
    assert home.authorization().record.state == ""  # só o endereço e o aparelho foram anotados
    authorization.mark_needs_permission()
    assert authorization.rebind(MAC)
    assert home.authorization().record.state == NEEDS_USER  # uma recusa da TV não vira permissão


def test_clearing_forgets_everything(home: Home) -> None:
    authorization = home.verify(settled=True)
    authorization.clear()
    assert home.authorization().record.state == ""
    assert home.authorization().record.mac == ""


# --- o adaptador ---------------------------------------------------------------------------------


async def test_the_way_out_of_the_lock_never_connects_by_itself(home: Home) -> None:
    home.verify(settled=True)
    home.mac = OTHER_MAC  # a TV trocou de Wi-Fi para cabo: outro MAC no mesmo endereço
    sink = Sink()
    runner = runner_with(state=UNKNOWN)
    adb = home.adb(runner, permission=sink)

    # Trancado: nem o caminho automático nem o pedido da pessoa conectam a outro MAC.
    with pytest.raises(AdbDeviceChanged):
        await adb.connect()
    with user_initiated_adb(), pytest.raises(AdbDeviceChanged):
        await adb.connect()
    assert CONNECT not in runner.calls
    assert sink.events == []  # e não é falta de permissão

    # A pessoa confirma "é a mesma TV": o registro passa ao MAC de agora, sem conectar a nada.
    await adb.rebind_registration()
    assert CONNECT not in runner.calls
    assert DISCONNECT in runner.calls  # só desfaz um transporte antigo
    assert home.authorization().record.mac == OTHER_MAC
    assert home.authorization().record.state == GRANTED
    assert sink.events[-1] == ("missing", "rebound")

    # Um caminho automático segue sem conectar (a permissão não está provada)...
    with pytest.raises(AdbUnauthorized):
        await adb.connect()
    assert CONNECT not in runner.calls

    # ...e o pedido da pessoa, o de sempre, conecta (e a TV mostra o aviso se não confia na chave).
    runner2 = runner_with()
    with user_initiated_adb():
        await home.adb(runner2).connect()
    assert CONNECT in runner2.calls


async def test_the_rebind_is_refused_when_the_tv_does_not_answer_or_has_no_readable_mac(
    home: Home,
) -> None:
    home.verify()
    adb = home.adb(runner_with())
    home.mac = None
    with pytest.raises(AdbUnreachable):
        await adb.rebind_registration()
    home.mac = ""
    with pytest.raises(AdbIdentityUnconfirmed):
        await adb.rebind_registration()
    assert home.authorization().record.mac == MAC  # nada mudou


async def test_a_new_pairing_with_the_same_tv_only_asks_for_a_new_proof(home: Home) -> None:
    home.verify(settled=True)
    sink = Sink()
    runner = runner_with(state=UNKNOWN)
    adb = home.adb(runner, permission=sink)
    await adb.forget_registration()
    record = home.authorization().record
    # Mesmo MAC: nada é apagado. Chave e MAC ficam, e só a prova se refaz.
    assert record.state == GRANTED
    assert record.mac == MAC
    assert record.fingerprint == home.authorization().keys.fingerprint()
    assert record.serial == "" and not record.timeout_disabled
    assert sink.events[-1] == ("missing", "unproven")
    with pytest.raises(AdbUnauthorized):  # nada conecta sozinho antes da prova
        await adb.connect()
    assert CONNECT not in runner.calls


async def test_a_new_pairing_with_another_device_deletes_the_registration_and_says_so(
    home: Home,
) -> None:
    home.verify(settled=True)
    home.mac = OTHER_MAC
    sink = Sink()
    adb = home.adb(runner_with(state=UNKNOWN), permission=sink)
    await adb.forget_registration()
    assert home.authorization().record.state == ""
    assert home.authorization().record.mac == ""
    # O app mostra um aviso gentil: o motivo próprio não é silencioso.
    assert sink.events[-1] == ("missing", "registration_cleared")


async def test_a_new_pairing_without_a_readable_mac_keeps_the_registration(home: Home) -> None:
    home.verify(settled=True)
    home.mac = ""
    adb = home.adb(runner_with(state=UNKNOWN))
    await adb.forget_registration()
    assert home.authorization().record.state == GRANTED
    assert home.authorization().record.mac == MAC


# --- uma espera do aceite não sobrevive a um registro refeito ------------------------------------


@pytest.mark.parametrize("action", ["rebind", "forget"])
async def test_a_running_accept_wait_ends_when_the_registration_changes(
    home: Home, action: str
) -> None:
    forever = asyncio.Event()

    async def never(seconds: float) -> None:
        del seconds
        await forever.wait()

    home.verify(settled=True)
    sink = Sink()
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    adb = home.adb(runner, permission=sink, sleep=never, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    assert sink.events[-1] == ("pending", "prompt_on_tv")
    task = adb._pairing_task
    assert task is not None and not task.done()

    if action == "rebind":
        await adb.rebind_registration()
    else:
        await adb.forget_registration()

    assert sink.events[-1][0] == "missing"  # nunca preso em `pending`
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert task.cancelled() or task.done()
    assert adb._pairing_task is None
    await adb.aclose()


# --- a chave mudou: refazer o registro não concede nada ------------------------------------------


async def test_rebinding_with_a_changed_key_grants_nothing(home: Home) -> None:
    authorization = home.verify(settled=True)
    old = authorization.keys.fingerprint()
    home.write_key(fake_key("outra-chave"))  # o `adbkey` de agora não é o do registro
    home.mac = OTHER_MAC
    sink = Sink()
    runner = runner_with(connect=[REFUSED], state=UNKNOWN)
    adb = home.adb(runner, permission=sink)

    await adb.rebind_registration()

    record = home.authorization().record
    assert record.state == VERIFIED  # estado e chave anotados ficam como estavam
    assert record.fingerprint == old
    assert record.mac == OTHER_MAC  # só o aparelho de agora foi anotado
    assert not home.authorization().has_grant()  # e a chave nova não tem permissão nenhuma
    assert sink.events[-1] == ("missing", "key_changed")
    assert CONNECT not in runner.calls
    # Sem a trava do outro aparelho (a permissão antiga era de outra chave), o pedido segue:
    # é ele que pede a permissão à chave nova.
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    assert CONNECT in runner.calls


def test_the_authorization_reports_what_a_rebind_did(home: Home) -> None:
    authorization = home.verify()
    home.write_key(fake_key("outra-chave"))
    assert authorization.rebind(OTHER_MAC) == REBIND_KEY_CHANGED
    assert not authorization.another_device_at(MAC)  # outra chave: nada a proteger


async def test_clearing_the_registration_survives_a_missing_runner_call(home: Home) -> None:
    runner = runner_with()
    adb = home.adb(runner)
    await adb.forget_registration()
    assert runner.calls == [DISCONNECT]
    assert GET_STATE not in runner.calls


# --- o comando e a composição --------------------------------------------------------------------


async def test_the_handler_answers_ok_or_the_stable_error_code() -> None:
    adb = FakeTvAdb()
    handler = tv_adb_rebind_handler(adb)
    command = Command("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea3", "tv.adb.rebind.v1", {})

    ok_result = await handler(command)
    assert ok_result.status is ResultStatus.OK
    assert adb.rebinds == 1

    adb.errors = [AdbIdentityUnconfirmed("não deu para confirmar qual aparelho responde")]
    failed = await handler(command)
    assert failed.status is ResultStatus.FAILED
    assert failed.code == "adb_identity"
    assert adb.rebinds == 1


def test_the_capability_only_goes_to_the_hello_after_the_api_lists_it() -> None:
    assert declarable_capabilities(["tv.adb.rebind.v1"], lambda _c: False) == ()
    assert declarable_capabilities(["tv.adb.rebind.v1"], lambda c: c == "tv.adb.rebind.v1") == (
        "tv.adb.rebind.v1",
    )
