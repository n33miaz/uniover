"""Rede do reencontro: SSDP, teste de vida, identidade e as placas de rede da máquina."""

import asyncio
import socket
from typing import Any

import pytest

from uniover_agent.adapters import tv_discovery, tv_locate
from uniover_agent.adapters.tv_discovery import (
    DiscoveredTv,
    find_tvs,
    local_address_for,
    subnet_hosts,
    usable_local_addresses,
)
from uniover_agent.adapters.tv_locate import (
    SSDP_TARGETS,
    _Collector,
    build_liveness,
    identify_android,
    identify_samsung,
    parse_ssdp_reply,
    ssdp_search,
)
from uniover_agent.core import TvIdentity

INFO = {"device": {"type": "Samsung SmartTV", "duid": "uuid:abc", "wifiMac": "aa-bb-cc-00-00-01"}}


# --- SSDP --------------------------------------------------------------------------------------


def test_only_search_replies_count_as_ssdp_answers() -> None:
    assert parse_ssdp_reply(b"HTTP/1.1 200 OK\r\nST: x\r\n\r\n")
    assert not parse_ssdp_reply(b"lixo qualquer")
    collector = _Collector()
    collector.datagram_received(b"HTTP/1.1 200 OK\r\n\r\n", ("192.168.0.14", 1900))
    collector.datagram_received(b"HTTP/1.1 200 OK\r\n\r\n", ("192.168.0.14", 1900))
    collector.datagram_received(b"ruido", ("192.168.0.99", 1900))
    assert collector.senders == ["192.168.0.14"]


def test_each_family_has_its_own_search_target() -> None:
    assert "samsung" in SSDP_TARGETS["samsung"]
    assert "dial" in SSDP_TARGETS["android"]


async def test_the_search_binds_to_the_given_card_and_sends_one_multicast_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[tuple[bytes, tuple[str, int]]] = []
    options: list[tuple[int, int, object]] = []
    binds: list[tuple[str, int]] = []

    class FakeSock:
        def setsockopt(self, level: int, name: int, value: object) -> None:
            options.append((level, name, value))

    class FakeTransport:
        def sendto(self, data: bytes, address: tuple[str, int]) -> None:
            sent.append((data, address))

        def get_extra_info(self, name: str) -> object:
            return FakeSock()

        def close(self) -> None:
            return None

    async def fake_endpoint(factory: Any, **kwargs: Any) -> tuple[FakeTransport, Any]:
        binds.append(kwargs["local_addr"])
        protocol = factory()
        protocol.datagram_received(b"HTTP/1.1 200 OK\r\n\r\n", ("192.168.0.14", 1900))
        return FakeTransport(), protocol

    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "create_datagram_endpoint", fake_endpoint)
    found = await ssdp_search("samsung", "192.168.0.12", wait=0)
    assert found == ["192.168.0.14"]
    assert binds == [("192.168.0.12", 0)]  # a placa da TV, não a da rota padrão
    [(request, address)] = sent
    assert address == ("239.255.255.250", 1900)
    assert b"M-SEARCH" in request
    assert SSDP_TARGETS["samsung"].encode() in request
    assert any(
        name == socket.IP_MULTICAST_IF and value == socket.inet_aton("192.168.0.12")
        for _, name, value in options
    )


async def test_a_search_that_cannot_open_the_socket_finds_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken(factory: Any, **kwargs: Any) -> None:
        raise OSError("sem placa")

    monkeypatch.setattr(asyncio.get_running_loop(), "create_datagram_endpoint", broken)
    assert await ssdp_search("android", "192.168.0.12", wait=0) == []


# --- identidade --------------------------------------------------------------------------------


async def test_samsung_identity_comes_from_the_rest_answer() -> None:
    async def fetch(url: str) -> dict[str, Any]:
        assert url == "http://192.168.0.14:8001/api/v2/"
        return INFO

    identity = await identify_samsung("192.168.0.14", fetch)
    assert identity == TvIdentity(("abc", "AA:BB:CC:00:00:01"), "AA:BB:CC:00:00:01")


async def test_a_host_that_is_not_a_samsung_has_no_identity() -> None:
    async def phone(url: str) -> dict[str, Any]:
        return {"device": {"type": "Celular"}}

    async def silent(url: str) -> None:
        return None

    assert await identify_samsung("192.168.0.11", phone) is None
    assert await identify_samsung("192.168.0.11", silent) is None


