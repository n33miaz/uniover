"""Samsung gentil: identidade gravada, Wake-on-LAN, volume (abrir e tecla) e o pareamento."""

import tomllib
from pathlib import Path
from typing import Any

import httpx
import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters import tv_samsung, wol
from uniover_agent.adapters import tv_samsung_volume as volume_module
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTransport
from uniover_agent.adapters.tv_samsung import SamsungTvDriver
from uniover_agent.adapters.tv_samsung_volume import SamsungVolume
from uniover_agent.adapters.wol import broadcast_for, magic_packet, send_wake_on_lan
from uniover_agent.config import Settings
from uniover_agent.core import EnvelopeFactory, EnvelopeGate, TvIdentity, TvKnown, TvSessionError
from uniover_agent.main import build_tv, remember_tv_identity, samsung_token_name, tv_pair

from .conftest import REAL_WOL_SEND
from .support import AGENT_ID
from .test_tv_samsung import FakeSamsungClient, factory

HOST = "192.168.0.11"
DUID = "12ce8c0c-730b-4300-84e7-3ae19e12e536"
MAC = "74:6D:FA:5D:52:08"
INFO = {"device": {"type": "Samsung SmartTV", "duid": f"uuid:{DUID}", "wifiMac": MAC.lower()}}


def read_toml(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


DMR_DESCRIPTION = """
    <root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceList><device><serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
    <controlURL>/dmr/upnp/control/RenderingControl1</controlURL></service>
    </serviceList></device></deviceList></device></root>
"""
LOCATION = f"http://{HOST}:9080/description.xml"


def volume_transport(level: int | None, *, status: int = 200) -> httpx.MockTransport:
    """A TV simulada: a descrição em `:9080` aponta o serviço de volume (a porta vem de lá)."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            assert request.url == LOCATION
            return httpx.Response(200, text=DMR_DESCRIPTION)
        assert request.url.path == "/dmr/upnp/control/RenderingControl1"
        assert "GetVolume" in request.headers["soapaction"]
        body = f"<Envelope><CurrentVolume>{level}</CurrentVolume></Envelope>"
        return httpx.Response(status, text=body if level is not None else "<x/>")

    return httpx.MockTransport(handler)


def driver_with(transport: httpx.AsyncBaseTransport) -> SamsungTvDriver:
    volume = SamsungVolume(HOST, transport=transport, discover=lambda _host: [LOCATION])
    return SamsungTvDriver(HOST, "t", "U", volume=volume)


# --- identidade: o duid e o MAC gravados sem o dono fazer nada -----------------------------


async def test_the_driver_hands_over_the_identity_from_the_same_rest_read_as_the_power(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def info(host: str) -> dict[str, Any]:
        calls.append(host)
        return {"device": {**INFO["device"], "PowerState": "on"}}

    monkeypatch.setattr(tv_samsung, "fetch_samsung_info", info)
    seen: list[TvIdentity] = []
    driver = SamsungTvDriver(
        HOST, "token", "UniOver", factory=factory(FakeSamsungClient()), on_identity=seen.append
    )
    powers: list[bool] = []
    driver.on_power(powers.append)
    await driver.connect()
    assert calls == [HOST]  # uma só leitura do REST por abertura
    assert seen == [TvIdentity((DUID, MAC), MAC)]
    assert powers == [True]


async def test_a_failing_identity_sink_never_breaks_the_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def info(host: str) -> dict[str, Any]:
        return INFO

    def broken(identity: TvIdentity) -> None:
        raise OSError("disco cheio")

    monkeypatch.setattr(tv_samsung, "fetch_samsung_info", info)
    driver = SamsungTvDriver(
        HOST, "token", "UniOver", factory=factory(FakeSamsungClient()), on_identity=broken
    )
    await driver.connect()
    assert driver.connected


def test_the_identity_is_saved_once_and_the_rest_of_the_file_is_kept(
    isolated_env: Path,
) -> None:
    isolated_env.write_text('api_url = "https://a.test"\ntv_cleanup_keep = ["com.x.y"]\n')
    known = TvKnown()
    remember_tv_identity(known, TvIdentity((DUID, MAC), MAC))
    assert read_toml(isolated_env) == {
        "api_url": "https://a.test",
        "tv_cleanup_keep": ["com.x.y"],
        "tv_id_hint": DUID,
        "tv_mac": MAC,
    }
    isolated_env.write_text('tv_host = "x"\n')  # se nada novo foi aprendido, não regrava
    remember_tv_identity(known, TvIdentity((DUID, MAC), MAC))
    assert read_toml(isolated_env) == {"tv_host": "x"}


def test_a_tv_that_already_has_the_duid_only_learns_the_mac(isolated_env: Path) -> None:
    known = TvKnown(hint="guardado-antes")
    remember_tv_identity(known, TvIdentity((DUID, MAC), MAC))
    assert read_toml(isolated_env) == {"tv_id_hint": "guardado-antes", "tv_mac": MAC}


def compose_samsung(
    monkeypatch: pytest.MonkeyPatch,
    client: FakeSamsungClient,
    transport: httpx.MockTransport | None = None,
    **settings: Any,
) -> tuple[Any, FakeClock]:
    real = SamsungTvDriver

    def build(*args: Any, **kwargs: Any) -> SamsungTvDriver:
        return real(*args, factory=factory(client), rest_transport=transport, **kwargs)

    monkeypatch.setattr(main_module, "SamsungTvDriver", build)
    secrets = FakeSecretStore()
    secrets.set(samsung_token_name("sala"), "token")
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    config = Settings(tv_kind="samsung", tv_host=HOST, tv_name="sala", **settings)
    setup = build_tv(config, clock, FakeTransport(), envelopes, secrets)
    assert setup is not None
    return setup, clock


async def test_the_composed_session_saves_the_identity_on_the_first_connection(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    async def info(host: str) -> dict[str, Any]:
        return INFO

    monkeypatch.setattr(tv_samsung, "fetch_samsung_info", info)
    setup, _ = compose_samsung(monkeypatch, FakeSamsungClient())
    assert setup.known == TvKnown()
    await setup.manager.wake()
    saved = read_toml(isolated_env)
    assert (saved["tv_id_hint"], saved["tv_mac"]) == (DUID, MAC)
    # O registro compartilhado com o vigia do endereço já sabe o MAC.
    assert (setup.known.hint, setup.known.mac) == (DUID, MAC)


# --- Wake-on-LAN no pedido de ligar ------------------------------------------------------------


async def test_power_with_the_tv_off_the_network_sends_the_magic_packet_to_the_saved_mac(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(main_module, "build_liveness", lambda kind, host: _dead)
    monkeypatch.setattr(wol, "_send", lambda mac, host: sent.append((mac, host)))
    client = FakeSamsungClient()
    setup, _ = compose_samsung(monkeypatch, client, tv_mac=MAC)
    await setup.manager.send_key("POWER")  # devolve na hora; a TV é acompanhada ao fundo
    await setup.manager.settle()
    assert sent == [(MAC, HOST)]
    assert client.keys == []  # nunca a tecla (é um interruptor)


async def _dead() -> bool:
    return False


async def test_power_with_the_tv_off_the_network_and_no_mac_says_it_cannot_send(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(main_module, "build_liveness", lambda kind, host: _dead)
    monkeypatch.setattr(wol, "_send", lambda mac, host: sent.append((mac, host)))
    setup, _ = compose_samsung(monkeypatch, FakeSamsungClient())
    with pytest.raises(TvSessionError, match="sinal de ligar"):
        await setup.manager.send_key("POWER")
    assert sent == []


async def test_power_with_the_tv_on_the_network_is_the_normal_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(wol, "_send", lambda mac, host: sent.append((mac, host)))
    client = FakeSamsungClient()
    setup, _ = compose_samsung(monkeypatch, client, tv_mac=MAC)
    await setup.manager.send_key("POWER")
    assert (sent, client.keys) == ([], [("KEY_POWER", "Click")])


def test_the_magic_packet_is_six_ff_and_the_mac_sixteen_times() -> None:
    packet = magic_packet("74-6d-fa-5d-52-08")
    assert packet == b"\xff" * 6 + bytes.fromhex("746dfa5d5208") * 16
    assert len(packet) == 102
    with pytest.raises(ValueError, match="MAC"):
        magic_packet("não é um mac")


def test_the_broadcast_is_the_slash_24_of_the_pc_in_the_tv_network() -> None:
    assert broadcast_for("192.168.0.12") == "192.168.0.255"


async def test_the_packet_leaves_by_the_card_that_reaches_the_tv(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[tuple[str, Any]] = []

    class FakeSocket:
        def __init__(self, *args: Any) -> None:
            events.append(("socket", args))

        def __enter__(self) -> FakeSocket:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def setsockopt(self, *args: Any) -> None:
            events.append(("opt", args))

        def bind(self, address: tuple[str, int]) -> None:
            events.append(("bind", address))

        def sendto(self, data: bytes, address: tuple[str, int]) -> None:
            events.append(("send", (data, address)))

    monkeypatch.setattr(wol, "_send", REAL_WOL_SEND)
    monkeypatch.setattr(wol, "_new_socket", FakeSocket)
    # A rota padrão aponta para a placa sem rede; a da TV é a do Wi-Fi.
    monkeypatch.setattr(wol, "local_address_for", lambda host: "192.168.0.12")
    monkeypatch.setattr(wol, "local_ipv4", lambda: "169.254.190.176")
    assert await send_wake_on_lan(MAC, HOST) is True
    assert ("bind", ("192.168.0.12", 0)) in events
    targets = [data[1] for kind, data in events if kind == "send"]
    assert ("192.168.0.255", 9) in targets
    assert ("255.255.255.255", 9) in targets
    packets = {data[0] for kind, data in events if kind == "send"}
    assert packets == {magic_packet(MAC)}


async def test_a_wake_on_lan_that_cannot_leave_is_reported_not_raised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken(mac: str, host: str) -> None:
        raise OSError("sem rede")

    monkeypatch.setattr(wol, "_send", broken)
    assert await send_wake_on_lan(MAC, HOST) is False
    assert await send_wake_on_lan("mac inválido", HOST) is False


# --- volume: ao abrir e depois de uma tecla --------------------------------------------


async def test_the_driver_reads_the_volume_from_the_service_the_tv_describes() -> None:
    assert await driver_with(volume_transport(17)).read_volume() == 17
    assert await driver_with(volume_transport(250)).read_volume() == 100


async def test_a_tv_that_does_not_answer_the_volume_gives_none() -> None:
    assert await driver_with(volume_transport(None)).read_volume() is None
    assert await driver_with(volume_transport(5, status=500)).read_volume() is None

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("recusou")

    assert await driver_with(httpx.MockTransport(refuse)).read_volume() is None


async def test_the_volume_is_read_on_open_and_after_a_volume_key_nothing_else_does(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[str] = []
    levels = iter([23, 24])

    def counting(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=DMR_DESCRIPTION)
        requests.append(request.url.path)
        return httpx.Response(
            200, text=f"<Envelope><CurrentVolume>{next(levels)}</CurrentVolume></Envelope>"
        )

    monkeypatch.setattr(volume_module, "ssdp_locations", lambda host: [LOCATION])
    client = FakeSamsungClient()
    setup, _ = compose_samsung(monkeypatch, client, httpx.MockTransport(counting))
    await setup.manager.wake()
    await setup.manager.settle()
    assert requests == ["/dmr/upnp/control/RenderingControl1"]
    assert setup.manager.snapshot().volume == 23
    await setup.manager.send_key("HOME")
    await setup.manager.settle()
    assert len(requests) == 1
    await setup.manager.send_key("VOLUME_UP")
    await setup.manager.settle()
    assert len(requests) == 2
    assert setup.manager.snapshot().volume == 24


async def test_the_installed_config_without_a_mac_still_gets_keys_and_survives_a_broken_volume(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A config que já está num PC (samsung, host, id_hint, token no cofre, sem `tv_mac`)."""

    def boom(host: str) -> list[str]:
        raise RuntimeError(host)

    monkeypatch.setattr(volume_module, "ssdp_locations", boom)
    client = FakeSamsungClient()
    setup, _ = compose_samsung(monkeypatch, client, tv_id_hint=DUID)
    assert setup.known.mac is None
    assert {"tv.remote", "tv.kind.samsung", "tv.key.v3", "tv.key.GUIDE"} <= set(setup.capabilities)
    await setup.manager.wake()
    await setup.manager.send_key("VOLUME_UP")
    await setup.manager.send_key("GUIDE")
    await setup.manager.settle()
    assert [key for key, _ in client.keys] == ["KEY_VOLUP", "KEY_GUIDE"]
    assert setup.manager.snapshot().volume is None


# --- pareamento grava a identidade ---------------------------------------------------------


async def paired_with(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, identity: TvIdentity | None
) -> tuple[int, list[tuple[str, str]]]:
    asked: list[tuple[str, str]] = []

    async def identify(kind: str, host: str) -> TvIdentity | None:
        asked.append((kind, host))
        return identity

    async def fake_pair(host: str, name: str) -> str:
        return "token"

    monkeypatch.setattr(main_module, "pair_samsung_tv", fake_pair)
    code = await tv_pair(
        settings,
        None,
        None,
        "samsung",
        FakeSecretStore(),
        identify=identify,
    )
    return code, asked


def exists(path: Path) -> bool:
    return path.exists()


async def test_pairing_the_configured_samsung_saves_its_duid_and_mac(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    settings = Settings(tv_host=HOST, tv_kind="samsung")
    code, asked = await paired_with(monkeypatch, settings, TvIdentity((DUID, MAC), MAC))
    assert (code, asked) == (0, [("samsung", HOST)])
    saved = read_toml(isolated_env)
    assert (saved["tv_id_hint"], saved["tv_mac"]) == (DUID, MAC)


async def test_pairing_another_tv_by_host_does_not_touch_the_file(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    settings = Settings(tv_host="192.168.0.99", tv_kind="samsung")
    # Sem `--host` o pareamento usa o `tv_host` configurado (a TV configurada), então o outro
    # endereço só vale quando vem na linha de comando.
    asked: list[tuple[str, str]] = []

    async def identify(kind: str, host: str) -> TvIdentity | None:
        asked.append((kind, host))
        return TvIdentity((DUID, MAC), MAC)

    async def fake_pair(host: str, name: str) -> str:
        return "token"

    monkeypatch.setattr(main_module, "pair_samsung_tv", fake_pair)
    code = await tv_pair(
        settings,
        HOST,
        None,
        "samsung",
        FakeSecretStore(),
        identify=identify,
    )
    assert (code, asked) == (0, [])
    assert not exists(isolated_env)


async def test_pairing_without_an_answer_from_the_tv_saves_nothing(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    settings = Settings(tv_host=HOST, tv_kind="samsung")
    code, _ = await paired_with(monkeypatch, settings, None)
    assert code == 0
    assert not exists(isolated_env)
