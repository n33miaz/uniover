"""Rede do reencontro da TV: tabela ARP, SSDP e confirmação pelo REST ou sessão pareada.

Cada função aqui fala com a rede de verdade e é injetada no `TvLocator` (o núcleo). Os endereços
e os identificadores nunca vão para o registro.

O SSDP e o Wake-on-LAN precisam sair pela placa certa: com Wi-Fi, cabo sem rede e adaptadores
virtuais, o multicast segue a rota padrão, que pode não ser a da TV. Por isso o socket é preso ao
endereço desta máquina **na rede da TV** (`local_address_for`).
"""

import asyncio
import ipaddress
import logging
import socket
from collections.abc import Awaitable, Callable

from uniover_agent.adapters.arp import arp_mac, arp_table
from uniover_agent.adapters.tv_discovery import (
    ANDROID_REMOTE_PORT,
    SAMSUNG_REST_PORT,
    FetchJson,
    TvKindName,
    http_json,
    local_address_for,
    local_ipv4,
    samsung_identity,
    subnet_hosts,
    tcp_open,
)
from uniover_agent.core.tv.locator import Authenticate, TvIdentity, TvKnown, TvLocator
from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

SSDP_GROUP = ("239.255.255.250", 1900)
SSDP_WAIT_SECONDS = 2.5
# Alvos de busca que cada família de TV responde.
SSDP_TARGETS: dict[TvKindName, str] = {
    "samsung": "urn:samsung.com:device:RemoteControlReceiver:1",
    "android": "urn:dial-multiscreen-org:service:dial:1",
}
PROBE_TIMEOUT_SECONDS = 1.5
SAMSUNG_WS_PORT = 8002


def parse_ssdp_reply(data: bytes) -> bool:
    """A resposta é de um `M-SEARCH` (e não ruído qualquer na porta)?"""
    return data.startswith(b"HTTP/1.1 200") or data.upper().startswith(b"NOTIFY")


class _Collector(asyncio.DatagramProtocol):
    def __init__(self) -> None:
        self.senders: list[str] = []

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        if parse_ssdp_reply(data) and addr[0] not in self.senders:
            self.senders.append(addr[0])


async def ssdp_search(
    kind: TvKindName, interface: str, wait: float = SSDP_WAIT_SECONDS
) -> list[str]:
    """Uma consulta SSDP multicast pela placa `interface`; devolve quem respondeu (endereços).

    Quem manda a resposta é o próprio aparelho, então o endereço de origem do datagrama é o dele.
    """
    request = (
        "M-SEARCH * HTTP/1.1\r\n"
        f"HOST: {SSDP_GROUP[0]}:{SSDP_GROUP[1]}\r\n"
        'MAN: "ssdp:discover"\r\n'
        "MX: 2\r\n"
        f"ST: {SSDP_TARGETS[kind]}\r\n\r\n"
    ).encode("ascii")
    loop = asyncio.get_running_loop()
    collector = _Collector()
    try:
        transport, _ = await loop.create_datagram_endpoint(
            lambda: collector, local_addr=(interface, 0), family=socket.AF_INET
        )
    except OSError:
        return []
    try:
        sock = transport.get_extra_info("socket")
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interface))
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        transport.sendto(request, SSDP_GROUP)
        await asyncio.sleep(wait)
    except OSError:
        return collector.senders
    finally:
        transport.close()
    return collector.senders


async def identify_samsung(host: str, fetch_json: FetchJson | None = None) -> TvIdentity | None:
    """Pergunta ao REST da Samsung quem ela é (`duid` e MAC Wi-Fi); `None` se não responde."""
    fetch = fetch_json or http_json
    return samsung_identity(await fetch(f"http://{host}:{SAMSUNG_REST_PORT}/api/v2/"))


async def identify_android(host: str) -> TvIdentity | None:
    """Android TV não conta o MAC no protocolo: vale a porta do controle aberta mais o ARP."""
    if not await tcp_open(host, ANDROID_REMOTE_PORT, wait=PROBE_TIMEOUT_SECONDS):
        return None
    mac = await arp_mac(host)
    return TvIdentity((mac,), mac) if mac else None


async def identify_tv(kind: TvKindName, host: str) -> TvIdentity | None:
    """Quem é a TV neste endereço (o `duid` e o MAC), conforme o tipo dela."""
    return await (identify_samsung(host) if kind == "samsung" else identify_android(host))


def build_liveness(kind: TvKindName, host: str) -> Callable[[], Awaitable[bool]]:
    """Teste de vida barato antes do WebSocket: uma conexão TCP curta (8001 e 8002 na Samsung,
    6466 na Android TV). Só abre a sessão completa se alguém atende."""
    ports = (SAMSUNG_REST_PORT, SAMSUNG_WS_PORT) if kind == "samsung" else (ANDROID_REMOTE_PORT,)

    async def alive() -> bool:
        for port in ports:
            if await tcp_open(host, port, wait=PROBE_TIMEOUT_SECONDS):
                return True
        return False

    return alive


def build_locator(
    kind: TvKindName,
    tv_host: str,
    known: TvKnown,
    clock: Clock,
    *,
    authenticate: Authenticate | None = None,
) -> TvLocator:
    """O `TvLocator` ligado à rede real, preso ao /24 da TV (o do `tv_host`)."""
    port = SAMSUNG_REST_PORT if kind == "samsung" else ANDROID_REMOTE_PORT

    def interface() -> str | None:
        return local_address_for(tv_host) or local_ipv4()

    async def ssdp() -> list[str]:
        address = interface()
        return await ssdp_search(kind, address) if address else []

    async def identify(host: str) -> TvIdentity | None:
        return await identify_tv(kind, host)

    async def probe(host: str) -> bool:
        return await tcp_open(host, port, wait=PROBE_TIMEOUT_SECONDS)

    def hosts() -> list[str]:
        # O /24 da TV; se o `tv_host` é um nome (e não um IP), o da placa que leva à rede.
        try:
            base = str(ipaddress.IPv4Address(tv_host))
        except ValueError:
            base = local_ipv4() or ""
        return subnet_hosts(base, exclude=interface()) if base else []

    return TvLocator(
        clock,
        known,
        arp_table=arp_table,
        ssdp=ssdp,
        hosts=hosts,
        probe=probe,
        identify=identify,
        authenticate=authenticate if kind == "android" else None,
    )
