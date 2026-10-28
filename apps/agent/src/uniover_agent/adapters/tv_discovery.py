"""Descoberta de TV na rede local: Samsung (REST na porta 8001) e Android TV (porta 6466).

A varredura é uma só: a sub-rede IPv4 /24 da interface com rota padrão, em duas fases.

1. Conexão TCP curta às portas 8001 e 6466 de cada endereço, tudo ao mesmo tempo (no Windows um
   endereço ausente não recusa, só deixa estourar o tempo; por isso o limite é curto e global).
2. Só nos que abriram a 8001, `GET /api/v2/`: a Samsung responde com `device.type`
   `Samsung SmartTV` e os identificadores. Outros aparelhos que usam a 8001 não passam.

Nada aqui envia tecla nem pede pareamento. Os endereços e os identificadores nunca vão para o log.
"""

import asyncio
import contextlib
import ipaddress
import logging
import re
import socket
from collections.abc import Awaitable, Callable, Coroutine, Iterable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Literal

import httpx
from zeroconf import IPVersion, ServiceStateChange, Zeroconf
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

from uniover_agent.adapters.arp import arp_mac
from uniover_agent.core.tv.locator import TvIdentity, normalize_mac

_log = logging.getLogger(__name__)

SAMSUNG_REST_PORT = 8001
ANDROID_REMOTE_PORT = 6466
# Por endereço: o bastante numa rede doméstica e curto para a varredura caber em poucos segundos.
CONNECT_TIMEOUT_SECONDS = 1.0
HTTP_TIMEOUT_SECONDS = 2.0
SCAN_DEADLINE_SECONDS = 8.0
CONCURRENCY = 128
MDNS_SERVICE_TYPE = "_androidtvremote2._tcp.local."
MDNS_TIMEOUT_SECONDS = 1.5
# Prazo para as leituras de anúncio em andamento acabarem de ser canceladas ao encerrar o mDNS.
MDNS_CANCEL_GRACE_SECONDS = 1.0

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

    @property
    def mac(self) -> str | None:
        """O MAC entre os identificadores (Samsung: o Wi-Fi do REST; Android: o do ARP)."""
        return next((known for known in self.ids if _MAC.fullmatch(known)), None)


# Substituíveis nos testes: nenhuma delas toca a rede real.
Connect = Callable[[str, int], Awaitable[bool]]
FetchJson = Callable[[str], Awaitable[dict[str, Any] | None]]
ArpLookup = Callable[[str], Awaitable[str | None]]
MdnsDiscovery = Callable[[float], Coroutine[Any, Any, list[DiscoveredTv]]]


async def discover_android_tvs(listen_seconds: float = MDNS_TIMEOUT_SECONDS) -> list[DiscoveredTv]:
    """Escuta por pouco tempo o anúncio mDNS do controle Android TV Remote v2.

    O anúncio traz o nome e o endereço da TV, o que dispensa varrer a /24 (e alcança TV em outra
    sub-rede). Só espera `listen_seconds` e cede o laço enquanto isso. Multicast bloqueado ou sem
    placa utilizável é normal em algumas redes: qualquer falha aqui vira lista vazia, porque a
    varredura TCP continua sendo a reserva e nunca pode ser derrubada pelo mDNS.
    """
    found: dict[str, DiscoveredTv] = {}
    requests: set[asyncio.Task[None]] = set()
    async_zeroconf: AsyncZeroconf | None = None
    browser: AsyncServiceBrowser | None = None
    closing = False
    try:
        async_zeroconf = AsyncZeroconf(ip_version=IPVersion.V4Only)

        async def inspect(name: str) -> None:
            info = AsyncServiceInfo(MDNS_SERVICE_TYPE, name)
            try:
                if not await info.async_request(
                    async_zeroconf.zeroconf, int(listen_seconds * 1000)
                ):
                    return
                label = name.removesuffix(MDNS_SERVICE_TYPE).rstrip(".") or None
                for address in info.parsed_addresses(IPVersion.V4Only):
                    found[address] = DiscoveredTv(address, "android", name=label)
            except Exception:
                _log.debug("não consegui ler um anúncio mDNS da Android TV", exc_info=True)

        # A biblioteca chama o tratador com argumentos nomeados: os nomes não podem mudar.
        def changed(
            zeroconf: Zeroconf, service_type: str, name: str, state_change: ServiceStateChange
        ) -> None:
            del zeroconf, service_type
            # Depois de a janela fechar, anúncio novo não abre leitura nova: a coleção já foi
            # congelada para o cancelamento.
            if closing or state_change is not ServiceStateChange.Added:
                return
            task = asyncio.create_task(inspect(name))
            requests.add(task)
            task.add_done_callback(requests.discard)

        browser = AsyncServiceBrowser(
            async_zeroconf.zeroconf, MDNS_SERVICE_TYPE, handlers=[changed]
        )
        await asyncio.sleep(listen_seconds)
    except Exception:
        _log.debug("o mDNS não está disponível nesta rede", exc_info=True)
    finally:
        # Nesta ordem: o navegador para de entregar anúncios; a coleção de leituras congela; o que
        # ainda estava lendo é cancelado (com prazo); só então o zeroconf fecha os soquetes.
        if browser is not None:
            with contextlib.suppress(Exception):
                await browser.async_cancel()
        closing = True
        in_flight = list(requests)
        for task in in_flight:
            task.cancel()
        if in_flight:
            await asyncio.wait(in_flight, timeout=MDNS_CANCEL_GRACE_SECONDS)
        if async_zeroconf is not None:
            with contextlib.suppress(Exception):
                await async_zeroconf.async_close()
    return sorted(found.values(), key=lambda tv: ipaddress.ip_address(tv.host))