async def test_android_identity_needs_the_remote_port_and_an_arp_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def alive(host: str, port: int, wait: float = 1.0) -> bool:
        return port == 6466

    async def mac(host: str) -> str:
        return "AA:BB:CC:00:00:09"

    monkeypatch.setattr(tv_locate, "tcp_open", alive)
    monkeypatch.setattr(tv_locate, "arp_mac", mac)
    assert await identify_android("192.168.0.50") == TvIdentity(
        ("AA:BB:CC:00:00:09",), "AA:BB:CC:00:00:09"
    )

    async def no_mac(host: str) -> None:
        return None

    monkeypatch.setattr(tv_locate, "arp_mac", no_mac)
    assert await identify_android("192.168.0.50") is None

    async def dead(host: str, port: int, wait: float = 1.0) -> bool:
        return False

    monkeypatch.setattr(tv_locate, "tcp_open", dead)
    assert await identify_android("192.168.0.50") is None


# --- teste de vida ------------------------------------------------------------------------------


async def test_the_samsung_probe_tries_8001_then_8002_and_android_only_6466(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked: list[tuple[str, int]] = []
    open_ports: set[int] = set()

    async def tcp(host: str, port: int, wait: float = 1.0) -> bool:
        asked.append((host, port))
        assert wait <= 2  # espera curta: nunca segura a TV
        return port in open_ports

    monkeypatch.setattr(tv_locate, "tcp_open", tcp)
    samsung = build_liveness("samsung", "192.168.0.14")
    assert await samsung() is False
    assert asked == [("192.168.0.14", 8001), ("192.168.0.14", 8002)]
    asked.clear()
    open_ports.add(8001)
    assert await samsung() is True
    assert asked == [("192.168.0.14", 8001)]  # a primeira que atende basta
    asked.clear()
    android = build_liveness("android", "192.168.0.50")
    assert await android() is False
    assert asked == [("192.168.0.50", 6466)]


# --- placas de rede ----------------------------------------------------------------------------


def test_the_sweep_list_leaves_out_the_pc_and_an_optional_address() -> None:
    hosts = subnet_hosts("192.168.0.11", exclude="192.168.0.12")
    assert len(hosts) == 252
    assert "192.168.0.11" not in hosts
    assert "192.168.0.12" not in hosts
    assert "192.168.0.14" in hosts


def test_the_local_address_for_a_host_only_consults_the_routing_table(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class FakeUdp:
        def __enter__(self) -> FakeUdp:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def connect(self, address: tuple[str, int]) -> None:
            events.append(f"connect {address[0]}")

        def getsockname(self) -> tuple[str, int]:
            return ("192.168.0.12", 5000)

        def sendto(self, *args: object) -> None:
            raise AssertionError("não pode mandar pacote nenhum")

    monkeypatch.setattr(socket, "socket", lambda *a: FakeUdp())
    assert local_address_for("192.168.0.11") == "192.168.0.12"
    assert events == ["connect 192.168.0.11"]


def test_link_local_and_loopback_cards_are_never_scanned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tv_discovery, "local_ipv4", lambda: "169.254.190.176")
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: [
            (socket.AF_INET, 0, 0, "", (address, 0))
            for address in ("127.0.0.1", "192.168.0.12", "169.254.220.8", "172.22.112.1")
        ],
    )
    assert usable_local_addresses() == ["192.168.0.12", "172.22.112.1"]


def test_the_default_route_card_comes_first_when_it_has_a_real_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tv_discovery, "local_ipv4", lambda: "192.168.0.12")
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, 0, 0, "", ("172.22.112.1", 0))],
    )
    assert usable_local_addresses() == ["192.168.0.12", "172.22.112.1"]


async def test_tv_find_scans_the_network_of_every_usable_card(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        tv_discovery, "usable_local_addresses", lambda: ["192.168.0.12", "10.0.5.7"]
    )
    probed: list[str] = []

    async def connect(host: str, port: int) -> bool:
        probed.append(host)
        return host == "10.0.5.20" and port == 8001

    async def fetch(url: str) -> dict[str, Any]:
        return INFO

    async def no_mac(host: str) -> None:
        return None

    found = await find_tvs(connect=connect, fetch_json=fetch, lookup_mac=no_mac)
    assert [tv.host for tv in found] == ["10.0.5.20"]
    assert "192.168.0.14" in probed
    assert "192.168.0.12" not in probed  # o próprio PC
    assert "10.0.5.7" not in probed


async def test_a_discovered_samsung_exposes_its_mac() -> None:
    tv = DiscoveredTv("192.168.0.14", "samsung", ("abc", "AA:BB:CC:00:00:01"))
    assert tv.mac == "AA:BB:CC:00:00:01"
    assert DiscoveredTv("x", "android", ()).mac is None
