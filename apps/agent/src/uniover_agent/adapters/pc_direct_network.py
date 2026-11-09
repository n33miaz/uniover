"""Que endereços o canal direto aceita e oferece: só os da rede local.

O canal direto existe para o celular e o PC na MESMA rede. Nada de endereço público de nenhum lado:
- das ofertas, só entram candidatos de endereço privado, de enlace local ou ULA (um candidato
  público ou um nome qualquer faria o agente mandar pacotes a onde o app mandar);
- dos candidatos que o agente mesmo junta (e vão na resposta), só os de interfaces físicas com
  IPv4 privado ou IPv6 ULA: nada de IPv6 global (endereço público), VPN, WSL, Hyper-V, Docker,
  máquinas virtuais, túneis. Sem isto o agente da resposta mostraria o endereço público do PC.
"""

import ipaddress
import re
from typing import Final

import ifaddr

# Interfaces que nunca servem a um celular na rede de casa: VPN, túnel, loopback, Bluetooth.
_NEVER: Final = re.compile(
    r"vpn|tailscale|zerotier|wireguard|nordlynx|openvpn|hamachi|\btap\b|tap-|\btun\b|tunnel|teredo|"
    r"isatap|6to4|loopback|pseudo|bluetooth",
    re.IGNORECASE,
)
# Interfaces virtuais de máquina e contêiner: fora, A NÃO SER que sejam a única saída. Um PC com um
# comutador externo do Hyper-V tem o IP da rede de casa num "vEthernet"; sem ele nada se ofereceria
# (o app ficaria na nuvem e o diagnóstico apontaria a causa errada).
_VIRTUAL: Final = re.compile(
    r"vethernet|hyper-v|wsl|docker|virtualbox|vbox|vmware|npcap", re.IGNORECASE
)
_ULA: Final = ipaddress.ip_network("fc00::/7")
# Em testes de loopback (o celular de mentira é o mesmo processo) o endereço 127.0.0.1 é aceito.
ALLOW_LOOPBACK = False


def is_lan_address(text: str) -> bool:
    """O endereço é privado, de enlace local ou ULA (e não nome, nem endereço público)?"""
    try:
        address = ipaddress.ip_address(text.split("%", 1)[0])
    except ValueError:
        return False
    if address.is_loopback:
        return ALLOW_LOOPBACK
    if address.is_unspecified or address.is_multicast:
        return False
    return address.is_private


def filter_offer_candidates(lines: list[str]) -> list[str]:
    """As linhas da oferta sem os candidatos que o agente não aceita (ver o texto do módulo).

    Fica só candidato UDP de endereço da rede local. Qualquer outra linha passa como está.
    """
    kept: list[str] = []
    for line in lines:
        if not line.startswith("a=candidate"):
            kept.append(line)
            continue
        parts = line.split()
        # a=candidate:<fundação> <componente> <transporte> <prioridade> <endereço> <porta> typ ...
        if len(parts) >= 8 and parts[2].lower() == "udp" and is_lan_address(parts[4]):  # noqa: PLR2004
            kept.append(line)
    return kept


def lan_host_addresses(use_ipv4: bool, use_ipv6: bool) -> list[str]:
    """Os endereços locais que o agente oferece: IPv4 privado e IPv6 ULA de interfaces físicas.

    No lugar do `get_host_addresses` do `aioice`, que oferece todos (inclusive o IPv6 global, que é
    o endereço público do PC, e as interfaces de VPN, WSL e Hyper-V). As interfaces virtuais de
    máquina e contêiner só entram se nenhuma interface física tem endereço da rede local.
    """
    physical: list[str] = []
    virtual: list[str] = []
    for adapter in ifaddr.get_adapters():
        name = f"{adapter.nice_name} {adapter.name}"
        if _NEVER.search(name):
            continue
        target = virtual if _VIRTUAL.search(name) else physical
        for entry in adapter.ips:
            if isinstance(entry.ip, str):
                if use_ipv4 and _private_ipv4(entry.ip):
                    target.append(entry.ip)
            elif use_ipv6 and _ula_ipv6(entry.ip[0]):
                target.append(entry.ip[0])
    return physical or virtual


def _private_ipv4(text: str) -> bool:
    try:
        address = ipaddress.IPv4Address(text)
    except ValueError:
        return False
    return address.is_private and not (
        address.is_loopback or address.is_link_local or address.is_unspecified
    )


def _ula_ipv6(text: str) -> bool:
    try:
        address = ipaddress.IPv6Address(text)
    except ValueError:
        return False
    return address in _ULA
