"""Diagnóstico do próprio agente: grava as ocorrências sem dados pessoais e as envia à API.

O que acontece com o agente (uma queda, uma tarefa de fundo que falhou, um reparo, uma atualização
recusada) vira uma ocorrência curta numa fila local limitada. Depois do `hello` e de tempos em
tempos a fila vai à API em lotes, para o administrador ver em Sistema. O registro local
(`agent.log`) segue inteiro; a API recebe só o resumo, sem caminhos, endereços, nomes nem segredos.

Repetição não enche a fila: a mesma ocorrência dentro da janela só aumenta um contador, que sai como
`count` quando a janela passa ou na hora do envio.
"""

import asyncio
import logging
import os
import re
import threading
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Final

from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.redaction import scrub_personal
from uniover_agent.ports import Clock, Transport, TransportError
from uniover_agent.ports.diagnostics import DiagnosticEvent, DiagnosticStore, Severity

_log = logging.getLogger(__name__)

DIAGNOSTICS_CAPABILITY: Final = "agent.diagnostics.v1"

# Os mesmos limites do esquema `agent.diagnostics.v1`.
KIND_PATTERN: Final = re.compile(r"[a-z0-9][a-z0-9_.]{1,47}")
COMPONENT_PATTERN: Final = re.compile(r"[a-z0-9][a-z0-9_.]{0,31}")
DETAIL_LIMIT: Final = 300
MAX_COUNT: Final = 10_000
BATCH_SIZE: Final = 20
# Uma rodada de envio manda no máximo isto: um agente em laço de erro não inunda a API.
MAX_BATCHES_PER_FLUSH: Final = 5
# A mesma ocorrência dentro desta janela só incrementa o contador.
REPEAT_WINDOW_SECONDS: Final = 600.0
SHIP_INTERVAL_SECONDS: Final = 300.0
_MAX_TRACKED: Final = 64
_UNKNOWN_LOCATION: Final = "local desconhecido"
_UNSAFE: Final = re.compile(r"[^a-z0-9_.]+")


def component_safe(name: str) -> str | None:
    """`name` no formato de componente do contrato, ou `None` se não couber."""
    candidate = _UNSAFE.sub("_", name.lower()).strip("._")[:32].rstrip("._")
    return candidate if candidate and COMPONENT_PATTERN.fullmatch(candidate) else None


def describe_exception(error: BaseException) -> str:
    """Tipo e lugar da falha (`TimeoutError em session.py:watch (linha 551)`), nunca a mensagem.

    A mensagem de uma exceção vem muitas vezes de bibliotecas e do sistema, com caminhos e
    endereços; o tipo e o ponto do nosso código bastam para achar a causa. O texto completo continua
    no registro local.
    """
    location = _UNKNOWN_LOCATION
    frame = error.__traceback__
    chosen = None
    while frame is not None:
        if "uniover_agent" in frame.tb_frame.f_code.co_filename:
            chosen = frame
        frame = frame.tb_next
    if chosen is not None:
        name = os.path.basename(chosen.tb_frame.f_code.co_filename)
        location = f"{name}:{chosen.tb_frame.f_code.co_name} (linha {chosen.tb_lineno})"
    return f"{type(error).__name__} em {location}"


@dataclass(slots=True)
class _Seen:
    window_started: float
    last_at: str
    kind: str
    severity: Severity
    detail: str
    component: str | None
    suppressed: int = 0


