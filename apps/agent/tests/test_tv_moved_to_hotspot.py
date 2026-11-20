"""A Android TV sai do roteador da casa (sem internet) para o ponto de acesso do celular, onde o
Wi-Fi do PC já estava. A rede do PC não muda (cabo e Wi-Fi seguem de pé), então nada acorda a
procura por troca de rede: o vigia tem de achá-la sozinho, gravar o endereço novo e entregá-lo ao
`main`, que recomeça a conexão com ele no mesmo processo. Tudo com rede de mentira."""

from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters import local_networks, tv_locate
from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.adapters.local_networks import LocalInterface
from uniover_agent.adapters.tv_discovery import ANDROID_REMOTE_PORT, DiscoveredTv, PortState
from uniover_agent.composition import connection as connection_module
from uniover_agent.composition.connection import build_relocator
from uniover_agent.config import Settings
from uniover_agent.core import TvRelocator
from uniover_agent.ports import TvCertificateRefused, TvUnreachable

from .test_tv_relocator import path_exists, read_saved

LAN_PC = LocalInterface("192.168.1.2", 24)  # cabo: roteador da casa, sem internet
HOTSPOT_PC = LocalInterface("10.27.62.170", 24)  # Wi-Fi: ponto de acesso do celular
OLD_HOST = "192.168.1.3"
NEW_HOST = "10.27.62.23"
WIFI_MAC = "02:00:5E:10:00:0A"
CABLE_MAC = "02:00:5E:10:00:0B"
STRANGER = "10.27.62.40"  # outra Android TV no ponto de acesso, que não conhece o certificado
STRANGER_MAC = "00:11:22:33:44:55"


def route_to(host: str) -> str:
    """A placa que leva até o endereço (a rota do sistema)."""
    return LAN_PC.address if host.startswith("192.168.1.") else HOTSPOT_PC.address


class House:
    """Onde a TV está, o que o ARP do Windows mostra (de todas as placas) e o que se anuncia."""

    def __init__(self) -> None:
        self.tv_host: str | None = OLD_HOST
        self.tv_mac = WIFI_MAC
        self.arp: dict[str, list[str]] = {}
        self.announced: list[str] = []
        self.stranger = False
        self.sessions: list[str] = []

    def listening(self, host: str) -> bool:
        return host == self.tv_host or (self.stranger and host == STRANGER)

    async def tcp_open(self, host: str, port: int, wait: float = 1.0) -> bool:
        return port == ANDROID_REMOTE_PORT and self.listening(host)

    async def tcp_probe(self, host: str, port: int, wait: float = 1.0) -> PortState:
        return PortState.OPEN if await self.tcp_open(host, port) else PortState.SILENT

    async def arp_table(self) -> dict[str, list[str]]:
        return self.arp

    async def arp_mac(self, host: str) -> str | None:
        for mac, hosts in self.arp.items():
            if host in hosts:
                return mac
        return None

    async def no_ssdp(self, kind: str, interface: str, wait: float = 0.0) -> list[str]:
        return []

    async def mdns(self, listen_seconds: float = 0.0) -> list[DiscoveredTv]:
        return [DiscoveredTv(host, "android") for host in self.announced]

    def remote(self) -> type:
        house = self

        class Remote:
            """A sessão com o certificado pareado: só a nossa TV a completa."""

            def __init__(self, host: str, *args: Any) -> None:
                self.host = host

            async def connect(self) -> None:
                house.sessions.append(self.host)
                if self.host == house.tv_host:
                    return
                if house.stranger and self.host == STRANGER:
                    raise TvCertificateRefused("outra TV")
                raise TvUnreachable("ninguém")

            async def disconnect(self) -> None:
                pass

        return Remote

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for module in (tv_locate,):
            monkeypatch.setattr(module, "tcp_open", self.tcp_open)
            monkeypatch.setattr(module, "tcp_probe", self.tcp_probe)
            monkeypatch.setattr(module, "arp_table", self.arp_table)
            monkeypatch.setattr(module, "arp_mac", self.arp_mac)
            monkeypatch.setattr(module, "ssdp_search", self.no_ssdp)
            monkeypatch.setattr(module, "discover_android_tvs", self.mdns)
            monkeypatch.setattr(module, "local_interfaces", lambda: [HOTSPOT_PC, LAN_PC])
            monkeypatch.setattr(
                module,
                "local_address_for",
                lambda host: (
                    LAN_PC.address if host.startswith("192.168.1.") else HOTSPOT_PC.address
                ),
            )
        monkeypatch.setattr(local_networks, "local_interfaces", lambda: [HOTSPOT_PC, LAN_PC])
        monkeypatch.setattr(connection_module, "tcp_probe", self.tcp_probe)
        monkeypatch.setattr(connection_module, "AndroidTvRemoteV2", self.remote())

    def move_to_hotspot(self) -> None:
        self.tv_host = NEW_HOST
        self.arp = {self.tv_mac: [NEW_HOST]}  # só na tabela do Wi-Fi