def local_ipv4() -> str | None:
    """Endereço da interface com rota padrão (o `connect` UDP só consulta a rota)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect(("192.0.2.1", 9))
            address: str = probe.getsockname()[0]
        except OSError:
            return None
    return None if address.startswith("0.") else address


def subnet_hosts(local: str, exclude: str | None = None) -> list[str]:
    """Os outros 253 endereços do /24 de `local` (e sem `exclude`, quando dado)."""
    network = ipaddress.ip_network(f"{local}/24", strict=False)
    skip = {local, exclude}
    return [str(host) for host in network.hosts() if str(host) not in skip]


def local_address_for(host: str) -> str | None:
    """Endereço desta máquina na interface que leva até `host`.

    O `connect` de UDP só consulta a tabela de rotas (nenhum pacote sai). É o que importa com
    várias placas (Wi-Fi, cabo sem rede, Hyper-V, VPN): a rota padrão pode ser outra, e o /24 da
    TV é o da interface que a alcança.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect((host, 9))
            address: str = probe.getsockname()[0]
        except OSError:
            return None
    return None if address.startswith("0.") else address


def usable_local_addresses() -> list[str]:
    """Endereços IPv4 desta máquina que podem estar na mesma rede de uma TV, o da rota padrão
    primeiro. Ficam de fora o de loopback e o link-local (169.254), de placa sem rede."""
    default = local_ipv4()
    if default is None:
        return []  # sem rota padrão não há rede a varrer
    candidates: list[str] = [default]
    try:
        listed = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        listed = []
    candidates.extend(str(entry[4][0]) for entry in listed)
    usable: list[str] = []
    for candidate in candidates:
        address = ipaddress.ip_address(candidate)
        if address.is_loopback or address.is_link_local or address.is_unspecified:
            continue
        if candidate not in usable:
            usable.append(candidate)
    return usable


class PortState(StrEnum):
    OPEN = "open"
    # A máquina respondeu e fechou a porta (RST): a TV está na rede e o serviço não está de pé.
    REFUSED = "refused"
    # Nenhuma resposta (TV em standby, fora da rede, rota sem destino): nada a consertar.
    SILENT = "silent"


# No Windows uma porta fechada só é reportada como recusada depois de ~2 s (a pilha repete o SYN
# duas vezes antes de aceitar o RST): com espera menor a recusa se confunde com o silêncio.
REFUSAL_WAIT_SECONDS = 3.0


async def tcp_probe(host: str, port: int, wait: float = CONNECT_TIMEOUT_SECONDS) -> PortState:
    """Abre e fecha a conexão na hora e diz se a porta atende, recusou ou não respondeu.

    Para distinguir a recusa do silêncio no Windows, `wait` precisa ser `REFUSAL_WAIT_SECONDS`.
    """
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), wait)
    except ConnectionRefusedError:
        return PortState.REFUSED
    except OSError, TimeoutError:
        return PortState.SILENT
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return PortState.OPEN


