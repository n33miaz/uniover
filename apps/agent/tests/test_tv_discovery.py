"""Descoberta da TV: redes falsas (nenhuma varredura real) e o comando `tv-find`."""

import asyncio
import json
import threading
import tomllib
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, ClassVar

import pytest
from zeroconf import ServiceStateChange

from uniover_agent import main as main_module
from uniover_agent.adapters import arp as arp_module
from uniover_agent.adapters import tv_discovery
from uniover_agent.adapters.arp import parse_arp_table
from uniover_agent.adapters.tv_discovery import (
    ANDROID_REMOTE_PORT,
    MDNS_SERVICE_TYPE,
    SAMSUNG_REST_PORT,
    DiscoveredTv,
    PortState,
    discover_android_tvs,
    find_tvs,
    http_json,
    local_ipv4,
    same_tv,
    scan_hosts,
    subnet_hosts,
    tcp_open,
    tcp_probe,
)
from uniover_agent.main import EXIT_FAILURE, EXIT_OK, main, tv_find

SAMSUNG_INFO: dict[str, Any] = {
    "id": "uuid:aaaa",
    "device": {
        "type": "Samsung SmartTV",
        "name": "[TV] Sala",
        "duid": "uuid:11111111-2222-3333-4444-555555555555",
        "wifiMac": "AA:BB:CC:DD:EE:01",
    },
}


class FakeNetwork:
    """Rede de mentira: quais portas abrem em cada endereço e o que a Samsung responde."""

    def __init__(
        self,
        open_ports: dict[str, set[int]],
        info: dict[str, dict[str, Any] | None] | None = None,
        arp: dict[str, str] | None = None,
    ) -> None:
        self.open_ports = open_ports
        self.info = info or {}
        self.arp = arp or {}
        self.connects = 0

    async def connect(self, host: str, port: int) -> bool:
        self.connects += 1
        return port in self.open_ports.get(host, set())

    async def fetch_json(self, url: str) -> dict[str, Any] | None:
        host = url.split("//")[1].split(":", maxsplit=1)[0]
        return self.info.get(host)

    async def lookup_mac(self, host: str) -> str | None:
        return self.arp.get(host)

    async def scan(self, hosts: list[str]) -> list[DiscoveredTv]:
        return await scan_hosts(
            hosts,
            connect=self.connect,
            fetch_json=self.fetch_json,
            lookup_mac=self.lookup_mac,
        )


async def test_finds_a_samsung_by_its_rest_answer() -> None:
    network = FakeNetwork({"192.168.0.20": {SAMSUNG_REST_PORT}}, {"192.168.0.20": SAMSUNG_INFO})
    found = await network.scan(["192.168.0.10", "192.168.0.20"])
    assert found == [
        DiscoveredTv(
            "192.168.0.20",
            "samsung",
            ("11111111-2222-3333-4444-555555555555", "AA:BB:CC:DD:EE:01"),
            "[TV] Sala",
        )
    ]
    assert found[0].id_hint == "11111111-2222-3333-4444-555555555555"


async def test_a_samsung_without_duid_falls_back_to_the_wifi_mac() -> None:
    info = {"device": {"type": "Samsung SmartTV", "wifiMac": "aa-bb-cc-dd-ee-02"}}
    network = FakeNetwork({"192.168.0.21": {SAMSUNG_REST_PORT}}, {"192.168.0.21": info})
    [tv] = await network.scan(["192.168.0.21"])
    assert (tv.ids, tv.name) == (("AA:BB:CC:DD:EE:02",), None)


async def test_other_devices_on_port_8001_are_not_samsung_tvs() -> None:
    network = FakeNetwork(
        {"192.168.0.30": {SAMSUNG_REST_PORT}, "192.168.0.31": {SAMSUNG_REST_PORT}},
        {"192.168.0.30": {"device": {"type": "Impressora"}}, "192.168.0.31": None},
    )
    assert await network.scan(["192.168.0.30", "192.168.0.31"]) == []


async def test_finds_an_android_tv_by_the_remote_port_and_reads_its_mac_from_arp() -> None:
    network = FakeNetwork(
        {"192.168.0.40": {ANDROID_REMOTE_PORT}}, arp={"192.168.0.40": "AA:BB:CC:00:00:09"}
    )
    assert await network.scan(["192.168.0.40"]) == [
        DiscoveredTv("192.168.0.40", "android", ("AA:BB:CC:00:00:09",))
    ]


