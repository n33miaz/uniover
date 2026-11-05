"""Permissão do ADB: a chave, a identidade da TV e a espera do aceite (nunca um aviso sem pedido).

Nenhum teste roda o `adb` nem toca a pasta `.android` real: a chave, a pasta de instalação e o MAC
são de mentira, e o processo é o `FakeAdbRunner`.
"""

import asyncio
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters.adb_authorization import (
    MAX_TIMEOUT_ATTEMPTS,
    NEEDS_USER,
    VERIFIED,
    AdbAuthorization,
    AdbKeys,
    key_fingerprint,
)
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_adb_parsing import AdbOutput
from uniover_agent.ports import (
    AdbUnauthorized,
    AdbUnreachable,
    is_user_initiated,
    user_initiated_adb,
)

from .support_adb import (
    ADB,
    CONNECT,
    DISCONNECT,
    GET_STATE,
    HOST,
    LAUNCHER_QUERY,
    LEANBACK_QUERY,
    NO_ACTIVITIES,
    FakeAdbRunner,
    ok,
    shell,
)
from .test_tv_adb import Clock

ENDPOINT = f"{HOST}:5555"
MAC = "AA:BB:CC:00:11:22"
OTHER_MAC = "DE:AD:BE:EF:00:01"
FRESH = ok(f"connected to {ENDPOINT}\r\n")
STALE = ok(f"already connected to {ENDPOINT}\r\n")
DEVICE = ok("device\r\n")
UNAUTHORIZED = ok("error: device unauthorized.\r\n", returncode=1)
UNKNOWN = ok(f"error: device '{ENDPOINT}' not found\r\n", returncode=1)
REFUSED = ok(f"failed to authenticate to {ENDPOINT}\r\n")
PUT_TIMEOUT = shell("settings put global adb_allowed_connection_time 0")
GET_TIMEOUT = shell("settings get global adb_allowed_connection_time")
GET_SERIAL = shell("getprop ro.serialno")
SERIAL = "SN123456"
PAIRING: dict[str, Any] = {"pairing_watch_seconds": 9.0, "pairing_poll_seconds": 3.0}


def fake_key(label: str) -> bytes:
    return f"-----BEGIN PRIVATE KEY-----\n{label * 8}\n-----END PRIVATE KEY-----\n".encode()


KEY = fake_key("chave-de-teste")


class Home:
    """Pasta `.android`, pasta de instalação e MAC de mentira."""

    def __init__(self, root: Path) -> None:
        self.android = root / ".android"
        self.state = root / "tv" / "casa"
        self.backup = root / "tv" / ".adb-key"
        self.android.mkdir(parents=True)
        self.mac: str | None = MAC

    def write_key(self, data: bytes = KEY) -> None:
        (self.android / "adbkey").write_bytes(data)
        (self.android / "adbkey.pub").write_bytes(b"QUFB user@pc\n")

    def keys(self) -> AdbKeys:
        return AdbKeys(self.backup, self.android)

    def authorization(self, endpoint: str = ENDPOINT) -> AdbAuthorization:
        return AdbAuthorization(self.state, self.keys(), endpoint)

    async def resolve(self) -> str | None:
        return self.mac

    def adb(
        self,
        runner: FakeAdbRunner,
        clock: Clock | None = None,
        authorization: AdbAuthorization | None = None,
        **extra: Any,
    ) -> AdbTv:
        # Sem a espera do aceite (`pairing_watch_seconds=0`), salvo nos testes dela.
        extra.setdefault("pairing_watch_seconds", 0.0)
        return AdbTv(
            ADB,
            HOST,
            5555,
            timeout=1.0,
            runner=runner,
            monotonic=clock or Clock(),
            retry_after=30.0,
            authorization=authorization or self.authorization(),
            mac_resolver=self.resolve,
            **extra,
        )

    def verify(self, mac: str = MAC) -> AdbAuthorization:
        """A TV deu e provou a permissão a esta chave (o que um pedido da pessoa deixa gravado)."""
        authorization = self.authorization()
        assert authorization.mark_verified(authorization.snapshot_key(), mac)
        return authorization


@pytest.fixture
def home(tmp_path: Path) -> Home:
    house = Home(tmp_path)
    house.write_key()
    return house


