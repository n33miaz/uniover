"""Samsung Tizen: tradução do protocolo, composição e os limites declarados ao app."""

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from samsungtvws import SamsungTVWS

from uniover_agent import main as main_module
from uniover_agent.adapters import tv_samsung_pairing as samsung_pairing
from uniover_agent.adapters import tv_samsung_volume as volume_module
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTransport
from uniover_agent.adapters.tv_samsung import (
    SAMSUNG_KEYS,
    SAMSUNG_OPTIONAL_KEYS,
    SamsungClient,
    SamsungTvDriver,
)
from uniover_agent.adapters.tv_samsung_pairing import (
    SAMSUNG_PAIR_TIMEOUT_SECONDS,
    _pairing_factory,
    pair_samsung_tv,
)
from uniover_agent.adapters.tv_samsung_volume import SamsungVolume, rendering_control_url
from uniover_agent.adapters.tv_samsung_volume import ssdp_locations as real_ssdp_locations
from uniover_agent.config import Settings
from uniover_agent.core import (
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    PowerOffResult,
    ResultStatus,
    SamsungMaintenanceScheduler,
    TvSessionManager,
)
from uniover_agent.core.tv.handlers import unsupported_handler
from uniover_agent.core.tv.samsung_apps import SamsungTvApps
from uniover_agent.core.tv.session import POWER_REPEAT_SECONDS
from uniover_agent.main import build_tv, samsung_token_name, tv_pair
from uniover_agent.ports import TvUnreachable

from .support import AGENT_ID


class FakeSamsungClient:
    """Cliente síncrono da biblioteca, sem rede e com o token que a TV devolve no aceite."""

    def __init__(self, token: str | None = None) -> None:
        self.token: str | None = token or "token-novo"
        self.opens = 0
        self.closes = 0
        self.keys: list[tuple[str, str]] = []
        self.apps: list[dict[str, Any]] | None = [
            {"appId": "111299001912", "name": "Vídeo"},
            {"appId": "org.tizen.browser", "name": "Internet"},
        ]
        self.icons: dict[str, str] = {}
        self.runs: list[tuple[str, str, str]] = []

    def open(self) -> object:
        self.opens += 1
        return object()

    def close(self) -> None:
        self.closes += 1

    def send_key(
        self,
        key: str,
        times: int = 1,
        key_press_delay: float | None = None,
        cmd: str = "Click",
    ) -> None:
        del times, key_press_delay
        self.keys.append((key, cmd))

    def app_list(self) -> list[dict[str, Any]] | None:
        return self.apps

    def app_icon(self, icon_path: str) -> str | None:
        return self.icons.get(icon_path)

    def run_app(self, app_id: str, app_type: str = "DEEP_LINK", meta_tag: str = "") -> None:
        self.runs.append((app_id, app_type, meta_tag))


def factory(client: FakeSamsungClient) -> Callable[[str, str | None, str], SamsungClient]:
    def build(host: str, token: str | None, name: str) -> SamsungClient:
        del host, token, name
        return client

    return build


async def power_on(host: str) -> bool | None:
    del host
    return True


async def power_off(host: str) -> bool | None:
    del host
    return False


def manager_for(client: FakeSamsungClient) -> tuple[FakeClock, SamsungTvDriver, TvSessionManager]:
    clock = FakeClock()
    driver = SamsungTvDriver(
        "192.168.0.11", "token-anterior", "UniOver", factory=factory(client), fetch_power=power_on
    )
    return clock, driver, TvSessionManager(clock, driver, hibernate_seconds=10)


async def test_key_map_keeps_the_contract_names_out_of_the_samsung_socket() -> None:
    client = FakeSamsungClient()
    _, _, manager = manager_for(client)
    keys = ("UP", "OK", "BACK", "HOME", "VOLUME_UP", "NUM_7", "INPUT", "POWER")
    for key in keys:
        await manager.send_key(key)
    assert client.keys == [(SAMSUNG_KEYS[key], "Click") for key in keys]
    assert {"PLAY_PAUSE", "MEDIA_NEXT", "MEDIA_PREVIOUS"} <= SAMSUNG_KEYS.keys()


async def test_samsung_session_hibernates_and_opens_again_on_the_next_command() -> None:
    client = FakeSamsungClient()
    clock, _, manager = manager_for(client)
    await manager.send_key("HOME")
    clock.advance(10)
    assert await manager.hibernate_if_idle() is True
    await manager.send_key("BACK")
    assert (client.opens, client.closes, client.keys) == (
        2,
        1,
        [("KEY_HOME", "Click"), ("KEY_RETURN", "Click")],
    )


