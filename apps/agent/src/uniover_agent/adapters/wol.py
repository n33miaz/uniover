"""Wake-on-LAN: o "pacote mágico" que acorda uma TV em standby (se ela aceita "ligar com celular").

Seis bytes `FF` e o MAC dezesseis vezes, em UDP para a difusão da rede da TV. O socket sai pela
placa que alcança a TV (e não pela rota padrão, que com várias placas pode ser outra).
"""

import asyncio
import ipaddress
import logging
import re
import socket

from uniover_agent.adapters.tv_discovery import local_address_for, local_ipv4

_log = logging.getLogger(__name__)

WOL_PORTS = (9, 7)
_MAC = re.compile(r"^(?:[0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}$")


def magic_packet(mac: str) -> bytes:
    """O pacote mágico do MAC dado. Levanta `ValueError` se o MAC não é válido."""
    if not _MAC.fullmatch(mac.strip()):
        raise ValueError("MAC inválido")
    raw = bytes.fromhex(mac.strip().replace("-", "").replace(":", ""))
    return b"\xff" * 6 + raw * 16


def broadcast_for(address: str) -> str:
    """Difusão do /24 de `address`."""
    return str(ipaddress.ip_network(f"{address}/24", strict=False).broadcast_address)


def _new_socket() -> socket.socket:
    return socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def _send(mac: str, tv_host: str) -> None:
    payload = magic_packet(mac)
    source = local_address_for(tv_host) or local_ipv4()
    targets = [broadcast_for(source)] if source else []
    targets.append("255.255.255.255")
    with _new_socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        if source:
            sock.bind((source, 0))
        for target in dict.fromkeys(targets):
            for port in WOL_PORTS:
                sock.sendto(payload, (target, port))


async def send_wake_on_lan(mac: str, tv_host: str) -> bool:
    """Manda o pacote mágico; devolve se saiu (não há como saber se a TV acordou)."""
    try:
        await asyncio.to_thread(_send, mac, tv_host)
    except (OSError, ValueError) as exc:
        _log.warning("não consegui enviar o Wake-on-LAN (%s)", type(exc).__name__)
        return False
    return True
