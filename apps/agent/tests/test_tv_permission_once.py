"""A marca de "pedido da pessoa", o token Samsung e o certificado do Remote v2: pedidos uma vez só.

Nenhum teste roda o `adb`, abre o cofre do Windows nem fala com uma TV. As regras do ADB (chave,
identidade da TV, espera do aceite) estão em `test_tv_adb_permission.py`.
"""

import asyncio
from pathlib import Path

import pytest

from uniover_agent.adapters.tv_remote_v2 import AndroidTvRemoteV2
from uniover_agent.adapters.tv_samsung import SAMSUNG_CLIENT_NAME, SamsungTvDriver
from uniover_agent.core import Command, CommandResult, ResultStatus, user_initiated
from uniover_agent.ports import (
    ADB_USER_INITIATED,
    TvNotPaired,
    TvPermissionNeeded,
    is_user_initiated,
    user_initiated_adb,
)

from .support_adb import HOST
from .support_tv import write_certificate
from .test_tv_remote_v2 import FakeLibrary
from .test_tv_samsung import FakeSamsungClient, power_on
from .test_tv_samsung_permission import CountingFactory


async def test_only_marked_commands_may_open_the_prompt() -> None:
    seen: list[bool] = []

    async def inner(command: Command) -> CommandResult:
        seen.append(is_user_initiated())
        return CommandResult(command.id, ResultStatus.OK)

    command = Command("1", "tv.livre.v1", {"action": "status"})
    await user_initiated(inner)(command)
    await user_initiated(inner, when=lambda c: c.body.get("action") != "status")(command)
    assert seen == [True, False]
    assert ADB_USER_INITIATED.get() is None  # a marca não vaza para o que vem depois


async def test_a_task_spawned_by_a_user_request_does_not_inherit_the_right_to_prompt() -> None:
    async def child() -> bool:
        return is_user_initiated()

    with user_initiated_adb():
        assert is_user_initiated()
        assert await asyncio.create_task(child()) is False
    assert not is_user_initiated()


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
