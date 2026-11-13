"""Por que o agente não alcança a API: sem internet em casa, API fora do ar ou PC sem rede nenhuma.

Só usa o que o agente já tem, sem tráfego extra: o tipo da falha ao abrir o canal com a API (a
tentativa que o laço de reconexão já faz) e a lista de placas de rede do Windows (leitura local).
É conservador de propósito: na dúvida não diz nada, e o texto genérico de "sem conexão" vale.

- "Sem internet" só com a mesma falha de rede repetida (várias tentativas seguidas, ao longo de um
  minuto) e sem proxy nem VPN no caminho: DNS do roteador, split-DNS, proxy ou rota corporativa
  quebrados também falham a resolução, e não são a internet de casa.
- "PC sem rede" só quando nenhuma placa ligada tem endereço utilizável (IPv4 ou IPv6, privado,
  público ou de operadora). Placa virtual ou que não se sabe classificar deixa a resposta em aberto.
"""

import errno
import ipaddress
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Final, Literal

# Como a abertura do canal falhou:
# - `dns`: o nome da API não resolveu;
# - `unreachable`: o Windows não tem rota para fora (rede/destino inalcançável);
# - `server`: alguém respondeu, mas não como a API (HTTP 5xx, resposta inválida): a API está fora;
# - `other`: tempo esgotado, conexão recusada ou derrubada: ambíguo, não classifica.
OpenFailure = Literal["dns", "unreachable", "server", "other"]
NetProblem = Literal["no_internet", "api_down", "no_network"]
NET_PROBLEMS: Final[frozenset[str]] = frozenset({"no_internet", "api_down", "no_network"})

# Evidência mínima para afirmar "sem internet": tentativas seguidas com a mesma falha de rede e o
# tempo entre a primeira e a última.
NO_INTERNET_MIN_FAILURES: Final = 3
NO_INTERNET_MIN_SECONDS: Final = 60.0

# Rede/destino inalcançável (POSIX e os códigos do Winsock: WSAENETUNREACH, WSAEHOSTUNREACH).
_UNREACHABLE_ERRNOS: Final = frozenset({errno.ENETUNREACH, errno.EHOSTUNREACH, 10051, 10065})

# Tipos de placa do Windows (IANA ifType).
_IF_ETHERNET: Final = 6
_IF_PPP: Final = 23
_IF_LOOPBACK: Final = 24
_IF_PROP_VIRTUAL: Final = 53
_IF_WIFI: Final = 71
_IF_TUNNEL: Final = 131
_IF_MOBILE: Final = frozenset({243, 244})
# Placas que levam a uma rede de verdade (cabo, Wi-Fi, banda larga móvel, PPP/discado).
_PHYSICAL_TYPES: Final = frozenset({_IF_ETHERNET, _IF_WIFI, _IF_PPP, *_IF_MOBILE})
# Pedaços do nome de uma VPN (o tráfego para a API pode passar por ela): comparados em minúsculas.
_VPN_MARKERS: Final = (
    "vpn",
    "wireguard",
    "wintun",
    "tap-windows",
    "tap-",
    "openvpn",
    "nordlynx",
    "tailscale",
    "zerotier",
    "hamachi",
    "anyconnect",
    "fortinet",
    "globalprotect",
    "pangp",
    "juniper",
    "pulse secure",
    "zscaler",
    "cloudflare warp",
)
# Placas virtuais que não são VPN (máquinas virtuais, WSL, Docker, túneis de transição do IPv6).
_VIRTUAL_MARKERS: Final = (
    "hyper-v",
    "vethernet",
    "wsl",
    "virtualbox",
    "vmware",
    "vmnet",
    "virtual",
    "docker",
    "npcap",
    "loopback",
    "bluetooth",
    "pseudo",
    "teredo",
    "isatap",
    "6to4",
    "ip-https",
)


def failure_of_errno(code: int | None) -> OpenFailure:
    """Um `OSError` comum (não de resolução de nome) pelo código de erro."""
    return "unreachable" if code in _UNREACHABLE_ERRNOS else "other"


@dataclass(frozen=True, slots=True)
class AdapterFacts:
    """O que se lê de uma placa: tipo, se está ligada, nome e endereços (IPv4 e IPv6)."""

    if_type: int
    up: bool
    description: str = ""
    friendly_name: str = ""
    addresses: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class NetworkPresence:
    """`up`: há placa real ligada com endereço utilizável (`None` quando não se sabe dizer).
    `detour`: há proxy ou VPN no caminho (então uma falha de nome não prova nada)."""

    up: bool | None
    detour: bool = False


UNKNOWN_PRESENCE: Final = NetworkPresence(None)


def _usable(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    return not (ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast)


def _kind(adapter: AdapterFacts) -> Literal["real", "vpn", "virtual"]:
    text = f"{adapter.description} {adapter.friendly_name}".lower()
    if any(marker in text for marker in _VPN_MARKERS):
        return "vpn"
    if any(marker in text for marker in _VIRTUAL_MARKERS):
        return "virtual"
    if adapter.if_type == _IF_PPP:
        # As VPNs do próprio Windows (PPTP, L2TP, SSTP, IKEv2) aparecem como PPP: é rede, mas o
        # caminho até a API pode ser outro.
        return "vpn"
    if adapter.if_type in {_IF_TUNNEL, _IF_PROP_VIRTUAL}:
        return "vpn"
    if adapter.if_type in _PHYSICAL_TYPES:
        return "real"
    return "virtual"  # tipo que não se sabe classificar: não conta como rede de verdade


def network_presence(adapters: Iterable[AdapterFacts], proxy: bool) -> NetworkPresence:
    """Se o PC está em alguma rede, a partir da lista de placas (pura, testável sem Windows).

    Real com endereço: há rede. Só virtual/VPN com endereço: não se sabe. Nenhuma placa ligada
    com endereço utilizável: o PC está sem rede."""
    real = vpn = virtual = False
    for adapter in adapters:
        if not adapter.up or adapter.if_type == _IF_LOOPBACK:
            continue
        if not any(_usable(address) for address in adapter.addresses):
            continue
        kind = _kind(adapter)
        real = real or kind == "real" or (kind == "vpn" and adapter.if_type == _IF_PPP)
        vpn = vpn or kind == "vpn"
        virtual = virtual or kind == "virtual"
    up: bool | None = True if real else (None if (vpn or virtual) else False)
    return NetworkPresence(up, detour=proxy or vpn)


@dataclass(frozen=True, slots=True)
class FailureStreak:
    """Tentativas seguidas que falharam do mesmo jeito e há quanto tempo isso começou."""

    failure: OpenFailure
    count: int = 1
    seconds: float = 0.0


def classify(streak: FailureStreak | None, presence: NetworkPresence) -> NetProblem | None:
    """O problema de rede a mostrar, ou `None` quando não dá para afirmar nada."""
    if streak is None:
        return None
    if streak.failure == "server":
        # A API respondeu errado: há rede e internet, quem está fora é ela.
        return "api_down"
    if presence.up is False:
        return "no_network"
    if presence.up is None or presence.detour:
        return None
    if (
        streak.failure in {"dns", "unreachable"}
        and streak.count >= NO_INTERNET_MIN_FAILURES
        and streak.seconds >= NO_INTERNET_MIN_SECONDS
    ):
        return "no_internet"
    return None
