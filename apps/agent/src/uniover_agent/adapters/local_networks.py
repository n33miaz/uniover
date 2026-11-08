"""As redes onde este PC está agora, para reencontrar a TV quando ele (e a TV) mudam de rede.

Quando o roteador de casa cai e o PC e a TV passam para o ponto de acesso do celular (mesmo nome e
senha), a TV ganha endereço de **outra faixa** (por exemplo 172.20.10.x). Varrer só o /24 do
endereço velho da TV nunca a acharia: a procura tem de cobrir a faixa de cada placa **de verdade**
deste PC. Aqui só se lê a lista de placas do Windows (nada sai pela rede):

- ficam de fora o loopback, o link-local (169.254, placa sem rede), as placas desligadas, as
  virtuais (Hyper-V, WSL, VMware, VirtualBox, VPN, Docker...), as de banda larga móvel e as
  de túnel/PPP, e os endereços que não são de rede privada (RFC 1918): nada disso leva a uma
  TV de casa;
- cada rede vale no máximo um /24 (o ponto de acesso do iPhone é um /28: varre-se só ele), e
  poucas redes entram na varredura.
"""

import asyncio
import ipaddress
import logging
import socket
import sys
from collections.abc import Iterable
from dataclasses import dataclass

from uniover_agent.adapters.tv_discovery import local_ipv4

_log = logging.getLogger(__name__)

# Uma varredura nunca passa disto: as redes das placas (a da rota padrão primeiro) e, por último,
# a do endereço antigo da TV.
MAX_SWEEP_NETWORKS = 4
# Nunca se varre além de um /24 por placa; redes menores (o /28 do iPhone) são varridas inteiras.
MIN_SWEEP_PREFIX = 24
MAX_SWEEP_PREFIX = 30

_IF_ETHERNET = 6
_IF_WIFI = 71
# Só Ethernet e Wi-Fi: banda larga móvel (243/244), PPP (23) e túnel (131) nunca levam a uma TV.
_REAL_ADAPTER_TYPES = frozenset({_IF_ETHERNET, _IF_WIFI})
_PRIVATE_NETWORKS = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
)
_OPER_STATUS_UP = 1

# Pedaços do nome/descrição de placas que não levam a uma TV (comparados em minúsculas).
_VIRTUAL_MARKERS = (
    "hyper-v",
    "vethernet",
    "wsl",
    "virtualbox",
    "vmware",
    "vmnet",
    "virtual",
    "tap-windows",
    "tap-",
    "wintun",
    "wireguard",
    "nordlynx",
    "openvpn",
    "vpn",
    "tailscale",
    "zerotier",
    "hamachi",
    "docker",
    "npcap",
    "loopback",
    "bluetooth",
    "pseudo",
    "teredo",
    "isatap",
    "6to4",
    "anyconnect",
    "fortinet",
)


@dataclass(frozen=True, slots=True)
class LocalInterface:
    """Um endereço IPv4 de uma placa real deste PC e o tamanho da rede dele."""

    address: str
    prefix: int = 24


@dataclass(frozen=True, slots=True)
class AdapterRow:
    """Uma linha crua da lista de placas, antes do filtro (separado para testar sem Windows)."""

    address: str
    prefix: int
    description: str
    friendly_name: str
    if_type: int
    up: bool


def is_virtual_adapter(description: str, friendly_name: str = "") -> bool:
    text = f"{description} {friendly_name}".lower()
    return any(marker in text for marker in _VIRTUAL_MARKERS)


def usable_interfaces(rows: Iterable[AdapterRow]) -> list[LocalInterface]:
    """Só as placas reais, ligadas e com endereço de rede de verdade (sem duplicar)."""
    found: list[LocalInterface] = []
    for row in rows:
        if not row.up or row.if_type not in _REAL_ADAPTER_TYPES:
            continue
        if is_virtual_adapter(row.description, row.friendly_name):
            continue
        try:
            address = ipaddress.IPv4Address(row.address)
        except ValueError:
            continue
        if address.is_loopback or address.is_link_local or address.is_unspecified:
            continue
        if address.is_multicast or address.is_reserved:
            continue
        if not any(address in network for network in _PRIVATE_NETWORKS):
            continue  # CGNAT (100.64/10), IP público: rede de operadora, não a de casa
        interface = LocalInterface(row.address, row.prefix)
        if interface not in found:
            found.append(interface)
    return found


