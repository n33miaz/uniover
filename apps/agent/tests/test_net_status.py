"""Por que a API não responde: sem internet em casa, API fora do ar ou PC sem rede nenhuma."""

import errno
import socket
import sys
from typing import Any

import pytest
from websockets.datastructures import Headers
from websockets.exceptions import InvalidMessage, InvalidStatus
from websockets.http11 import Response

from uniover_agent.adapters import network_presence as presence_module
from uniover_agent.adapters import transport_ws
from uniover_agent.adapters.api_reach import ApiReach
from uniover_agent.adapters.ssl_contexts import ssl_contexts
from uniover_agent.adapters.transport_ws import WebSocketTransport, open_failure_of
from uniover_agent.core.net_status import (
    NO_INTERNET_MIN_FAILURES,
    NO_INTERNET_MIN_SECONDS,
    UNKNOWN_PRESENCE,
    AdapterFacts,
    FailureStreak,
    NetProblem,
    NetworkPresence,
    OpenFailure,
    classify,
    failure_of_errno,
    network_presence,
)
from uniover_agent.ports import CredentialRejected, TransportError

HOME = NetworkPresence(up=True)
NO_NETWORK = NetworkPresence(up=False)
DETOUR = NetworkPresence(up=True, detour=True)


# Evidência suficiente: a mesma falha, tentativas seguidas, ao longo de um minuto.
def enough(failure: OpenFailure) -> FailureStreak:
    return FailureStreak(failure, NO_INTERNET_MIN_FAILURES, NO_INTERNET_MIN_SECONDS)


class TestClassify:
    @pytest.mark.parametrize("failure", ["dns", "unreachable"])
    def test_a_repeated_network_failure_at_home_is_no_internet(self, failure: OpenFailure) -> None:
        assert classify(enough(failure), HOME) == "no_internet"

    @pytest.mark.parametrize(
        ("count", "seconds"),
        [
            (1, 0.0),  # uma falha só (DNS do roteador tropeçou)
            (NO_INTERNET_MIN_FAILURES - 1, 600.0),  # poucas tentativas, mesmo que espaçadas
            (10, NO_INTERNET_MIN_SECONDS - 1),  # muitas, mas em menos de um minuto
        ],
    )
    def test_little_evidence_is_not_no_internet(self, count: int, seconds: float) -> None:
        assert classify(FailureStreak("dns", count, seconds), HOME) is None

    def test_a_proxy_or_vpn_in_the_way_makes_it_unknown(self) -> None:
        assert classify(enough("dns"), DETOUR) is None

    def test_unknown_presence_makes_it_unknown(self) -> None:
        assert classify(enough("dns"), UNKNOWN_PRESENCE) is None

    @pytest.mark.parametrize("failure", ["dns", "unreachable", "other"])
    def test_no_adapter_at_all_is_no_network(self, failure: OpenFailure) -> None:
        assert classify(FailureStreak(failure), NO_NETWORK) == "no_network"

    @pytest.mark.parametrize("presence", [HOME, DETOUR, UNKNOWN_PRESENCE])
    def test_the_server_answering_wrong_is_the_api_down(self, presence: NetworkPresence) -> None:
        assert classify(FailureStreak("server"), presence) == "api_down"

    def test_ambiguous_or_no_failure_says_nothing(self) -> None:
        assert classify(FailureStreak("other", 50, 3600.0), HOME) is None
        assert classify(None, HOME) is None
        assert classify(None, NO_NETWORK) is None


def adapter(
    if_type: int = 71, *addresses: str, up: bool = True, name: str = "Wi-Fi"
) -> AdapterFacts:
    return AdapterFacts(if_type, up, name, name, addresses or ("192.168.1.10",))