async def test_an_android_tv_without_arp_has_no_id_hint() -> None:
    network = FakeNetwork({"192.168.0.41": {ANDROID_REMOTE_PORT}})
    [tv] = await network.scan(["192.168.0.41"])
    assert tv.id_hint is None


async def test_an_empty_network_finds_nothing() -> None:
    assert await FakeNetwork({}).scan(["192.168.0.1", "192.168.0.2"]) == []
    assert await FakeNetwork({}).scan([]) == []


async def test_several_tvs_come_back_ordered_by_address() -> None:
    network = FakeNetwork(
        {"192.168.0.9": {ANDROID_REMOTE_PORT}, "192.168.0.100": {SAMSUNG_REST_PORT}},
        {"192.168.0.100": SAMSUNG_INFO},
    )
    found = await network.scan(["192.168.0.100", "192.168.0.9"])
    assert [tv.host for tv in found] == ["192.168.0.9", "192.168.0.100"]


async def test_the_scan_gives_up_at_the_deadline_and_keeps_what_it_found() -> None:
    network = FakeNetwork({"192.168.0.50": {ANDROID_REMOTE_PORT}})
    original = network.connect

    async def slow(host: str, port: int) -> bool:
        if host == "192.168.0.99":
            await asyncio.sleep(30)
        return await original(host, port)

    found = await scan_hosts(
        ["192.168.0.50", "192.168.0.99"],
        connect=slow,
        fetch_json=network.fetch_json,
        lookup_mac=network.lookup_mac,
        deadline=0.3,
    )
    assert [tv.host for tv in found] == ["192.168.0.50"]


async def test_find_tvs_scans_the_other_253_hosts_and_filters_by_kind() -> None:
    network = FakeNetwork(
        {"10.1.2.20": {SAMSUNG_REST_PORT}, "10.1.2.21": {ANDROID_REMOTE_PORT}},
        {"10.1.2.20": SAMSUNG_INFO},
    )

    async def search(kind: str | None) -> list[DiscoveredTv]:
        return await find_tvs(
            kind,  # type: ignore[arg-type]
            local="10.1.2.5",
            connect=network.connect,
            fetch_json=network.fetch_json,
            lookup_mac=network.lookup_mac,
        )

    assert [tv.kind for tv in await search(None)] == ["samsung", "android"]
    assert [tv.host for tv in await search("android")] == ["10.1.2.21"]
    # 253 endereços x 2 portas por varredura (o do próprio PC fica de fora).
    assert network.connects == 2 * 2 * 253


async def test_find_tvs_without_a_route_finds_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tv_discovery, "local_ipv4", lambda: None)
    assert await find_tvs() == []


def test_subnet_hosts_is_the_slash_24_without_the_pc_itself() -> None:
    hosts = subnet_hosts("192.168.7.33")
    assert len(hosts) == 253
    assert "192.168.7.33" not in hosts
    assert hosts[0] == "192.168.7.1"
    assert hosts[-1] == "192.168.7.254"


def test_local_ipv4_is_an_address_or_nothing() -> None:
    address = local_ipv4()
    assert address is None or address.count(".") == 3


def test_same_tv_matches_any_known_id_ignoring_case_and_prefix() -> None:
    tv = DiscoveredTv("1.2.3.4", "samsung", ("abc-123", "AA:BB:CC:DD:EE:01"))
    assert same_tv(tv, "ABC-123")
    assert same_tv(tv, "uuid:abc-123")
    assert same_tv(tv, "aa:bb:cc:dd:ee:01")
    assert not same_tv(tv, "outra")
    assert not same_tv(DiscoveredTv("1.2.3.5", "android"), "abc-123")


# --- adaptadores reais, só contra o próprio PC ----------------------------------------------


@pytest.fixture
def local_server() -> Iterator[int]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = b"nao e json" if self.path == "/quebrado" else json.dumps(SAMSUNG_INFO).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1]
    server.shutdown()
    server.server_close()


async def test_tcp_open_tells_an_open_port_from_a_closed_one(local_server: int) -> None:
    assert await tcp_open("127.0.0.1", local_server)
    assert not await tcp_open("127.0.0.1", 1, wait=0.5)