async def test_rest_power_state_is_published_and_power_is_not_sent_twice() -> None:
    client = FakeSamsungClient()
    clock, driver, manager = manager_for(client)
    saved: list[str] = []
    driver._save_token = saved.append
    await manager.send_key("POWER")
    await manager.send_key("POWER")
    assert manager.snapshot().power == "on"
    assert client.keys == [("KEY_POWER", "Click")]
    assert saved == ["token-novo"]
    clock.advance(POWER_REPEAT_SECONDS)
    await manager.send_key("POWER")
    assert client.keys == [("KEY_POWER", "Click"), ("KEY_POWER", "Click")]


async def test_standby_reported_by_rest_becomes_power_off() -> None:
    client = FakeSamsungClient()
    clock = FakeClock()
    driver = SamsungTvDriver(
        "192.168.0.11", "token-anterior", "UniOver", factory=factory(client), fetch_power=power_off
    )
    manager = TvSessionManager(clock, driver)
    await manager.wake()
    assert manager.snapshot().power == "off"


DESCRIPTION = """
    <root xmlns="urn:schemas-upnp-org:device-1-0"><device><serviceList><service>
    <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
    <controlURL>/upnp/control/RenderingControl1</controlURL>
    </service></serviceList></device></root>
"""
SOAP_VOLUME = (
    "<s:Envelope xmlns:s='http://schemas.xmlsoap.org/soap/envelope/'><s:Body>"
    "<u:GetVolumeResponse xmlns:u='urn:schemas-upnp-org:service:RenderingControl:1'>"
    "<CurrentVolume>{}</CurrentVolume></u:GetVolumeResponse>"
    "</s:Body></s:Envelope>"
)