def runner_with(**script: Any) -> FakeAdbRunner:
    runner = FakeAdbRunner(
        {
            CONNECT: FRESH,
            GET_STATE: DEVICE,
            DISCONNECT: ok(""),
            PUT_TIMEOUT: ok(""),
            GET_TIMEOUT: ok("0\r\n"),
            GET_SERIAL: ok(f"{SERIAL}\r\n"),
        }
    )
    for name, reply in script.items():
        runner.script[{"connect": CONNECT, "state": GET_STATE}[name]] = reply
    return runner


async def instant(seconds: float) -> None:
    del seconds
    await asyncio.sleep(0)


async def watched(adb: AdbTv) -> None:
    task = adb._pairing_task
    assert task is not None
    await asyncio.wait_for(task, 5)


def script_apps(runner: FakeAdbRunner) -> None:
    runner.script[shell(LEANBACK_QUERY)] = ok(NO_ACTIVITIES)
    runner.script[shell(LAUNCHER_QUERY)] = ok(NO_ACTIVITIES)


# --- a chave: cópia por resumo, nunca trocada por outra, nunca meio gravada -----------------------


def test_each_key_is_backed_up_under_its_own_fingerprint(home: Home) -> None:
    home.verify()
    fingerprint = key_fingerprint(KEY)
    assert fingerprint is not None
    assert (home.backup / fingerprint / "adbkey").read_bytes() == KEY
    assert not (home.state / "adb-authorization.json").read_bytes().count(b"chave-de-teste")


def test_a_second_key_keeps_the_first_backup(home: Home) -> None:
    keys = home.keys()
    first = keys.fingerprint()
    assert first is not None and keys.back_up(first)
    home.write_key(fake_key("outra"))
    second = keys.fingerprint()
    assert second is not None and second != first and keys.back_up(second)
    assert set(keys.backups()) == {first, second}
    assert (home.backup / first / "adbkey").read_bytes() == KEY


def test_a_valid_but_different_key_is_never_overwritten_and_closes_the_door(home: Home) -> None:
    home.verify()
    home.write_key(fake_key("do-usuario"))
    authorization = home.authorization()
    assert authorization.keys.restore_if_missing(authorization.record.fingerprint) is False
    assert (home.android / "adbkey").read_bytes() == fake_key("do-usuario")
    assert not authorization.verified_for(MAC)


def test_a_truncated_key_is_set_aside_and_the_valid_backup_comes_back(home: Home) -> None:
    home.verify()
    (home.android / "adbkey").write_bytes(b"-----BEGIN PRIVATE KEY-----\nabc")  # sem o fim
    authorization = home.authorization()
    authorization.prepare()
    assert (home.android / "adbkey").read_bytes() == KEY
    assert (home.android / "adbkey.invalido").exists()


def test_a_tampered_backup_is_ignored_instead_of_restored(home: Home) -> None:
    home.verify()
    fingerprint = key_fingerprint(KEY)
    assert fingerprint is not None
    (home.backup / fingerprint / "adbkey").write_bytes(fake_key("adulterada"))
    (home.android / "adbkey").unlink()
    keys = home.keys()
    assert keys.backups() == []
    assert keys.restore_if_missing(fingerprint) is False
    assert not (home.android / "adbkey").exists()


def test_a_half_written_backup_is_never_taken_for_a_good_one(home: Home) -> None:
    fingerprint = key_fingerprint(KEY)
    assert fingerprint is not None
    broken = home.backup / fingerprint
    broken.mkdir(parents=True)
    (broken / "adbkey").write_bytes(KEY[:40])
    keys = home.keys()
    assert keys.backups() == []
    assert keys.back_up(fingerprint)  # a boa substitui a que não conferia
    assert keys.backups() == [fingerprint]


async def test_a_missing_key_comes_back_before_any_adb_call(home: Home) -> None:
    home.verify()
    (home.android / "adbkey").unlink()
    present: list[bool] = []

    class Watching(FakeAdbRunner):
        async def __call__(self, argv: Sequence[str], seconds: float) -> AdbOutput:
            present.append((home.android / "adbkey").exists())
            return await super().__call__(argv, seconds)

    runner = Watching({CONNECT: FRESH, GET_STATE: DEVICE})
    await home.adb(runner).connect()
    # Sem isto o `adb` geraria uma chave nova e a TV perguntaria tudo de novo.
    assert present == [True, True]
    assert (home.android / "adbkey").read_bytes() == KEY


