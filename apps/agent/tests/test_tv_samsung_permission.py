"""Permissão do UniOver na TV Samsung: um aviso só, nunca pedido em silêncio.

Nenhum teste abre o cofre real do Windows (o agente instalado usa o mesmo): todos recebem
`FakeSecretStore`. Nenhum fala com a rede nem com uma TV.
"""

import asyncio
from typing import Any

import pytest
import websocket
from samsungtvws import exceptions as samsung_exceptions

from uniover_agent import main as main_module
from uniover_agent.adapters import tv_samsung
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTransport
from uniover_agent.adapters.tv_discovery import DiscoveredTv
from uniover_agent.adapters.tv_nearby import build_finder, is_controlled, opaque_id
from uniover_agent.adapters.tv_samsung import (
    SAMSUNG_CLIENT_NAME,
    SamsungAwaitingPermission,
    SamsungTvDriver,
    _SamsungTvWs,
    is_permission_failure,
)
from uniover_agent.adapters.tv_samsung_pairing import SamsungPairingError, pair_samsung_tv
from uniover_agent.config import Settings
from uniover_agent.core import (
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    ResultStatus,
    TvPermission,
    TvSessionManager,
)
from uniover_agent.core.tv.discovery import FoundTv, tv_discover_handler
from uniover_agent.core.tv.locator import TvKnown
from uniover_agent.core.tv.session import TV_PERMISSION_NEEDED, TvSessionError
from uniover_agent.main import (
    build_tv,
    resolve_samsung_client_name,
    samsung_client_name_key,
    samsung_permission_key,
    samsung_token_name,
    tv_pair,
)
from uniover_agent.ports import TvNotPaired, TvPermissionNeeded, TvUnreachable

from .support import AGENT_ID
from .test_tv_samsung import FakeSamsungClient, power_on

HOST = "192.168.0.11"
COMMAND_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1"


class DenyingClient(FakeSamsungClient):
    """A TV que esqueceu o token: recusa (ou deixa o aviso pendente) em vez de conectar."""

    def __init__(self, error: Exception) -> None:
        super().__init__()
        self.error = error

    def open(self) -> object:
        self.opens += 1
        raise self.error


class CountingFactory:
    def __init__(self, client: FakeSamsungClient) -> None:
        self.client = client
        self.calls: list[tuple[str, str | None, str]] = []

    def __call__(self, host: str, token: str | None, name: str) -> FakeSamsungClient:
        self.calls.append((host, token, name))
        return self.client


def envelopes() -> EnvelopeFactory:
    return EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock())


# --- o nome do cliente é sempre o mesmo ---------------------------------------------------------


def test_the_client_name_is_the_historic_default() -> None:
    # Mudar este valor faria toda TV já pareada perguntar "Permitir" de novo.
    assert SAMSUNG_CLIENT_NAME == "UniOver"
    assert Settings().tv_client_name == SAMSUNG_CLIENT_NAME


def test_a_new_pairing_uses_the_fixed_name_and_keeps_it_in_the_vault() -> None:
    store = FakeSecretStore()
    assert resolve_samsung_client_name(store, "sala", "OutroNome") == SAMSUNG_CLIENT_NAME
    assert store.get(samsung_client_name_key("sala")) == SAMSUNG_CLIENT_NAME


def test_the_name_survives_an_update_or_reinstall_with_a_different_configuration() -> None:
    store = FakeSecretStore()
    resolve_samsung_client_name(store, "sala", "UniOver")
    # Reinstalar regrava o arquivo de configuração com outro valor: o cofre manda.
    assert resolve_samsung_client_name(store, "sala", "MeuNome") == "UniOver"


def test_a_token_paired_before_the_rule_keeps_the_name_it_was_paired_with() -> None:
    store = FakeSecretStore()
    store.set(samsung_token_name("sala"), "token-antigo")
    assert resolve_samsung_client_name(store, "sala", "NomeDaConfiguracao") == "NomeDaConfiguracao"
    # E passa a ficar gravado: a configuração mudar depois não muda mais o nome.
    assert resolve_samsung_client_name(store, "sala", "Outro") == "NomeDaConfiguracao"


