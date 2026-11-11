"""Que endereços o canal direto aceita e oferece: só os da rede local, dos dois lados."""

from dataclasses import dataclass

import pytest

from uniover_agent.adapters.pc_direct_network import (
    candidate_is_lan,
    filter_offer_candidates,
    is_lan_address,
    lan_host_addresses,
)
from uniover_agent.core.pc import lan


@pytest.mark.parametrize(
    "address",
    [
        "192.168.1.9",
        "10.0.0.7",
        "172.16.5.4",
        "172.31.255.1",
        "169.254.10.20",
        "fd12:3456::1",
        "fe80::1%12",
    ],
)
def test_the_local_network_addresses_are_accepted(address: str) -> None:
    assert is_lan_address(address)


@pytest.mark.parametrize(
    "address",
    [
        "8.8.8.8",
        "100.64.0.5",  # CGNAT (Tailscale e provedores): não é a rede de casa
        "2001:4860:4860::8888",
        "0.0.0.0",
        "224.0.0.251",
        "abc-123.local",
        "exemplo.com",
        "",
        "não é endereço",
        "127.0.0.1",
        "::1",
    ],
)
def test_public_names_loopback_and_odd_addresses_are_not(address: str) -> None:
    assert not is_lan_address(address)


def test_loopback_is_accepted_only_when_a_test_allows_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lan, "ALLOW_LOOPBACK", True)

    assert is_lan_address("127.0.0.1")


OFFER_LINES = [
    "v=0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "a=candidate:1 1 udp 2122260223 192.168.1.9 50000 typ host",
    "a=candidate:2 1 udp 2122194687 abc-123.local 50001 typ host",
    "a=candidate:3 1 udp 1686052607 203.0.114.5 50002 typ srflx raddr 0.0.0.0 rport 0",
    "a=candidate:4 1 tcp 1518280447 192.168.1.9 9 typ host tcptype active",
    "a=candidate:5 1 udp 2122129151 2606:4700::7 50003 typ host",
    "a=candidate:6 1 udp 2122063615 fd00::7 50004 typ host",
    "a=candidate:7 1 udp 2121998079 100.64.1.1 50005 typ host",
    "a=candidate:8 1 udp 2121932543 relay.exemplo.com 3478 typ relay",
    "a=fingerprint:sha-256 AA",
]


def test_the_offer_keeps_only_udp_candidates_of_the_local_network() -> None:
    kept = filter_offer_candidates(OFFER_LINES)

    candidates = [line for line in kept if line.startswith("a=candidate")]
    assert [line.split()[4] for line in candidates] == ["192.168.1.9", "fd00::7"]
    # O resto da oferta passa como está.
    assert "v=0" in kept
    assert "a=fingerprint:sha-256 AA" in kept


def test_a_truncated_candidate_line_is_dropped() -> None:
    assert filter_offer_candidates(["a=candidate:1 1 udp 1 192.168.1.9"]) == []


@dataclass
class FakeIp:
    ip: str | tuple[str, int, int]


@dataclass
class FakeAdapter:
    nice_name: str
    name: str
    ips: list[FakeIp]


def adapters() -> list[FakeAdapter]:
    return [
        FakeAdapter(
            "Ethernet",
            "{A}",
            [
                FakeIp("192.168.1.2"),
                FakeIp(("fd00::2", 0, 0)),
                FakeIp(("2804:14d::2", 0, 0)),
                FakeIp(("fe80::2", 0, 7)),
            ],
        ),
        FakeAdapter("Wi-Fi", "{B}", [FakeIp("10.1.1.5"), FakeIp("169.254.9.9")]),
        FakeAdapter("vEthernet (WSL (Hyper-V firewall))", "{C}", [FakeIp("172.21.208.1")]),
        FakeAdapter("vEthernet (Default Switch)", "{D}", [FakeIp("172.18.96.1")]),
        FakeAdapter("Tailscale", "{E}", [FakeIp("100.101.102.103")]),
        FakeAdapter("VPN - Empresa", "{F}", [FakeIp("10.99.0.2")]),
        FakeAdapter("Loopback Pseudo-Interface 1", "{G}", [FakeIp("127.0.0.1")]),
        FakeAdapter("Ethernet 3", "VMware Network Adapter VMnet8", [FakeIp("192.168.80.1")]),
        FakeAdapter("Docker Desktop", "{H}", [FakeIp("192.168.65.1")]),
    ]


