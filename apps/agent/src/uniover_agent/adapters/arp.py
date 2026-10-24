"""Tabela ARP do Windows lida pela API do sistema (`GetIpNetTable`), sem abrir processo.

Fora do Windows (desenvolvimento) cai no `arp -an`, também sem janela. Só leitura: nada vai à rede.
"""

import asyncio
import ipaddress
import re
import socket
import struct
import sys

from uniover_agent.adapters.process import exec_hidden
from uniover_agent.core.tv.locator import normalize_mac

ARP_TIMEOUT_SECONDS = 3.0
_IPV4 = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
_MAC = re.compile(r"(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f])")
_IGNORED_PREFIXES = ("FF:FF:FF", "01:00:5E", "33:33")

# MIB_IPNETROW: índice, tamanho do MAC, MAC (8 bytes), IPv4, tipo; tudo de 4 bytes menos o MAC.
_ROW = struct.Struct("<II8s4sI")
_TYPE_INVALID = 2
_ETHERNET_MAC_LENGTH = 6
_ERROR_INSUFFICIENT_BUFFER = 122


def _usable(mac: str) -> bool:
    return not mac.startswith(_IGNORED_PREFIXES) and mac != "00:00:00:00:00:00"


def _add(table: dict[str, list[str]], mac: str, host: str) -> None:
    hosts = table.setdefault(mac, [])
    if host not in hosts:
        hosts.append(host)


def parse_arp_table(text: str) -> dict[str, list[str]]:
    """MAC (maiúsculo, com dois-pontos) -> endereços, a partir da saída de `arp -a`.

    Serve ao formato do Windows (`192.168.0.14  74-6d-fa-5d-52-08  dinâmico`) e ao de Linux e
    macOS (`? (192.168.0.14) at 74:6d:fa:5d:52:08`): em cada linha, o primeiro IPv4 e o primeiro
    MAC. Difusão e multicast não identificam aparelho nenhum.
    """
    table: dict[str, list[str]] = {}
    for line in text.splitlines():
        ip_match, mac_match = _IPV4.search(line), _MAC.search(line)
        if ip_match is None or mac_match is None:
            continue
        mac = normalize_mac(mac_match.group())
        try:
            ipaddress.IPv4Address(ip_match.group())
        except ValueError:
            continue
        if _usable(mac):
            _add(table, mac, ip_match.group())
    return table


def parse_ip_net_table(raw: bytes) -> dict[str, list[str]]:
    """Decodifica o `MIB_IPNETTABLE` que o `GetIpNetTable` devolve (contagem e linhas)."""
    table: dict[str, list[str]] = {}
    if len(raw) < 4:  # noqa: PLR2004 - o cabeçalho é a contagem de 4 bytes
        return table
    (count,) = struct.unpack_from("<I", raw, 0)
    for number in range(count):
        offset = 4 + number * _ROW.size
        if offset + _ROW.size > len(raw):
            break
        _, length, physical, address, kind = _ROW.unpack_from(raw, offset)
        if length != _ETHERNET_MAC_LENGTH or kind == _TYPE_INVALID:
            continue
        mac = normalize_mac(physical[:_ETHERNET_MAC_LENGTH].hex(":"))
        if _usable(mac):
            _add(table, mac, socket.inet_ntoa(address))
    return table


def _read_windows() -> dict[str, list[str]]:
    import ctypes  # noqa: PLC0415 - a DLL só existe no Windows

    iphlpapi = ctypes.WinDLL("iphlpapi")  # type: ignore[attr-defined,unused-ignore]
    size = ctypes.c_ulong(0)
    if iphlpapi.GetIpNetTable(None, ctypes.byref(size), False) != _ERROR_INSUFFICIENT_BUFFER:
        return {}
    buffer = ctypes.create_string_buffer(size.value)
    if iphlpapi.GetIpNetTable(buffer, ctypes.byref(size), False) != 0:
        return {}
    return parse_ip_net_table(buffer.raw[: size.value])


async def _read_with_arp_program() -> dict[str, list[str]]:
    try:
        process = await exec_hidden(
            "arp", "-an", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        output, _ = await asyncio.wait_for(process.communicate(), ARP_TIMEOUT_SECONDS)
    except OSError, TimeoutError:
        return {}
    return parse_arp_table(output.decode("ascii", errors="ignore"))


async def arp_table() -> dict[str, list[str]]:
    """A tabela ARP inteira (uma leitura; não manda nada à rede)."""
    if sys.platform == "win32":
        try:
            return await asyncio.to_thread(_read_windows)
        except OSError, AttributeError:
            return {}
    return await _read_with_arp_program()


async def arp_mac(host: str) -> str | None:
    """MAC do endereço pela tabela ARP (o `connect` da varredura acabou de populá-la)."""
    for mac, hosts in (await arp_table()).items():
        if host in hosts:
            return mac
    return None
