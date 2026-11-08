"""A TV e o PC trocam de rede (o roteador de casa caiu e os dois foram para o ponto de acesso do
celular): a TV ganha endereço de outra faixa e precisa ser reencontrada nela, sem adotar um
aparelho qualquer e sem pedir pareamento de novo. Tudo com rede de mentira: nada é varrido de
verdade."""

import sys
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters import local_networks, tv_locate
from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.adapters.local_networks import (
    AdapterRow,
    LocalInterface,
    network_signature,
    same_network,
    sweep_networks,
    usable_interfaces,
)
from uniover_agent.adapters.tv_discovery import subnet_hosts
from uniover_agent.composition.connection import build_relocator
from uniover_agent.config import Settings
from uniover_agent.core import TvKnown, TvRelocator

from .test_tv_locator import DUID as LOCATOR_DUID
from .test_tv_locator import MAC as LOCATOR_MAC
from .test_tv_locator import ME, OTHER, world
from .test_tv_relocator import DUID, TV_INFO, Lan, Scene, path_exists, read_saved

MAC_FOR_SEARCHED = LOCATOR_MAC
OLD_HOST = "192.168.1.20"  # a TV na rede do roteador de casa (que caiu)
HOME_PC = LocalInterface("192.168.1.10", 24)
HOTSPOT_PC = LocalInterface("172.20.10.2", 28)  # o ponto de acesso do iPhone é um /28
HOTSPOT_TV = "172.20.10.5"


class Recorder:
    """O registrador de diagnóstico de mentira: guarda o que foi registrado."""

    def __init__(self) -> None:
        self.events: list[tuple[str, str, str]] = []

    def record(self, kind: str, severity: str, detail: str, **_: Any) -> None:
        self.events.append((kind, severity, detail))


class Pc:
    """As placas do PC, que o teste muda para simular a troca de rede."""

    def __init__(self, *interfaces: LocalInterface) -> None:
        self.interfaces = list(interfaces)

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(tv_locate, "local_interfaces", lambda: list(self.interfaces))
        monkeypatch.setattr(local_networks, "local_interfaces", lambda: list(self.interfaces))
        monkeypatch.setattr(
            tv_locate,
            "local_address_for",
            lambda host: self.interfaces[0].address if self.interfaces else None,
        )


def settings_old_host() -> Settings:
    return Settings(tv_host=OLD_HOST, tv_kind="samsung", tv_id_hint=DUID)


def in_known_networks(host: str) -> bool:
    return same_network("172.20.10.0", host, 28) is True or same_network(OLD_HOST, host) is True


# --- a TV foi para o ponto de acesso ----------