class TestNetworkPresence:
    @pytest.mark.parametrize(
        "address",
        [
            "192.168.1.10",
            "100.72.10.3",  # CGNAT da operadora
            "200.150.1.2",  # IP público
            "2804:14c:1:2::10",  # IPv6 global
        ],
    )
    def test_any_usable_address_on_a_real_adapter_is_a_network(self, address: str) -> None:
        assert network_presence([adapter(71, address)], proxy=False) == HOME

    @pytest.mark.parametrize("if_type", [6, 71, 243, 244])
    def test_cable_wifi_and_mobile_broadband_count(self, if_type: int) -> None:
        assert network_presence([adapter(if_type, name="Placa")], proxy=False).up is True

    def test_ppp_is_a_network_but_may_be_a_vpn(self) -> None:
        assert network_presence([adapter(23, name="Conexão")], proxy=False) == DETOUR

    @pytest.mark.parametrize(
        "address",
        ["127.0.0.1", "169.254.10.2", "fe80::1", "::1", "0.0.0.0"],  # noqa: S104 - só um dado
    )
    def test_loopback_and_link_local_are_not_a_network(self, address: str) -> None:
        assert network_presence([adapter(71, address)], proxy=False) == NO_NETWORK

    def test_a_disconnected_adapter_is_not_a_network(self) -> None:
        assert network_presence([adapter(71, up=False)], proxy=False) == NO_NETWORK
        assert network_presence([], proxy=False) == NO_NETWORK

    @pytest.mark.parametrize(
        ("if_type", "name"),
        [
            (6, "Hyper-V Virtual Ethernet Adapter"),
            (6, "vEthernet (WSL)"),
            (53, "Placa sem nome"),
            (131, "Túnel"),
            (999, "Tipo desconhecido"),
        ],
    )
    def test_only_virtual_or_ambiguous_adapters_leave_it_open(
        self, if_type: int, name: str
    ) -> None:
        assert network_presence([adapter(if_type, name=name)], proxy=False).up is None

    def test_a_vm_adapter_next_to_the_real_one_is_ignored(self) -> None:
        adapters = [adapter(6, name="vEthernet (WSL)"), adapter(71), adapter(131, name="Teredo")]
        assert network_presence(adapters, proxy=False) == HOME

    @pytest.mark.parametrize("name", ["WireGuard Tunnel", "TAP-Windows Adapter V9", "Tailscale"])
    def test_an_active_vpn_is_a_detour(self, name: str) -> None:
        adapters = [adapter(71), adapter(6, name=name)]
        assert network_presence(adapters, proxy=False) == DETOUR

    def test_a_system_proxy_is_a_detour(self) -> None:
        assert network_presence([adapter(71)], proxy=True) == DETOUR

    def test_an_environment_proxy_is_detected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in (
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
        ):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setattr(presence_module, "_registry_proxy", lambda: False)
        assert presence_module.proxy_configured() is False
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy:3128")
        assert presence_module.proxy_configured() is True

    def test_the_reader_never_raises_and_falls_back_to_unknown(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def broken() -> None:
            raise OSError("sem DLL")

        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.setattr(presence_module, "_read_adapters", broken)
        assert presence_module.read_network_presence() == UNKNOWN_PRESENCE
        monkeypatch.setattr(presence_module, "_read_adapters", lambda: None)
        assert presence_module.read_network_presence() == UNKNOWN_PRESENCE

    @pytest.mark.skipif(sys.platform != "win32", reason="lê as placas do Windows")
    def test_the_real_reader_lists_adapters_with_both_families(self) -> None:
        adapters = presence_module._read_adapters()
        assert adapters is not None
        assert any(item.addresses for item in adapters)


def test_unreachable_errnos_include_the_windows_codes() -> None:
    assert failure_of_errno(10051) == "unreachable"  # WSAENETUNREACH
    assert failure_of_errno(10065) == "unreachable"  # WSAEHOSTUNREACH
    assert failure_of_errno(errno.ENETUNREACH) == "unreachable"
    assert failure_of_errno(10061) == "other"  # recusada: a API pode estar só reiniciando
    assert failure_of_errno(None) == "other"


def _status(code: int) -> InvalidStatus:
    return InvalidStatus(Response(code, "x", Headers()))


def _winerror(code: int) -> OSError:
    error = OSError(code, "x")
    error.winerror = code  # type: ignore[attr-defined,unused-ignore]  # só existe no Windows
    return error


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (socket.gaierror(11001, "getaddrinfo failed"), "dns"),
        (_winerror(10065), "unreachable"),
        (OSError(errno.ENETUNREACH, "x"), "unreachable"),
        (_status(503), "server"),
        (_status(502), "server"),
        (_status(429), "other"),
        (InvalidMessage("resposta sem WebSocket"), "server"),
        (TimeoutError(), "other"),
        (ConnectionResetError(), "other"),
        (ConnectionRefusedError(), "other"),
        (ValueError(), "other"),
    ],
)
def test_the_transport_names_how_the_opening_failed(exc: BaseException, expected: str) -> None:
    assert open_failure_of(exc) == expected


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class TestApiReach:
    def fail(self, reach: ApiReach, clock: Clock, times: int, step: float = 30.0) -> None:
        for _ in range(times):
            reach.failed("dns", HOME)
            clock.now += step

    def test_no_internet_needs_three_failures_over_a_minute(self) -> None:
        clock = Clock()
        reach = ApiReach(clock)

        self.fail(reach, clock, NO_INTERNET_MIN_FAILURES - 1)
        assert reach.problem() is None
        self.fail(reach, clock, 1)
        assert reach.problem() == "no_internet"

    def test_fast_failures_are_not_enough(self) -> None:
        clock = Clock()
        reach = ApiReach(clock)

        self.fail(reach, clock, 10, step=1.0)
        assert reach.problem() is None

    def test_a_different_failure_restarts_the_count(self) -> None:
        clock = Clock()
        reach = ApiReach(clock)
        self.fail(reach, clock, 2)
        reach.failed("other", HOME)
        clock.now += 30
        self.fail(reach, clock, 2)

        assert reach.problem() is None

    def test_success_or_forget_clears_reason_and_count(self) -> None:
        clock = Clock()
        reach = ApiReach(clock)
        self.fail(reach, clock, NO_INTERNET_MIN_FAILURES)
        assert reach.problem() == "no_internet"

        reach.opened()
        assert reach.problem() is None
        self.fail(reach, clock, NO_INTERNET_MIN_FAILURES - 1)
        assert reach.problem() is None

        self.fail(reach, clock, 1)
        reach.forget()
        assert reach.problem() is None

    def test_no_network_and_api_down_need_one_failure(self) -> None:
        reach = ApiReach(Clock())
        reach.failed("dns", NO_NETWORK)
        assert reach.problem() == "no_network"
        reach.failed("server", UNKNOWN_PRESENCE)
        assert reach.problem() == "api_down"


