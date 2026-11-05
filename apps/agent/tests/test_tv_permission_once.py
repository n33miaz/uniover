"""A permissão da TV é pedida uma vez e nunca mais sozinha (ADB, Samsung e Remote v2).

Nenhum teste roda o `adb`, abre o cofre do Windows nem toca a pasta `.android` real: a chave e a
pasta de instalação são de `tmp_path`, e o processo é o `FakeAdbRunner`.
"""

from collections.abc import Sequence
from pathlib import Path

import pytest

from uniover_agent.adapters.adb_authorization import (
    MAX_TIMEOUT_ATTEMPTS,
    AdbAuthorization,
    AdbKeys,
)
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_adb_parsing import AdbOutput
from uniover_agent.adapters.tv_remote_v2 import AndroidTvRemoteV2
from uniover_agent.adapters.tv_samsung import SAMSUNG_CLIENT_NAME, SamsungTvDriver
from uniover_agent.core import Command, CommandResult, ResultStatus, user_initiated
from uniover_agent.ports import (
    ADB_USER_INITIATED,
    AdbUnauthorized,
    TvNotPaired,
    TvPermissionNeeded,
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
from .support_tv import write_certificate
from .test_tv_adb import Clock
from .test_tv_remote_v2 import FakeLibrary
from .test_tv_samsung import FakeSamsungClient, power_on
from .test_tv_samsung_permission import CountingFactory

SERIAL_CONNECTED = ok("connected to " + HOST + ":5555\r\n")
DEVICE = ok("device\r\n")
UNAUTHORIZED = ok("error: device unauthorized.\r\n", returncode=1)
REFUSED = ok("failed to authenticate to " + HOST + ":5555\r\n")
PUT_TIMEOUT = shell("settings put global adb_allowed_connection_time 0")
GET_TIMEOUT = shell("settings get global adb_allowed_connection_time")
KEY_BYTES = b"-----BEGIN PRIVATE KEY-----\nchave-de-teste\n-----END PRIVATE KEY-----\n"


class Home:
    """Pasta `.android` e pasta de instalação de mentira."""

    def __init__(self, root: Path) -> None:
        self.android = root / ".android"
        self.state = root / "tv" / "casa"
        self.backup = root / "tv" / ".adb-key"
        self.android.mkdir(parents=True)

    def write_key(self, data: bytes = KEY_BYTES) -> None:
        (self.android / "adbkey").write_bytes(data)
        (self.android / "adbkey.pub").write_bytes(b"QUFB user@pc\n")

    def authorization(self) -> AdbAuthorization:
        return AdbAuthorization(self.state, AdbKeys(self.backup, self.android))

    def adb(
        self,
        runner: FakeAdbRunner,
        clock: Clock | None = None,
        authorization: AdbAuthorization | None = None,
    ) -> AdbTv:
        return AdbTv(
            ADB,
            HOST,
            5555,
            timeout=1.0,
            runner=runner,
            monotonic=clock or Clock(),
            retry_after=30.0,
            authorization=authorization or self.authorization(),
        )


@pytest.fixture
def home(tmp_path: Path) -> Home:
    house = Home(tmp_path)
    house.write_key()
    return house


def authorized_runner() -> FakeAdbRunner:
    return FakeAdbRunner({CONNECT: SERIAL_CONNECTED, GET_STATE: DEVICE, DISCONNECT: ok("")})


# --- a chave: uma só, guardada fora do que a atualização troca -----------------------------------


def test_the_key_is_backed_up_once_authorized_and_survives_in_the_install_folder(
    home: Home,
) -> None:
    home.authorization().mark_authorized()
    assert (home.backup / "adbkey").read_bytes() == KEY_BYTES
    assert (home.backup / "adbkey.pub").exists()
    # Só um resumo curto da chave vai para o estado, nunca o conteúdo.
    state = (home.state / "adb-authorization.json").read_text(encoding="utf-8")
    assert "chave-de-teste" not in state


async def test_a_missing_key_comes_back_from_the_backup_before_adb_runs(home: Home) -> None:
    home.authorization().mark_authorized()
    (home.android / "adbkey").unlink()
    key_present_at_each_call: list[bool] = []

    class Watching(FakeAdbRunner):
        async def __call__(self, argv: Sequence[str], seconds: float) -> AdbOutput:
            key_present_at_each_call.append((home.android / "adbkey").exists())
            return await super().__call__(argv, seconds)

    runner = Watching({CONNECT: SERIAL_CONNECTED, GET_STATE: DEVICE})
    await home.adb(runner).connect()
    # Sem isto o `adb` geraria uma chave nova e a TV perguntaria tudo de novo.
    assert key_present_at_each_call == [True, True]
    assert (home.android / "adbkey").read_bytes() == KEY_BYTES


def test_a_different_existing_key_is_never_overwritten_and_blocks_automatic_connects(
    home: Home,
) -> None:
    home.authorization().mark_authorized()
    home.write_key(b"outra chave do usuario")
    authorization = home.authorization()
    assert authorization.keys.restore_if_missing() is False
    assert (home.android / "adbkey").read_bytes() == b"outra chave do usuario"
    # A TV só conhece a chave antiga: nada de conectar sozinho com a nova.
    assert not authorization.allows_automatic_connect()


def test_the_record_survives_a_restart_and_a_reinstall_of_the_code(home: Home) -> None:
    first = home.authorization()
    first.mark_authorized()
    first.mark_timeout_disabled()
    again = home.authorization()  # outro processo, mesma pasta de instalação
    assert again.allows_automatic_connect()
    assert again.record.timeout_disabled
    assert not again.timeout_step_pending()


# --- nenhuma conexão sozinha enquanto a TV não deu a permissão -----------------------------------


async def test_without_a_record_the_agent_never_connects_by_itself(home: Home) -> None:
    runner = FakeAdbRunner({GET_STATE: ok("error: no devices/emulators found\r\n", returncode=1)})
    adb = home.adb(runner)
    with pytest.raises(AdbUnauthorized):
        await adb.connect()
    assert runner.calls == [GET_STATE]  # só leitura: nenhum `adb connect`, nenhum aviso na TV


async def test_an_unauthorized_tv_is_not_reconnected_in_a_loop_after_the_block_expires(
    home: Home,
) -> None:
    clock = Clock()
    runner = FakeAdbRunner({CONNECT: REFUSED, GET_STATE: ok("unknown", returncode=1)})
    adb = home.adb(runner, clock)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()  # o pedido da pessoa: a única conexão
    assert runner.calls.count(CONNECT) == 1
    for seconds in (5, 31, 600, 7200, 90000):  # bem além dos 30 s do bloqueio antigo
        clock.now = seconds
        with pytest.raises(AdbUnauthorized):
            await adb.list_apps()
        with pytest.raises(AdbUnauthorized):
            await adb.connect()
    assert runner.calls.count(CONNECT) == 1
    # Reiniciar o agente (novo adaptador, mesmo arquivo de estado) também não conecta.
    restarted = home.adb(runner, clock)
    with pytest.raises(AdbUnauthorized):
        await restarted.connect()
    assert runner.calls.count(CONNECT) == 1
    assert not home.authorization().record.authorized


async def test_accepting_the_prompt_late_is_noticed_without_connecting(home: Home) -> None:
    runner = FakeAdbRunner({CONNECT: REFUSED, GET_STATE: DEVICE})
    adb = home.adb(runner)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    runner.script[shell(LEANBACK_QUERY)] = ok(NO_ACTIVITIES)
    runner.script[shell(LAUNCHER_QUERY)] = ok(NO_ACTIVITIES)
    assert await adb.list_apps() == []
    assert runner.calls.count(CONNECT) == 1
    assert home.authorization().allows_automatic_connect()


async def test_a_registered_permission_lets_the_agent_reconnect_by_itself(home: Home) -> None:
    home.authorization().mark_authorized()
    runner = authorized_runner()
    await home.adb(runner).connect()
    assert runner.calls == [CONNECT, GET_STATE]


async def test_a_prompt_that_comes_back_on_an_automatic_connect_stops_all_later_ones(
    home: Home,
) -> None:
    home.authorization().mark_authorized()  # a TV esqueceu (reset de fábrica): um aviso, não mais
    runner = FakeAdbRunner({CONNECT: REFUSED})
    adb = home.adb(runner)
    with pytest.raises(AdbUnauthorized):
        await adb.connect()
    runner.script[GET_STATE] = ok("unknown", returncode=1)
    for _ in range(3):
        with pytest.raises(AdbUnauthorized):
            await adb.connect()
    assert runner.calls.count(CONNECT) == 1


# --- o vencimento de 7 dias é desligado uma vez, num pedido da pessoa -----------------------------


async def test_the_timeout_is_disabled_once_after_a_user_initiated_authorization(
    home: Home,
) -> None:
    runner = authorized_runner()
    runner.script[PUT_TIMEOUT] = ok("")
    runner.script[GET_TIMEOUT] = ok("0\r\n")
    adb = home.adb(runner)
    with user_initiated_adb():
        await adb.connect()
    assert runner.calls.count(PUT_TIMEOUT) == 1
    assert runner.calls.index(GET_TIMEOUT) > runner.calls.index(PUT_TIMEOUT)  # conferiu depois
    assert home.authorization().record.timeout_disabled
    with user_initiated_adb():
        await adb.connect()
        await home.adb(authorized_runner()).connect()
    assert runner.calls.count(PUT_TIMEOUT) == 1  # nunca de novo
    assert (home.state / "adb-authorization.json").exists()


async def test_the_timeout_step_never_runs_on_an_automatic_connect(home: Home) -> None:
    home.authorization().mark_authorized()
    runner = authorized_runner()
    await home.adb(runner).connect()
    assert PUT_TIMEOUT not in runner.calls
    assert home.authorization().timeout_step_pending()


async def test_the_timeout_step_runs_when_the_channel_was_already_open(home: Home) -> None:
    home.authorization().mark_authorized()
    runner = authorized_runner()
    runner.script[PUT_TIMEOUT] = ok("")
    runner.script[GET_TIMEOUT] = ok("0\r\n")
    adb = home.adb(runner)
    await adb.connect()  # sozinho: canal aberto, sem o passo
    assert PUT_TIMEOUT not in runner.calls
    runner.script[shell(LEANBACK_QUERY)] = ok(NO_ACTIVITIES)
    runner.script[shell(LAUNCHER_QUERY)] = ok(NO_ACTIVITIES)
    with user_initiated_adb():
        await adb.list_apps()
    assert runner.calls.count(PUT_TIMEOUT) == 1


async def test_a_tv_that_keeps_the_timeout_is_tried_a_few_times_and_then_left_alone(
    home: Home,
) -> None:
    runner = authorized_runner()
    runner.script[PUT_TIMEOUT] = ok("")
    runner.script[GET_TIMEOUT] = ok("604800000\r\n")  # a TV não aceitou o 0
    adb = home.adb(runner)
    for _ in range(MAX_TIMEOUT_ATTEMPTS + 3):
        with user_initiated_adb():
            await adb.connect()
    assert runner.calls.count(PUT_TIMEOUT) == MAX_TIMEOUT_ATTEMPTS
    assert not home.authorization().record.timeout_disabled


async def test_a_new_key_does_not_inherit_the_timeout_done_for_the_old_one(home: Home) -> None:
    first = home.authorization()
    first.mark_authorized()
    first.mark_timeout_disabled()
    home.write_key(b"chave nova")
    runner = authorized_runner()
    runner.script[PUT_TIMEOUT] = ok("")
    runner.script[GET_TIMEOUT] = ok("0\r\n")
    with user_initiated_adb():
        await home.adb(runner).connect()
    assert home.authorization().record.timeout_disabled
    assert PUT_TIMEOUT in runner.calls


# --- o contato periódico mantém a permissão viva sem mandar nada à TV -----------------------------


async def test_the_keepalive_is_only_a_handshake_and_only_with_a_registered_permission(
    home: Home,
) -> None:
    runner = authorized_runner()
    adb = home.adb(runner)
    assert await adb.keep_authorization_fresh() == "skipped"
    assert runner.calls == []
    home.authorization().mark_authorized()
    adb = home.adb(runner)
    assert await adb.keep_authorization_fresh() == "fresh"
    assert runner.calls == [CONNECT, GET_STATE, DISCONNECT]  # nenhum shell, nenhuma tecla
    assert home.authorization().record.last_handshake_at > 0


async def test_a_keepalive_that_meets_the_prompt_stops_everything_after_it(home: Home) -> None:
    home.authorization().mark_authorized()
    runner = FakeAdbRunner({CONNECT: REFUSED, GET_STATE: ok("unknown", returncode=1)})
    adb = home.adb(runner)
    assert await adb.keep_authorization_fresh() == "unauthorized"
    assert await adb.keep_authorization_fresh() == "skipped"
    assert runner.calls.count(CONNECT) == 1


# --- a marca de "pedido da pessoa" ---------------------------------------------------------------


async def test_only_marked_commands_may_open_the_prompt() -> None:
    seen: list[bool] = []

    async def inner(command: Command) -> CommandResult:
        seen.append(ADB_USER_INITIATED.get())
        return CommandResult(command.id, ResultStatus.OK)

    command = Command("1", "tv.livre.v1", {"action": "status"})
    await user_initiated(inner)(command)
    await user_initiated(inner, when=lambda c: c.body.get("action") != "status")(command)
    assert seen == [True, False]
    assert ADB_USER_INITIATED.get() is False  # a marca não vaza para o que vem depois


# --- Samsung e Remote v2: token e certificado são reaproveitados, nunca pedidos de novo -----------


async def test_the_samsung_token_is_reused_and_a_refusal_never_asks_again() -> None:
    client = FakeSamsungClient(token="guardado")
    saved: list[str] = []
    counting = CountingFactory(client)
    driver = SamsungTvDriver(
        HOST,
        "guardado",
        SAMSUNG_CLIENT_NAME,
        factory=counting,
        fetch_power=power_on,
        save_token=saved.append,
    )
    await driver.connect()
    assert counting.calls == [(HOST, "guardado", SAMSUNG_CLIENT_NAME)]
    assert saved == []  # o mesmo token: nada novo a guardar
    blocked = SamsungTvDriver(
        HOST,
        "guardado",
        SAMSUNG_CLIENT_NAME,
        factory=counting,
        permission_needed=True,  # o que o cofre lembra depois de um reinício
    )
    with pytest.raises(TvPermissionNeeded):
        await blocked.connect()
    assert len(counting.calls) == 1


async def test_the_remote_v2_certificate_is_reused_and_never_regenerated(tmp_path: Path) -> None:
    write_certificate(tmp_path, "UniOver")
    before = {name: (tmp_path / name).read_bytes() for name in ("cert.pem", "key.pem")}
    paths: list[tuple[str, str]] = []
    library = FakeLibrary()

    def factory(name: str, certfile: str, keyfile: str, host: str) -> FakeLibrary:
        del name, host
        paths.append((certfile, keyfile))
        return library

    adapter = AndroidTvRemoteV2("10.0.0.4", "UniOver", tmp_path, client_factory=factory)
    await adapter.connect()
    await adapter.connect()
    assert paths == [(str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))]
    assert {name: (tmp_path / name).read_bytes() for name in before} == before


async def test_a_missing_remote_v2_pair_is_not_created_by_connecting(tmp_path: Path) -> None:
    called: list[str] = []

    def factory(*_args: str) -> FakeLibrary:
        called.append("fábrica")
        return FakeLibrary()

    adapter = AndroidTvRemoteV2("10.0.0.4", "UniOver", tmp_path / "vazio", client_factory=factory)
    with pytest.raises(TvNotPaired):
        await adapter.connect()
    assert called == []
    assert not (tmp_path / "vazio").exists()
