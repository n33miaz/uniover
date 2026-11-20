"""PC com duas placas: o cabo na rede da TV (sem internet) e o Wi-Fi no ponto de acesso do celular
(com internet e com a rota padrão). A TV só está no cabo. A procura e o reencontro precisam olhar a
placa que **não** tem a rota padrão, e trocar só a rede da internet não pode fazer o agente achar
que a TV mudou de lugar. Tudo com placas e rede de mentira: nada sai da máquina."""

from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters import local_networks, tv_discovery, tv_locate
from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.adapters.local_networks import AdapterRow, LocalInterface, usable_interfaces
from uniover_agent.adapters.tv_discovery import (
    ANDROID_REMOTE_PORT,
    find_tvs,
    scan_targets,
)
from uniover_agent.composition.connection import build_relocator
from uniover_agent.config import Settings

from .test_tv_relocator import DUID, TV_INFO, Lan

# O cabo: rede local da casa, roteador sem internet. É onde a TV está.
LAN_PC = LocalInterface("192.168.1.2", 24)
TV_ON_LAN = "192.168.1.3"
# O Wi-Fi: ponto de acesso do celular, com internet e com a rota padrão.
HOTSPOT_PC = LocalInterface("10.27.62.170", 24)
OTHER_HOTSPOT_PC = LocalInterface("172.20.10.2", 28)


class Interfaces:
    """As placas do PC, que o teste troca para simular o Wi-Fi caindo ou mudando."""

    def __init__(self, *interfaces: LocalInterface) -> None:
        self.interfaces: list[LocalInterface] | None = list(interfaces)

    def read(self) -> list[LocalInterface] | None:
        return None if self.interfaces is None else list(self.interfaces)

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(local_networks, "local_interfaces", self.read)
        monkeypatch.setattr(tv_locate, "local_interfaces", self.read)
        # A rota até a TV sai pelo cabo, qualquer que seja a rota padrão.
        monkeypatch.setattr(
            tv_locate,
            "local_address_for",
            lambda host: LAN_PC.address if host.startswith("192.168.1.") else None,
        )


class Probes:
    """Quem a varredura tentou alcançar; só a Android TV do cabo atende."""

    def __init__(self) -> None:
        self.hosts: list[str] = []

    async def connect(self, host: str, port: int) -> bool:
        self.hosts.append(host)
        return host == TV_ON_LAN and port == ANDROID_REMOTE_PORT

    async def fetch_json(self, url: str) -> dict[str, Any] | None:
        return None

    async def lookup_mac(self, host: str) -> str | None:
        return "74:6D:FA:5D:52:08" if host == TV_ON_LAN else None

    async def no_mdns(self, seconds: float) -> list[Any]:
        return []


def test_the_cable_and_the_wifi_are_both_real_networks() -> None:
    rows = [
        AdapterRow("10.27.62.170", 24, "Intel Wi-Fi 6 AX201", "Wi-Fi", 71, True),
        AdapterRow("192.168.1.2", 24, "Realtek PCIe GbE Family Controller", "Ethernet", 6, True),
        AdapterRow("172.22.112.1", 20, "Hyper-V Virtual Ethernet Adapter", "vEthernet", 6, True),
    ]
    assert usable_interfaces(rows) == [HOTSPOT_PC, LAN_PC]


def test_scan_targets_cover_every_real_card_and_not_only_the_default_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    Interfaces(HOTSPOT_PC, LAN_PC).install(monkeypatch)
    assert scan_targets() == [("10.27.62.170", 24), ("192.168.1.2", 24)]


def test_scan_targets_keep_the_real_prefix_and_skip_repeated_networks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    Interfaces(OTHER_HOTSPOT_PC, LAN_PC, LocalInterface("192.168.1.9", 24), HOTSPOT_PC).install(
        monkeypatch
    )
    assert scan_targets() == [("172.20.10.2", 28), ("192.168.1.2", 24), ("10.27.62.170", 24)]


def test_scan_targets_fall_back_to_the_machine_name_list_when_the_cards_cannot_be_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    Interfaces().install(monkeypatch)
    monkeypatch.setattr(tv_discovery, "usable_local_addresses", lambda: ["192.168.1.2"])
    assert scan_targets() == [("192.168.1.2", 24)]
    failed = Interfaces()
    failed.interfaces = None
    failed.install(monkeypatch)
    assert scan_targets() == [("192.168.1.2", 24)]


async def test_the_tv_on_the_cable_is_found_while_the_internet_goes_through_the_hotspot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    Interfaces(HOTSPOT_PC, LAN_PC).install(monkeypatch)
    probes = Probes()
    found = await find_tvs(
        connect=probes.connect,
        fetch_json=probes.fetch_json,
        lookup_mac=probes.lookup_mac,
        discover_mdns=probes.no_mdns,
    )
    assert [(tv.host, tv.kind) for tv in found] == [(TV_ON_LAN, "android")]
    assert any(host.startswith("10.27.62.") for host in probes.hosts)
    assert any(host.startswith("192.168.1.") for host in probes.hosts)
    # O próprio PC, nas duas placas, nunca é sondado.
    assert LAN_PC.address not in probes.hosts
    assert HOTSPOT_PC.address not in probes.hosts


async def test_the_tv_on_the_cable_is_found_even_with_no_default_route_at_all(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Celular longe e Wi-Fi fora: só o cabo, sem roteador com internet. A TV continua ali."""
    Interfaces(LAN_PC).install(monkeypatch)
    monkeypatch.setattr(tv_discovery, "local_ipv4", lambda: None)
    probes = Probes()
    found = await find_tvs(
        "android",
        connect=probes.connect,
        fetch_json=probes.fetch_json,
        lookup_mac=probes.lookup_mac,
        discover_mdns=probes.no_mdns,
    )
    assert [tv.host for tv in found] == [TV_ON_LAN]


async def test_changing_only_the_internet_card_never_moves_the_tv(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    """O Wi-Fi cai, volta e troca de ponto de acesso; a TV segue respondendo no cabo."""
    lan = Lan()
    lan.open = {(TV_ON_LAN, 8001): True}
    lan.rest = {TV_ON_LAN: TV_INFO}
    lan.install(monkeypatch)
    pc = Interfaces(HOTSPOT_PC, LAN_PC)
    pc.install(monkeypatch)
    clock = FakeClock()
    relocator = build_relocator(
        Settings(tv_host=TV_ON_LAN, tv_kind="samsung", tv_id_hint=DUID), clock, lambda: False
    )
    assert relocator is not None
    assert await relocator.step() is None
    for interfaces in ([LAN_PC], [OTHER_HOTSPOT_PC, LAN_PC], [HOTSPOT_PC, LAN_PC]):
        pc.interfaces = interfaces
        assert await relocator.step() is None
        clock.advance(40)
        assert await relocator.step() is None
    # Só a própria TV foi conferida: nenhuma varredura, nenhum outro endereço.
    assert set(lan.contacted) == {TV_ON_LAN}
    assert lan.ssdp_calls == 0
