"""Religar o ADB sozinho, sem nunca abrir o aviso "Permitir depuração USB" na TV.

O pedido de permissão é feito **uma única vez** por aparelho, e só pela pessoa (um toque no app).
Sem ninguém usando a TV, o agente também não abre conexão ADB: cada `adb connect` a uma TV que
perdeu a chave faria o aviso aparecer sem ninguém diante dela. Esta peça troca a presença da
pessoa por uma **prova do momento**: a sonda silenciosa (`adapters/adb_silent_probe.py`) assina o
token da TV com a chave do `adb` e nunca oferece a chave pública, então não abre aviso nenhum. Só
com `authorized` a conexão acontece; qualquer outro resultado (`unauthorized`, `tls_required`,
`unknown`, `unreachable`) deixa tudo como está e fica registrado.

Duas regras duras, que valem aqui e não dependem de quem chama:

- no máximo **uma sonda por endereço a cada 5 minutos** (a janela só conta quando a sonda de fato
  rodou, sobrevive a reiniciar o agente, e um resultado `authorized` nunca é reaproveitado: a
  conexão só vale logo depois da prova);
- **nunca durante um comando do dono**: a TV tem pouca memória e o comando dele tem a vez.

A abertura sem a pessoa é **de curta duração**: abre, faz a leitura que precisava (a conferência
diária dos ajustes de ligar pela rede, a leitura do app da frente) e desconecta no fim, sempre.

O núcleo não sabe falar com a TV: a sonda e a abertura chegam por injeção.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from typing import Final, Protocol

from uniover_agent.ports import (
    PROBE_AUTHORIZED,
    PROBE_EVENT_HOST_NOT_NUMERIC,
    PROBE_EVENT_KEY_CHANGED,
    PROBE_EVENT_KEY_STALE,
    PROBE_EVENT_KEY_UNVERIFIABLE,
    PROBE_EVENT_MAC_CHANGED,
    PROBE_EVENT_MISMATCH,
    PROBE_EVENT_VENDOR_KEYS,
    PROBE_SKIPPED,
    PROBE_TLS_REQUIRED,
    PROBE_UNAUTHORIZED,
    PROBE_UNKNOWN,
    PROBE_UNREACHABLE,
    AdbError,
    AdbUnreachable,
    ProbeVerdict,
)
from uniover_agent.ports.diagnostics import Severity

_log = logging.getLogger(__name__)

# No máximo uma sonda por endereço neste intervalo, e nunca menos: a regra não se afrouxa.
MIN_PROBE_INTERVAL_SECONDS: Final = 300.0
# A TV que acabou de voltar atende o controle antes do ADB: se a porta do ADB ainda não responde, a
# conexão tenta de novo depois destas esperas (a sonda nem chegou a rodar, então a janela de 5
# minutos não foi gasta).
RETRY_DELAYS_SECONDS: Final = (10.0, 30.0, 60.0)
# Horários guardados mais velhos que isto são esquecidos ao gravar (o arquivo não cresce).
_FORGET_AFTER_SECONDS: Final = 86400.0
DIAGNOSTIC_KIND: Final = "adb.probe"
DIAGNOSTIC_COMPONENT: Final = "tv_adb"

# Texto fixo por resultado (o registro junta repetições), sem endereço nem MAC. Curto, em pt-BR.
_TEXTS: Final = {
    PROBE_AUTHORIZED: "sonda do ADB: a TV aceita a chave do PC",
    PROBE_UNAUTHORIZED: (
        "sonda do ADB: a TV não reconhece a chave do PC; nada foi conectado e nenhum aviso foi "
        "aberto"
    ),
    PROBE_TLS_REQUIRED: "sonda do ADB: a TV exige TLS; nada foi conectado",
    PROBE_UNREACHABLE: "sonda do ADB: a TV não respondeu na porta do ADB; nada foi conectado",
    PROBE_UNKNOWN: "sonda do ADB: resposta ou chave inesperada; nada foi conectado",
}
_SEVERITY: Final[dict[str, Severity]] = {PROBE_UNAUTHORIZED: "warn", PROBE_UNKNOWN: "warn"}
# Abertura que parou antes do `adb connect` (o `adb.probe.<código>`): sempre aviso.
_EVENT_TEXTS: Final = {
    PROBE_EVENT_MISMATCH: (
        "sonda do ADB: a TV aceita o adb mas recusou a chave da sonda; chaves diferentes"
    ),
    PROBE_EVENT_KEY_CHANGED: "sonda do ADB: a chave do adb mudou depois da sonda; nada conectado",
    PROBE_EVENT_KEY_STALE: (
        "sonda do ADB: a chave é mais nova que o servidor adb em execução; nada conectado"
    ),
    PROBE_EVENT_VENDOR_KEYS: "sonda do ADB: ADB_VENDOR_KEYS definido; nada conectado",
    PROBE_EVENT_KEY_UNVERIFIABLE: (
        "sonda do ADB: não deu para conferir a chave do adb; nada conectado"
    ),
    PROBE_EVENT_MAC_CHANGED: (
        "sonda do ADB: outro aparelho passou a responder no endereço da TV; nada conectado"
    ),
    PROBE_EVENT_HOST_NOT_NUMERIC: (
        "sonda do ADB: o endereço da TV não é um IP numérico; sem a pessoa o ADB não religa"
    ),
}

Probe = Callable[[], Awaitable[ProbeVerdict]]
Recorder = Callable[[str, Severity, str], None]
Session = Callable[[], AbstractAsyncContextManager[None]]


class ProbeTimeStore(Protocol):
    """Onde ficam os horários (de parede) da última sonda por endereço, para durar a um reinício."""

    def load(self) -> dict[str, float]: ...

    def save(self, times: dict[str, float]) -> None: ...


class AdbSilentLink:
    """Sonda com limite de frequência, e a abertura de curta duração que só vale depois dela."""

    def __init__(  # noqa: PLR0913 - o endereço, a sonda e os limites, todos injetados
        self,
        address: str,
        probe: Probe,
        monotonic: Callable[[], float],
        *,
        owner_busy: Callable[[], bool] = lambda: False,
        min_interval_seconds: float = MIN_PROBE_INTERVAL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        retry_delays: tuple[float, ...] = RETRY_DELAYS_SECONDS,
        wall_clock: Callable[[], float] = time.time,
        store: ProbeTimeStore | None = None,
    ) -> None:
        # O endereço é o canônico (IP numérico e porta). Um `AdbSilentLink` serve a um endereço: ao
        # mudar de endereço o agente monta tudo de novo e o endereço novo começa sem janela gasta.
        self._address = address
        self._probe = probe
        self._monotonic = monotonic
        self._owner_busy = owner_busy
        self._min_interval = max(MIN_PROBE_INTERVAL_SECONDS, min_interval_seconds)
        self._sleep = sleep
        self._retry_delays = retry_delays
        self._wall_clock = wall_clock
        self._store = store
        self._last_probe_at: dict[str, float] = {}
        self._persisted: dict[str, float] | None = None
        self._last_result: str | None = None
        self._recorder: Recorder | None = None
        self._task: asyncio.Task[bool] | None = None
        self._lock = asyncio.Lock()
        self._closed = False

    @property
    def last_result(self) -> str | None:
        """O resultado da última sonda que rodou (`None`: nenhuma ainda)."""
        return self._last_result

    def record_with(self, recorder: Recorder) -> None:
        """Liga o diagnóstico: cada resultado vira uma ocorrência `adb.probe.<resultado>`."""
        self._recorder = recorder

    def note_event(self, code: str) -> None:
        """Uma abertura parou antes do `adb connect` (aparelho ou chave diferentes do provado)."""
        text = _EVENT_TEXTS.get(code)
        if text is None:
            return
        _log.warning(text)
        self._record(f"{DIAGNOSTIC_KIND}.{code}", "warn", text)

    async def clearance(self) -> ProbeVerdict:
        """Pergunta agora se a TV aceita a chave. Só `authorized` libera conexão sozinha.

        `skipped`: não sondou (comando do dono em andamento, ou já houve sonda neste endereço há
        menos de 5 minutos, mesmo antes de um reinício do agente). Nada é gravado nesse caso, e a
        janela não é gasta. `authorized` traz a impressão digital da chave que assinou.
        """
        if self._owner_busy():
            return ProbeVerdict(PROBE_SKIPPED)
        await self._load_persisted()
        now = self._monotonic()
        wall = self._wall_clock()
        if self._within_window(now, wall):
            return ProbeVerdict(PROBE_SKIPPED)
        self._last_probe_at[self._address] = now
        await self._persist(wall)
        try:
            verdict = await self._probe()
        except Exception:
            # A sonda nunca levanta por contrato; se levantar, não se prova nada.
            _log.exception("falha na sonda do ADB")
            verdict = ProbeVerdict(PROBE_UNKNOWN)
        if verdict.result not in _TEXTS:
            verdict = ProbeVerdict(PROBE_UNKNOWN)
        self._last_result = verdict.result
        self._write(verdict.result)
        return verdict

    async def run(
        self,
        session: Session,
        work: Callable[[], Awaitable[None]],
        reason: str,
        *,
        retry: bool = True,
    ) -> bool:
        """Abre o canal sem a pessoa, depois da prova, faz `work` e o fecha. Devolve se abriu.

        `session` é a abertura de curta duração do adaptador (que chama `clearance` no portão): sem
        `authorized` ela não conecta, e o que abriu é desconectado no fim, aconteça o que
        acontecer. `work` é a leitura que precisava do canal (a conferência diária, o app da
        frente). Uma abertura por vez (outra chamada durante ela devolve `False`); `retry` tenta
        de novo (com espera) enquanto a porta do ADB da TV não responde.
        """
        if self._lock.locked():
            # Uma abertura por vez: quem chega durante outra desiste (a que está aberta cuida da
            # leitura, e a próxima vez o dia ainda estará em aberto).
            return False
        async with self._lock:
            if self._closed or self._owner_busy():
                return False
            self._task = asyncio.ensure_future(self._run(session, work, reason, retry))
            return await self._task

    async def aclose(self) -> None:
        """Encerramento do agente: cancela a abertura em andamento e espera ela se desfazer.

        Chamada **antes** de fechar o ADB: o cancelamento passa pelo `adb disconnect` do fim da
        abertura, e nada fica aberto nem conecta depois disso.
        """
        self._closed = True
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _run(
        self, session: Session, work: Callable[[], Awaitable[None]], reason: str, retry: bool
    ) -> bool:
        delays = iter(self._retry_delays if retry else ())
        while True:
            stack = AsyncExitStack()
            try:
                await stack.enter_async_context(session())
            except AdbUnreachable as exc:
                delay = next(delays, None)
                if delay is None:
                    _log.info("ADB não aberto sem a pessoa (%s): %s", reason, exc.code)
                    return False
                await self._sleep(delay)
                if self._owner_busy() or self._closed:
                    return False
                continue
            except AdbError as exc:
                # A causa já foi dita (portão, sonda): aqui só o que o código do erro explica.
                # Nenhum aviso foi aberto: a conexão não passou do portão.
                _log.info("ADB não aberto sem a pessoa (%s): %s", reason, exc.code)
                return False
            try:
                await work()
            finally:
                # Desconecta sempre (sucesso, erro ou cancelamento): ver `AdbTv.unattended`.
                await stack.aclose()
            _log.info("ADB aberto sem a pessoa (%s) com a prova da sonda, e fechado", reason)
            return True

    def _within_window(self, now: float, wall: float) -> bool:
        local = self._last_probe_at.get(self._address)
        if local is not None and now - local < self._min_interval:
            return True
        saved = (self._persisted or {}).get(self._address)
        if saved is None:
            return False
        # Um horário no futuro além do intervalo é arquivo ruim (ou relógio muito mexido): ignora.
        return -self._min_interval <= wall - saved < self._min_interval

    async def _load_persisted(self) -> None:
        if self._persisted is not None:
            return
        self._persisted = {}
        if self._store is None:
            return
        try:
            self._persisted = await asyncio.to_thread(self._store.load)
        except Exception:
            _log.exception("não consegui ler os horários das sondas do ADB")

    async def _persist(self, wall: float) -> None:
        if self._store is None:
            return
        saved = {
            address: moment
            for address, moment in (self._persisted or {}).items()
            if 0 <= wall - moment < _FORGET_AFTER_SECONDS
        }
        saved[self._address] = wall
        self._persisted = saved
        try:
            # Fora do laço de eventos: gravar em disco não pode atrasar nada.
            await asyncio.to_thread(self._store.save, dict(saved))
        except Exception:
            _log.exception("não consegui gravar o horário da sonda do ADB")

    def _write(self, result: str) -> None:
        text = _TEXTS[result]
        severity = _SEVERITY.get(result, "info")
        _log.log(logging.WARNING if severity == "warn" else logging.INFO, text)
        self._record(f"{DIAGNOSTIC_KIND}.{result}", severity, text)

    def _record(self, kind: str, severity: Severity, text: str) -> None:
        if self._recorder is None:
            return
        try:
            self._recorder(kind, severity, text)
        except Exception:
            _log.exception("falha ao anotar a sonda do ADB no diagnóstico")
