"""Rede do reencontro da TV: tabela ARP, SSDP e confirmação pelo REST ou sessão pareada.

Cada função aqui fala com a rede de verdade e é injetada no `TvLocator` (o núcleo). Os endereços
e os identificadores nunca vão para o registro.

O SSDP e o Wake-on-LAN precisam sair pela placa certa: com Wi-Fi, cabo sem rede e adaptadores
virtuais, o multicast segue a rota padrão, que pode não ser a da TV. Por isso o socket é preso ao
endereço desta máquina **na rede da TV** (`local_address_for`).

A varredura cobre as redes de cada placa real deste PC (até um /24 por placa) e a do endereço
velho da TV: com a TV no ponto de acesso do celular, ela está numa faixa que o endereço velho
não diz.
"""

import asyncio
import ipaddress
import logging
import socket
from collections.abc import Awaitable, Callable

from uniover_agent.adapters.arp import arp_mac, arp_table
from uniover_agent.adapters.local_networks import (
    LocalInterface,
    local_interfaces,
    network_signature,
    sweep_networks,
)
from uniover_agent.adapters.tv_discovery import (
    ANDROID_REMOTE_PORT,
    REFUSAL_WAIT_SECONDS,
    SAMSUNG_REST_PORT,
    FetchJson,
    PortState,
    TvKindName,
    discover_android_tvs,
    http_json,
    local_address_for,
    local_ipv4,
    samsung_identity,
    subnet_hosts,
    tcp_open,
    tcp_probe,
)
from uniover_agent.core.tv.locator import (
    DEFAULT_EMPTY_SEARCHES_LIMIT,
    DEFAULT_SLOW_SEARCH_SECONDS,
    Authenticate,
    TvIdentity,
    TvKnown,
    TvLocator,
)
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
# O SSDP sai por no máximo tantas placas (cada consulta espera `SSDP_WAIT_SECONDS`, em paralelo).
MAX_SSDP_INTERFACES = 3
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


def build_locator(  # noqa: PLR0913 - tipo, endereço, identidade, relógio e os limites
    kind: TvKindName,
    tv_host: str,
    known: TvKnown,
    clock: Clock,
    *,
    authenticate: Authenticate | None = None,
    empty_searches_limit: int = DEFAULT_EMPTY_SEARCHES_LIMIT,
    slow_search_seconds: float = DEFAULT_SLOW_SEARCH_SECONDS,
) -> TvLocator:
    """O `TvLocator` ligado à rede real: as redes das placas do PC e o /24 do `tv_host`."""
    port = SAMSUNG_REST_PORT if kind == "samsung" else ANDROID_REMOTE_PORT

    def interface() -> str | None:
        return local_address_for(tv_host) or local_ipv4()

    def ssdp_interfaces() -> list[str]:
        # Além da placa que leva ao endereço velho, a de cada rede onde o PC está agora (a TV pode
        # ter mudado de faixa junto com ele).
        addresses: list[str] = []
        first = interface()
        if first:
            addresses.append(first)
        for item in local_interfaces() or []:
            if item.address not in addresses:
                addresses.append(item.address)
        return addresses[:MAX_SSDP_INTERFACES]

    async def ssdp() -> list[str]:
        addresses = await asyncio.to_thread(ssdp_interfaces)
        # Uma placa que falha não descarta as respostas das outras.
        replies = await asyncio.gather(
            *(ssdp_search(kind, address) for address in addresses), return_exceptions=True
        )
        found = [host for reply in replies if isinstance(reply, list) for host in reply]
        return list(dict.fromkeys(found))

    async def answers(host: str) -> bool:
        # Recusar a conexão também é resposta: a TV está no endereço, só o serviço caiu.
        state = await tcp_probe(host, port, wait=REFUSAL_WAIT_SECONDS)
        return state is not PortState.SILENT

    async def mdns() -> list[str]:
        return [tv.host for tv in await discover_android_tvs()]

    async def identify(host: str) -> TvIdentity | None:
        return await identify_tv(kind, host)

    async def probe(host: str) -> bool:
        return await tcp_open(host, port, wait=PROBE_TIMEOUT_SECONDS)

    def hosts() -> list[str]:
        # A rede de cada placa real do PC (até um /24 cada) e, por último, o /24 da TV; se o
        # `tv_host` é um nome (e não um IP), vale o da placa que leva à rede.
        try:
            base: str | None = str(ipaddress.IPv4Address(tv_host))
        except ValueError:
            base = None
        read = local_interfaces()  # `None`: a leitura falhou (o /24 velho entra como antes)
        interfaces = read or []
        if base is None and not interfaces:
            fallback = local_ipv4()
            interfaces = [LocalInterface(fallback)] if fallback else []
        mine = {item.address for item in interfaces}
        own = interface()
        if own:
            mine.add(own)
        found: dict[str, None] = {}
        for network in sweep_networks(
            base, None if read is None and not interfaces else interfaces
        ):
            for host in subnet_hosts(
                str(network.ip), exclude=own, prefix=network.network.prefixlen
            ):
                if host not in mine:
                    found.setdefault(host)
        return list(found)

    return TvLocator(
        clock,
        known,
        arp_table=arp_table,
        ssdp=ssdp,
        hosts=hosts,
        probe=probe,
        identify=identify,
        authenticate=authenticate if kind == "android" else None,
        mdns=mdns if kind == "android" else None,
        answers=answers,
        network_key=network_signature,
        empty_searches_limit=empty_searches_limit,
        slow_search_seconds=slow_search_seconds,
    )