class DiagnosticsRecorder:
    """Monta a ocorrência (higieniza, limita, resume repetições) e a põe na fila."""

    def __init__(
        self,
        store: DiagnosticStore,
        clock: Clock,
        *,
        names: Iterable[str] = (),
        window: float = REPEAT_WINDOW_SECONDS,
    ) -> None:
        self._store = store
        self._clock = clock
        self._names = tuple(names)
        self._window = window
        self._seen: dict[tuple[str, str | None, str], _Seen] = {}
        self._lock = threading.Lock()

    def _stamp(self) -> str:
        return self._clock.now().isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def record(
        self,
        kind: str,
        severity: Severity,
        detail: str,
        *,
        component: str | None = None,
        error: BaseException | None = None,
    ) -> None:
        """Nunca levanta: o diagnóstico nunca pode ser a causa de uma falha nova."""
        try:
            self._record(kind, severity, detail, component, error)
        except Exception:
            _log.warning("não consegui gravar uma ocorrência de diagnóstico", exc_info=True)

    def _record(
        self,
        kind: str,
        severity: Severity,
        detail: str,
        component: str | None,
        error: BaseException | None,
    ) -> None:
        if not KIND_PATTERN.fullmatch(kind):
            raise ValueError("tipo de ocorrência fora do formato do contrato")
        if component is not None and not COMPONENT_PATTERN.fullmatch(component):
            raise ValueError("componente fora do formato do contrato")
        text = f"{detail} ({describe_exception(error)})" if error is not None else detail
        text = scrub_personal(" ".join(text.split()), self._names)[:DETAIL_LIMIT].strip()
        if not text:
            text = kind
        key = (kind, component, text)
        now = self._clock.monotonic()
        stamp = self._stamp()
        overflow: list[DiagnosticEvent] = []
        with self._lock:
            seen = self._seen.get(key)
            if seen is not None and now - seen.window_started < self._window:
                seen.suppressed += 1
                seen.last_at = stamp
                return
            carried = seen.suppressed if seen is not None else 0
            self._seen[key] = _Seen(now, stamp, kind, severity, text, component)
            overflow = self._trim()
            count = min(MAX_COUNT, 1 + carried)
        for event in overflow:
            self._store.append(event)
        self._store.append(self._event((kind, severity, text, component), count, stamp))

    def _trim(self) -> list[DiagnosticEvent]:
        """Esquece as ocorrências mais antigas, guardando o resumo do que ainda não disseram."""
        dropped: list[DiagnosticEvent] = []
        while len(self._seen) > _MAX_TRACKED:
            seen = self._seen.pop(next(iter(self._seen)))
            if seen.suppressed:
                dropped.append(self._from_seen(seen))
        return dropped

    @staticmethod
    def _event(data: tuple[str, Severity, str, str | None], count: int, at: str) -> DiagnosticEvent:
        kind, severity, detail, component = data
        return DiagnosticEvent(
            id=str(uuid.uuid7()),
            at=at,
            kind=kind,
            severity=severity,
            detail=detail,
            component=component,
            count=count,
        )

    def _from_seen(self, seen: _Seen) -> DiagnosticEvent:
        return self._event(
            (seen.kind, seen.severity, seen.detail, seen.component),
            min(MAX_COUNT, seen.suppressed),
            seen.last_at,
        )

    def flush_pending(self) -> None:
        """Grava os resumos das repetições que ainda não saíram (antes de cada envio e ao sair)."""
        with self._lock:
            pending = [seen for seen in self._seen.values() if seen.suppressed > 0]
            events = [self._from_seen(seen) for seen in pending]
            for seen in pending:
                seen.suppressed = 0
        for event in events:
            self._store.append(event)


class DiagnosticsShipper:
    """Manda a fila à API em lotes. Sem conexão, o que não saiu volta para o começo da fila."""

    def __init__(  # noqa: PLR0913 - dependências injetadas, todas necessárias
        self,
        store: DiagnosticStore,
        recorder: DiagnosticsRecorder,
        transport: Transport,
        envelopes: EnvelopeFactory,
        clock: Clock,
        *,
        interval: float = SHIP_INTERVAL_SECONDS,
        enabled: Callable[[], bool] = lambda: True,
    ) -> None:
        self._store = store
        self._recorder = recorder
        self._transport = transport
        self._envelopes = envelopes
        self._clock = clock
        self._interval = interval
        # Falso enquanto a API não disse que aceita o diagnóstico: nada sai e a fila local guarda.
        self._enabled = enabled

    async def flush(self) -> int:
        """Envia o que há na fila; devolve quantas ocorrências foram entregues ao transporte."""
        self._recorder.flush_pending()
        if not self._enabled():
            return 0
        sent = 0
        for _ in range(MAX_BATCHES_PER_FLUSH):
            batch = await asyncio.to_thread(self._store.take, BATCH_SIZE)
            if not batch:
                break
            try:
                await self._transport.send(self._envelopes.agent_diagnostics(batch))
            except TransportError:
                await asyncio.to_thread(self._store.put_back, batch)
                break
            except asyncio.CancelledError:
                # Reinício ou atualização no meio do envio: o lote volta à fila (chamada direta, a
                # tarefa já está cancelada) em vez de ficar emprestado, e o cancelamento segue.
                self._store.put_back(batch)
                raise
            except Exception:
                # Um lote que não vira mensagem válida não pode travar a fila para sempre:
                # descarta-o.
                _log.warning("descartei um lote de diagnóstico inválido", exc_info=True)
                await asyncio.to_thread(self._store.confirm, batch)
                continue
            # Só agora o lote sai da fila: antes disto, uma queda o deixaria para o reenvio.
            await asyncio.to_thread(self._store.confirm, batch)
            sent += len(batch)
        return sent

    async def run(self) -> None:
        while True:
            await self._clock.sleep(self._interval)
            try:
                await self.flush()
            except Exception:
                _log.warning("falha ao enviar o diagnóstico", exc_info=True)