def relocator(clock: FakeClock, **saved: Any) -> TvRelocator:
    built = build_relocator(
        Settings(tv_host=OLD_HOST, tv_kind="android", **saved), clock, lambda: False
    )
    assert built is not None
    return built


async def steps(relocator: TvRelocator, clock: FakeClock, limit: int) -> str | None:
    for _ in range(limit):
        clock.advance(61)
        moved = await relocator.step()
        if moved is not None:
            return moved
    return None


async def test_the_tv_on_the_hotspot_is_found_by_its_mac_in_the_wifi_arp_and_saved(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    house = House()
    house.install(monkeypatch)
    house.arp = {WIFI_MAC: [OLD_HOST]}
    clock = FakeClock()
    watch = relocator(clock, tv_mac=WIFI_MAC)
    assert await watch.step() is None  # a TV está no cabo
    house.move_to_hotspot()
    assert await steps(watch, clock, 3) == NEW_HOST
    saved = read_saved(isolated_env)
    assert saved["tv_host"] == NEW_HOST
    assert saved["tv_mac"] == WIFI_MAC


async def test_a_tv_that_left_the_cable_for_the_wifi_is_confirmed_by_the_paired_certificate(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    """O MAC guardado é o do cabo; no Wi-Fi a TV tem outro, e nenhum identificador bate."""
    house = House()
    house.install(monkeypatch)
    clock = FakeClock()
    watch = relocator(clock, tv_mac=CABLE_MAC)
    assert await watch.step() is None
    house.move_to_hotspot()
    house.announced = [NEW_HOST]
    assert await steps(watch, clock, 3) == NEW_HOST
    saved = read_saved(isolated_env)
    assert saved["tv_host"] == NEW_HOST
    assert saved["tv_mac"] == WIFI_MAC  # da próxima vez o ARP a acha direto


async def test_another_android_tv_on_the_hotspot_is_never_adopted(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    house = House()
    house.install(monkeypatch)
    house.tv_host = None  # a nossa TV está desligada
    house.stranger = True
    house.arp = {STRANGER_MAC: [STRANGER]}
    house.announced = [STRANGER]
    clock = FakeClock()
    watch = relocator(clock, tv_mac=CABLE_MAC)
    assert await steps(watch, clock, 12) is None
    assert STRANGER in house.sessions  # tentou o certificado e a TV recusou
    assert not path_exists(isolated_env)  # nada foi gravado


async def test_after_a_night_with_the_tv_off_its_announce_still_finds_it_at_once(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    """Horas de procuras vazias deixam as etapas caras na cadência lenta (meia hora); a escuta do
    anúncio da TV não espera: ela não manda nada à TV."""
    house = House()
    house.install(monkeypatch)
    house.tv_host = None
    clock = FakeClock()
    watch = relocator(clock, tv_mac=CABLE_MAC)
    assert await steps(watch, clock, 240) is None  # quatro horas de TV desligada
    house.move_to_hotspot()
    house.announced = [NEW_HOST]
    assert await steps(watch, clock, 3) == NEW_HOST