async def tcp_open(host: str, port: int, wait: float = CONNECT_TIMEOUT_SECONDS) -> bool:
    """Há alguém ouvindo nesta porta? Abre e fecha na hora."""
    return await tcp_probe(host, port, wait) is PortState.OPEN


async def http_json(url: str) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            response = await client.get(url)
        data = response.json()
    except httpx.HTTPError, ValueError:
        return None
    return data if isinstance(data, dict) else None


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


def samsung_identity(info: dict[str, Any] | None) -> TvIdentity | None:
    """Quem a TV diz ser no REST (`duid` e MAC Wi-Fi), ou `None` se não é uma Samsung."""
    device = _samsung_device(info)
    if device is None:
        return None
    mac = device.get("wifiMac")
    return TvIdentity(
        _samsung_ids(device),
        normalize_mac(mac) if isinstance(mac, str) and _MAC.fullmatch(mac.strip()) else None,
    )


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


async def _cancel_and_wait(task: asyncio.Task[Any]) -> None:
    """Cancela e espera a tarefa acabar de fechar o que abriu, com prazo."""
    task.cancel()
    await asyncio.wait({task}, timeout=MDNS_CANCEL_GRACE_SECONDS * 2)


async def _mdns_or_nothing(task: asyncio.Task[list[DiscoveredTv]] | None) -> list[DiscoveredTv]:
    if task is None:
        return []
    try:
        return await task
    except Exception:
        _log.debug("a descoberta por mDNS falhou", exc_info=True)
        return []


async def find_tvs(  # noqa: PLR0913 - cada injeção é um ponto de teste independente
    kind: TvKindName | None = None,
    *,
    local: str | None = None,
    connect: Connect = tcp_open,
    fetch_json: FetchJson = http_json,
    lookup_mac: ArpLookup = arp_mac,
    discover_mdns: MdnsDiscovery | None = None,
) -> list[DiscoveredTv]:
    """Varre a rede local atrás de TVs (todas, ou só do `kind`). Sem rede, lista vazia.

    Sem `local`, varre o /24 de cada endereço utilizável desta máquina (não só o da rota padrão:
    com várias placas a TV pode estar em outra), sem os de placa sem rede (169.254).
    """
    addresses = [local] if local else usable_local_addresses()
    if not addresses:
        _log.warning("sem rota de rede: nada a varrer")
        return []
    hosts: list[str] = []
    for address in addresses:
        for host in subnet_hosts(address):
            if host not in hosts and host not in addresses:
                hosts.append(host)
    mdns_task: asyncio.Task[list[DiscoveredTv]] | None = (
        asyncio.create_task((discover_mdns or discover_android_tvs)(MDNS_TIMEOUT_SECONDS))
        if kind in (None, "android")
        else None
    )
    try:
        tvs = await scan_hosts(
            hosts,
            connect=connect,
            fetch_json=fetch_json,
            lookup_mac=lookup_mac,
            deadline=SCAN_DEADLINE_SECONDS * len(addresses),
        )
        mdns_tvs = await _mdns_or_nothing(mdns_task)
    except BaseException:
        # Erro ou cancelamento de fora: a escuta não fica solta, com os soquetes abertos.
        if mdns_task is not None:
            await _cancel_and_wait(mdns_task)
        raise
    merged: dict[tuple[str, TvKindName], DiscoveredTv] = {(tv.host, tv.kind): tv for tv in mdns_tvs}
    for tv in tvs:
        key = (tv.host, tv.kind)
        previous = merged.get(key)
        merged[key] = (
            tv
            if previous is None
            else DiscoveredTv(tv.host, tv.kind, tv.ids, previous.name or tv.name)
        )
    return [
        tv
        for tv in sorted(merged.values(), key=lambda item: ipaddress.ip_address(item.host))
        if kind is None or tv.kind == kind
    ]


def same_tv(tv: DiscoveredTv, hint: str) -> bool:
    """A TV achada é a que tem esta dica de identificador?"""
    wanted = hint.removeprefix("uuid:").upper()
    return any(known.upper() == wanted for known in tv.ids)