async def test_tcp_probe_tells_open_from_refused_from_silence(
    local_server: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert await tcp_probe("127.0.0.1", local_server) is PortState.OPEN

    async def refused(host: str, port: int) -> None:
        raise ConnectionRefusedError

    monkeypatch.setattr(asyncio, "open_connection", refused)
    assert await tcp_probe("192.168.0.50", 6466) is PortState.REFUSED

    async def no_route(host: str, port: int) -> None:
        raise OSError("sem rota para o destino")

    monkeypatch.setattr(asyncio, "open_connection", no_route)
    assert await tcp_probe("192.168.0.50", 6466) is PortState.SILENT

    async def never(host: str, port: int) -> None:
        await asyncio.sleep(30)

    monkeypatch.setattr(asyncio, "open_connection", never)
    assert await tcp_probe("192.168.0.50", 6466, wait=0.01) is PortState.SILENT


async def test_http_json_reads_objects_and_swallows_failures(local_server: int) -> None:
    base = f"http://127.0.0.1:{local_server}"
    assert await http_json(f"{base}/api/v2/") == SAMSUNG_INFO
    assert await http_json(f"{base}/quebrado") is None
    assert await http_json("http://127.0.0.1:1/api/v2/") is None


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        (
            "Interface: 192.168.0.5\n  192.168.0.40  aa-bb-cc-00-00-09  dynamic\n",
            "AA:BB:CC:00:00:09",
        ),
        ("  224.0.0.22  01-00-5e-00-00-16  static\n  192.168.0.40  ff-ff-ff-ff-ff-ff\n", None),
        ("Nenhuma entrada ARP encontrada.\n", None),
    ],
)
async def test_arp_mac_reads_the_table_and_skips_broadcast(
    monkeypatch: pytest.MonkeyPatch, output: str, expected: str | None
) -> None:
    async def fake_table() -> dict[str, list[str]]:
        return parse_arp_table(output)

    monkeypatch.setattr(arp_module, "arp_table", fake_table)
    assert await arp_module.arp_mac("192.168.0.40") == expected


# --- comando `tv-find` ----------------------------------------------------------------------

SAMSUNG = DiscoveredTv("192.168.0.20", "samsung", ("duid-1", "AA:BB:CC:DD:EE:01"), "[TV] Sala")
ANDROID = DiscoveredTv("192.168.0.40", "android", ("AA:BB:CC:00:00:09",))


def finder(*tvs: DiscoveredTv) -> Any:
    async def find(kind: str | None) -> list[DiscoveredTv]:
        return [tv for tv in tvs if kind is None or tv.kind == kind]

    return find


