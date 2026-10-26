"""Reencontro da TV na rede quando o IP dela muda (o roteador reparte os endereços de novo).

A procura anda do mais barato para o mais caro e, quando já conhece a identidade, para na primeira
TV confirmada:

1. **Tabela ARP**: o MAC da TV (que o agente guardou) mapeia direto para o IP atual. Não manda
   nada à rede: só lê o que o Windows já sabe.
2. **SSDP**: uma única consulta multicast; as TVs respondem com o próprio endereço.
3. **Varredura do /24**, devagar: poucas conexões ao mesmo tempo, com pausa entre os endereços, e
   no máximo uma a cada `sweep_seconds` (dez minutos). Uma TV com a pilha de rede travada não
   aguenta rajada de conexões.

Nenhum candidato vale só por ter a porta aberta: `identify` compara os identificadores guardados;
sem identificador, a Android TV precisa completar uma sessão com o certificado pareado. O núcleo
não sabe fazer rede: tudo vem por injeção, e os testes andam o tempo à mão.
"""

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

DEFAULT_SSDP_SECONDS = 120.0
DEFAULT_SWEEP_SECONDS = 600.0
# Poucas conexões de uma vez, com pausa entre os endereços: a TV pode estar com a pilha travada.
DEFAULT_CONCURRENCY = 16
DEFAULT_SPACING_SECONDS = 0.05
DEFAULT_SWEEP_DEADLINE_SECONDS = 90.0
# O SSDP pode ser respondido por dezenas de aparelhos da casa: só os primeiros são conferidos.
MAX_SSDP_CANDIDATES = 24

_MAC = re.compile(r"(?:[0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}")


def normalize_mac(raw: str) -> str:
    return raw.strip().upper().replace("-", ":")


def normalize_id(raw: str) -> str:
    """Forma comparável de um identificador (`duid` sem o prefixo `uuid:`, MAC com dois-pontos)."""
    cleaned = raw.strip().removeprefix("uuid:").removeprefix("UUID:")
    return normalize_mac(cleaned) if _MAC.fullmatch(cleaned) else cleaned.upper()


@dataclass(frozen=True, slots=True)
class TvIdentity:
    """O que uma TV diz de si mesma: identificadores estáveis e o MAC (quando o entrega)."""

    ids: tuple[str, ...] = ()
    mac: str | None = None


@dataclass(slots=True)
class TvKnown:
    """O que o agente já sabe da TV dele: a dica de identificador e o MAC (gravados no arquivo).

    Aprende o que faltar na primeira vez que a TV se identifica (a instalação antiga só tem a
    dica; o MAC vem do REST na primeira conexão).
    """

    hint: str | None = None
    mac: str | None = None

    @property
    def macs(self) -> tuple[str, ...]:
        """Os MACs conhecidos: o gravado e a dica, quando a dica é um MAC (Android)."""
        found: list[str] = []
        for value in (self.mac, self.hint):
            if value and _MAC.fullmatch(value.strip()):
                mac = normalize_mac(value)
                if mac not in found:
                    found.append(mac)
        return tuple(found)

    @property
    def can_identify(self) -> bool:
        return bool(self.hint or self.mac)

    def matches(self, identity: TvIdentity) -> bool:
        wanted = {normalize_id(value) for value in (self.hint, self.mac) if value}
        offered = {normalize_id(value) for value in identity.ids}
        if identity.mac:
            offered.add(normalize_id(identity.mac))
        return bool(wanted & offered)

    def conflicts(self, identity: TvIdentity) -> bool:
        """A TV disse quem é, e não é a nossa (o endereço virou de outro aparelho)."""
        return (
            self.can_identify and bool(identity.ids or identity.mac) and not self.matches(identity)
        )

    def learn(self, identity: TvIdentity) -> bool:
        """Completa o que faltava; devolve se aprendeu algo (para gravar no arquivo)."""
        changed = False
        if self.mac is None and identity.mac:
            self.mac = normalize_mac(identity.mac)
            changed = True
        if self.hint is None and identity.ids:
            self.hint = identity.ids[0]
            changed = True
        return changed