async def test_pairing_from_the_cli_records_the_stable_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    async def pair(host: str, name: str, **_kwargs: Any) -> str:
        seen.append(name)
        return "token"

    monkeypatch.setattr(main_module, "pair_samsung_tv", pair)
    store = FakeSecretStore()
    store.set(samsung_permission_key("sala"), "needed")
    assert await tv_pair(Settings(tv_client_name="X"), HOST, "sala", "samsung", store) == 0
    assert seen == [SAMSUNG_CLIENT_NAME]
    assert store.get(samsung_client_name_key("sala")) == SAMSUNG_CLIENT_NAME
    assert store.get(samsung_permission_key("sala")) is None


# --- a abertura que separa o aviso pendente de uma TV lenta -------------------------------------


class _Socket:
    def __init__(self, frames: list[str | Exception]) -> None:
        self.frames = frames
        self.closed = False

    def recv(self) -> str:
        item = self.frames.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def close(self) -> None:
        self.closed = True


def _client_with(monkeypatch: pytest.MonkeyPatch, socket: _Socket) -> _SamsungTvWs:
    monkeypatch.setattr(websocket, "create_connection", lambda *_a, **_k: socket)
    return _SamsungTvWs(HOST, token="velho", port=8002, timeout=1, name="UniOver")


def test_a_silent_socket_after_the_handshake_means_the_tv_waits_for_the_accept(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket = _Socket([websocket.WebSocketTimeoutException()])
    client = _client_with(monkeypatch, socket)
    with pytest.raises(SamsungAwaitingPermission) as caught:
        client.open()
    assert is_permission_failure(caught.value)
    assert socket.closed


def test_the_unauthorized_event_means_permission_is_needed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket = _Socket(['{"event": "ms.channel.unauthorized"}'])
    client = _client_with(monkeypatch, socket)
    with pytest.raises(samsung_exceptions.UnauthorizedError) as caught:
        client.open()
    assert is_permission_failure(caught.value)
    assert socket.closed


def test_the_tv_giving_up_on_the_prompt_means_permission_is_needed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket = _Socket(['{"event": "ms.channel.timeOut"}'])
    client = _client_with(monkeypatch, socket)
    with pytest.raises(samsung_exceptions.ConnectionFailure) as caught:
        client.open()
    assert is_permission_failure(caught.value)


def test_a_connect_event_with_a_new_token_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    socket = _Socket(['{"event": "ms.channel.connect", "data": {"token": "novo"}}'])
    client = _client_with(monkeypatch, socket)
    client.open()
    assert client.token == "novo"
    assert not socket.closed


def test_ordinary_network_failures_are_not_a_permission_problem() -> None:
    assert not is_permission_failure(TimeoutError())
    assert not is_permission_failure(ConnectionRefusedError())
    assert not is_permission_failure(websocket.WebSocketTimeoutException())


# --- o driver: nunca pede em silêncio -----------------------------------------------------------


def driver_with(
    client: FakeSamsungClient,
    *,
    stored: str | None = "velho",
    permission_needed: bool = False,
    requester: Any = None,
    saved: list[str] | None = None,
) -> tuple[SamsungTvDriver, CountingFactory, list[bool]]:
    counting = CountingFactory(client)
    changes: list[bool] = []
    driver = SamsungTvDriver(
        HOST,
        stored,
        SAMSUNG_CLIENT_NAME,
        factory=counting,
        fetch_power=power_on,
        permission_needed=permission_needed,
        request_token=requester,
        save_token=saved.append if saved is not None else None,
    )
    driver.on_permission(changes.append)
    return driver, counting, changes


@pytest.mark.parametrize(
    "error",
    [
        samsung_exceptions.UnauthorizedError({"event": "ms.channel.unauthorized"}),
        SamsungAwaitingPermission(),
        samsung_exceptions.ConnectionFailure({"event": "ms.channel.timeOut"}),
    ],
)
async def test_a_revoked_permission_stops_the_driver_from_touching_the_tv(error: Exception) -> None:
    client = DenyingClient(error)
    driver, counting, changes = driver_with(client)
    with pytest.raises(TvPermissionNeeded):
        await driver.connect()
    assert driver.permission_needed
    assert changes == [True]
    assert len(counting.calls) == 1
    # Nenhuma tentativa seguinte chega à TV: cada uma faria o aviso aparecer sozinho.
    for _ in range(3):
        with pytest.raises(TvPermissionNeeded):
            await driver.connect()
    assert len(counting.calls) == 1
    assert client.opens == 1
    assert changes == [True]


async def test_a_plain_network_failure_is_unreachable_and_does_not_flag_permission() -> None:
    client = DenyingClient(TimeoutError("sem rota"))
    driver, _counting, changes = driver_with(client)
    with pytest.raises(TvUnreachable):
        await driver.connect()
    assert not driver.permission_needed
    assert changes == []


async def test_permission_needed_is_a_not_paired_error_for_the_existing_handling() -> None:
    driver, _counting, _changes = driver_with(FakeSamsungClient(), permission_needed=True)
    with pytest.raises(TvNotPaired):
        await driver.connect()


async def test_an_explicit_request_asks_with_the_stored_token_and_saves_the_new_one() -> None:
    asked: list[str | None] = []

    async def requester(token: str | None) -> str:
        asked.append(token)
        return "token-novo"

    saved: list[str] = []
    driver, counting, changes = driver_with(
        FakeSamsungClient(), permission_needed=True, requester=requester, saved=saved
    )
    assert await driver.request_permission() is True
    assert asked == ["velho"]
    assert saved == ["token-novo"]
    assert not driver.permission_needed
    assert changes == [False]
    # Concedida, a conexão volta a ser tentada, com o token novo e o mesmo nome.
    await driver.connect()
    assert counting.calls == [(HOST, "token-novo", SAMSUNG_CLIENT_NAME)]


async def test_a_request_that_nobody_accepts_keeps_the_state_and_the_old_token() -> None:
    async def requester(token: str | None) -> str:
        del token
        raise SamsungPairingError("o aviso na TV não foi aceito em até 60 segundos")

    saved: list[str] = []
    driver, counting, changes = driver_with(
        FakeSamsungClient(), permission_needed=True, requester=requester, saved=saved
    )
    assert await driver.request_permission() is False
    assert driver.permission_needed
    assert saved == []
    assert changes == []
    with pytest.raises(TvPermissionNeeded):
        await driver.connect()
    assert counting.calls == []


async def test_pairing_with_a_stored_token_does_not_pass_it_as_new() -> None:
    client = FakeSamsungClient("guardado")
    counting = CountingFactory(client)
    assert await pair_samsung_tv(HOST, "UniOver", token="guardado", factory=counting) == "guardado"
    assert counting.calls == [(HOST, "guardado", "UniOver")]


async def test_pairing_reports_a_pending_prompt_without_the_token() -> None:
    client = DenyingClient(SamsungAwaitingPermission())
    with pytest.raises(SamsungPairingError) as caught:
        await pair_samsung_tv(HOST, "UniOver", token="segredo", factory=CountingFactory(client))
    assert "segredo" not in str(caught.value)


# --- a sessão: o código estável e nenhuma insistência -------------------------------------------


async def test_the_session_reports_permission_needed_and_does_not_retry_on_every_key() -> None:
    client = DenyingClient(samsung_exceptions.UnauthorizedError({}))
    driver, counting, _changes = driver_with(client)
    manager = TvSessionManager(FakeClock(), driver)
    for _ in range(3):
        with pytest.raises(TvSessionError) as caught:
            await manager.send_key("OK")
        assert caught.value.code == TV_PERMISSION_NEEDED
    assert len(counting.calls) == 1


async def test_while_closed_runs_with_the_session_closed_and_holds_the_door() -> None:
    client = FakeSamsungClient()
    driver, _counting, _changes = driver_with(client)
    manager = TvSessionManager(FakeClock(), driver)
    await manager.wake()
    assert manager.snapshot().connection == "hot"
    inside: list[str] = []

    async def action() -> bool:
        inside.append(manager.snapshot().connection)
        return True

    assert await manager.while_closed(action) is True
    assert inside == ["hibernating"]
    assert client.closes >= 1


# --- o serviço de permissão: pedido, resposta rápida e aviso à API ------------------------------


class FakePermissionDriver:
    def __init__(self, *, needed: bool, reachable: bool = True, grants: bool = True) -> None:
        self.permission_needed = needed
        self._reachable = reachable
        self._grants = grants
        self.requests = 0
        self.gate = asyncio.Event()
        self.callbacks: list[Any] = []

    def on_permission(self, callback: Any) -> None:
        self.callbacks.append(callback)

    async def reachable(self) -> bool:
        return self._reachable

    async def request_permission(self) -> bool:
        self.requests += 1
        await self.gate.wait()
        if self._grants:
            self.permission_needed = False
            for callback in self.callbacks:
                callback(False)
        return self._grants


class PassThroughSession:
    async def while_closed(self, action: Any) -> bool:
        result: bool = await action()
        return result


def permission_service(driver: FakePermissionDriver) -> tuple[TvPermission, FakeTransport]:
    transport = FakeTransport()
    transport._connected = True
    return TvPermission(driver, PassThroughSession(), transport, envelopes()), transport


def request_command() -> Command:
    return Command("c1", "tv.permission.request.v1", {})


async def test_announce_tells_the_api_the_current_state_after_hello() -> None:
    service, transport = permission_service(FakePermissionDriver(needed=True))
    await service.announce()
    assert [(m["type"], m["body"]["state"]) for m in transport.sent] == [
        ("tv.permission.v1", "needed")
    ]
    granted, other = permission_service(FakePermissionDriver(needed=False))
    await granted.announce()
    assert other.sent[0]["body"]["state"] == "granted"


async def test_the_request_answers_at_once_and_the_grant_arrives_later() -> None:
    driver = FakePermissionDriver(needed=True)
    service, transport = permission_service(driver)
    handler = service.handler()
    result = await handler(request_command())
    assert result.status is ResultStatus.OK
    assert service.in_progress
    # Um segundo pedido com o aviso já na tela não faz a TV mostrar outro.
    again = await handler(Command("c2", "tv.permission.request.v1", {}))
    assert (again.status, again.code) == (ResultStatus.REJECTED, "permission_in_progress")
    await asyncio.sleep(0)
    assert driver.requests == 1
    driver.gate.set()
    await asyncio.sleep(0.01)
    await asyncio.sleep(0.01)
    assert [m["body"]["state"] for m in transport.sent] == ["granted"]
    assert not service.in_progress
    await service.aclose()


async def test_the_request_with_an_unreachable_tv_fails_without_asking() -> None:
    driver = FakePermissionDriver(needed=True, reachable=False)
    service, _transport = permission_service(driver)
    result = await service.handler()(request_command())
    assert (result.status, result.code) == (ResultStatus.FAILED, "tv_unreachable")
    assert driver.requests == 0


# --- a composição: capacidade, handler e estado inicial -----------------------------------------


def samsung_settings() -> Settings:
    return Settings(tv_kind="samsung", tv_host=HOST, tv_name="sala")


def test_without_a_token_the_setup_is_built_waiting_for_permission() -> None:
    clock = FakeClock()
    setup = build_tv(
        samsung_settings(),
        clock,
        FakeTransport(),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        FakeSecretStore(),
    )
    assert setup is not None
    assert "tv.permission.v1" in setup.capabilities
    assert "tv.permission.request.v1" in setup.handlers
    assert "tv.permission.request.v1" in setup.background_commands


async def test_a_marked_vault_starts_the_driver_blocked_and_persists_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = FakeSecretStore()
    store.set(samsung_token_name("sala"), "velho")
    store.set(samsung_permission_key("sala"), "needed")
    built: list[SamsungTvDriver] = []
    real = SamsungTvDriver

    def spy(*args: Any, **kwargs: Any) -> SamsungTvDriver:
        driver = real(*args, **kwargs)
        built.append(driver)
        return driver

    monkeypatch.setattr(main_module, "SamsungTvDriver", spy)
    clock = FakeClock()
    setup = build_tv(
        samsung_settings(),
        clock,
        FakeTransport(),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        store,
    )
    assert setup is not None
    driver = built[0]
    assert driver.permission_needed
    with pytest.raises(TvPermissionNeeded):
        await driver.connect()
    driver._set_permission_needed(False)
    assert store.get(samsung_permission_key("sala")) is None
    driver._set_permission_needed(True)
    assert store.get(samsung_permission_key("sala")) == "needed"


def test_the_driver_is_built_with_the_stable_name(monkeypatch: pytest.MonkeyPatch) -> None:
    store = FakeSecretStore()
    store.set(samsung_token_name("sala"), "velho")
    store.set(samsung_client_name_key("sala"), "UniOver")
    names: list[str] = []
    real = SamsungTvDriver

    def spy(host: str, token: str | None, name: str, **kwargs: Any) -> SamsungTvDriver:
        names.append(name)
        return real(host, token, name, **kwargs)

    monkeypatch.setattr(main_module, "SamsungTvDriver", spy)
    clock = FakeClock()
    build_tv(
        Settings(tv_kind="samsung", tv_host=HOST, tv_name="sala", tv_client_name="Mudou"),
        clock,
        FakeTransport(),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        store,
    )
    assert names == ["UniOver"]


# --- procura de TVs na rede ---------------------------------------------------------------------


def test_the_opaque_id_never_carries_the_address_or_mac() -> None:
    tv = DiscoveredTv("192.168.0.50", "samsung", ("uuid-da-tv", "AA:BB:CC:DD:EE:FF"), "Sala")
    found = opaque_id(tv)
    assert "192" not in found
    assert "AA:BB" not in found
    assert len(found) == 16
    # Estável: o mesmo aparelho, o mesmo id.
    assert found == opaque_id(DiscoveredTv("10.0.0.9", "samsung", ("uuid-da-tv",), None))


def test_the_tv_the_agent_already_controls_is_marked() -> None:
    tv = DiscoveredTv("192.168.0.50", "samsung", ("duid-1", "AA:BB:CC:DD:EE:FF"), "Sala")
    assert is_controlled(tv, None, TvKnown("duid-1", None))
    assert is_controlled(tv, None, TvKnown(None, "aa-bb-cc-dd-ee-ff"))
    assert is_controlled(tv, "192.168.0.50", TvKnown())
    assert not is_controlled(tv, "192.168.0.99", TvKnown("outro", "11:22:33:44:55:66"))


async def test_the_finder_lists_only_what_the_scan_found(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scan() -> list[DiscoveredTv]:
        return [DiscoveredTv("192.168.0.50", "samsung", ("duid-1",), "Sala")]

    monkeypatch.setattr("uniover_agent.adapters.tv_nearby.find_tvs", scan)
    found = await build_finder(HOST, TvKnown("duid-1", None))()
    assert [(tv.kind, tv.name, tv.controlled) for tv in found] == [("samsung", "Sala", True)]


async def test_the_discovery_list_goes_before_the_command_result() -> None:
    transport = FakeTransport()

    async def finder() -> list[FoundTv]:
        return [FoundTv("a1b2c3d4e5f60718", "samsung", "Sala", True)]

    handler = tv_discover_handler(finder, transport, envelopes())
    request_id = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea0"
    result = await handler(Command(COMMAND_ID, "tv.discover.v1", {"requestId": request_id}))
    assert result.status is ResultStatus.OK
    (message,) = transport.sent
    assert message["type"] == "tv.discovery.v1"
    assert message["correlationId"] == COMMAND_ID
    assert message["body"]["requestId"] == request_id
    assert message["body"]["tvs"] == [
        {"id": "a1b2c3d4e5f60718", "kind": "samsung", "name": "Sala", "controlled": True}
    ]


async def test_a_failed_scan_is_reported_without_a_list() -> None:
    transport = FakeTransport()

    async def finder() -> list[FoundTv]:
        raise OSError("sem rede")

    result = await tv_discover_handler(finder, transport, envelopes())(
        Command(COMMAND_ID, "tv.discover.v1", {"requestId": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea0"})
    )
    assert (result.status, result.code) == (ResultStatus.FAILED, "discovery_failed")
    assert transport.sent == []


def test_every_tv_setup_declares_the_discovery_capability() -> None:
    clock = FakeClock()
    setup = build_tv(
        samsung_settings(),
        clock,
        FakeTransport(),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        FakeSecretStore(),
    )
    assert setup is not None
    assert "tv.discovery.v1" in setup.capabilities
    assert "tv.discover.v1" in setup.handlers
    assert "tv.discover.v1" in setup.background_commands


def test_the_websocket_failure_helper_ignores_unrelated_errors() -> None:
    assert tv_samsung.is_permission_failure(samsung_exceptions.ConnectionFailure("texto")) is False