async def test_the_tv_on_the_hotspot_subnet_is_found_and_saved(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    lan.open = {(HOTSPOT_TV, 8001): True}
    lan.rest = {HOTSPOT_TV: TV_INFO}
    lan.install(monkeypatch)
    pc = Pc(HOME_PC)
    pc.install(monkeypatch)
    recorder = Recorder()
    clock = FakeClock()
    relocator = build_relocator(
        settings_old_host(),
        clock,
        lambda: False,
        recorder=recorder,  # type: ignore[arg-type]
    )
    assert relocator is not None
    # Ainda na rede de casa: o roteador caiu, a TV sumiu e a procura não acha nada.
    assert [await relocator.step() for _ in range(3)] == [None, None, None]
    assert all(host.startswith("192.168.1.") for host in lan.contacted)
    lan.contacted.clear()

    pc.interfaces = [HOTSPOT_PC]  # o PC entrou no ponto de acesso; a TV entrou depois dele
    assert await relocator.step() is None  # a rede nova ainda não provou ser estável
    clock.advance(40)
    assert await relocator.step() == HOTSPOT_TV
    assert read_saved(isolated_env)["tv_host"] == HOTSPOT_TV
    # A faixa do ponto de acesso foi varrida (não só a do endereço velho) e nada além das duas.
    assert any(host.startswith("172.20.10.") for host in lan.contacted)
    assert all(in_known_networks(host) for host in lan.contacted)
    assert [kind for kind, _, _ in recorder.events] == ["tv.found_other_network"]
    assert "TV encontrada em outra rede" in recorder.events[0][2]
    assert HOTSPOT_TV not in recorder.events[0][2]  # nada de endereço no diagnóstico


async def test_the_stable_network_change_searches_at_once_instead_of_waiting_for_three_failures(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    lan.open = {(HOTSPOT_TV, 8001): True}
    lan.rest = {HOTSPOT_TV: TV_INFO}
    lan.install(monkeypatch)
    pc = Pc(HOME_PC)
    pc.install(monkeypatch)
    clock = FakeClock()
    relocator = build_relocator(settings_old_host(), clock, lambda: False)
    assert relocator is not None
    assert await relocator.step() is None  # só a primeira falha: sem a troca, ainda não procura
    assert lan.contacted == [OLD_HOST]  # a conferência do endereço de sempre, nada mais
    pc.interfaces = [HOTSPOT_PC]
    assert await relocator.step() is None  # vista agora: ainda pode ser uma oscilação
    assert not any(host.startswith("172.20.10.") for host in lan.contacted)
    clock.advance(40)
    # Estável: a terceira conferência (só a segunda falha seguida) já procura, por causa da troca.
    assert await relocator.step() == HOTSPOT_TV


async def test_a_host_on_the_new_subnet_that_is_not_our_tv_is_never_adopted(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    # Uma Samsung de outro dono, uma máquina que atende a porta mas não se identifica e um
    # aparelho qualquer: nenhum é a nossa TV.
    lan.open = {("172.20.10.7", 8001): True, ("172.20.10.8", 8001): True}
    lan.rest = {"172.20.10.7": {"device": {"type": "Samsung SmartTV", "duid": "uuid:de-outro"}}}
    lan.install(monkeypatch)
    pc = Pc(HOME_PC)
    pc.install(monkeypatch)
    recorder = Recorder()
    clock = FakeClock()
    relocator = build_relocator(
        settings_old_host(),
        clock,
        lambda: False,
        recorder=recorder,  # type: ignore[arg-type]
    )
    assert relocator is not None
    await relocator.step()
    pc.interfaces = [HOTSPOT_PC]
    for _ in range(5):
        clock.advance(40)
        assert await relocator.step() is None
    assert any(host.startswith("172.20.10.") for host in lan.contacted)  # foi conferido
    assert not path_exists(isolated_env)  # e nada foi gravado
    assert recorder.events == []


async def test_the_sweep_stays_bounded_with_many_interfaces_and_never_passes_a_slash_24(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    lan.open = {}
    lan.install(monkeypatch)
    pc = Pc(
        LocalInterface("10.0.0.2", 8),  # rede enorme: só o /24 dela
        LocalInterface("10.1.0.2", 16),
        LocalInterface("172.20.10.2", 28),
        LocalInterface("192.168.50.2", 24),
        LocalInterface("192.168.60.2", 24),
        LocalInterface("192.168.70.2", 24),
    )
    pc.install(monkeypatch)
    relocator = build_relocator(settings_old_host(), FakeClock(), lambda: False)
    assert relocator is not None
    for _ in range(3):
        await relocator.step()
    swept = [host for host in lan.contacted if host != OLD_HOST]  # (o velho é a conferência)
    subnets = {host.rsplit(".", maxsplit=1)[0] for host in swept}
    assert len(subnets) <= local_networks.MAX_SWEEP_NETWORKS
    assert len(set(swept)) <= local_networks.MAX_SWEEP_NETWORKS * 254
    # A rede enorme de verdade nunca foi varrida além do /24 do endereço do PC.
    assert not any(host.startswith("10.0.1.") or host.startswith("10.2.") for host in lan.contacted)


async def test_ssdp_goes_out_through_every_real_interface(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    lan.install(monkeypatch)
    pc = Pc(HOTSPOT_PC, HOME_PC)
    pc.install(monkeypatch)
    used: list[str] = []

    async def ssdp(kind: str, interface: str, wait: float = 0.0) -> list[str]:
        used.append(interface)
        return [HOTSPOT_TV] if interface == HOTSPOT_PC.address else []

    monkeypatch.setattr(tv_locate, "ssdp_search", ssdp)
    lan.rest = {HOTSPOT_TV: TV_INFO}
    relocator = build_relocator(settings_old_host(), FakeClock(), lambda: False)
    assert relocator is not None
    for _ in range(3):
        moved = await relocator.step()
    assert moved == HOTSPOT_TV
    assert set(used) == {HOTSPOT_PC.address, HOME_PC.address}


async def test_one_failing_adapter_does_not_discard_the_ssdp_answers_of_the_others(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    lan.install(monkeypatch)
    pc = Pc(HOME_PC, HOTSPOT_PC)
    pc.install(monkeypatch)

    async def ssdp(kind: str, interface: str, wait: float = 0.0) -> list[str]:
        if interface == HOME_PC.address:
            raise OSError("placa sem endereço")
        return [HOTSPOT_TV]

    monkeypatch.setattr(tv_locate, "ssdp_search", ssdp)
    lan.rest = {HOTSPOT_TV: TV_INFO}
    relocator = build_relocator(settings_old_host(), FakeClock(), lambda: False)
    assert relocator is not None
    for _ in range(3):
        moved = await relocator.step()
    assert moved == HOTSPOT_TV


# --- o núcleo: a troca de rede e o registro de "não achada" ----------


class NetworkScene(Scene):
    """O vigia com a rede do PC lida de uma lista que o teste muda, e o relógio à mão."""

    HOME = ("192.168.1.0/24",)
    HOTSPOT = ("172.20.10.0/28",)
    CABLE_AND_WIFI = ("192.168.1.0/24", "192.168.2.0/24")

    def __init__(self) -> None:
        super().__init__()
        self.network: tuple[str, ...] = self.HOME
        self.wakes: list[bool] = []
        self.not_found: list[tuple[int, bool]] = []

    async def read_network(self) -> tuple[str, ...]:
        return self.network

    def build(self, **limits: Any) -> TvRelocator:
        limits.setdefault("failures", 10)  # só a troca de rede dispara a procura nestes testes
        return self.relocator(
            network_signature=self.read_network,
            on_network_change=self.wakes.append,
            on_not_found=lambda attempts, changed: self.not_found.append((attempts, changed)),
            **limits,
        )

    async def settle(self, relocator: TvRelocator, network: tuple[str, ...]) -> None:
        """Põe a rede e a deixa estável (duas leituras com 31 s no meio)."""
        self.network = network
        await relocator.step()
        self.clock.advance(31)
        await relocator.step()


async def test_a_stable_network_change_forces_a_search_and_wakes_the_locator() -> None:
    scene = NetworkScene()
    relocator = scene.build()
    assert await relocator.step() is None  # leitura de base e primeira falha
    scene.network = scene.HOTSPOT
    await relocator.step()  # a rede nova acabou de aparecer: pode ser oscilação
    assert (scene.rescans, scene.wakes) == (0, [])
    scene.clock.advance(31)
    await relocator.step()
    assert (scene.rescans, scene.wakes) == (1, [True])  # rede nunca vista: acorda tudo


async def test_the_burst_after_a_change_is_limited_and_then_the_backoff_rules_again() -> None:
    scene = NetworkScene()
    relocator = scene.build(network_attempts=3)
    await relocator.step()
    await scene.settle(relocator, scene.HOTSPOT)
    for _ in range(6):
        await relocator.step()
    assert scene.wakes == [
        True,
        True,
        True,
    ]  # a troca e mais duas procuras; depois só o localizador


async def test_a_flapping_adapter_never_counts_as_a_network_change() -> None:
    """Doca com cabo e Wi-Fi, tethering USB que cai com a tela: a rede vai e volta em segundos."""
    scene = NetworkScene()
    relocator = scene.build(failures=1000)
    await relocator.step()
    for number in range(40):
        scene.network = scene.CABLE_AND_WIFI if number % 2 == 0 else scene.HOME
        scene.clock.advance(5)
        await relocator.step()
    assert scene.wakes == []
    assert scene.rescans == 0


async def test_a_network_that_flaps_with_stable_stretches_makes_at_most_one_burst() -> None:
    scene = NetworkScene()
    relocator = scene.build(network_attempts=3)
    await relocator.step()
    for network in (scene.CABLE_AND_WIFI, scene.HOME, scene.CABLE_AND_WIFI, scene.HOME):
        await scene.settle(relocator, network)
        for _ in range(3):
            scene.clock.advance(31)
            await relocator.step()
    assert scene.wakes == [True, True, True]  # uma rajada, a da primeira rede nova
    # Passados os 15 minutos, uma rede já conhecida volta a valer, e sem zerar a procura lenta.
    scene.clock.advance(1000)
    await scene.settle(relocator, scene.CABLE_AND_WIFI)
    assert scene.wakes[3:4] == [False]


async def test_a_network_not_seen_for_an_hour_is_new_again() -> None:
    scene = NetworkScene()
    relocator = scene.build(network_attempts=1)
    await relocator.step()
    await scene.settle(relocator, scene.HOTSPOT)
    scene.clock.advance(4000)
    await relocator.step()  # a hora passou: a base some da memória na próxima troca
    await scene.settle(relocator, scene.HOME)
    await scene.settle(relocator, scene.HOTSPOT)
    assert scene.wakes[-1] is True


async def test_no_network_at_all_is_not_a_change_and_the_same_network_back_is_not_either() -> None:
    scene = NetworkScene()
    relocator = scene.build()
    await relocator.step()
    await scene.settle(relocator, ())  # a placa caindo: sem rede nenhuma
    await scene.settle(relocator, scene.HOME)  # voltou à mesma
    assert scene.wakes == []
    assert scene.rescans == 0


async def test_a_reachable_tv_needs_no_search_even_if_the_network_changed() -> None:
    scene = NetworkScene()
    scene.reachable = True
    relocator = scene.build()
    await relocator.step()
    await scene.settle(relocator, scene.HOTSPOT)
    assert scene.rescans == 0


async def test_a_failing_signature_reader_never_breaks_the_watch() -> None:
    scene = NetworkScene()

    async def broken() -> tuple[str, ...]:
        raise OSError("sem placas")

    relocator = scene.relocator(network_signature=broken)
    assert await relocator.step() is None


async def test_not_found_is_reported_once_after_the_configured_attempts() -> None:
    scene = NetworkScene()
    relocator = scene.build(not_found_attempts=3, failures=3)
    for _ in range(8):
        await relocator.step()
    assert scene.not_found == [(3, False)]


async def test_searches_that_did_not_really_search_are_not_counted_as_not_found() -> None:
    """Procura lenta pulada ou TV dormindo no mesmo lugar: o localizador diz que não buscou."""
    scene = NetworkScene()
    relocator = scene.build(not_found_attempts=3, failures=3, searched=lambda: False)
    for _ in range(12):
        await relocator.step()
    assert scene.rescans > 3
    assert scene.not_found == []


async def test_not_found_says_when_the_pc_changed_network_meanwhile() -> None:
    scene = NetworkScene()
    relocator = scene.build(not_found_attempts=3)
    await relocator.step()
    await scene.settle(relocator, scene.HOTSPOT)
    for _ in range(4):
        await relocator.step()
    assert scene.not_found == [(3, True)]


async def test_run_wakes_up_before_the_full_interval_when_the_network_is_stable() -> None:
    scene = NetworkScene()
    scene.answer = "172.20.10.5"

    class Flipping(FakeClock):
        async def sleep(self, seconds: float) -> None:
            await super().sleep(seconds)
            if len(self.sleeps) == 3:
                scene.network = scene.HOTSPOT

    scene.clock = Flipping()
    relocator = scene.build(check_seconds=60.0, network_poll_seconds=5.0)
    await relocator.step()  # leitura de base
    assert await relocator.run() == "172.20.10.5"
    # Visto na 3ª leitura, estável 30 s depois (a 9ª): e não os 60 s inteiros.
    assert scene.clock.sleeps == [5] * 9


# --- o localizador: espaçamentos e identidade ----------


async def test_reset_schedule_lets_the_sweep_run_again_before_the_cadence() -> None:
    lan = world()
    lan.hosts = ["172.20.10.5"]
    locator = lan.locator()
    assert await locator.find("192.168.1.20") is None
    lan.open_hosts = {"172.20.10.5"}
    lan.identities["172.20.10.5"] = ME
    # Dez minutos de espaçamento: a varredura de agora não roda sozinha...
    assert await locator.find("192.168.1.20") is None
    # ...mas depois da troca de rede, sim.
    locator.reset_schedule()
    found = await locator.find("192.168.1.20")
    assert found is not None
    assert found.host == "172.20.10.5"


async def test_a_partial_reset_keeps_the_slow_search_counters_and_a_full_one_clears_them() -> None:
    lan = world()
    locator = lan.locator()
    await locator.find("192.168.1.20")
    schedule = locator._schedule
    schedule.empty_searches = 6
    assert schedule.last_search is not None
    locator.reset_schedule()
    assert (schedule.last_sweep, schedule.last_ssdp, schedule.last_mdns) == (None, None, None)
    assert schedule.empty_searches == 6
    assert schedule.last_search is not None  # a procura lenta segue valendo
    locator.reset_schedule(full=True)
    assert schedule.empty_searches == 0
    assert locator._schedule.last_search is None


async def test_find_says_whether_a_costly_stage_really_ran() -> None:
    lan = world()
    lan.arp = {MAC_FOR_SEARCHED: ["192.168.0.11"]}
    lan.open_hosts = {"192.168.0.11"}
    locator = lan.locator(TvKnown(LOCATOR_DUID, MAC_FOR_SEARCHED), empty_searches_limit=1)
    await locator.find("192.168.0.11")  # a TV dorme no mesmo lugar: nada a buscar
    assert locator.searched is False
    lan.arp = {}
    await locator.find("192.168.0.11")  # primeira busca de verdade
    assert locator.searched is True
    await locator.find("192.168.0.11")  # busca lenta: pulada até o intervalo longo
    assert locator.searched is False


async def test_without_a_saved_identity_only_the_paired_session_can_confirm_a_new_host() -> None:
    lan = world()
    lan.hosts = ["172.20.10.5", "172.20.10.6"]
    lan.open_hosts = {"172.20.10.5", "172.20.10.6"}
    refused: list[str] = []

    async def authenticate(host: str) -> bool:
        refused.append(host)
        return False  # nenhum aceita o certificado: nenhum é a nossa TV

    locator = lan.locator(TvKnown(), authenticate=authenticate)
    assert await locator.find("192.168.1.20") is None
    assert refused  # tentou confirmar pela sessão pareada (sem abrir pareamento novo)


async def test_a_host_that_says_it_is_another_tv_is_not_the_one() -> None:
    lan = world()
    lan.hosts = ["172.20.10.5"]
    lan.open_hosts = {"172.20.10.5"}
    lan.identities["172.20.10.5"] = OTHER
    assert await lan.locator(TvKnown(LOCATOR_DUID, LOCATOR_MAC)).find("192.168.1.20") is None


# --- as placas reais do PC ----------


def row(
    address: str, description: str, *, kind: int = 71, up: bool = True, prefix: int = 24
) -> Any:
    return AdapterRow(address, prefix, description, description, kind, up)


def test_virtual_loopback_link_local_and_down_adapters_are_left_out() -> None:
    rows = [
        row("172.20.10.2", "Intel(R) Wi-Fi 6 AX201", prefix=28),
        row("192.168.1.10", "Realtek PCIe GbE Family Controller", kind=6),
        row("172.28.176.1", "Hyper-V Virtual Ethernet Adapter", kind=6),
        row("172.17.0.1", "vEthernet (WSL (Hyper-V firewall))", kind=6),
        row("192.168.56.1", "VirtualBox Host-Only Ethernet Adapter", kind=6),
        row("192.168.80.1", "VMware Virtual Ethernet Adapter for VMnet8", kind=6),
        row("10.8.0.2", "TAP-Windows Adapter V9", kind=6),
        row("100.64.0.3", "Tailscale Tunnel", kind=131),
        row("10.9.0.2", "WireGuard Tunnel", kind=53),
        row("10.10.0.2", "Corporate VPN Client", kind=6),
        row("192.168.43.9", "Operadora 4G", kind=243),  # banda larga móvel
        row("10.20.0.2", "Conexão PPP", kind=23),
        row("100.72.3.4", "Wi-Fi com CGNAT", kind=71),  # fora do RFC 1918
        row("203.0.113.7", "Ethernet com IP público", kind=6),
        row("127.0.0.1", "Software Loopback Interface 1", kind=24),
        row("169.254.190.176", "Ethernet 2", kind=6),
        row("192.168.99.5", "Realtek USB GbE", kind=6, up=False),
        row("172.20.10.2", "Intel(R) Wi-Fi 6 AX201", prefix=28),  # repetida
    ]
    assert usable_interfaces(rows) == [
        LocalInterface("172.20.10.2", 28),
        LocalInterface("192.168.1.10", 24),
    ]


def test_sweep_networks_are_capped_deduplicated_and_never_bigger_than_a_slash_24() -> None:
    interfaces = [
        LocalInterface("10.0.0.2", 8),
        LocalInterface("10.0.0.9", 24),  # a mesma rede (o /24 do /8 acima)
        LocalInterface("172.20.10.2", 28),
        LocalInterface("192.168.1.10", 24),
        LocalInterface("192.168.2.10", 24),
        LocalInterface("192.168.3.10", 24),
    ]
    networks = sweep_networks("192.168.1.20", interfaces)
    assert [str(item.network) for item in networks] == [
        "10.0.0.0/24",
        "172.20.10.0/28",
        "192.168.1.0/24",
        "192.168.2.0/24",
    ]


def test_the_old_tv_network_is_left_out_when_the_pc_is_no_longer_in_it() -> None:
    """Sem placa na rede velha, a varredura dela só sairia pela rota padrão, à toa."""
    networks = sweep_networks("192.168.1.20", [HOTSPOT_PC])
    assert [str(item.network) for item in networks] == ["172.20.10.0/28"]
    assert sweep_networks("nome-da-tv.local", [HOTSPOT_PC])[0].network.prefixlen == 28


def test_the_old_tv_network_comes_last_when_an_adapter_network_contains_it() -> None:
    # Uma placa /20 (192.168.0.0 a 192.168.15.255) contém o endereço velho; o /24 dele entra.
    networks = sweep_networks("192.168.1.20", [LocalInterface("192.168.0.9", 20), HOTSPOT_PC])
    assert [str(item.network) for item in networks] == [
        "192.168.0.0/24",
        "172.20.10.0/28",
        "192.168.1.0/24",
    ]


def test_without_any_known_adapter_the_old_tv_network_is_kept_as_before() -> None:
    assert [str(item.network) for item in sweep_networks("192.168.1.20", [])] == ["192.168.1.0/24"]


def test_a_slash_28_subnet_has_only_its_own_hosts_and_never_more_than_a_slash_24() -> None:
    assert len(subnet_hosts("172.20.10.2", prefix=28)) == 13  # os 14 do /28 sem o próprio PC
    assert len(subnet_hosts("10.0.0.2", prefix=8)) == 253  # nunca passa de /24


def test_same_network_compares_the_slash_24_and_tolerates_names() -> None:
    assert same_network("192.168.1.20", "192.168.1.99") is True
    assert same_network("192.168.1.20", "172.20.10.5") is False
    assert same_network("tv.local", "172.20.10.5") is None


async def test_the_signature_is_the_set_of_networks_not_addresses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(local_networks, "local_interfaces", lambda: [HOTSPOT_PC, HOME_PC])
    assert await network_signature() == frozenset({"172.20.10.0/28", "192.168.1.0/24"})
    # O DHCP renovando o endereço dentro da mesma rede não é troca de rede.
    monkeypatch.setattr(
        local_networks, "local_interfaces", lambda: [LocalInterface("172.20.10.3", 28), HOME_PC]
    )
    assert await network_signature() == frozenset({"172.20.10.0/28", "192.168.1.0/24"})


@pytest.mark.skipif(sys.platform != "win32", reason="a lista de placas é do Windows")
def test_the_real_adapter_list_is_readable_and_has_no_loopback_or_link_local() -> None:
    """Só lê as placas do Windows (nada sai pela rede)."""
    rows = local_networks._read_adapters()
    assert all(isinstance(item, AdapterRow) for item in rows)
    for interface in usable_interfaces(rows):
        assert not interface.address.startswith(("127.", "169.254."))
        assert 0 < interface.prefix <= 32