async def test_a_key_swapped_during_the_handshake_is_not_recorded_or_backed_up(home: Home) -> None:
    def swap() -> AdbOutput:
        home.write_key(fake_key("android-studio"))  # o Android Studio troca o `adbkey` no meio
        return FRESH

    runner = runner_with(connect=swap)
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert home.authorization().record.state == ""
    assert home.keys().backups() == []  # nem a nova nem a velha foram guardadas em nome errado
    assert PUT_TIMEOUT not in runner.calls


async def test_a_key_swapped_while_waiting_for_the_accept_is_not_recorded(home: Home) -> None:
    def swap_then_device() -> AdbOutput:
        home.write_key(fake_key("android-studio"))
        return DEVICE

    runner = runner_with(connect=FRESH, state=[UNAUTHORIZED, swap_then_device])
    adb = home.adb(runner, sleep=instant, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    assert home.authorization().record.state != VERIFIED
    assert home.authorization().record.state == NEEDS_USER
    assert PUT_TIMEOUT not in runner.calls
    assert home.keys().backups() == []


def test_the_record_survives_a_restart(home: Home) -> None:
    first = home.verify()
    first.mark_timeout_disabled()
    again = home.authorization()
    assert again.verified_for(MAC)
    assert again.record.timeout_disabled
    assert not again.timeout_step_pending()


# --- a identidade da TV: sem prova desta TV, nenhuma conexão sozinha ------------------------------


async def test_without_a_record_the_agent_never_connects_by_itself(home: Home) -> None:
    runner = runner_with(state=UNKNOWN)
    with pytest.raises(AdbUnauthorized):
        await home.adb(runner).connect()
    assert runner.calls == [GET_STATE]  # só leitura: nenhum `adb connect`, nenhum aviso na TV


async def test_a_record_for_another_address_never_connects(home: Home) -> None:
    home.verify()
    runner = runner_with(state=UNKNOWN)
    other = home.authorization("192.168.1.99:5555")  # o `tv_host` mudou
    with pytest.raises(AdbUnauthorized):
        await home.adb(runner, authorization=other).connect()
    assert runner.calls == [GET_STATE]


async def test_another_device_at_the_same_address_never_connects(home: Home) -> None:
    home.verify()
    home.mac = OTHER_MAC  # o IP foi parar em outro aparelho
    runner = runner_with(state=UNKNOWN)
    with pytest.raises(AdbUnauthorized):
        await home.adb(runner).connect()
    assert CONNECT not in runner.calls


async def test_a_tv_that_does_not_answer_on_the_network_is_unreachable_without_any_adb_call(
    home: Home,
) -> None:
    home.verify()
    home.mac = None
    runner = runner_with()
    with pytest.raises(AdbUnreachable):
        await home.adb(runner).connect()
    assert runner.calls == []


async def test_a_proven_permission_for_this_tv_lets_the_agent_reconnect(home: Home) -> None:
    home.verify()
    runner = runner_with()
    await home.adb(runner).connect()
    assert runner.calls == [CONNECT, GET_STATE]


async def test_a_reset_tv_costs_one_attempt_and_then_none_even_after_restarts(home: Home) -> None:
    home.verify()  # a TV foi restaurada de fábrica: o registro em disco já não vale
    clock = Clock()
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    adb = home.adb(runner, clock)
    with pytest.raises(AdbUnauthorized):
        await adb.connect()  # a única tentativa inevitável
    assert runner.calls.count(CONNECT) == 1
    assert home.authorization().record.state == NEEDS_USER  # gravado: sobrevive ao reinício
    for seconds in (5, 31, 600, 90000):
        clock.now = seconds
        with pytest.raises(AdbUnauthorized):
            await adb.list_apps()
        with pytest.raises(AdbUnauthorized):
            await adb.connect()
    restarted = home.adb(runner, clock)
    with pytest.raises(AdbUnauthorized):
        await restarted.connect()
    assert await restarted.keep_authorization_fresh() == "skipped"
    assert runner.calls.count(CONNECT) == 1


async def test_a_user_request_may_connect_but_a_failed_one_closes_the_door_again(
    home: Home,
) -> None:
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    adb = home.adb(runner)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    for _ in range(3):
        with pytest.raises(AdbUnauthorized):
            await adb.list_apps()
    assert runner.calls.count(CONNECT) == 1


# --- a espera do aceite só observa; a prova é de um pedido seguinte da pessoa ---------------------


async def test_the_watch_records_the_grant_without_connecting_or_disconnecting(home: Home) -> None:
    runner = runner_with(state=[UNAUTHORIZED, UNAUTHORIZED, DEVICE])
    adb = home.adb(runner, sleep=instant, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()  # o toque: o aviso aparece na TV
    assert runner.calls == [CONNECT, GET_STATE]
    await watched(adb)
    record = home.authorization().record
    assert record.state == "granted"  # aceita, ainda não provada
    assert record.timeout_disabled  # desligado já na mesma sessão, sobre o transporte vivo
    assert record.serial == SERIAL
    assert record.mac == MAC
    assert runner.calls.count(CONNECT) == 1
    assert DISCONNECT not in runner.calls  # a espera nunca desconecta
    assert adb.connected
    await adb.aclose()


async def test_the_watch_task_never_holds_the_user_marker(home: Home) -> None:
    seen: list[bool] = []

    def spy() -> AdbOutput:
        seen.append(is_user_initiated())
        return UNAUTHORIZED

    runner = runner_with(state=[UNAUTHORIZED, spy, DEVICE])
    adb = home.adb(runner, sleep=instant, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    assert seen == [False]
    await adb.aclose()


async def test_after_the_grant_a_dropped_transport_is_not_reopened_by_the_agent(
    home: Home,
) -> None:
    runner = runner_with(state=[UNAUTHORIZED, DEVICE])
    adb = home.adb(runner, sleep=instant, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    await adb.disconnect()  # a TV foi para o standby, o transporte caiu
    runner.script[GET_STATE] = UNKNOWN
    for _ in range(3):
        with pytest.raises(AdbUnauthorized):
            await adb.list_apps()
    assert runner.calls.count(CONNECT) == 1  # concedida mas não provada: só um pedido prova
    await adb.aclose()


async def test_the_next_tap_proves_the_grant_with_a_fresh_connection(home: Home) -> None:
    runner = runner_with(state=[UNAUTHORIZED, DEVICE])
    adb = home.adb(runner, sleep=instant, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    script_apps(runner)
    before = len(runner.calls)
    with user_initiated_adb():
        await adb.list_apps()  # o toque seguinte, com o transporte ainda vivo
    assert runner.calls[before : before + 4] == [
        DISCONNECT,
        CONNECT,
        GET_STATE,
        shell(LEANBACK_QUERY),
    ]
    assert home.authorization().record.state == VERIFIED
    await adb.disconnect()
    await adb.list_apps()  # provada: o agente reconecta sozinho
    assert runner.calls.count(CONNECT) == 3
    await adb.aclose()


async def test_an_accept_without_always_allow_prompts_again_only_on_the_next_tap(
    home: Home,
) -> None:
    runner = runner_with(state=[UNAUTHORIZED, DEVICE])
    adb = home.adb(runner, sleep=instant, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    assert runner.calls.count(CONNECT) == 1  # nenhum aviso novo sem toque
    runner.script[CONNECT] = REFUSED  # o toque seguinte: a TV pede de novo
    runner.script[GET_STATE] = UNAUTHORIZED
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.list_apps()
    assert home.authorization().record.state == NEEDS_USER
    connects = runner.calls.count(CONNECT)
    for _ in range(3):
        with pytest.raises(AdbUnauthorized):
            await adb.list_apps()
    assert runner.calls.count(CONNECT) == connects
    await adb.aclose()


async def test_a_live_transport_seen_outside_a_request_is_not_recorded(home: Home) -> None:
    runner = runner_with(connect=REFUSED, state=DEVICE)
    adb = home.adb(runner)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    script_apps(runner)
    assert await adb.list_apps() == []  # serve ao canal, sem conectar
    assert runner.calls.count(CONNECT) == 1
    assert home.authorization().record.state == NEEDS_USER  # nada virou permissão


async def test_a_live_transport_is_proven_by_the_users_request(home: Home) -> None:
    runner = runner_with(connect=[STALE, FRESH])
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert runner.calls[:5] == [CONNECT, GET_STATE, DISCONNECT, CONNECT, GET_STATE]
    assert home.authorization().record.state == VERIFIED


# --- o vencimento de 7 dias: desligado uma vez, só com a permissão dada ---------------------------


async def test_the_timeout_is_disabled_once_after_a_user_request(home: Home) -> None:
    runner = runner_with()
    adb = home.adb(runner)
    with user_initiated_adb():
        await adb.connect()
    assert runner.calls.count(PUT_TIMEOUT) == 1
    assert runner.calls.index(GET_TIMEOUT) > runner.calls.index(PUT_TIMEOUT)
    assert home.authorization().record.timeout_disabled
    with user_initiated_adb():
        await adb.connect()
        await home.adb(runner).connect()
    assert runner.calls.count(PUT_TIMEOUT) == 1


async def test_the_timeout_step_never_runs_on_an_automatic_connect(home: Home) -> None:
    home.verify()
    runner = runner_with()
    await home.adb(runner).connect()
    assert PUT_TIMEOUT not in runner.calls
    assert home.authorization().timeout_step_pending()


async def test_the_timeout_step_runs_when_the_channel_was_already_open(home: Home) -> None:
    home.verify()
    runner = runner_with()
    script_apps(runner)
    adb = home.adb(runner)
    await adb.connect()  # sozinho: sem o passo
    assert PUT_TIMEOUT not in runner.calls
    with user_initiated_adb():
        await adb.list_apps()
    assert runner.calls.count(PUT_TIMEOUT) == 1


async def test_a_tv_that_keeps_the_timeout_is_tried_a_few_times_and_then_left_alone(
    home: Home,
) -> None:
    runner = runner_with()
    runner.script[GET_TIMEOUT] = ok("604800000\r\n")  # a TV não aceitou o 0
    adb = home.adb(runner)
    for _ in range(MAX_TIMEOUT_ATTEMPTS + 3):
        with user_initiated_adb():
            await adb.connect()
    assert runner.calls.count(PUT_TIMEOUT) == MAX_TIMEOUT_ATTEMPTS
    assert not home.authorization().record.timeout_disabled


async def test_a_new_key_does_not_inherit_the_timeout_done_for_the_old_one(home: Home) -> None:
    first = home.verify()
    first.mark_timeout_disabled()
    home.write_key(fake_key("nova"))
    runner = runner_with()
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert runner.calls.count(PUT_TIMEOUT) == 1
    assert home.authorization().record.timeout_disabled


# --- o contato periódico: só aperto de mão, só com a identidade conferida -------------------------


async def test_the_keepalive_is_only_a_handshake_and_only_with_a_proven_permission(
    home: Home,
) -> None:
    runner = runner_with()
    assert await home.adb(runner).keep_authorization_fresh() == "skipped"
    assert runner.calls == []
    home.verify()
    assert await home.adb(runner).keep_authorization_fresh() == "fresh"
    assert runner.calls == [CONNECT, GET_STATE, DISCONNECT]  # nenhum shell, nenhuma tecla
    assert home.authorization().record.last_handshake_at > 0


async def test_the_keepalive_never_runs_for_another_device_at_the_address(home: Home) -> None:
    home.verify()
    home.mac = OTHER_MAC
    runner = runner_with(state=UNKNOWN)
    assert await home.adb(runner).keep_authorization_fresh() == "unauthorized"
    assert CONNECT not in runner.calls


async def test_the_keepalive_invalidates_the_permission_if_the_serial_is_another(
    home: Home,
) -> None:
    authorization = home.verify()
    authorization.note_serial("OUTRO-APARELHO")
    runner = runner_with()
    assert await home.adb(runner).keep_authorization_fresh() == "unauthorized"
    assert home.authorization().record.state == NEEDS_USER
    assert await home.adb(runner).keep_authorization_fresh() == "skipped"


async def test_a_keepalive_that_meets_the_prompt_stops_everything_after_it(home: Home) -> None:
    home.verify()
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    adb = home.adb(runner)
    assert await adb.keep_authorization_fresh() == "unauthorized"
    assert await adb.keep_authorization_fresh() == "skipped"
    assert runner.calls.count(CONNECT) == 1
