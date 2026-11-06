"""Permissão do ADB: a chave, a identidade da TV e a espera do aceite (nunca um aviso sem pedido).

Nenhum teste roda o `adb` nem toca a pasta `.android` real: a chave, a pasta de instalação e o MAC
são de mentira, e o processo é o `FakeAdbRunner`.
"""

import asyncio
import threading
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters import adb_authorization as adb_authorization_module
from uniover_agent.adapters.adb_authorization import (
    MAX_TIMEOUT_ATTEMPTS,
    NEEDS_USER,
    VERIFIED,
    AdbAuthorization,
    AdbKeys,
    key_fingerprint,
    resolve_tv_mac,
)
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_adb_parsing import AdbOutput
from uniover_agent.core import (
    Command,
    CommandResult,
    ResultStatus,
    UserActivity,
    tv_presence_handler,
    user_initiated,
)
from uniover_agent.ports import (
    AdbIdle,
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
        self.active = True  # alguém usa a TV pelo app agora (a janela de 60 s)

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
            user_active=lambda: self.active,
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


async def test_after_a_reset_nothing_connects_at_startup_or_while_idle(home: Home) -> None:
    home.verify()  # a TV foi restaurada de fábrica: o registro em disco já não vale
    home.active = False  # partida, vigia, tarefas de fundo: ninguém usa a TV pelo app
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    clock = Clock()
    adb = home.adb(runner, clock)
    for seconds in (0, 31, 600, 90000):
        clock.now = seconds
        with pytest.raises(AdbIdle):
            await adb.connect()
        with pytest.raises(AdbIdle):
            await adb.list_apps()
    restarted = home.adb(runner, clock)
    with pytest.raises(AdbIdle):
        await restarted.connect()  # a partida do agente
    assert CONNECT not in runner.calls  # nenhum aviso na TV sem ninguém diante dela
    assert home.authorization().record.state == VERIFIED  # ocioso não invalida nada


async def test_after_a_reset_only_the_use_of_the_tv_costs_one_attempt_and_then_none(
    home: Home,
) -> None:
    home.verify()
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    clock = Clock()
    adb = home.adb(runner, clock)
    home.active = True  # o sinal de presença acabou de chegar
    with pytest.raises(AdbUnauthorized):
        await adb.connect()  # a única tentativa: a pessoa está diante da TV e vê o aviso
    assert runner.calls.count(CONNECT) == 1
    assert home.authorization().record.state == NEEDS_USER  # gravado: sobrevive ao reinício
    for seconds in (5, 31, 600, 90000):
        clock.now = seconds
        with pytest.raises(AdbUnauthorized):
            await adb.list_apps()
        with pytest.raises(AdbUnauthorized):
            await adb.connect()
    with pytest.raises(AdbUnauthorized):
        await home.adb(runner, clock).connect()  # reinício, ainda com o app em uso
    assert runner.calls.count(CONNECT) == 1


async def test_an_idle_agent_still_uses_a_transport_that_is_already_open(home: Home) -> None:
    home.verify()
    home.active = False
    runner = runner_with(state=DEVICE)
    script_apps(runner)
    adb = home.adb(runner)
    assert await adb.list_apps() == []  # servido pelo transporte vivo, sem `adb connect`
    assert CONNECT not in runner.calls


async def test_idle_agent_gets_an_error_that_does_not_blame_the_tv(home: Home) -> None:
    home.verify()
    home.active = False
    runner = runner_with(state=UNKNOWN)
    with pytest.raises(AdbIdle, match="alguém usa a TV pelo app") as caught:
        await home.adb(runner).connect()
    # Código próprio: o app não diz "a TV ainda não deu a permissão" a uma TV que já deu.
    assert caught.value.code == "adb_idle"


async def test_the_user_activity_window_decides_if_a_connection_may_open() -> None:
    now = [0.0]
    activity = UserActivity(lambda: now[0])
    assert not activity.recent()  # ninguém usou ainda
    activity.touch()
    now[0] = 59.9
    assert activity.recent()
    now[0] = 60.1
    assert not activity.recent()
    activity.touch()
    assert activity.recent()


async def test_only_the_presence_signal_counts_as_use_of_the_tv() -> None:
    now = [0.0]
    activity = UserActivity(lambda: now[0])
    presence = tv_presence_handler(activity)

    result = await presence(Command("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1", "tv.presence.v1", {}))

    assert result.status.value == "ok"
    assert activity.recent()
    now[0] = 61.0
    assert not activity.recent()  # a janela é de 60 s


# --- o serial: só se lê dentro de um pedido da pessoa ------------------------------------------


async def test_an_automatic_connect_never_runs_a_shell_even_with_a_recorded_serial(
    home: Home,
) -> None:
    authorization = home.verify()
    authorization.note_serial(SERIAL)
    runner = runner_with()
    await home.adb(runner).connect()  # automático, com a TV em uso pelo app
    assert runner.calls == [CONNECT, GET_STATE]
    assert runner.shell_commands() == []  # nenhum shell em caminho automático


async def test_a_users_request_checks_the_recorded_serial(home: Home) -> None:
    authorization = home.verify()
    authorization.note_serial(SERIAL)
    runner = runner_with()
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert GET_SERIAL in runner.calls
    assert home.authorization().record.state == VERIFIED


# --- cópias da chave com vários processos ao mesmo tempo -----------------------------------------


def test_two_processes_backing_up_the_same_key_never_corrupt_or_delete_the_copy(
    home: Home,
) -> None:
    fingerprint = key_fingerprint(KEY)
    assert fingerprint is not None
    results: list[bool] = []
    errors: list[BaseException] = []

    def work() -> None:
        try:
            for _ in range(20):
                results.append(home.keys().back_up(fingerprint))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert home.keys().backups() == [fingerprint]
    assert (home.backup / fingerprint / "adbkey").read_bytes() == KEY
    assert results.count(True) >= 1


def test_an_existing_valid_backup_is_never_replaced_or_deleted(home: Home) -> None:
    keys = home.keys()
    fingerprint = keys.fingerprint()
    assert fingerprint is not None and keys.back_up(fingerprint)
    inode_before = (home.backup / fingerprint / "adbkey").stat().st_mtime_ns
    assert keys.back_up(fingerprint) is False
    assert (home.backup / fingerprint / "adbkey").stat().st_mtime_ns == inode_before
    assert not [entry for entry in home.backup.iterdir() if entry.name.startswith(".novo")]


def test_a_broken_backup_is_moved_aside_not_deleted_when_a_good_one_takes_its_place(
    home: Home,
) -> None:
    fingerprint = key_fingerprint(KEY)
    assert fingerprint is not None
    broken = home.backup / fingerprint
    broken.mkdir(parents=True)
    (broken / "adbkey").write_bytes(KEY[:40])
    assert home.keys().back_up(fingerprint)
    assert home.keys().backups() == [fingerprint]
    assert [entry for entry in home.backup.iterdir() if entry.name.startswith(".ruim")]


# --- formatos de chave: só a truncada se troca; o resto é do usuário -----------------------------


def test_a_key_with_a_byte_order_mark_is_still_a_valid_key(home: Home) -> None:
    home.write_key(bytes([0xEF, 0xBB, 0xBF]) + KEY)
    assert home.keys().fingerprint() is not None
    authorization = home.authorization()
    authorization.prepare()
    assert (home.android / "adbkey").read_bytes().startswith(bytes([0xEF, 0xBB, 0xBF]))
    assert not (home.android / "adbkey.invalido").exists()


def test_a_key_in_an_unknown_format_is_left_alone_and_nothing_is_recorded(home: Home) -> None:
    home.verify()  # há cópia boa da chave antiga...
    home.write_key(b"ssh-rsa AAAAB3NzaC1yc2E formato-que-nao-e-nosso")
    authorization = home.authorization()
    authorization.prepare()  # ...mas a do usuário, de formato estranho, não é trocada
    assert (home.android / "adbkey").read_bytes().startswith(b"ssh-rsa")
    assert not (home.android / "adbkey.invalido").exists()
    assert authorization.snapshot_key() is None
    assert not authorization.mark_verified(None, MAC)


async def test_an_automatic_connect_never_redoes_the_connection_even_if_the_mac_flips(
    home: Home,
) -> None:
    home.verify()
    answers = iter([MAC, OTHER_MAC])  # a segunda consulta à ARP volta diferente (corrida)

    async def flaky() -> str | None:
        return next(answers, OTHER_MAC)

    home.resolve = flaky  # type: ignore[method-assign]
    runner = runner_with(connect=STALE)
    await home.adb(runner).connect()
    assert DISCONNECT not in runner.calls  # só um pedido da pessoa desconecta e reconecta
    assert runner.calls.count(CONNECT) == 1


def test_a_grant_without_a_mac_is_recorded_but_never_allows_automatic_connects(
    home: Home, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level("WARNING"):
        authorization = home.verify(mac="")
    assert "MAC" in caplog.text
    assert not authorization.verified_for("")
    assert not authorization.verified_for(MAC)


# --- a prova dentro do mesmo toque; a espera do aceite acaba com a janela ----------------


async def test_a_one_time_accept_during_the_first_connect_is_not_recorded_as_proven(
    home: Home,
) -> None:
    # A primeira conexão volta `device` porque a pessoa aceitou o aviso durante ela, sem marcar
    # "Sempre permitir"; a segunda, ainda no mesmo pedido, mostra que a TV não guardou nada.
    runner = runner_with(connect=[FRESH, FRESH], state=[DEVICE, UNAUTHORIZED])
    clock = Clock()
    adb = home.adb(runner, clock)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    assert runner.calls[:5] == [CONNECT, GET_STATE, DISCONNECT, CONNECT, GET_STATE]
    assert home.authorization().record.state == NEEDS_USER
    assert PUT_TIMEOUT not in runner.calls  # nada foi dado como provado
    connects = runner.calls.count(CONNECT)
    for _ in range(3):
        clock.now += 31  # fora do bloqueio de 30 s: quem recusa é a trava, não a espera
        with pytest.raises(AdbUnauthorized):
            await adb.list_apps()
    assert runner.calls.count(CONNECT) == connects  # e nenhum aviso novo sem toque


async def test_two_connections_that_reach_device_inside_one_request_prove_the_grant(
    home: Home,
) -> None:
    runner = runner_with()
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert runner.calls[:5] == [CONNECT, GET_STATE, DISCONNECT, CONNECT, GET_STATE]
    assert home.authorization().record.state == VERIFIED
    assert runner.calls.count(PUT_TIMEOUT) == 1


async def test_a_proven_grant_is_not_reproven_by_the_next_request(home: Home) -> None:
    home.verify()
    runner = runner_with()
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert DISCONNECT not in runner.calls  # só uma conexão: já estava provada
    assert runner.calls.count(CONNECT) == 1


async def test_the_accept_watch_ends_with_its_window_and_never_runs_after_it(home: Home) -> None:
    clock = Clock()

    async def slow(seconds: float) -> None:
        del seconds
        clock.now += 100  # cada espera passa da janela de 90 s
        await asyncio.sleep(0)

    runner = runner_with(state=[UNAUTHORIZED, DEVICE])  # o aceite só chegaria depois da janela
    adb = home.adb(runner, clock, sleep=slow, pairing_watch_seconds=90.0, pairing_poll_seconds=3.0)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    # Nem `get-state` nem shell depois da janela; só o `disconnect` que desfaz a conexão sem aceite.
    assert runner.calls == [CONNECT, GET_STATE, DISCONNECT]
    assert home.authorization().record.state == NEEDS_USER


async def test_the_accept_watch_lives_only_in_memory(home: Home) -> None:
    forever = asyncio.Event()

    async def never(seconds: float) -> None:
        del seconds
        await forever.wait()

    runner = runner_with(state=UNAUTHORIZED)
    adb = home.adb(runner, sleep=never, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    task = adb._pairing_task
    assert task is not None and not task.done()
    await adb.aclose()  # o encerramento do agente cancela a espera
    assert task.cancelled()
    restarted = home.adb(runner_with(), **PAIRING)  # o reinício não a retoma
    assert restarted._pairing_task is None


# --- a permissão nova zera o ajuste; tentativas só pela resposta da TV; ARP; prova no toque ------


def test_a_grant_after_a_reset_does_not_inherit_the_timeout_done_before_it(home: Home) -> None:
    first = home.verify()
    first.mark_timeout_disabled()
    first.note_timeout_attempt()
    first.mark_needs_permission()  # reset de fábrica: a TV voltou ao padrão de 7 dias
    again = home.authorization()
    assert again.record.timeout_disabled  # o registro velho ainda diz "desligado"...
    assert again.mark_granted(again.snapshot_key(), MAC)
    record = home.authorization().record
    assert not record.timeout_disabled  # ...mas a permissão nova começa do zero
    assert record.timeout_attempts == 0
    assert home.authorization().timeout_step_pending()


def test_granted_to_verified_keeps_the_timeout_done_for_the_same_grant(home: Home) -> None:
    authorization = home.authorization()
    assert authorization.mark_granted(authorization.snapshot_key(), MAC)
    authorization.mark_timeout_disabled()
    assert authorization.mark_verified(authorization.snapshot_key(), MAC)
    assert home.authorization().record.timeout_disabled


async def test_after_a_reset_the_new_grant_runs_the_timeout_step_again(home: Home) -> None:
    first = home.verify()
    first.mark_timeout_disabled()
    first.mark_needs_permission()
    runner = runner_with()
    with user_initiated_adb():
        await home.adb(runner).connect()  # a pessoa tocou e a TV, já sem o ajuste, aceitou
    assert runner.calls.count(PUT_TIMEOUT) == 1
    assert home.authorization().record.timeout_disabled


async def test_timeouts_and_dropped_transports_do_not_spend_the_timeout_attempts(
    home: Home,
) -> None:
    runner = runner_with()
    runner.script[PUT_TIMEOUT] = TimeoutError()  # a TV lenta: nenhuma resposta dela
    adb = home.adb(runner)
    for _ in range(MAX_TIMEOUT_ATTEMPTS + 3):
        with user_initiated_adb():
            await adb.connect()
    record = home.authorization().record
    assert record.timeout_attempts == 0
    assert home.authorization().timeout_step_pending()
    runner.script[PUT_TIMEOUT] = ok("")  # a TV volta a responder: o ajuste enfim acontece
    with user_initiated_adb():
        await adb.connect()
    assert home.authorization().record.timeout_disabled


async def test_only_the_tvs_own_refusal_spends_an_attempt(home: Home) -> None:
    runner = runner_with()
    runner.script[GET_TIMEOUT] = ok("604800000\r\n")
    adb = home.adb(runner)
    for _ in range(MAX_TIMEOUT_ATTEMPTS):
        with user_initiated_adb():
            await adb.connect()
    assert home.authorization().record.timeout_attempts == MAX_TIMEOUT_ATTEMPTS
    assert not home.authorization().timeout_step_pending()


async def test_a_tv_that_answers_the_port_but_not_the_arp_is_not_called_unreachable(
    home: Home,
) -> None:
    home.verify()
    home.mac = ""  # porta aberta, a ARP não mostra o aparelho (VPN, outra sub-rede)
    runner = runner_with(state=UNKNOWN)
    adb = home.adb(runner)
    for _ in range(2):  # sem bloqueio de 30 s: cada chamada reavalia
        with pytest.raises(AdbIdle, match="qual aparelho responde") as caught:
            await adb.connect()
        assert caught.value.code == "adb_idle"
    assert CONNECT not in runner.calls
    assert adb._blocked_error is None


async def test_resolve_tv_mac_tells_a_closed_port_from_an_unknown_mac(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def closed(host: str, port: int, wait: float) -> bool:
        return False

    async def opened(host: str, port: int, wait: float) -> bool:
        return True

    async def no_mac(host: str) -> str | None:
        return None

    async def some_mac(host: str) -> str | None:
        return MAC

    monkeypatch.setattr(adb_authorization_module, "tcp_open", closed)
    assert await resolve_tv_mac(HOST, 5555) is None
    monkeypatch.setattr(adb_authorization_module, "tcp_open", opened)
    monkeypatch.setattr(adb_authorization_module, "arp_mac", no_mac)
    assert await resolve_tv_mac(HOST, 5555) == ""
    monkeypatch.setattr(adb_authorization_module, "arp_mac", some_mac)
    assert await resolve_tv_mac(HOST, 5555) == MAC


async def test_a_second_tap_right_after_accepting_still_proves_the_grant(home: Home) -> None:
    # O primeiro toque deixou o aviso na tela; a pessoa aceitou e tocou de novo dentro dos 30 s
    # do bloqueio: o caminho bloqueado vê `device`, mas a prova é neste toque (não num terceiro).
    runner = runner_with(connect=[REFUSED, FRESH], state=[UNKNOWN, DEVICE])
    script_apps(runner)
    adb = home.adb(runner)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    runner.script[GET_STATE] = DEVICE
    with user_initiated_adb():
        await adb.list_apps()
    assert DISCONNECT in runner.calls
    assert runner.calls.count(CONNECT) == 2  # o toque que mostrou o aviso e a conexão nova da prova
    assert home.authorization().record.state == VERIFIED


# --- arquivo de estado corrompido e cópia sem `.pub` ----------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        '{"state": "verified", "timeout_attempts": 1e400}',
        '{"state": "verified", "timeout_attempts": Infinity}',
        '{"state": "verified", "granted_at": 1e999, "last_handshake_at": NaN}',
        '{"state": "verified", "timeout_attempts": "muitas"}',
        "[1, 2, 3]",
        "isto não é json",
    ],
)
def test_a_corrupted_state_file_starts_clean_instead_of_stopping_the_agent(
    home: Home, text: str
) -> None:
    home.state.mkdir(parents=True)
    (home.state / "adb-authorization.json").write_text(text, encoding="utf-8")
    authorization = home.authorization()  # não levanta
    assert authorization.record.timeout_attempts <= MAX_TIMEOUT_ATTEMPTS
    assert not authorization.verified_for(MAC) or authorization.record.state == VERIFIED


def test_each_save_uses_its_own_temporary_file(home: Home) -> None:
    authorization = home.authorization()
    for _ in range(5):
        authorization.note_timeout_attempt()
    assert [p.name for p in home.state.iterdir()] == ["adb-authorization.json"]


def test_a_restored_key_without_a_public_part_does_not_keep_the_old_one(home: Home) -> None:
    home.verify()
    fingerprint = key_fingerprint(KEY)
    assert fingerprint is not None
    (home.backup / fingerprint / "adbkey.pub").unlink()  # cópia sem o `.pub`
    (home.android / "adbkey").unlink()
    (home.android / "adbkey.pub").write_bytes(b"pub de outra chave\n")
    assert home.keys().restore_if_missing(fingerprint)
    assert (home.android / "adbkey").read_bytes() == KEY
    assert not (home.android / "adbkey.pub").exists()


# --- revisão 5: prova só com conexão nova, serial sem trava eterna, sem rebaixar sem a TV ---------


async def test_a_second_connection_that_is_already_connected_does_not_prove_the_grant(
    home: Home,
) -> None:
    # O `disconnect` não derrubou o transporte: a segunda resposta é "already connected" + device.
    runner = runner_with(connect=[FRESH, STALE])
    with user_initiated_adb():
        await home.adb(runner).connect()  # serve ao canal, mas não prova nada
    record = home.authorization().record
    assert record.state == "granted"
    assert record.state != VERIFIED
    assert (
        runner.calls.count(PUT_TIMEOUT) == 1
    )  # o ajuste do vencimento segue sobre o transporte vivo
    home.active = True
    runner.script[GET_STATE] = UNKNOWN
    with pytest.raises(AdbUnauthorized):  # e nenhuma conexão sozinha com a permissão só `granted`
        await home.adb(runner).connect()
    assert runner.calls.count(CONNECT) == 2


async def test_a_serial_that_changed_is_re_recorded_after_a_real_proof_not_locked(
    home: Home,
) -> None:
    authorization = home.verify()
    authorization.note_serial("OUTRO-APARELHO")
    authorization.mark_timeout_disabled()
    runner = runner_with()
    adb = home.adb(runner)
    with user_initiated_adb():
        await adb.connect()  # o toque da pessoa: nada de `adb_unauthorized`
    record = home.authorization().record
    assert record.state == VERIFIED  # provada de novo, nunca `needs_user`
    assert record.serial == SERIAL  # a identidade nova foi anotada
    assert adb.connected
    # A prova foi refeita por dentro do toque: conexão, desconexão e conexão nova.
    assert runner.calls.count(CONNECT) == 2 and runner.calls.count(DISCONNECT) == 1
    assert runner.calls.count(PUT_TIMEOUT) == 1  # o ajuste do aparelho novo se refez


async def test_a_changed_serial_during_a_proof_is_re_recorded_in_the_same_call(
    home: Home,
) -> None:
    authorization = home.authorization()
    assert authorization.mark_granted(authorization.snapshot_key(), MAC)
    authorization.note_serial("OUTRO-APARELHO")
    runner = runner_with()
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert home.authorization().record.state == VERIFIED
    assert home.authorization().record.serial == SERIAL
    assert runner.calls.count(CONNECT) == 2  # só a prova normal (conexão e conexão nova)


async def test_a_lock_refusal_and_the_watchdog_never_demote_the_record(home: Home) -> None:
    authorization = home.authorization()
    assert authorization.mark_granted(authorization.snapshot_key(), MAC)
    authorization.mark_timeout_disabled()
    runner = runner_with(state=UNKNOWN)  # a TV desligada: o `get-state` não a conhece
    adb = home.adb(runner)
    with pytest.raises(AdbUnauthorized):
        await adb.list_apps()  # recusa da trava (só `granted`), não da TV
    with pytest.raises(AdbUnauthorized):
        await adb.restart_remote_service()  # o vigia vendo a TV desligada
    record = home.authorization().record
    assert record.state == "granted"  # nada de `needs_user`
    assert record.timeout_disabled  # e o ajuste do vencimento não se perdeu
    assert CONNECT not in runner.calls


async def test_only_an_explicit_refusal_by_the_tv_demotes_the_record(home: Home) -> None:
    home.verify()
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    with pytest.raises(AdbUnauthorized):
        await home.adb(runner).connect()  # automático, na janela de presença: a TV recusou
    assert home.authorization().record.state == NEEDS_USER


async def test_without_a_mac_the_proof_completes_and_is_not_repeated_forever(home: Home) -> None:
    home.mac = ""  # a ARP não mostra a TV (VPN, outra sub-rede)
    runner = runner_with()
    adb = home.adb(runner)
    with user_initiated_adb():
        await adb.connect()
    record = home.authorization().record
    assert record.state == VERIFIED and record.mac == ""  # provado com o que dá para provar
    first = list(runner.calls)
    assert first.count(DISCONNECT) == 1 and first.count(CONNECT) == 2
    script_apps(runner)
    for _ in range(3):  # os toques seguintes não derrubam nem reabrem o ADB
        with user_initiated_adb():
            await adb.list_apps()
    assert runner.calls.count(DISCONNECT) == 1
    assert runner.calls.count(CONNECT) == 2


# --- a espera do aceite, o vencimento de 7 dias e a prova (restaurados da rodada 2) -----------


async def test_a_live_transport_is_proven_by_the_users_request(home: Home) -> None:
    runner = runner_with(connect=[STALE, FRESH])
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert runner.calls[:5] == [CONNECT, GET_STATE, DISCONNECT, CONNECT, GET_STATE]
    assert home.authorization().record.state == VERIFIED


async def test_a_live_transport_seen_outside_a_request_is_not_recorded(home: Home) -> None:
    runner = runner_with(connect=REFUSED, state=DEVICE)
    adb = home.adb(runner)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    script_apps(runner)
    assert await adb.list_apps() == []  # serve ao canal, sem conectar
    assert runner.calls.count(CONNECT) == 1
    assert home.authorization().record.state == NEEDS_USER  # nada virou permissão


async def test_a_new_key_does_not_inherit_the_timeout_done_for_the_old_one(home: Home) -> None:
    first = home.verify()
    first.mark_timeout_disabled()
    home.write_key(fake_key("nova"))
    runner = runner_with()
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert runner.calls.count(PUT_TIMEOUT) == 1
    assert home.authorization().record.timeout_disabled


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


async def test_a_user_request_may_connect_but_a_failed_one_closes_the_door_again(
    home: Home,
) -> None:
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    clock = Clock()
    adb = home.adb(runner, clock)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    for _ in range(3):
        clock.now += 31  # fora do bloqueio de 30 s: quem recusa é a trava, não a espera
        with pytest.raises(AdbUnauthorized):
            await adb.list_apps()
    assert runner.calls.count(CONNECT) == 1


async def test_after_the_grant_a_dropped_transport_is_not_reopened_by_the_agent(
    home: Home,
) -> None:
    runner = runner_with(state=[UNAUTHORIZED, DEVICE])
    clock = Clock()
    adb = home.adb(runner, clock, sleep=instant, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)  # em `granted` a espera já desfez a conexão (o transporte caiu de verdade)
    assert not adb.connected
    runner.script[GET_STATE] = UNKNOWN
    for _ in range(3):
        clock.now += 31  # fora do bloqueio de 30 s: quem recusa é a trava, não a espera
        with pytest.raises(AdbUnauthorized):
            await adb.list_apps()
    assert runner.calls.count(CONNECT) == 1  # concedida mas não provada: só um pedido prova
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


async def test_the_next_tap_proves_the_grant_with_a_fresh_connection(home: Home) -> None:
    runner = runner_with(state=[UNAUTHORIZED, DEVICE])
    adb = home.adb(runner, sleep=instant, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    script_apps(runner)
    before = len(runner.calls)
    with user_initiated_adb():
        await adb.list_apps()  # o toque seguinte: a espera já desfez a conexão do `granted`
    assert runner.calls[before : before + 6] == [
        CONNECT,
        GET_STATE,
        DISCONNECT,  # a prova: um `disconnect` e uma `connect`, nunca duas
        CONNECT,
        GET_STATE,
        GET_SERIAL,  # o serial anotado se confere dentro do toque
    ]
    assert home.authorization().record.state == VERIFIED
    await adb.disconnect()  # hibernação: com a permissão provada o canal fica
    assert adb.connected
    adb._connected = False  # a TV foi para o standby e o transporte caiu
    await adb.list_apps()  # provada: o agente reconecta sozinho
    assert runner.calls.count(CONNECT) == 4
    await adb.aclose()


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
    # A espera nunca desconecta enquanto espera; ao terminar em `granted` desfaz a conexão.
    assert runner.calls.index(PUT_TIMEOUT) < runner.calls.index(DISCONNECT)
    assert runner.calls[-1] == DISCONNECT
    assert not adb.connected
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


# --- revisão 6: nada não provado fica registrado no servidor do `adb`; hibernação; MAC instável ---


async def test_the_accept_wait_running_out_undoes_the_connection(home: Home) -> None:
    clock = Clock()

    async def slow(seconds: float) -> None:
        del seconds
        clock.now += 100
        await asyncio.sleep(0)

    runner = runner_with(state=UNAUTHORIZED)  # o aviso nunca é aceito
    adb = home.adb(runner, clock, sleep=slow, pairing_watch_seconds=90.0, pairing_poll_seconds=3.0)
    with user_initiated_adb() as request, pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    await request.finish()
    assert runner.calls[-1] == DISCONNECT  # o servidor do `adb` não fica com a conexão para religar
    assert not adb.connected


async def test_a_refusal_in_a_users_request_undoes_the_connection(home: Home) -> None:
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    adb = home.adb(runner, sleep=instant, **PAIRING)
    with user_initiated_adb() as request, pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    await request.finish()
    assert DISCONNECT in runner.calls


async def test_a_refusal_on_an_automatic_path_undoes_the_connection_at_once(home: Home) -> None:
    home.verify()  # a TV foi restaurada de fábrica
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    with pytest.raises(AdbUnauthorized):
        await home.adb(runner).connect()
    assert runner.calls == [CONNECT, DISCONNECT]


async def test_stopping_at_granted_undoes_the_connection(home: Home) -> None:
    runner = runner_with(state=[UNAUTHORIZED, DEVICE])
    adb = home.adb(runner, sleep=instant, **PAIRING)
    with user_initiated_adb() as request, pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    await request.finish()
    assert home.authorization().record.state == "granted"
    assert runner.calls.index(PUT_TIMEOUT) < runner.calls.index(
        DISCONNECT
    )  # ajuste antes de soltar
    assert runner.calls[-1] == DISCONNECT
    assert not adb.connected


async def test_a_users_request_that_ends_unproven_undoes_the_connection(home: Home) -> None:
    runner = runner_with(connect=[FRESH, STALE])  # a segunda "already connected": não prova
    adb = home.adb(runner)
    with user_initiated_adb() as request:
        await adb.connect()
        assert adb.connected  # o pedido usa a conexão enquanto roda
    await request.finish()
    assert home.authorization().record.state == "granted"
    assert runner.calls[-1] == DISCONNECT
    assert not adb.connected


async def test_a_users_request_that_ends_proven_keeps_the_connection(home: Home) -> None:
    runner = runner_with()
    adb = home.adb(runner)
    with user_initiated_adb() as request:
        await adb.connect()
    await request.finish()
    assert home.authorization().record.state == VERIFIED
    assert runner.calls.count(DISCONNECT) == 1  # só o da prova, nenhum no fim
    assert adb.connected


async def test_the_handler_wrapper_finishes_the_request_before_answering(home: Home) -> None:
    runner = runner_with(connect=[FRESH, STALE])
    adb = home.adb(runner)

    async def inner(command: Command) -> CommandResult:
        await adb.connect()
        return CommandResult(command.id, ResultStatus.OK)

    command = Command("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1", "tv.apps.refresh.v1", {})
    await user_initiated(inner)(command)
    assert runner.calls[-1] == DISCONNECT


async def test_hibernation_keeps_a_proven_channel_attached(home: Home) -> None:
    home.verify()
    runner = runner_with()
    adb = home.adb(runner)
    await adb.connect()  # automático, na janela de presença
    runner.calls.clear()
    await adb.disconnect()  # a hibernação por ociosidade da sessão
    assert runner.calls == []  # nada de `adb disconnect`
    assert adb.connected
    script_apps(runner)
    home.active = False  # fora da janela de presença
    assert await adb.list_apps() == []  # as funções automáticas seguem funcionando
    assert CONNECT not in runner.calls


async def test_hibernation_disconnects_a_channel_that_is_not_proven(home: Home) -> None:
    runner = runner_with(connect=[FRESH, STALE])
    adb = home.adb(runner)
    with user_initiated_adb():
        await adb.connect()  # `granted`, sem prova
    runner.calls.clear()
    await adb.disconnect()
    assert runner.calls == [DISCONNECT]
    assert not adb.connected


async def test_hibernation_disconnects_when_the_tv_is_not_the_proven_one(home: Home) -> None:
    home.verify()
    runner = runner_with()
    adb = home.adb(runner)
    await adb.connect()
    home.mac = OTHER_MAC  # outro aparelho no mesmo endereço
    runner.calls.clear()
    await adb.disconnect()
    assert runner.calls == [DISCONNECT]


# --- MAC lido vazio num toque não derruba o registro --------------------------------------------


async def test_an_empty_arp_read_on_a_tap_does_not_overwrite_the_mac_or_drop_the_setup(
    home: Home,
) -> None:
    authorization = home.verify()
    authorization.note_serial(SERIAL)
    authorization.mark_timeout_disabled()
    home.mac = ""  # a ARP veio vazia neste toque
    runner = runner_with()
    with user_initiated_adb():
        await home.adb(runner).connect()
    record = home.authorization().record
    assert record.mac == MAC  # o MAC lido não foi apagado
    assert record.timeout_disabled and record.serial == SERIAL  # nem o ajuste nem o serial
    assert record.state == VERIFIED
    assert DISCONNECT not in runner.calls  # e nenhuma prova refeita
    assert PUT_TIMEOUT not in runner.calls


def test_an_unknown_mac_is_never_another_tv_but_two_read_macs_that_differ_are(home: Home) -> None:
    authorization = home.verify()
    assert authorization.proven_for("")  # desconhecido não invalida
    assert authorization.proven_for(MAC)
    assert not authorization.proven_for(OTHER_MAC)  # dois MACs lidos e diferentes: outra TV
    assert not authorization.verified_for("")  # conexão automática segue exigindo o MAC


def test_a_record_without_a_mac_learns_it_keeping_the_setup(home: Home) -> None:
    first = home.verify(mac="")
    first.mark_timeout_disabled()
    again = home.authorization()
    assert not again.proven_for(MAC)  # pede a prova uma vez, para aprender o MAC
    assert again.mark_verified(again.snapshot_key(), MAC)
    record = home.authorization().record
    assert record.mac == MAC and record.timeout_disabled


# --- presença atrasada ---------------------------------------------------------------------------


async def test_a_stale_presence_signal_is_ignored() -> None:
    now = datetime(2026, 11, 6, 12, 0, 0, tzinfo=UTC)
    clock = [0.0]
    activity = UserActivity(lambda: clock[0])
    presence = tv_presence_handler(activity, now=lambda: now)

    def command(sent: datetime) -> Command:
        return Command(
            "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1",
            "tv.presence.v1",
            {},
            None,
            sent.isoformat().replace("+00:00", "Z"),
        )

    await presence(command(now - timedelta(seconds=40)))  # o gateway segurou a entrega
    assert not activity.recent()
    await presence(command(now - timedelta(seconds=5)))
    assert activity.recent()


async def test_a_presence_signal_without_a_usable_timestamp_still_counts() -> None:
    clock = [0.0]
    activity = UserActivity(lambda: clock[0])
    presence = tv_presence_handler(activity)
    await presence(
        Command("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1", "tv.presence.v1", {}, None, None)
    )
    assert activity.recent()