def test_only_the_physical_private_ipv4_and_ula_ipv6_interfaces_are_offered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("ifaddr.get_adapters", adapters)

    # Sem o IPv6 global (endereço público do PC), o enlace local, a VPN, o WSL, o Hyper-V, o Docker e as virtuais.
    assert lan_host_addresses(True, True) == ["192.168.1.2", "fd00::2", "10.1.1.5"]


def test_a_pc_whose_only_lan_address_is_on_a_hyper_v_external_switch_still_offers_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    only_virtual = [
        FakeAdapter("vEthernet (External)", "{X}", [FakeIp("192.168.1.50")]),
        FakeAdapter("vEthernet (WSL (Hyper-V firewall))", "{C}", [FakeIp("172.21.208.1")]),
        FakeAdapter("Tailscale", "{E}", [FakeIp("100.101.102.103")]),
        FakeAdapter("VPN - Empresa", "{F}", [FakeIp("10.99.0.2")]),
    ]
    monkeypatch.setattr("ifaddr.get_adapters", lambda: only_virtual)

    # Sem interface física, as virtuais servem; VPN e túnel nunca.
    assert lan_host_addresses(True, True) == ["192.168.1.50", "172.21.208.1"]


def test_a_physical_interface_always_wins_over_the_virtual_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("ifaddr.get_adapters", adapters)

    assert "172.21.208.1" not in lan_host_addresses(True, True)


def test_the_ip_family_flags_are_honored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ifaddr.get_adapters", adapters)

    assert lan_host_addresses(True, False) == ["192.168.1.2", "10.1.1.5"]
    assert lan_host_addresses(False, True) == ["fd00::2"]


@pytest.mark.parametrize(
    "address",
    [
        "192.0.2.1",  # documentação (TEST-NET-1)
        "198.18.0.1",  # benchmarking
        "198.51.100.7",
        "::ffff:192.168.1.5",  # IPv4 dentro de IPv6: não se confia
        "fec0::1",  # site-local obsoleto
        "2002:c0a8:101::1",  # 6to4
    ],
)
def test_reserved_ranges_that_are_not_a_home_network_are_refused(address: str) -> None:
    assert not is_lan_address(address)


@pytest.mark.parametrize(
    "address",
    [
        "192.168.1.9",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.254",
        "169.254.9.9",
        "fd12::7",
        "fe80::1%12",
    ],
)
def test_home_networks_are_accepted(address: str) -> None:
    assert is_lan_address(address)


@pytest.mark.parametrize(
    "line",
    [
        "candidate:1 1 udp 1 192.168.1.9 5000 typ host",
        "a=candidate:1 1 UDP 1 192.168.1.9 5000 typ host generation 0",
        "candidate:5 1 udp 1 fd00::7 5000 typ prflx raddr 0.0.0.0 rport 0",
    ],
)
def test_a_udp_candidate_on_the_local_network_is_accepted(line: str) -> None:
    assert candidate_is_lan(line)


@pytest.mark.parametrize(
    "line",
    [
        "candidate:1 1 tcp 1 192.168.1.9 9 typ host tcptype active",
        "candidate:2 1 udp 1 192.168.1.9 3478 typ relay",
        "candidate:3 1 udp 1 8.8.8.8 5000 typ srflx",
        "candidate:4 1 udp 1 meu-pc.local 5000 typ host",
        "candidate:5 1 udp 1 192.168.1.9 5000 host",
        "candidate:6 1 udp 1 192.168.1.9",
        "",
    ],
)
def test_other_candidates_are_refused(line: str) -> None:
    assert not candidate_is_lan(line)
