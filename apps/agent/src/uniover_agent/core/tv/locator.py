"""Reencontro da TV na rede quando o IP dela muda (o roteador reparte os endereços de novo).

A procura anda do mais barato para o mais caro e, quando já conhece a identidade, para na primeira
TV confirmada:

1. **Tabela ARP**: o MAC da TV (que o agente guardou) mapeia direto para o IP atual. Não manda
   nada à rede: só lê o que o Windows já sabe.
2. **SSDP**: uma única consulta multicast; as TVs respondem com o próprio endereço.
3. **mDNS** (só a Android TV, que anuncia `_androidtvremote2._tcp`): uma escuta curta antes da
   varredura, com o mesmo espaçamento do SSDP.
4. **Varredura das redes do PC** (um /24 no máximo por placa, mais o /24 do endereço velho),
   devagar: poucas conexões ao mesmo tempo, com pausa entre os endereços, e no máximo uma a cada
   `sweep_seconds` (dez minutos). Uma TV com a pilha de rede travada não aguenta rajada de
   conexões.

Depois de `empty_searches_limit` buscas seguidas sem achar nada (TV desligada por horas), as
etapas caras (SSDP, mDNS e varredura) passam a rodar no máximo uma vez a cada `slow_search_seconds`
(meia hora): a tabela ARP continua sendo lida em toda conferência, porque é de graça.

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
DEFAULT_MDNS_SECONDS = 120.0
DEFAULT_EMPTY_SEARCHES_LIMIT = 6
DEFAULT_SLOW_SEARCH_SECONDS = 1800.0
# Poucas conexões de uma vez, com pausa entre os endereços: a TV pode estar com a pilha travada.
DEFAULT_CONCURRENCY = 16
DEFAULT_SPACING_SECONDS = 0.05
DEFAULT_SWEEP_DEADLINE_SECONDS = 90.0
# O SSDP pode ser respondido por dezenas de aparelhos da casa: só os primeiros são conferidos.
MAX_SSDP_CANDIDATES = 24
# Tamanho de um /24 sem o próprio PC: a unidade do prazo da varredura.
SWEEP_NETWORK_HOSTS = 253

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
    # De onde veio a confirmação: `arp`, `ssdp`, `mdns` ou `varredura` (só para o registro).
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
    last_mdns: float | None = None
    last_sweep: float | None = None
    sweeps: int = 0
    # Buscas caras seguidas sem achar a TV, e quando foi a última que rodou alguma etapa.
    empty_searches: int = 0
    last_search: float | None = None
    ran_expensive_stage: bool = False


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
        mdns: SsdpSearch | None = None,
        answers: Probe | None = None,
        ssdp_seconds: float = DEFAULT_SSDP_SECONDS,
        mdns_seconds: float = DEFAULT_MDNS_SECONDS,
        sweep_seconds: float = DEFAULT_SWEEP_SECONDS,
        empty_searches_limit: int = DEFAULT_EMPTY_SEARCHES_LIMIT,
        slow_search_seconds: float = DEFAULT_SLOW_SEARCH_SECONDS,
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
        self._mdns = mdns
        # Algo responde na porta da TV (atende ou recusa)? Sem isto, só o atender conta.
        self._answers = answers or probe
        self._ssdp_seconds = ssdp_seconds
        self._mdns_seconds = mdns_seconds
        self._empty_searches_limit = empty_searches_limit
        self._slow_search_seconds = slow_search_seconds
        self._sweep_seconds = sweep_seconds
        self._concurrency = max(1, concurrency)
        self._spacing = spacing_seconds
        self._sweep_deadline = sweep_deadline_seconds
        self._schedule = _Schedule()
        # A tabela ARP ainda mostra a TV no endereço de sempre (a última procura concluiu isso).
        self._at_same_place = False
        # A última `find` rodou alguma etapa cara (SSDP, mDNS ou varredura)?
        self.searched = False

    def reset_schedule(self, *, full: bool = False) -> None:
        """Esquece os espaçamentos do SSDP, do mDNS e da varredura: a próxima procura roda na hora.

        Chamado quando o PC mudou de rede (a TV, se ainda está ligada, também foi para outra). Os
        contadores da procura lenta (TV desligada por horas) só zeram com `full`, para uma rede
        genuinamente nova: uma placa que oscila não pode acordar a varredura a noite toda.
        """
        schedule = self._schedule
        schedule.last_ssdp = None
        schedule.last_mdns = None
        schedule.last_sweep = None
        if full:
            schedule.empty_searches = 0
            schedule.last_search = None
        self._at_same_place = False

    async def is_at(self, host: str) -> bool:
        """A TV certa responde neste endereço? (Outro aparelho no mesmo IP não conta.)"""
        identity = await self._identify(host)
        if identity is None:
            return False
        return not self.known.can_identify or self.known.matches(identity)

    async def find(self, current_host: str) -> Located | None:
        """Procura a TV; devolve onde ela está agora, ou `None` (não achou, ou não mudou).

        Depois, `searched` diz se alguma etapa cara rodou de verdade (e não só o ARP, ou a espera da
        procura lenta, ou a TV dormindo no mesmo lugar).
        """
        self._schedule.ran_expensive_stage = False
        found = await self._find(current_host)
        self.searched = self._schedule.ran_expensive_stage
        return found

    async def _find(self, current_host: str) -> Located | None:
        if not self.known.can_identify:
            # Sem MAC, só a sessão com o certificado pareado pode confirmar um candidato.
            return await self._by_sweep(current_host) if self._authenticate is not None else None
        found = await self._by_arp(current_host)
        if found is not None or self._at_same_place:
            self._schedule.empty_searches = 0
            return found
        if self._searching_slowly():
            return None
        self._schedule.ran_expensive_stage = False
        found = await self._by_ssdp(current_host)
        if found is None:
            found = await self._by_mdns(current_host)
        if found is None:
            found = await self._by_sweep(current_host)
        self._note_search(found is not None)
        return found

    def _searching_slowly(self) -> bool:
        """Muitas buscas vazias seguidas: as etapas caras esperam o intervalo longo."""
        last = self._schedule.last_search
        return (
            self._schedule.empty_searches >= self._empty_searches_limit
            and last is not None
            and self._clock.monotonic() - last < self._slow_search_seconds
        )

    def _note_search(self, found: bool) -> None:
        schedule = self._schedule
        if found:
            schedule.empty_searches = 0
        elif schedule.ran_expensive_stage:
            schedule.empty_searches += 1
        if schedule.ran_expensive_stage:
            schedule.last_search = self._clock.monotonic()

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
        if current_host in addresses and await self._answers(current_host):
            # O Windows ainda a vê no endereço de sempre e a porta do controle atende (ou recusa:
            # a TV está lá e só o serviço caiu, assunto do vigia): a TV só está dormindo ou com a
            # rede engasgada. Varrer a rede não a faria aparecer. Entrada
            # velha do ARP, com a porta muda, não prova nada: a busca segue.
            self._at_same_place = True
            return None
        unconfirmed: list[str] = []
        for host in dict.fromkeys(addresses):
            if host == current_host:
                continue
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
        self._schedule.ran_expensive_stage = True
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

    # --- 3. mDNS -----------------------------------------------------------------------------

    async def _by_mdns(self, current_host: str) -> Located | None:
        if self._mdns is None:
            return None
        now = self._clock.monotonic()
        last = self._schedule.last_mdns
        if last is not None and now - last < self._mdns_seconds:
            return None
        self._schedule.last_mdns = now
        self._schedule.ran_expensive_stage = True
        try:
            candidates = await self._mdns()
        except OSError:
            return None
        for host in list(dict.fromkeys(candidates))[:MAX_SSDP_CANDIDATES]:
            if host == current_host:
                continue
            identity = await self._identify(host)
            if identity is not None and self.known.matches(identity):
                return self._found(host, identity, "mdns")
        return None

    # --- 4. varredura limitada -----------------------------------------------------------------

    async def _by_sweep(self, current_host: str) -> Located | None:
        now = self._clock.monotonic()
        last = self._schedule.last_sweep
        if last is not None and now - last < self._sweep_seconds:
            return None
        self._schedule.last_sweep = now
        self._schedule.ran_expensive_stage = True
        self._schedule.sweeps += 1
        # Listar as placas do PC é leitura do sistema: fora do laço de eventos.
        listed = await asyncio.to_thread(self._hosts)
        hosts = [host for host in listed if host != current_host]
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
            # Mais de uma rede (placas do PC) pede mais prazo: um /24 por vez, não tudo no mesmo.
            deadline = self._sweep_deadline * max(1, -(-len(hosts) // SWEEP_NETWORK_HOSTS))
            _, pending = await asyncio.wait(workers, timeout=deadline)
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