@dataclass(frozen=True, slots=True)
class Located:
    host: str
    mac: str | None
    # De onde veio a confirmação: `arp`, `ssdp` ou `varredura` (só para o registro).
    via: str


ArpTable = Callable[[], Awaitable[dict[str, list[str]]]]
SsdpSearch = Callable[[], Awaitable[list[str]]]
Identify = Callable[[str], Awaitable[TvIdentity | None]]
Probe = Callable[[str], Awaitable[bool]]
Authenticate = Callable[[str], Awaitable[bool]]
Hosts = Callable[[], list[str]]


@dataclass(slots=True)
class _Schedule:
    last_ssdp: float | None = None
    last_sweep: float | None = None
    sweeps: int = 0


class TvLocator:
    def __init__(  # noqa: PLR0913 - cada argumento é uma injeção de rede ou um limite
        self,
        clock: Clock,
        known: TvKnown,
        *,
        arp_table: ArpTable,
        ssdp: SsdpSearch,
        hosts: Hosts,
        probe: Probe,
        identify: Identify,
        authenticate: Authenticate | None = None,
        ssdp_seconds: float = DEFAULT_SSDP_SECONDS,
        sweep_seconds: float = DEFAULT_SWEEP_SECONDS,
        concurrency: int = DEFAULT_CONCURRENCY,
        spacing_seconds: float = DEFAULT_SPACING_SECONDS,
        sweep_deadline_seconds: float = DEFAULT_SWEEP_DEADLINE_SECONDS,
    ) -> None:
        self._clock = clock
        self.known = known
        self._arp_table = arp_table
        self._ssdp = ssdp
        self._hosts = hosts
        self._probe = probe
        self._identify = identify
        self._authenticate = authenticate
        self._ssdp_seconds = ssdp_seconds
        self._sweep_seconds = sweep_seconds
        self._concurrency = max(1, concurrency)
        self._spacing = spacing_seconds
        self._sweep_deadline = sweep_deadline_seconds
        self._schedule = _Schedule()
        # A tabela ARP ainda mostra a TV no endereço de sempre (a última procura concluiu isso).
        self._at_same_place = False

    async def is_at(self, host: str) -> bool:
        """A TV certa responde neste endereço? (Outro aparelho no mesmo IP não conta.)"""
        identity = await self._identify(host)
        if identity is None:
            return False
        return not self.known.can_identify or self.known.matches(identity)

    async def find(self, current_host: str) -> Located | None:
        """Procura a TV; devolve onde ela está agora, ou `None` (não achou, ou não mudou)."""
        if not self.known.can_identify:
            # Sem MAC, só a sessão com o certificado pareado pode confirmar um candidato.
            return await self._by_sweep(current_host) if self._authenticate is not None else None
        found = await self._by_arp(current_host)
        if found is not None or self._at_same_place:
            return found
        found = await self._by_ssdp(current_host)
        if found is not None:
            return found
        return await self._by_sweep(current_host)

    # --- 1. ARP ------------------------------------------------------------------------------

    async def _by_arp(self, current_host: str) -> Located | None:
        self._at_same_place = False
        macs = self.known.macs
        if not macs:
            return None
        try:
            table = await self._arp_table()
        except OSError:
            return None
        addresses = [ip for mac in macs for ip in table.get(mac, [])]
        if current_host in addresses:
            # O Windows ainda a vê no endereço de sempre: a TV só está dormindo ou com a rede
            # engasgada. Varrer a rede não a faria aparecer.
            self._at_same_place = True
            return None
        unconfirmed: list[str] = []
        for host in dict.fromkeys(addresses):
            # Entrada velha do ARP pode apontar para um endereço que já é de outro aparelho: só
            # vale o que atende por TCP na porta da TV (e, de preferência, se diz quem é).
            if not await self._probe(host):
                continue
            identity = await self._identify(host)
            if identity is not None and self.known.matches(identity):
                return self._found(host, identity, "arp")
            if identity is None:
                unconfirmed.append(host)
        if len(unconfirmed) == 1:
            # O MAC é único no mundo e a porta da TV atende; só o REST não respondeu. Aceita.
            _log.info("TV achada pelo MAC na tabela ARP, sem confirmar pelo REST")
            return Located(unconfirmed[0], macs[0], "arp")
        return None

    async def learn_mac(self, host: str) -> str | None:
        """O MAC que a tabela ARP mostra para o endereço da TV, se for novo (ou `None`).

        Numa TV no cabo o ARP mostra o MAC da placa de rede, que não é o `wifiMac` do REST: é ele
        que reencontra a TV pelo ARP e que o Wake-on-LAN precisa. Só vale com a TV confirmada
        naquele endereço (o chamador garante: sessão pareada, sessão quente ou REST respondeu).
        """
        try:
            table = await self._arp_table()
        except OSError:
            return None
        for mac, hosts in table.items():
            if host in hosts:
                if mac == self.known.mac:
                    return None
                self.known.mac = mac
                return mac
        return None

    # --- 2. SSDP -----------------------------------------------------------------------------

    async def _by_ssdp(self, current_host: str) -> Located | None:
        now = self._clock.monotonic()
        last = self._schedule.last_ssdp
        if last is not None and now - last < self._ssdp_seconds:
            return None
        self._schedule.last_ssdp = now
        try:
            candidates = await self._ssdp()
        except OSError:
            return None
        for host in list(dict.fromkeys(candidates))[:MAX_SSDP_CANDIDATES]:
            if host == current_host:
                continue
            identity = await self._identify(host)
            if identity is not None and self.known.matches(identity):
                return self._found(host, identity, "ssdp")
        return None

    # --- 3. varredura limitada -----------------------------------------------------------------

    async def _by_sweep(self, current_host: str) -> Located | None:
        now = self._clock.monotonic()
        last = self._schedule.last_sweep
        if last is not None and now - last < self._sweep_seconds:
            return None
        self._schedule.last_sweep = now
        self._schedule.sweeps += 1
        hosts = [host for host in self._hosts() if host != current_host]
        queue: asyncio.Queue[str] = asyncio.Queue()
        for host in hosts:
            queue.put_nowait(host)
        result: list[Located] = []
        stop = asyncio.Event()
        needs_unique = not self.known.can_identify

        async def worker() -> None:
            while not stop.is_set():
                try:
                    host = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                located = await self._inspect(host)
                if located is not None:
                    result.append(located)
                    if not needs_unique:
                        stop.set()
                        return
                # Pausa entre os endereços: cada trabalhador só chega ao próximo depois dela.
                await self._clock.sleep(self._spacing)

        workers = [asyncio.create_task(worker()) for _ in range(min(self._concurrency, len(hosts)))]
        pending: set[asyncio.Task[None]] = set()
        failed = False
        if workers:
            _, pending = await asyncio.wait(workers, timeout=self._sweep_deadline)
            for task in pending:
                task.cancel()
            outcomes = await asyncio.gather(*workers, return_exceptions=True)
            failed = any(isinstance(outcome, BaseException) for outcome in outcomes)
        if needs_unique and len(result) > 1:
            _log.warning("mais de uma TV respondeu à confirmação; continuo procurando")
            return None
        # Prazo estourado deixa endereços sem conferir: um único sucesso ainda seria ambíguo.
        if needs_unique and (pending or failed):
            return None
        _log.info("varredura limitada da rede terminou: %s", "achou" if result else "não achou")
        return result[0] if result else None

    async def _inspect(self, host: str) -> Located | None:
        try:
            if not await self._probe(host):
                return None
            if not self.known.can_identify:
                if self._authenticate is not None and await self._authenticate(host):
                    return Located(host, None, "varredura")
                return None
            identity = await self._identify(host)
        except OSError:
            return None
        if identity is not None and self.known.matches(identity):
            return self._found(host, identity, "varredura")
        return None

    def _found(self, host: str, identity: TvIdentity, via: str) -> Located:
        self.known.learn(identity)
        return Located(host, identity.mac or self.known.mac, via)