def upnp_tv(
    volume: int | None = 37,
    *,
    requests: list[httpx.Request] | None = None,
    renderer: bool = True,
) -> httpx.MockTransport:
    """A TV simulada: o renderizador em `:9197/dmr`, o servidor da Netflix em `:9080`.

    Com `renderer=False` a TV não tem o serviço: tudo o que se pergunta é 404.
    """

    def respond(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(request)
        if not renderer:
            return httpx.Response(404)
        if request.url.port == 9080:
            return httpx.Response(200, text="status=ok")
        if request.method == "GET" and request.url.path == "/dmr":
            return httpx.Response(200, text=DESCRIPTION)
        if request.method == "POST" and request.url.path == "/upnp/control/RenderingControl1":
            assert request.headers["SOAPACTION"].endswith('#GetVolume"')
            if volume is None:
                return httpx.Response(500)
            return httpx.Response(200, text=SOAP_VOLUME.format(volume))
        return httpx.Response(404)

    return httpx.MockTransport(respond)


def discover(*locations: str) -> Callable[[str], list[str]]:
    return lambda _host: list(locations)


async def test_samsung_volume_is_read_from_the_description_on_the_renderer_port() -> None:
    requests: list[httpx.Request] = []
    searches: list[str] = []

    def never_searched(host: str) -> list[str]:
        searches.append(host)
        return []

    reader = SamsungVolume(
        "192.168.0.11", transport=upnp_tv(37, requests=requests), discover=never_searched
    )
    assert await reader.read() == 37
    assert reader.available is True
    assert reader.method == volume_module.METHOD_DESCRIPTION
    # Sem multicast: a descrição na porta do renderizador resolve, e o SSDP nem é perguntado.
    assert searches == []
    assert [(request.method, request.url.port, request.url.path) for request in requests] == [
        ("GET", 9197, "/dmr"),
        ("POST", 9197, "/upnp/control/RenderingControl1"),
    ]
    # O caminho que funcionou fica guardado: a leitura seguinte vai direto ao serviço.
    requests.clear()
    assert await reader.read() == 37
    assert [request.method for request in requests] == ["POST"]


async def test_samsung_volume_falls_back_to_the_fixed_control_address() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/upnp/control/RenderingControl1":
            return httpx.Response(200, text=SOAP_VOLUME.format(21))
        return httpx.Response(404)

    reader = SamsungVolume(
        "192.168.0.11", transport=httpx.MockTransport(respond), discover=discover()
    )
    assert await reader.read() == 21
    assert reader.method == volume_module.METHOD_DIRECT


async def test_samsung_volume_finds_a_renderer_that_only_ssdp_announces() -> None:
    description = DESCRIPTION.replace("/upnp/control/RenderingControl1", "/odd/control")
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.port == 9197:
            raise httpx.ConnectError("refused", request=request)
        if request.url.port == 9080:
            return httpx.Response(200, text="status=ok")
        if request.method == "GET":
            return httpx.Response(200, text=description)
        return httpx.Response(200, text=SOAP_VOLUME.format(44))

    reader = SamsungVolume(
        "192.168.0.11",
        transport=httpx.MockTransport(respond),
        # A TV anuncia vários dispositivos: o primeiro (texto puro) não é a descrição.
        discover=discover("http://192.168.0.11:9080", "http://192.168.0.11:7676/desc"),
    )
    assert await reader.read() == 44
    assert reader.method == volume_module.METHOD_SSDP
    posts = [(r.url.port, r.url.path) for r in requests if r.method == "POST"]
    assert posts[-1] == (7676, "/odd/control")


async def test_samsung_volume_without_the_service_backs_off_then_stops_asking() -> None:
    requests: list[httpx.Request] = []
    searches: list[str] = []

    def only_netflix(host: str) -> list[str]:
        searches.append(host)
        return ["http://192.168.0.11:9080", "http://192.168.0.11:9110/ip_control"]

    now = [100.0]
    reader = SamsungVolume(
        "192.168.0.11",
        transport=upnp_tv(None, requests=requests, renderer=False),
        discover=only_netflix,
        monotonic=lambda: now[0],
    )
    assert reader.available is None
    assert await reader.read() is None
    # Uma falha não é veredito (o serviço de uma TV que acabou de ligar pode demorar a subir).
    assert reader.available is None
    # Dentro da espera nada vai à rede.
    asked = len(requests)
    assert await reader.read() is None
    assert len(requests) == asked
    for wait in volume_module.RETRY_STEPS_SECONDS[:-1]:
        now[0] += wait
        assert await reader.read() is None
    assert reader.available is False
    assert len(searches) == len(volume_module.RETRY_STEPS_SECONDS)
    # Com o veredito dado, a TV não é perguntada nem em minutos nem na sessão reaberta.
    asked = len(requests)
    now[0] += 600
    assert await reader.read() is None
    reader.reset()
    assert await reader.read() is None
    assert len(requests) == asked
    # Passado o prazo longo, a TV pode ter mudado: pergunta de novo.
    now[0] += volume_module.REDISCOVER_SECONDS
    reader.reset()
    assert reader.available is None
    assert await reader.read() is None
    assert len(requests) > asked


async def test_samsung_volume_recovers_when_the_service_comes_up_after_the_session_opens() -> None:
    service_up = [False]

    def respond(request: httpx.Request) -> httpx.Response:
        if not service_up[0]:
            raise httpx.ConnectError("refused", request=request)
        if request.method == "GET":
            return httpx.Response(200, text=DESCRIPTION)
        return httpx.Response(200, text=SOAP_VOLUME.format(30))

    reader = SamsungVolume(
        "192.168.0.11", transport=httpx.MockTransport(respond), discover=discover()
    )
    assert await reader.read() is None
    service_up[0] = True
    # A sessão reabre: sem veredito ainda, a cascata roda de novo na hora.
    reader.reset()
    assert await reader.read() == 30
    assert reader.available is True


async def test_samsung_volume_goes_through_the_cascade_again_when_the_remembered_path_dies() -> (
    None
):
    state = {"description": True}
    description = DESCRIPTION.replace("/upnp/control/RenderingControl1", "/custom/control")
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200 if state["description"] else 404, text=description)
        if request.url.path == "/custom/control":
            return (
                httpx.Response(200, text=SOAP_VOLUME.format(9))
                if state["description"]
                else httpx.Response(404)
            )
        if request.url.path == "/upnp/control/RenderingControl1":
            return httpx.Response(200, text=SOAP_VOLUME.format(12))
        return httpx.Response(404)

    reader = SamsungVolume(
        "192.168.0.11", transport=httpx.MockTransport(respond), discover=discover()
    )
    assert await reader.read() == 9
    assert reader.method == volume_module.METHOD_DESCRIPTION
    state["description"] = False
    requests.clear()
    assert await reader.read() == 12
    assert reader.method == volume_module.METHOD_DIRECT
    assert [(r.method, r.url.path) for r in requests] == [
        ("POST", "/custom/control"),
        ("GET", "/dmr"),
        ("POST", "/upnp/control/RenderingControl1"),
    ]


async def test_samsung_volume_follows_the_url_base_of_the_description() -> None:
    description = (
        '<root xmlns="urn:schemas-upnp-org:device-1-0">'
        "<URLBase>http://192.168.0.11:7676/</URLBase><device><deviceList><device><serviceList>"
        "<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>"
        "<controlURL>upnp/control/RenderingControl1</controlURL></service>"
        "</serviceList></device></deviceList></device></root>"
    )
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, text=description)
        return httpx.Response(200, text=SOAP_VOLUME.format(12))

    reader = SamsungVolume(
        "192.168.0.11", transport=httpx.MockTransport(respond), discover=discover()
    )
    assert await reader.read() == 12
    assert [(r.method, r.url.port, r.url.path) for r in requests] == [
        ("GET", 9197, "/dmr"),
        ("POST", 7676, "/upnp/control/RenderingControl1"),
    ]