def _read_adapters() -> list[AdapterRow] | None:
    """`GetAdaptersAddresses` do Windows: placas, estado, tipo e endereços IPv4 com o prefixo.

    `None` quando a leitura falha (lista vazia é uma leitura que deu certo e não achou nada)."""
    import ctypes  # noqa: PLC0415 - a DLL só existe no Windows
    from ctypes import wintypes  # noqa: PLC0415

    class SocketAddress(ctypes.Structure):
        _fields_ = (("sockaddr", ctypes.c_void_p), ("length", ctypes.c_int))

    class Unicast(ctypes.Structure):
        pass

    Unicast._fields_ = (
        ("length", wintypes.ULONG),
        ("flags", wintypes.DWORD),
        ("next", ctypes.POINTER(Unicast)),
        ("address", SocketAddress),
        ("prefix_origin", ctypes.c_int),
        ("suffix_origin", ctypes.c_int),
        ("dad_state", ctypes.c_int),
        ("valid_lifetime", wintypes.ULONG),
        ("preferred_lifetime", wintypes.ULONG),
        ("lease_lifetime", wintypes.ULONG),
        ("on_link_prefix_length", ctypes.c_ubyte),
    )

    class Adapter(ctypes.Structure):
        pass

    Adapter._fields_ = (
        ("length", wintypes.ULONG),
        ("if_index", wintypes.DWORD),
        ("next", ctypes.POINTER(Adapter)),
        ("adapter_name", ctypes.c_char_p),
        ("first_unicast", ctypes.POINTER(Unicast)),
        ("first_anycast", ctypes.c_void_p),
        ("first_multicast", ctypes.c_void_p),
        ("first_dns_server", ctypes.c_void_p),
        ("dns_suffix", ctypes.c_wchar_p),
        ("description", ctypes.c_wchar_p),
        ("friendly_name", ctypes.c_wchar_p),
        ("physical_address", ctypes.c_ubyte * 8),
        ("physical_address_length", wintypes.ULONG),
        ("flags", wintypes.ULONG),
        ("mtu", wintypes.ULONG),
        ("if_type", wintypes.DWORD),
        ("oper_status", ctypes.c_int),
    )

    iphlpapi = ctypes.WinDLL("iphlpapi")  # type: ignore[attr-defined,unused-ignore]
    skip_anycast_multicast_dns = 2 | 4 | 8
    buffer_overflow = 111
    size = ctypes.c_ulong(16384)
    buffer = ctypes.create_string_buffer(size.value)
    for _ in range(3):
        result = iphlpapi.GetAdaptersAddresses(
            socket.AF_INET, skip_anycast_multicast_dns, None, buffer, ctypes.byref(size)
        )
        if result != buffer_overflow:
            break
        buffer = ctypes.create_string_buffer(size.value)
    if result != 0:
        return None
    rows: list[AdapterRow] = []
    adapter = ctypes.cast(buffer, ctypes.POINTER(Adapter))
    while adapter:
        item = adapter.contents
        unicast = item.first_unicast
        while unicast:
            entry = unicast.contents
            sockaddr = entry.address.sockaddr
            if sockaddr and entry.address.length >= 8:  # noqa: PLR2004 - família, porta e IPv4
                raw = ctypes.string_at(sockaddr, 8)
                rows.append(
                    AdapterRow(
                        socket.inet_ntoa(raw[4:8]),
                        int(entry.on_link_prefix_length),
                        item.description or "",
                        item.friendly_name or "",
                        int(item.if_type),
                        item.oper_status == _OPER_STATUS_UP,
                    )
                )
            unicast = entry.next
        adapter = item.next
    return rows


