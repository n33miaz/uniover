"""Descoberta de TV na rede local: Samsung (REST na porta 8001) e Android TV (porta 6466).

A varredura é uma só: a sub-rede IPv4 /24 da interface com rota padrão, em duas fases.

1. Conexão TCP curta às portas 8001 e 6466 de cada endereço, tudo ao mesmo tempo (no Windows um
   endereço ausente não recusa, só deixa estourar o tempo; por isso o limite é curto e global).
2. Só nos que abriram a 8001, `GET /api/v2/`: a Samsung responde com `device.type`
   `Samsung SmartTV` e os identificadores. Outros aparelhos que usam a 8001 não passam.

Nada aqui envia tecla nem pede pareamento. Os endereços e os identificadores nunca vão para o log.
"""

import asyncio
import ipaddress
import logging
import re
import socket
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal

import httpx

_log = logging.getLogger(__name__)

SAMSUNG_REST_PORT = 8001
ANDROID_REMOTE_PORT = 6466
# Por endereço: o bastante numa rede doméstica e curto para a varredura caber em poucos segundos.
CONNECT_TIMEOUT_SECONDS = 1.0
HTTP_TIMEOUT_SECONDS = 2.0
SCAN_DEADLINE_SECONDS = 8.0
CONCURRENCY = 128

_MAC = re.compile(r"(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f])")

TvKindName = Literal["android", "samsung"]


@dataclass(frozen=True, slots=True)
class DiscoveredTv:
    host: str
    kind: TvKindName
    # Identificadores estáveis que a TV entrega (o primeiro é o gravado como dica). Vazio: a
    # TV não revelou nenhum, e o reencontro automático não é possível para ela.
    ids: tuple[str, ...] = ()
    name: str | None = None

    @property
    def id_hint(self) -> str | None:
        return self.ids[0] if self.ids else None


# Substituíveis nos testes: nenhuma delas toca a rede real.
Connect = Callable[[str, int], Awaitable[bool]]
FetchJson = Callable[[str], Awaitable[dict[str, Any] | None]]
ArpLookup = Callable[[str], Awaitable[str | None]]


def local_ipv4() -> str | None:
    """Endereço da interface com rota padrão (o `connect` UDP só consulta a rota)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect(("192.0.2.1", 9))
            address: str = probe.getsockname()[0]
        except OSError:
            return None
    return None if address.startswith("0.") else address


def subnet_hosts(local: str) -> list[str]:
    """Os outros 253 endereços do /24 de `local`."""
    network = ipaddress.ip_network(f"{local}/24", strict=False)
    return [str(host) for host in network.hosts() if str(host) != local]


async def tcp_open(host: str, port: int, wait: float = CONNECT_TIMEOUT_SECONDS) -> bool:
    """Há alguém ouvindo nesta porta? Abre e fecha na hora."""
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), wait)
    except OSError, TimeoutError:
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return True


async def http_json(url: str) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            response = await client.get(url)
        data = response.json()
    except httpx.HTTPError, ValueError:
        return None
    return data if isinstance(data, dict) else None


def normalize_mac(raw: str) -> str:
    return raw.strip().upper().replace("-", ":")


async def arp_mac(host: str) -> str | None:
    """MAC do endereço pela tabela ARP (o `connect` da varredura acabou de populá-la)."""
    try:
        process = await asyncio.create_subprocess_exec(
            "arp",
            "-a",
            host,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        output, _ = await asyncio.wait_for(process.communicate(), 3.0)
    except OSError, TimeoutError:
        return None
    for match in _MAC.finditer(output.decode("ascii", errors="ignore")):
        mac = normalize_mac(match.group())
        # Entradas de difusão e multicast não identificam a TV.
        if mac != "FF:FF:FF:FF:FF:FF" and not mac.startswith("01:00:5E"):
            return mac
    return None


def _samsung_ids(device: dict[str, Any]) -> tuple[str, ...]:
    """Identificadores da Samsung: `duid` primeiro (estável), depois o MAC Wi-Fi."""
    found: list[str] = []
    duid = device.get("duid")
    if isinstance(duid, str) and duid:
        found.append(duid.removeprefix("uuid:"))
    mac = device.get("wifiMac")
    if isinstance(mac, str) and _MAC.fullmatch(mac.strip()):
        found.append(normalize_mac(mac))
    return tuple(found)


def _samsung_device(info: dict[str, Any] | None) -> dict[str, Any] | None:
    device = info.get("device") if info else None
    if isinstance(device, dict) and device.get("type") == "Samsung SmartTV":
        return device
    return None


async def _identify(
    host: str,
    samsung_open: bool,
    android_open: bool,
    fetch_json: FetchJson,
    lookup_mac: ArpLookup,
) -> DiscoveredTv | None:
    if samsung_open:
        device = _samsung_device(await fetch_json(f"http://{host}:{SAMSUNG_REST_PORT}/api/v2/"))
        if device is not None:
            name = device.get("name")
            return DiscoveredTv(
                host,
                "samsung",
                _samsung_ids(device),
                name if isinstance(name, str) and name else None,
            )
    if android_open:
        mac = await lookup_mac(host)
        return DiscoveredTv(host, "android", (mac,) if mac else ())
    return None


async def scan_hosts(  # noqa: PLR0913 - injeções dos testes, todas só por nome
    hosts: Iterable[str],
    *,
    connect: Connect = tcp_open,
    fetch_json: FetchJson = http_json,
    lookup_mac: ArpLookup = arp_mac,
    concurrency: int = CONCURRENCY,
    deadline: float = SCAN_DEADLINE_SECONDS,
) -> list[DiscoveredTv]:
    """TVs encontradas nos endereços dados, ordenadas por endereço. Estourar o prazo devolve o
    que já foi achado: a varredura nunca trava o instalador."""
    limit = asyncio.Semaphore(concurrency)
    found: list[DiscoveredTv] = []

    async def inspect(host: str) -> None:
        async with limit:
            samsung_open, android_open = await asyncio.gather(
                connect(host, SAMSUNG_REST_PORT), connect(host, ANDROID_REMOTE_PORT)
            )
        if not (samsung_open or android_open):
            return
        tv = await _identify(host, samsung_open, android_open, fetch_json, lookup_mac)
        if tv is not None:
            found.append(tv)

    tasks = [asyncio.create_task(inspect(host)) for host in hosts]
    if tasks:
        _, pending = await asyncio.wait(tasks, timeout=deadline)
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return sorted(found, key=lambda tv: ipaddress.ip_address(tv.host))


async def find_tvs(
    kind: TvKindName | None = None,
    *,
    local: str | None = None,
    connect: Connect = tcp_open,
    fetch_json: FetchJson = http_json,
    lookup_mac: ArpLookup = arp_mac,
) -> list[DiscoveredTv]:
    """Varre a rede local atrás de TVs (todas, ou só do `kind`). Sem rede, lista vazia."""
    address = local or local_ipv4()
    if address is None:
        _log.warning("sem rota de rede: nada a varrer")
        return []
    tvs = await scan_hosts(
        subnet_hosts(address), connect=connect, fetch_json=fetch_json, lookup_mac=lookup_mac
    )
    return [tv for tv in tvs if kind is None or tv.kind == kind]


def same_tv(tv: DiscoveredTv, hint: str) -> bool:
    """A TV achada é a que tem esta dica de identificador?"""
    wanted = hint.removeprefix("uuid:").upper()
    return any(known.upper() == wanted for known in tv.ids)