def _transport(
    monkeypatch: pytest.MonkeyPatch,
    error: BaseException,
    presence: NetworkPresence,
    token: str | None = "token",  # noqa: S107 - token de teste
) -> tuple[WebSocketTransport, ApiReach, Clock, list[bool]]:
    asked: list[bool] = []

    async def failing_connect(*_args: Any, **_kwargs: Any) -> Any:
        raise error

    def read_presence() -> NetworkPresence:
        asked.append(True)
        return presence

    monkeypatch.setattr(transport_ws, "connect", failing_connect)
    monkeypatch.setattr(WebSocketTransport, "_presence", staticmethod(read_presence))
    clock = Clock()
    reach = ApiReach(clock)
    transport = WebSocketTransport("ws://api.invalid/canal", lambda: token, reach=reach)
    return transport, reach, clock, asked


async def _attempts(transport: WebSocketTransport, clock: Clock, times: int) -> None:
    for _ in range(times):
        with pytest.raises(TransportError):
            await transport.connect()
        clock.now += 30


async def test_repeated_dns_failures_at_home_become_no_internet(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, reach, clock, _ = _transport(monkeypatch, socket.gaierror(11001, "x"), HOME)

    await _attempts(transport, clock, 1)
    assert reach.problem() is None
    await _attempts(transport, clock, NO_INTERNET_MIN_FAILURES - 1)
    assert reach.problem() == "no_internet"


@pytest.mark.parametrize(
    ("error", "presence", "expected"),
    [
        (socket.gaierror(11001, "x"), NO_NETWORK, "no_network"),
        (socket.gaierror(11001, "x"), DETOUR, None),
        (_status(503), HOME, "api_down"),
        (TimeoutError(), HOME, None),
    ],
)
async def test_a_failed_opening_leaves_the_reason_for_the_tray(
    monkeypatch: pytest.MonkeyPatch,
    error: BaseException,
    presence: NetworkPresence,
    expected: NetProblem | None,
) -> None:
    transport, reach, clock, _ = _transport(monkeypatch, error, presence)

    await _attempts(transport, clock, NO_INTERNET_MIN_FAILURES)

    assert reach.problem() == expected


async def test_the_server_answering_skips_reading_the_adapters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, reach, clock, asked = _transport(monkeypatch, InvalidMessage("x"), HOME)

    await _attempts(transport, clock, 1)

    assert reach.problem() == "api_down"
    assert asked == []


async def test_a_refused_credential_proves_the_network_is_fine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, reach, _, _ = _transport(monkeypatch, _status(401), HOME)
    reach.failed("dns", NO_NETWORK)

    with pytest.raises(CredentialRejected):
        await transport.connect()

    assert reach.problem() is None


async def test_an_attempt_that_never_reaches_the_network_clears_the_old_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, reach, _, _ = _transport(monkeypatch, socket.gaierror(11001, "x"), HOME, token=None)
    reach.failed("dns", NO_NETWORK)

    with pytest.raises(CredentialRejected):
        await transport.connect()

    assert reach.problem() is None


async def test_a_tls_setup_failure_clears_the_old_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken_tls() -> Any:
        raise OSError("certificados")

    monkeypatch.setattr(ssl_contexts, "verified", broken_tls)
    reach = ApiReach(Clock())
    reach.failed("dns", NO_NETWORK)
    transport = WebSocketTransport("wss://api.invalid/canal", lambda: "token", reach=reach)

    with pytest.raises(OSError, match="certificados"):
        await transport.connect()

    assert reach.problem() is None


async def test_a_successful_opening_clears_the_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    async def opened(*_args: Any, **_kwargs: Any) -> Any:
        return object()

    monkeypatch.setattr(transport_ws, "connect", opened)
    reach = ApiReach(Clock())
    reach.failed("dns", NO_NETWORK)
    transport = WebSocketTransport("ws://api.invalid/canal", lambda: "token", reach=reach)

    await transport.connect()

    assert reach.problem() is None