def seed(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def exists(path: Path) -> bool:
    return path.exists()


def saved(isolated_env: Path) -> dict[str, Any]:
    return tomllib.loads(isolated_env.read_text(encoding="utf-8"))


async def test_tv_find_with_one_tv_saves_kind_host_and_id_without_asking(
    isolated_env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    seed(isolated_env, 'api_url = "https://a.test"\ntv_cleanup_keep = ["com.x.y"]\n')
    assert await tv_find(find=finder(SAMSUNG)) == EXIT_OK
    assert saved(isolated_env) == {
        "api_url": "https://a.test",
        "tv_cleanup_keep": ["com.x.y"],
        "tv_kind": "samsung",
        "tv_host": "192.168.0.20",
        "tv_id_hint": "duid-1",
        "tv_mac": "AA:BB:CC:DD:EE:01",
    }
    assert "TV encontrada: Samsung [TV] Sala em 192.168.0.20" in capsys.readouterr().out


async def test_tv_find_with_none_fails_with_a_clear_message(
    isolated_env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert await tv_find(find=finder()) == EXIT_FAILURE
    assert "Não encontrei nenhuma TV" in capsys.readouterr().err
    assert not exists(isolated_env)


async def test_tv_find_asks_which_when_there_are_several(isolated_env: Path) -> None:
    prompts: list[str] = []

    async def ask(prompt: str) -> str:
        prompts.append(prompt)
        return "2"

    assert await tv_find(find=finder(SAMSUNG, ANDROID), ask=ask, interactive=True) == EXIT_OK
    assert saved(isolated_env)["tv_host"] == "192.168.0.40"
    assert prompts == ["Qual é a sua? (1-2): "]


@pytest.mark.parametrize("answer", ["", "0", "3", "abc"])
async def test_tv_find_rejects_an_invalid_choice(isolated_env: Path, answer: str) -> None:
    async def ask(prompt: str) -> str:
        return answer

    assert await tv_find(find=finder(SAMSUNG, ANDROID), ask=ask, interactive=True) == EXIT_FAILURE
    assert not exists(isolated_env)


async def test_tv_find_never_blocks_on_input_without_a_terminal(
    isolated_env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    async def ask(prompt: str) -> str:
        raise AssertionError("não deveria perguntar")

    code = await tv_find(find=finder(SAMSUNG, ANDROID), ask=ask, interactive=False)
    assert code == EXIT_FAILURE
    assert "mais de uma TV" in capsys.readouterr().err


async def test_tv_find_kind_filter_narrows_the_search(isolated_env: Path) -> None:
    assert await tv_find("android", find=finder(SAMSUNG, ANDROID)) == EXIT_OK
    assert saved(isolated_env)["tv_kind"] == "android"


async def test_a_tv_without_id_warns_and_clears_the_old_hint(
    isolated_env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    seed(isolated_env, 'tv_id_hint = "velho"\n')
    assert await tv_find(find=finder(DiscoveredTv("192.168.0.77", "android"))) == EXIT_OK
    assert "tv_id_hint" not in saved(isolated_env)
    assert "não informa um identificador" in capsys.readouterr().out


def test_tv_find_is_a_command_line_subcommand(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    async def find(kind: str | None) -> list[DiscoveredTv]:
        return [ANDROID]

    monkeypatch.setattr(main_module, "find_tvs", find)
    assert main(["tv-find", "--kind", "android"]) == EXIT_OK
    assert saved(isolated_env)["tv_host"] == "192.168.0.40"


# --- mDNS (zeroconf trocado por dublês: nenhum pacote sai pela rede) -----------------------------

ANNOUNCED = {
    "Sala._androidtvremote2._tcp.local.": ["10.9.9.20"],
    "Quarto._androidtvremote2._tcp.local.": ["10.1.2.31", "fe80::1"],
    "Muda._androidtvremote2._tcp.local.": [],
}


class FakeAsyncZeroconf:
    instances: ClassVar[list[FakeAsyncZeroconf]] = []

    def __init__(self, **kwargs: Any) -> None:
        self.zeroconf = object()
        self.closed = False
        FakeAsyncZeroconf.instances.append(self)

    async def async_close(self) -> None:
        self.closed = True


class FakeBrowser:
    cancelled = False

    def __init__(self, zeroconf: Any, service_type: str, handlers: list[Any]) -> None:
        assert service_type == MDNS_SERVICE_TYPE
        for name in ANNOUNCED:
            # Como a biblioteca real: tudo por nome.
            handlers[0](
                zeroconf=zeroconf,
                service_type=service_type,
                name=name,
                state_change=ServiceStateChange.Added,
            )
        handlers[0](
            zeroconf=zeroconf,
            service_type=service_type,
            name="Sala._x.local.",
            state_change=ServiceStateChange.Removed,
        )

    async def async_cancel(self) -> None:
        FakeBrowser.cancelled = True


class FakeInfo:
    def __init__(self, service_type: str, name: str) -> None:
        self.name = name

    async def async_request(self, zeroconf: Any, timeout: int) -> bool:  # noqa: ASYNC109
        return bool(ANNOUNCED[self.name])

    def parsed_addresses(self, version: Any) -> list[str]:
        return [a for a in ANNOUNCED[self.name] if ":" not in a]


@pytest.fixture
def fake_zeroconf(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeAsyncZeroconf.instances.clear()
    FakeBrowser.cancelled = False
    monkeypatch.setattr(tv_discovery, "AsyncZeroconf", FakeAsyncZeroconf)
    monkeypatch.setattr(tv_discovery, "AsyncServiceBrowser", FakeBrowser)
    monkeypatch.setattr(tv_discovery, "AsyncServiceInfo", FakeInfo)


async def test_mdns_lists_the_announced_android_tvs_by_address(fake_zeroconf: None) -> None:
    found = await discover_android_tvs(0.01)
    assert [(tv.host, tv.kind, tv.name) for tv in found] == [
        ("10.1.2.31", "android", "Quarto"),
        ("10.9.9.20", "android", "Sala"),
    ]
    # Fecha o que abriu, para não deixar soquete de multicast para trás.
    assert FakeBrowser.cancelled
    assert all(zc.closed for zc in FakeAsyncZeroconf.instances)


async def test_mdns_that_cannot_start_is_just_an_empty_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken(**kwargs: Any) -> None:
        raise OSError("sem multicast")

    monkeypatch.setattr(tv_discovery, "AsyncZeroconf", broken)
    assert await discover_android_tvs(0.01) == []


async def test_mdns_failing_halfway_still_closes_what_it_opened(
    monkeypatch: pytest.MonkeyPatch, fake_zeroconf: None
) -> None:
    class Exploding(FakeBrowser):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise RuntimeError("falha do zeroconf")

    monkeypatch.setattr(tv_discovery, "AsyncServiceBrowser", Exploding)
    assert await discover_android_tvs(0.01) == []
    assert all(zc.closed for zc in FakeAsyncZeroconf.instances)


def _scan_network() -> FakeNetwork:
    return FakeNetwork(
        {"10.1.2.21": {ANDROID_REMOTE_PORT}, "10.1.2.40": {SAMSUNG_REST_PORT}},
        {"10.1.2.40": SAMSUNG_INFO},
    )


async def _find(
    kind: str | None, mdns: Any, network: FakeNetwork | None = None
) -> list[DiscoveredTv]:
    network = network or _scan_network()
    return await find_tvs(
        kind,  # type: ignore[arg-type]
        local="10.1.2.5",
        connect=network.connect,
        fetch_json=network.fetch_json,
        lookup_mac=network.lookup_mac,
        discover_mdns=mdns,
    )


async def test_find_tvs_adds_what_mdns_found_to_the_scan_without_duplicates() -> None:
    async def mdns(listen_seconds: float) -> list[DiscoveredTv]:
        return [
            DiscoveredTv("10.1.2.21", "android", name="Sala"),
            DiscoveredTv("10.9.9.20", "android", name="Outra sub-rede"),
        ]

    found = await _find(None, mdns)
    assert [(tv.host, tv.kind, tv.name) for tv in found] == [
        ("10.1.2.21", "android", "Sala"),
        ("10.1.2.40", "samsung", "[TV] Sala"),
        ("10.9.9.20", "android", "Outra sub-rede"),
    ]


async def test_find_tvs_keeps_the_scan_result_when_mdns_fails() -> None:
    async def mdns(listen_seconds: float) -> list[DiscoveredTv]:
        raise RuntimeError("sem multicast")

    found = await _find("android", mdns)
    assert [tv.host for tv in found] == ["10.1.2.21"]


async def test_find_tvs_does_not_ask_mdns_for_a_samsung() -> None:
    asked: list[float] = []

    async def mdns(listen_seconds: float) -> list[DiscoveredTv]:
        asked.append(listen_seconds)
        return [DiscoveredTv("10.9.9.20", "android")]

    found = await _find("samsung", mdns)
    assert [tv.host for tv in found] == ["10.1.2.40"]
    assert asked == []


async def test_mdns_runs_beside_the_scan_not_after_it() -> None:
    started = asyncio.Event()
    seen: list[bool] = []

    async def mdns(listen_seconds: float) -> list[DiscoveredTv]:
        started.set()
        return []

    class Probing(FakeNetwork):
        async def connect(self, host: str, port: int) -> bool:
            await asyncio.sleep(0)
            seen.append(started.is_set())
            return await super().connect(host, port)

    await _find("android", mdns, Probing({}))
    assert seen
    assert all(seen)


class Journal:
    """A ordem em que o encerramento do mDNS mexeu em cada peça."""

    def __init__(self) -> None:
        self.events: list[str] = []
        self.reading = 0
        self.started: list[str] = []


def closing_doubles(monkeypatch: pytest.MonkeyPatch, journal: Journal) -> None:
    """Anúncio que chega durante o `async_cancel` e uma leitura que nunca termina sozinha."""

    class Zeroconf(FakeAsyncZeroconf):
        async def async_close(self) -> None:
            # Ao fechar os soquetes, nenhuma leitura pode continuar viva.
            journal.events.append(f"zeroconf.close(reading={journal.reading})")
            await super().async_close()

    class Browser(FakeBrowser):
        def __init__(self, zeroconf: Any, service_type: str, handlers: list[Any]) -> None:
            self._zeroconf, self._type, self._handler = zeroconf, service_type, handlers[0]
            self._announce("Trava._androidtvremote2._tcp.local.")

        def _announce(self, name: str) -> None:
            self._handler(
                zeroconf=self._zeroconf,
                service_type=self._type,
                name=name,
                state_change=ServiceStateChange.Added,
            )

        async def async_cancel(self) -> None:
            journal.events.append("browser.cancel")
            self._announce("Tarde._androidtvremote2._tcp.local.")  # chegou no meio do encerramento

    class Info(FakeInfo):
        async def async_request(self, zeroconf: Any, timeout: int) -> bool:  # noqa: ASYNC109
            journal.started.append(self.name)
            journal.reading += 1
            try:
                await asyncio.Event().wait()
            finally:
                journal.reading -= 1
            return True

    ANNOUNCED["Trava._androidtvremote2._tcp.local."] = ["10.1.2.77"]
    ANNOUNCED["Tarde._androidtvremote2._tcp.local."] = ["10.1.2.78"]
    monkeypatch.setattr(tv_discovery, "AsyncZeroconf", Zeroconf)
    monkeypatch.setattr(tv_discovery, "AsyncServiceBrowser", Browser)
    monkeypatch.setattr(tv_discovery, "AsyncServiceInfo", Info)


@pytest.fixture
def announced_cleanup() -> Iterator[None]:
    yield
    ANNOUNCED.pop("Trava._androidtvremote2._tcp.local.", None)
    ANNOUNCED.pop("Tarde._androidtvremote2._tcp.local.", None)


async def test_mdns_closing_cancels_the_browser_then_the_reads_and_only_then_the_sockets(
    monkeypatch: pytest.MonkeyPatch, announced_cleanup: None
) -> None:
    journal = Journal()
    closing_doubles(monkeypatch, journal)
    assert await discover_android_tvs(0.05) == []
    # O navegador parou primeiro; a leitura pendurada foi cancelada antes do fechamento; o anúncio
    # que chegou durante o encerramento não abriu leitura nova.
    assert journal.events == ["browser.cancel", "zeroconf.close(reading=0)"]
    assert journal.started == ["Trava._androidtvremote2._tcp.local."]


async def test_mdns_cancelled_from_outside_still_closes_everything(
    monkeypatch: pytest.MonkeyPatch, announced_cleanup: None
) -> None:
    journal = Journal()
    closing_doubles(monkeypatch, journal)
    task = asyncio.create_task(discover_android_tvs(30))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert journal.events == ["browser.cancel", "zeroconf.close(reading=0)"]


async def test_find_tvs_cancelled_from_outside_cancels_and_awaits_the_mdns_task() -> None:
    journal = Journal()
    network = _scan_network()

    async def slow_connect(host: str, port: int) -> bool:
        await asyncio.sleep(30)
        return False

    async def mdns(listen_seconds: float) -> list[DiscoveredTv]:
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            journal.events.append("mdns.cancelled")
            await asyncio.sleep(0.01)  # fechar os soquetes leva um instante
            journal.events.append("mdns.closed")
            raise
        return []

    task = asyncio.create_task(
        find_tvs(
            "android",
            local="10.1.2.5",
            connect=slow_connect,
            fetch_json=network.fetch_json,
            lookup_mac=network.lookup_mac,
            discover_mdns=mdns,
        )
    )
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # O cancelamento só volta a quem chamou depois de a escuta acabar de fechar.
    assert journal.events == ["mdns.cancelled", "mdns.closed"]


async def test_find_tvs_whose_scan_fails_cancels_and_awaits_the_mdns_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    journal = Journal()

    async def broken_scan(*args: Any, **kwargs: Any) -> list[DiscoveredTv]:
        await asyncio.sleep(0.02)
        raise RuntimeError("varredura quebrada")

    async def mdns(listen_seconds: float) -> list[DiscoveredTv]:
        try:
            await asyncio.sleep(30)
        finally:
            await asyncio.sleep(0.01)
            journal.events.append("mdns.closed")
        return []

    monkeypatch.setattr(tv_discovery, "scan_hosts", broken_scan)
    with pytest.raises(RuntimeError, match="varredura quebrada"):
        await find_tvs("android", local="10.1.2.5", discover_mdns=mdns)
    assert journal.events == ["mdns.closed"]