async def test_samsung_volume_never_raises_whatever_goes_wrong() -> None:
    def broken(host: str) -> list[str]:
        raise RuntimeError(host)

    nothing = upnp_tv(None, renderer=False)
    assert await SamsungVolume("192.168.0.11", discover=broken, transport=nothing).read() is None

    garbage = httpx.MockTransport(
        lambda request: httpx.Response(200, content=bytes([255, 254, 60]))
    )
    reader = SamsungVolume(
        "192.168.0.11", transport=garbage, discover=discover("http://192.168.0.11:9080")
    )
    assert await reader.read() is None
    assert await reader.read() is None


async def test_samsung_volume_ignores_announcements_that_point_to_another_machine() -> None:
    requests: list[httpx.Request] = []
    reader = SamsungVolume(
        "192.168.0.11",
        transport=upnp_tv(None, requests=requests, renderer=False),
        discover=discover("http://10.0.0.9:9197/dmr"),
    )
    assert await reader.read() is None
    assert all(request.url.host == "192.168.0.11" for request in requests)


async def test_samsung_volume_reads_nothing_when_the_service_fails() -> None:
    reader = SamsungVolume("192.168.0.11", transport=upnp_tv(None), discover=discover())
    assert await reader.read() is None
    # Uma falha de leitura não é veredito: a TV tem o serviço, mas ele não devolveu o nível.
    assert reader.available is None


async def test_samsung_volume_diagnosis_reports_every_path_without_sending_keys() -> None:
    reader = SamsungVolume(
        "192.168.0.11", transport=upnp_tv(55), discover=discover("http://192.168.0.11:9197/dmr")
    )
    attempts = await reader.diagnose()
    assert [(a.method, a.ok) for a in attempts] == [
        (volume_module.METHOD_DESCRIPTION, True),
        (volume_module.METHOD_DIRECT, False),
        (volume_module.METHOD_SSDP, False),
    ]
    assert "55" in attempts[0].detail
    assert all("192.168" not in a.detail for a in attempts)

    dead = SamsungVolume(
        "192.168.0.11", transport=upnp_tv(None, renderer=False), discover=discover()
    )
    assert not any(a.ok for a in await dead.diagnose())


