"""Se o PC está em alguma rede e se há proxy ou VPN no caminho, sem nada sair pela rede.

Lê só a lista de placas do Windows (`GetAdaptersAddresses`, IPv4 e IPv6) e a configuração de proxy
(registro do usuário e variáveis de ambiente). A decisão fica em `core.net_status`. Fora do
Windows, ou se a leitura falhar, a resposta é "não se sabe".
"""

import ctypes
import logging
import os
import socket
import sys

from uniover_agent.core.net_status import (
    UNKNOWN_PRESENCE,
    AdapterFacts,
    NetworkPresence,
    network_presence,
)

_log = logging.getLogger(__name__)

_AF_INET = 2
_AF_INET6 = 23
_SOCKADDR_IN_SIZE = 8  # família, porta e o IPv4
_SOCKADDR_IN6_SIZE = 24  # família, porta, fluxo e o IPv6
_OPER_STATUS_UP = 1
_PROXY_VARIABLES = ("https_proxy", "http_proxy", "all_proxy")
_INTERNET_SETTINGS = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"


def _address_of(sockaddr: int, length: int) -> str | None:
    family = int.from_bytes(ctypes.string_at(sockaddr, 2), "little")
    if family == _AF_INET and length >= _SOCKADDR_IN_SIZE:
        return socket.inet_ntop(socket.AF_INET, ctypes.string_at(sockaddr + 4, 4))
    if family == _AF_INET6 and length >= _SOCKADDR_IN6_SIZE:
        return socket.inet_ntop(socket.AF_INET6, ctypes.string_at(sockaddr + 8, 16))
    return None


def _read_adapters() -> list[AdapterFacts] | None:
    """Todas as placas, de qualquer tipo, com endereços IPv4 e IPv6. `None` se a leitura falhar."""
    from ctypes import wintypes  # noqa: PLC0415 - só no Windows

    class SocketAddress(ctypes.Structure):
        _fields_ = (("sockaddr", ctypes.c_void_p), ("length", ctypes.c_int))

    class Unicast(ctypes.Structure):
        pass

    Unicast._fields_ = (
        ("length", wintypes.ULONG),
        ("flags", wintypes.DWORD),
        ("next", ctypes.POINTER(Unicast)),
        ("address", SocketAddress),
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
    size = ctypes.c_ulong(32768)
    buffer = ctypes.create_string_buffer(size.value)
    for _ in range(3):
        result = iphlpapi.GetAdaptersAddresses(
            0,
            skip_anycast_multicast_dns,
            None,
            buffer,
            ctypes.byref(size),  # 0: IPv4 e IPv6
        )
        if result != buffer_overflow:
            break
        buffer = ctypes.create_string_buffer(size.value)
    if result != 0:
        return None
    adapters: list[AdapterFacts] = []
    adapter = ctypes.cast(buffer, ctypes.POINTER(Adapter))
    while adapter:
        item = adapter.contents
        addresses: list[str] = []
        unicast = item.first_unicast
        while unicast:
            entry = unicast.contents
            if entry.address.sockaddr:
                address = _address_of(entry.address.sockaddr, entry.address.length)
                if address is not None:
                    addresses.append(address)
            unicast = entry.next
        adapters.append(
            AdapterFacts(
                int(item.if_type),
                item.oper_status == _OPER_STATUS_UP,
                item.description or "",
                item.friendly_name or "",
                tuple(addresses),
            )
        )
        adapter = item.next
    return adapters


def proxy_configured() -> bool:
    """Proxy do sistema (ligado ou por script de configuração) ou nas variáveis de ambiente."""
    if any(os.environ.get(name) or os.environ.get(name.upper()) for name in _PROXY_VARIABLES):
        return True
    return sys.platform == "win32" and _registry_proxy()


def _registry_proxy() -> bool:
    import winreg  # noqa: PLC0415 - só no Windows

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _INTERNET_SETTINGS) as key:
            values: dict[str, object] = {}
            for name in ("ProxyEnable", "AutoConfigURL"):
                try:
                    values[name] = winreg.QueryValueEx(key, name)[0]
                except OSError:
                    continue
    except OSError:
        return False
    return bool(values.get("ProxyEnable")) or bool(values.get("AutoConfigURL"))


def read_network_presence() -> NetworkPresence:
    """Nunca levanta: qualquer falha de leitura vira "não se sabe"."""
    if sys.platform != "win32":
        return UNKNOWN_PRESENCE
    try:
        adapters = _read_adapters()
        proxy = proxy_configured()
    except Exception:
        _log.debug("não consegui ler as placas de rede", exc_info=True)
        return UNKNOWN_PRESENCE
    if adapters is None:
        return UNKNOWN_PRESENCE
    return network_presence(adapters, proxy)