def local_interfaces() -> list[LocalInterface] | None:
    """As placas reais e ligadas deste PC com endereço IPv4 (a da rota padrão primeiro).

    `None` quando **a leitura falhou** (não se sabe onde o PC está); lista vazia quando a leitura
    deu certo e os filtros descartaram tudo (o PC não está em rede nenhuma que valha).
    Fora do Windows (ou se a leitura das placas falhar) cai na lista de endereços do nome da
    máquina, com /24.
    """
    rows: list[AdapterRow] | None = None
    if sys.platform == "win32":
        try:
            rows = _read_adapters()
        except OSError, AttributeError, ValueError:
            _log.debug("não consegui listar as placas de rede", exc_info=True)
    if rows is None:
        try:
            listed = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        except OSError:
            return None
        rows = [AdapterRow(str(entry[4][0]), 24, "", "", _IF_ETHERNET, True) for entry in listed]
    interfaces = usable_interfaces(rows)
    default = local_ipv4()
    interfaces.sort(key=lambda interface: interface.address != default)
    return interfaces


def _networks_now() -> frozenset[str]:
    return frozenset(
        str(ipaddress.IPv4Interface(f"{item.address}/{item.prefix}").network)
        for item in local_interfaces() or []  # leitura falha: sem rede, o vigia ignora
    )


async def network_signature() -> frozenset[str]:
    """As redes onde o PC está (e não os endereços: o DHCP renovar o endereço não é trocar de rede).

    Só lê a lista de placas do sistema (numa thread, fora do laço de eventos); nada sai pela rede.
    """
    return await asyncio.to_thread(_networks_now)


def _clamped(interface: ipaddress.IPv4Interface) -> ipaddress.IPv4Interface:
    prefix = max(MIN_SWEEP_PREFIX, min(interface.network.prefixlen, MAX_SWEEP_PREFIX))
    return ipaddress.IPv4Interface(f"{interface.ip}/{prefix}")


def sweep_networks(
    old_host: str | None,
    interfaces: Iterable[LocalInterface] | None,
    limit: int = MAX_SWEEP_NETWORKS,
) -> list[ipaddress.IPv4Interface]:
    """As redes a varrer: a de cada placa (no máximo /24 cada) e, por último, a do endereço velho.

    Sem repetir rede e com no máximo `limit` redes. O /24 do endereço velho só entra se alguma
    placa do PC está numa rede que o contém; senão os pacotes sairiam pela rota padrão (o roteador
    de casa caiu), à toa. Só quando a leitura das placas **falhou** (`None`) ele entra como antes;
    lista vazia (os filtros descartaram tudo) não varre rede nenhuma.
    """
    chosen: list[ipaddress.IPv4Interface] = []
    seen: set[ipaddress.IPv4Network] = set()
    listed = list(interfaces or [])
    real = [ipaddress.IPv4Interface(f"{item.address}/{item.prefix}") for item in listed]
    candidates = [_clamped(item) for item in real]
    if old_host:
        try:
            old = ipaddress.IPv4Interface(f"{old_host}/{MIN_SWEEP_PREFIX}")
        except ValueError:
            _log.debug("o endereço velho da TV não é um IP; só as placas contam")
        else:
            if interfaces is None or any(old.ip in item.network for item in real):
                candidates.append(old)
    for candidate in candidates:
        if candidate.network in seen:
            continue
        seen.add(candidate.network)
        chosen.append(candidate)
        if len(chosen) >= limit:
            break
    return chosen


def same_network(first: str, second: str, prefix: int = MIN_SWEEP_PREFIX) -> bool | None:
    """Os dois endereços estão no mesmo /24? `None` quando algum não é um IP."""
    try:
        network = ipaddress.IPv4Network(f"{first}/{prefix}", strict=False)
        return ipaddress.IPv4Address(second) in network
    except ValueError:
        return None