async def test_the_log_never_carries_the_internal_address_of_the_tv(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # O registro sai do PC pela manutenção remota: nem host, nem porta, nem caminho do serviço.
    reader = SamsungVolume(
        "192.168.0.11",
        transport=upnp_tv(37),
        discover=discover("http://192.168.0.11:9080", "http://192.168.0.11:9197/dmr"),
    )
    failing = SamsungVolume(
        "192.168.0.11", transport=upnp_tv(None, renderer=False), discover=discover()
    )
    with caplog.at_level(logging.DEBUG, logger=volume_module.__name__):
        assert await reader.read() == 37
        assert await failing.read() is None
    messages = [record.getMessage() for record in caplog.records]
    assert any("caminho" in message and "respondeu" in message for message in messages)
    for leaked in ("192.168", "9197", "9080", "/dmr", "RenderingControl1", "http"):
        assert not any(leaked in message for message in messages), leaked


def test_samsung_rendering_control_url_needs_xml_with_the_service() -> None:
    assert rendering_control_url("status=ok", "http://tv:9080/") is None
    assert rendering_control_url("<root/>", "http://tv:9080/") is None
    assert (
        rendering_control_url(DESCRIPTION, "http://tv:9197/dmr")
        == "http://tv:9197/upnp/control/RenderingControl1"
    )


def test_ssdp_locations_collects_every_announcement_of_the_tv(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ok = b"HTTP/1.1 200 OK\r\n"
    replies = [
        (ok + b"LOCATION: http://192.168.0.11:9110/ip_control\r\n\r\n", "192.168.0.11"),
        (ok + b"Location: http://192.168.0.99:9197/dmr\r\n\r\n", "192.168.0.99"),
        (ok + b"LOCATION: http://192.168.0.11:9080\r\n\r\n", "192.168.0.11"),
        (ok + b"LOCATION: http://192.168.0.11:9080\r\n\r\n", "192.168.0.11"),
        (ok + b"EXT:\r\n\r\n", "192.168.0.11"),
    ]
    sent: list[tuple[bytes, tuple[str, int]]] = []

    class FakeSocket:
        def __enter__(self) -> FakeSocket:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def settimeout(self, seconds: float) -> None:
            del seconds

        def sendto(self, data: bytes, address: tuple[str, int]) -> None:
            sent.append((data, address))

        def recvfrom(self, size: int) -> tuple[bytes, tuple[str, int]]:
            del size
            if not replies:
                raise TimeoutError
            data, host = replies.pop(0)
            return data, (host, 1900)

    monkeypatch.setattr(volume_module, "_udp_socket", FakeSocket)
    monkeypatch.setattr(volume_module, "SSDP_LISTEN_SECONDS", 0.05)
    assert real_ssdp_locations("192.168.0.11") == [
        "http://192.168.0.11:9110/ip_control",
        "http://192.168.0.11:9080",
    ]
    # Perguntou direto à TV e, como ela respondeu, nem chegou a falar com o grupo multicast.
    assert all(address == ("192.168.0.11", 1900) for _, address in sent)
    assert len(sent) == len(volume_module.SSDP_TARGETS)


def test_ssdp_locations_falls_back_to_multicast_when_the_tv_ignores_the_direct_question(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[tuple[str, int]] = []
    replies: list[tuple[bytes, tuple[str, int]]] = []

    class FakeSocket:
        def __enter__(self) -> FakeSocket:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def settimeout(self, seconds: float) -> None:
            del seconds

        def sendto(self, data: bytes, address: tuple[str, int]) -> None:
            del data
            sent.append(address)
            if address[0] == "239.255.255.250" and not replies:
                reply = b"HTTP/1.1 200 OK\r\nLOCATION: http://192.168.0.11:9080/desc\r\n\r\n"
                replies.append((reply, ("192.168.0.11", 1900)))

        def recvfrom(self, size: int) -> tuple[bytes, tuple[str, int]]:
            del size
            if not replies:
                raise TimeoutError
            return replies.pop(0)

    monkeypatch.setattr(volume_module, "_udp_socket", FakeSocket)
    monkeypatch.setattr(volume_module, "SSDP_LISTEN_SECONDS", 0.02)
    assert real_ssdp_locations("192.168.0.11") == ["http://192.168.0.11:9080/desc"]
    assert sent[0] == ("192.168.0.11", 1900)
    assert ("239.255.255.250", 1900) in sent


def test_ssdp_locations_gives_up_quietly_without_a_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken(*args: object) -> None:
        raise OSError("sem rede")

    monkeypatch.setattr(volume_module, "_udp_socket", broken)
    assert real_ssdp_locations("192.168.0.11") == []


def samsung_with_volume(client: FakeSamsungClient, reader: SamsungVolume) -> TvSessionManager:
    driver = SamsungTvDriver(
        "192.168.0.11",
        "token-anterior",
        "UniOver",
        factory=factory(client),
        fetch_power=power_on,
        volume=reader,
    )
    return TvSessionManager(
        FakeClock(), driver, hibernate_seconds=10, volume_reader=driver.read_volume
    )


class CountingVolume(SamsungVolume):
    """Leitor que devolve uma sequência de níveis e conta as consultas."""

    def __init__(self, levels: list[int | None], *, has_service: bool = True) -> None:
        super().__init__("192.168.0.11")
        self.levels = levels
        self.reads = 0
        self.resets = 0
        self.has_service = has_service

    @property
    def available(self) -> bool | None:
        return self.has_service if self.reads else None

    def reset(self) -> None:
        self.resets += 1

    async def read(self) -> int | None:
        self.reads += 1
        return self.levels.pop(0) if self.levels else None


async def test_samsung_volume_is_published_on_open_and_after_a_volume_key_only() -> None:
    reader = CountingVolume([22, 23, 22])
    manager = samsung_with_volume(FakeSamsungClient(), reader)
    await manager.wake()
    await manager.settle()
    assert manager.snapshot().volume == 22
    assert reader.resets == 1

    await manager.send_key("VOLUME_UP")
    await manager.settle()
    assert manager.snapshot().volume == 23

    await manager.send_key("MUTE")
    await manager.settle()
    assert manager.snapshot().volume == 22
    # Teclas que não mexem no volume não consultam a TV, e nada consulta sozinho.
    reads = reader.reads
    await manager.send_key("UP")
    await manager.settle()
    assert reader.reads == reads
    await manager.aclose()


async def test_samsung_does_not_poll_the_volume() -> None:
    reader = CountingVolume([10])
    manager = samsung_with_volume(FakeSamsungClient(), reader)
    await manager.wake()
    await manager.settle()
    for _ in range(50):
        await asyncio.sleep(0.01)
    assert reader.reads == 1
    await manager.aclose()


async def test_samsung_without_the_volume_service_costs_no_traffic_per_key() -> None:
    reader = SamsungVolume(
        "192.168.0.11", transport=upnp_tv(None, renderer=False), discover=lambda _host: []
    )
    manager = samsung_with_volume(FakeSamsungClient(), reader)
    await manager.wake()
    await manager.settle()
    # A primeira falha não é veredito, mas abre a espera: as teclas logo depois não vão à rede.
    assert reader.available is None
    assert manager.snapshot().volume is None
    searches: list[str] = []

    def spy(host: str) -> list[str]:
        searches.append(host)
        return []

    reader._discover = spy
    for _ in range(5):
        await manager.send_key("VOLUME_DOWN")
    await manager.settle()
    assert searches == []
    await manager.aclose()


async def test_samsung_keeps_volume_unknown_when_the_service_answers_nothing() -> None:
    reader = CountingVolume([None])
    manager = samsung_with_volume(FakeSamsungClient(), reader)
    await manager.wake()
    await manager.settle()
    assert manager.snapshot().volume is None
    await manager.aclose()


async def test_samsung_declares_only_keys_it_can_send() -> None:
    assert set(SAMSUNG_OPTIONAL_KEYS) <= SAMSUNG_KEYS.keys()
    client = FakeSamsungClient()
    _, _, manager = manager_for(client)
    for key in ("GUIDE", "BLUE", "SUBTITLE", "E_MANUAL"):
        await manager.send_key(key)
    assert [key for key, _ in client.keys] == [
        "KEY_GUIDE",
        "KEY_CYAN",
        "KEY_CAPTION",
        "KEY_EMANUAL",
    ]


async def test_samsung_apps_use_a_valid_alias_but_launch_the_original_app_id() -> None:
    client = FakeSamsungClient()
    client.apps = []  # Firmware sem EDEN: a lista vem do catálogo REST abaixo.

    def respond(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path.endswith("/111299001912"):
            return httpx.Response(200, json={"id": "111299001912", "name": "Vídeo"})
        return httpx.Response(404)

    transport = httpx.MockTransport(respond)
    driver = SamsungTvDriver(
        "192.168.0.11",
        "token-anterior",
        "UniOver",
        factory=factory(client),
        fetch_power=power_on,
        rest_transport=transport,
    )
    manager = TvSessionManager(FakeClock(), driver, hibernate_seconds=10)
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    apps = SamsungTvApps(manager, driver, FakeTransport(), envelopes)
    entries = await apps.refresh()
    assert [entry.package for entry in entries] == ["samsung.app.id111299001912"]
    await apps.launch_package(entries[0].package)
    assert client.runs == [("111299001912", "NATIVE_LAUNCH", "")]
    assert apps.last_opened_app_id == "111299001912"


async def test_samsung_ws_list_publishes_its_square_icon_in_the_v2_contract() -> None:
    client = FakeSamsungClient()
    client.apps = [{"appId": "111299001912", "name": "YouTube", "icon": "/icons/youtube.png"}]
    png = (
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGN4yinyHxkzkC4A"
        "AD/YIBHrRBzaAAAAAElFTkSuQmCC"
    )
    client.icons["/icons/youtube.png"] = png
    driver = SamsungTvDriver(
        "192.168.0.11", "token-anterior", "UniOver", factory=factory(client), fetch_power=power_on
    )
    manager = TvSessionManager(FakeClock(), driver)
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    transport = FakeTransport()
    apps = SamsungTvApps(manager, driver, transport, envelopes)

    listed = await apps.refresh()
    await apps.publish(listed)

    (message,) = transport.sent
    assert message["type"] == "tv.apps.v2"
    icon = message["body"]["apps"][0]["icon"]
    assert icon == {"mime": "image/png", "data": png}


async def test_samsung_catalog_probes_only_installed_apps_and_extra_ids() -> None:
    async def respond(request: httpx.Request) -> httpx.Response:
        app_id = request.url.path.rsplit("/", maxsplit=1)[-1]
        if app_id == "111299001912":
            return httpx.Response(200, json={"id": app_id, "name": "YouTube"})
        if app_id == "meu.app":
            return httpx.Response(200, json={"id": app_id, "name": "Meu app"})
        if app_id == "lento.app":
            await asyncio.sleep(0.1)
        return httpx.Response(404)

    driver = SamsungTvDriver(
        "192.168.0.11",
        None,
        "UniOver",
        app_ids=("meu.app", "lento.app"),
        rest_transport=httpx.MockTransport(respond),
        app_timeout_seconds=0.01,
        app_list_timeout_seconds=0.2,
    )
    assert await driver.app_list() == [
        {"appId": "111299001912", "name": "YouTube"},
        {"appId": "meu.app", "name": "Meu app"},
    ]


async def test_samsung_app_launch_uses_rest_before_the_websocket_and_falls_back() -> None:
    client = FakeSamsungClient()

    def respond(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/111299001912"):
            return httpx.Response(200)
        return httpx.Response(500)

    driver = SamsungTvDriver(
        "192.168.0.11",
        "token-anterior",
        "UniOver",
        factory=factory(client),
        fetch_power=power_on,
        rest_transport=httpx.MockTransport(respond),
    )
    await driver.run_app("111299001912")
    assert client.runs == []
    await driver.connect()
    await driver.run_app("sem-rest")
    assert client.runs == [("sem-rest", "NATIVE_LAUNCH", "")]


async def test_samsung_websocket_timeout_does_not_block_the_event_loop() -> None:
    class SlowSamsungClient(FakeSamsungClient):
        def send_key(
            self,
            key: str,
            times: int = 1,
            key_press_delay: float | None = None,
            cmd: str = "Click",
        ) -> None:
            del key, times, key_press_delay, cmd
            time.sleep(0.1)

    client = SlowSamsungClient()

    driver = SamsungTvDriver(
        "192.168.0.11",
        "token-anterior",
        "UniOver",
        factory=factory(client),
        fetch_power=power_on,
        ws_timeout_seconds=0.01,
    )
    await driver.connect()
    started = time.monotonic()
    with pytest.raises(TvUnreachable, match="canal da TV Samsung"):
        await driver.send_key("HOME")
    assert time.monotonic() - started < 0.08
    await asyncio.sleep(0.11)


async def test_text_and_cleanup_are_explicitly_unsupported() -> None:
    text = unsupported_handler("a TV Samsung não suporta digitação por este canal")
    cleanup = unsupported_handler("a TV Samsung não suporta limpeza por ADB")
    text_result = await text(Command("t", "tv.text.v1", {"text": "oi"}))
    cleanup_result = await cleanup(Command("c", "tv.cleanup.v1", {"requestId": "x"}))
    assert (text_result.status, text_result.code) == (ResultStatus.REJECTED, "unsupported")
    assert (cleanup_result.status, cleanup_result.code) == (ResultStatus.REJECTED, "unsupported")


def test_samsung_configuration_selects_its_capabilities_without_adb(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    client = FakeSamsungClient()
    remote = SamsungTvDriver(
        "192.168.0.11", "token-secreto", "UniOver", factory=factory(client), fetch_power=power_on
    )
    monkeypatch.setattr(main_module, "SamsungTvDriver", lambda *_args, **_kwargs: remote)
    secrets = FakeSecretStore()
    secrets.set(samsung_token_name("sala"), "token-secreto")
    settings = Settings(tv_kind="samsung", tv_host="192.168.0.11", tv_name="sala")
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    setup = build_tv(
        settings,
        clock,
        FakeTransport(),
        envelopes,
        secrets,
    )
    assert setup is not None
    expected = (
        [
            "tv.remote",
            "tv.kind.samsung",
            "tv.power.off.v1",
            "tv.permission.v1",
            "tv.maintenance.v1",
            "tv.key.v3",
        ]
        + [f"tv.key.{key}" for key in SAMSUNG_OPTIONAL_KEYS]
        + ["tv.discovery.v1"]
    )
    assert setup.capabilities == expected
    assert envelopes.hello("0.1.0", tuple(setup.capabilities))["body"]["capabilities"] == expected
    assert "tv.key.v3" in setup.handlers
    assert "tv.cleanup.v1" in setup.handlers
    # A Samsung recebe só a preferência da manutenção por REST (`tv.maintenance.v1`); a limpeza
    # automática do Android (`tv.cleanup.automatic.v1`) continua sendo só dele.
    assert "tv.cleanup.config.v1" in setup.handlers
    assert "tv.cleanup.automatic.v1" not in setup.capabilities
    assert "tv.light-settings.v1" not in setup.capabilities
    assert "tv.focus-closes-background.v1" not in setup.capabilities  # fechar apps é só Android
    assert setup.text is None
    assert "token-secreto" not in caplog.text

    # Sem o campo (API antiga) a manutenção fica parada; com ele, o valor desta TV manda.
    scheduler = setup.cleanup_scheduler
    assert isinstance(scheduler, SamsungMaintenanceScheduler)
    configure = setup.handlers["tv.cleanup.config.v1"]
    legacy = {"lightEnabled": True, "deepEnabled": True, "deepThresholdMb": 160}
    configured = asyncio.run(configure(Command("c1", "tv.cleanup.config.v1", legacy)))
    assert configured.status == ResultStatus.OK
    assert scheduler.enabled is False
    asyncio.run(
        configure(Command("c2", "tv.cleanup.config.v1", {**legacy, "maintenanceEnabled": True}))
    )
    assert scheduler.enabled is True
    asyncio.run(
        configure(Command("c3", "tv.cleanup.config.v1", {**legacy, "maintenanceEnabled": False}))
    )
    assert scheduler.enabled is False


async def test_read_power_asks_the_tv_again_instead_of_reusing_the_reading_from_connect() -> None:
    readings = iter([True, False])

    async def fetch(host: str) -> bool | None:
        del host
        return next(readings)

    client = FakeSamsungClient()
    driver = SamsungTvDriver(
        "192.168.0.11", "token", "UniOver", factory=factory(client), fetch_power=fetch
    )
    seen: list[bool] = []
    driver.on_power(seen.append)
    await driver.connect()
    assert seen == [True]
    assert await driver.read_power() is False


async def test_power_off_on_a_samsung_tv_in_standby_sends_no_key() -> None:
    # A sessão abriu com a TV ligada, mas ela entrou em espera depois: a leitura nova manda.
    states = iter([True, False])

    async def fetch(host: str) -> bool | None:
        del host
        return next(states)

    client = FakeSamsungClient()
    driver = SamsungTvDriver(
        "192.168.0.11", "token", "UniOver", factory=factory(client), fetch_power=fetch
    )
    manager = TvSessionManager(FakeClock(), driver, power_reader=driver.read_power)
    assert await manager.power_off() is PowerOffResult.ALREADY_OFF
    assert client.keys == []


def test_tv_kind_reads_the_environment_and_defaults_to_android(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert Settings().tv_kind == "android"
    monkeypatch.setenv("UNIOVER_TV_KIND", "samsung")
    assert Settings().tv_kind == "samsung"
    monkeypatch.setenv("UNIOVER_TV_SAMSUNG_APPS", "meu.app, 123456")
    assert Settings().tv_samsung_apps == ["meu.app", "123456"]

    monkeypatch.setenv("UNIOVER_TV_SAMSUNG_APPS", ",".join(str(100000 + n) for n in range(32)))
    assert len(Settings().tv_samsung_apps) == 32
    monkeypatch.setenv("UNIOVER_TV_SAMSUNG_APPS", ",".join(str(100000 + n) for n in range(33)))
    with pytest.raises(ValueError, match="no máximo 32"):
        Settings()


async def test_samsung_link_launch_is_explicitly_unsupported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = FakeSamsungClient()
    remote = SamsungTvDriver(
        "192.168.0.11", "token-secreto", "UniOver", factory=factory(client), fetch_power=power_on
    )
    monkeypatch.setattr(main_module, "SamsungTvDriver", lambda *_args, **_kwargs: remote)
    secrets = FakeSecretStore()
    secrets.set(samsung_token_name("sala"), "token-secreto")
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    setup = build_tv(
        Settings(tv_kind="samsung", tv_host="192.168.0.11", tv_name="sala"),
        clock,
        FakeTransport(),
        envelopes,
        secrets,
    )
    assert setup is not None
    result = await setup.handlers["tv.app.launch.v1"](
        Command("link", "tv.app.launch.v1", {"target": {"kind": "link", "value": "https://a.test"}})
    )
    assert (result.status, result.code) == (ResultStatus.REJECTED, "unsupported")


async def test_samsung_pair_saves_only_the_token_in_the_credential_store(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def pair(host: str, name: str) -> str:
        assert (host, name) == ("192.168.0.11", "UniOver")
        return "token-secreto"

    monkeypatch.setattr(main_module, "pair_samsung_tv", pair)
    store = FakeSecretStore()
    with caplog.at_level(logging.DEBUG):
        assert await tv_pair(Settings(), "192.168.0.11", "sala", "samsung", store) == 0
    captured = capsys.readouterr()
    assert store.get("samsung:sala") == "token-secreto"
    assert "token-secreto" not in captured.out
    assert "token-secreto" not in captured.err
    assert "token-secreto" not in caplog.text


async def test_samsung_pair_does_not_wait_for_a_slow_close(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    class SlowCloseClient(FakeSamsungClient):
        def close(self) -> None:
            time.sleep(0.1)
            super().close()

    client = SlowCloseClient()
    monkeypatch.setattr(samsung_pairing, "SAMSUNG_CLOSE_TIMEOUT_SECONDS", 0.01)
    started = time.monotonic()
    with caplog.at_level(logging.WARNING):
        result = await pair_samsung_tv("192.168.0.11", "UniOver", factory=factory(client))
    assert result == "token-novo"
    assert time.monotonic() - started < 0.08
    assert "falha ao fechar o canal Samsung depois do pareamento" in caplog.text
    assert "token-novo" not in caplog.text
    await asyncio.sleep(0.11)
    assert client.closes == 1


def test_pairing_waits_for_the_accept_on_the_tv() -> None:
    # A TV só responde depois do aceite: o socket do pareamento não pode usar os 5 s do controle.
    client = _pairing_factory("192.168.0.11", None, "UniOver")

    assert isinstance(client, SamsungTVWS)
    assert client.timeout == SAMSUNG_PAIR_TIMEOUT_SECONDS
