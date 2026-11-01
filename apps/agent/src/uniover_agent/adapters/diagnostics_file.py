r"""Fila local do diagnóstico em `runtime\diagnostics.jsonl` (uma ocorrência por linha).

Quem acrescenta: o agente e o supervisor do Windows (que é um script e escreve a linha por conta
própria, no mesmo formato). Quem tira: só o agente, ao enviar. Por isso a leitura é tolerante: linha
que não é JSON, que não tem os campos do contrato ou que traz um texto grande demais é ajustada ou
descartada, nunca derruba.

Tirar da fila é por renomeação (`diagnostics.jsonl` vira `diagnostics.sending.jsonl`): o que o
supervisor acrescentar enquanto o agente lê cai num arquivo novo e não se perde. O que sobrou de um
envio interrompido (a renomeação feita, o processo caiu) é lido primeiro na vez seguinte.
"""

import json
import logging
import os
import re
import threading
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from uniover_agent.core.diagnostics import (
    COMPONENT_PATTERN,
    DETAIL_LIMIT,
    KIND_PATTERN,
    MAX_COUNT,
    DiagnosticsRecorder,
)
from uniover_agent.core.redaction import scrub_personal
from uniover_agent.ports.diagnostics import DiagnosticEvent, Severity

_log = logging.getLogger(__name__)

PENDING_FILE: Final = "diagnostics.jsonl"
SENDING_FILE: Final = "diagnostics.sending.jsonl"
# O que saiu de `diagnostics.jsonl` e ainda não entrou em `.sending` (só existe no meio da troca).
INCOMING_FILE: Final = "diagnostics.incoming.jsonl"
# Lote emprestado e nunca confirmado (envio cancelado, processo vivo) volta à fila depois disto.
LEASE_SECONDS: Final = 120.0
# A fila nunca passa disto: o mais antigo cai primeiro (o PC pode ficar dias sem API).
MAX_EVENTS: Final = 200
_COMPACT_BYTES: Final = 160 * 1024
_SEVERITIES: Final = frozenset({"info", "warn", "error"})
_STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z")


def _event_from(raw: Any, now: datetime) -> DiagnosticEvent | None:
    """A ocorrência da linha lida, ajustada ao contrato; `None` se não há o que aproveitar."""
    if not isinstance(raw, dict):
        return None
    kind, severity, detail = raw.get("kind"), raw.get("severity"), raw.get("detail")
    if not isinstance(kind, str) or not KIND_PATTERN.fullmatch(kind):
        return None
    if severity not in _SEVERITIES or not isinstance(detail, str):
        return None
    text = scrub_personal(" ".join(detail.split()))[:DETAIL_LIMIT].strip()
    if not text:
        return None
    component = raw.get("component")
    if not isinstance(component, str) or not COMPONENT_PATTERN.fullmatch(component):
        component = None
    count = raw.get("count")
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        count = 1
    at = raw.get("at")
    if not isinstance(at, str) or not _STAMP.fullmatch(at):
        at = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    identifier = raw.get("id")
    if not isinstance(identifier, str) or len(identifier) != len(str(uuid.uuid4())):
        identifier = str(uuid.uuid7())
    severity_value: Severity = severity
    return DiagnosticEvent(
        id=identifier,
        at=at,
        kind=kind,
        severity=severity_value,
        detail=text,
        component=component,
        count=min(count, MAX_COUNT),
    )


def _line(event: DiagnosticEvent) -> str:
    data: dict[str, Any] = {
        "id": event.id,
        "at": event.at,
        "kind": event.kind,
        "severity": event.severity,
        "detail": event.detail,
    }
    if event.component:
        data["component"] = event.component
    if event.count > 1:
        data["count"] = event.count
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


class FileDiagnosticStore:
    """Fila em arquivo com empréstimo: `take` não tira nada do disco, só marca o lote em envio.

    O lote só sai de `diagnostics.sending.jsonl` em `confirm`. Uma queda (ou um cancelamento)
    entre `take` e `confirm` deixa tudo no arquivo e o próximo processo reenvia; como cada
    ocorrência tem `id` fixo (gravado no arquivo na primeira leitura) e a API ignora repetidos, o
    reenvio é seguro."""

    def __init__(
        self,
        runtime: Path,
        *,
        max_events: int = MAX_EVENTS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._pending = runtime / PENDING_FILE
        self._sending = runtime / SENDING_FILE
        self._incoming = runtime / INCOMING_FILE
        self._max = max_events
        self._monotonic = monotonic
        # id -> quando foi emprestado (só nesta execução: ao reiniciar, tudo volta a estar
        # disponível).
        self._leased: dict[str, float] = {}
        self._lock = threading.Lock()

    def append(self, event: DiagnosticEvent) -> None:
        try:
            with self._lock:
                self._pending.parent.mkdir(parents=True, exist_ok=True)
                with self._pending.open("a", encoding="utf-8", newline="\n") as handle:
                    handle.write(_line(event) + "\n")
                if self._pending.stat().st_size > _COMPACT_BYTES:
                    self._compact()
        except OSError:
            # O arquivo pode estar aberto por outro processo por um instante: a ocorrência fica só
            # no registro.
            _log.warning("não consegui gravar a fila do diagnóstico", exc_info=True)

    def _compact(self) -> None:
        events = self._read(self._pending)
        self._write(self._pending, events[-self._max :])

    def _read(self, path: Path) -> list[DiagnosticEvent]:
        try:
            text = path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            return []
        now = datetime.now(UTC)
        found: list[DiagnosticEvent] = []
        for line in text.splitlines():
            try:
                event = _event_from(json.loads(line), now)
            except ValueError:
                continue
            if event is not None:
                found.append(event)
        return found

    @staticmethod
    def _write(path: Path, events: list[DiagnosticEvent]) -> None:
        if not events:
            path.unlink(missing_ok=True)
            return
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text("".join(_line(event) + "\n" for event in events), encoding="utf-8")
        os.replace(temporary, path)

    def _free(self, events: list[DiagnosticEvent]) -> list[DiagnosticEvent]:
        """As ocorrências que não estão emprestadas agora (empréstimo velho demais não vale)."""
        now = self._monotonic()
        self._leased = {k: t for k, t in self._leased.items() if now - t < LEASE_SECONDS}
        return [event for event in events if event.id not in self._leased]

    def _absorb(self, events: list[DiagnosticEvent]) -> list[DiagnosticEvent]:
        """Traz para a fila de envio o que entrou em `diagnostics.jsonl` (agente e supervisor).

        A renomeação é atômica: o que for escrito depois dela cai num arquivo novo e não se perde. O
        arquivo de envio é regravado antes de o intermediário sumir, então uma queda no meio só
        repete ocorrências (que a API ignora), nunca perde."""
        if not self._incoming.exists():
            try:
                os.replace(self._pending, self._incoming)
            except FileNotFoundError:
                return events
        merged = (events + self._read(self._incoming))[-self._max :]
        self._write(self._sending, merged)
        self._incoming.unlink(missing_ok=True)
        return merged

    def take(self, limit: int) -> list[DiagnosticEvent]:
        try:
            with self._lock:
                events = self._read(self._sending)[-self._max :]
                free = self._free(events)
                if not free:
                    events = self._absorb(events)
                    free = self._free(events)
                taken = free[:limit]
                if taken:
                    # Regrava o arquivo normalizado: linhas do supervisor sem `id` ganham um agora,
                    # e ele
                    # fica o mesmo nas leituras seguintes (é com ele que o lote é confirmado e
                    # deduplicado).
                    self._write(self._sending, events)
                    now = self._monotonic()
                    self._leased.update({event.id: now for event in taken})
                return taken
        except OSError:
            _log.warning("não consegui ler a fila do diagnóstico", exc_info=True)
            return []

    def confirm(self, events: list[DiagnosticEvent]) -> None:
        done = {event.id for event in events}
        try:
            with self._lock:
                self._write(
                    self._sending, [e for e in self._read(self._sending) if e.id not in done]
                )
                for key in done:
                    self._leased.pop(key, None)
        except OSError:
            # O lote fica no arquivo e será reenviado (repetido, a API o ignora).
            _log.warning("não consegui confirmar o envio do diagnóstico", exc_info=True)

    def put_back(self, events: list[DiagnosticEvent]) -> None:
        try:
            with self._lock:
                for event in events:
                    self._leased.pop(event.id, None)
                present = self._read(self._sending)
                known = {event.id for event in present}
                missing = [event for event in events if event.id not in known]
                if missing:
                    self._write(self._sending, (missing + present)[: self._max])
        except OSError:
            _log.warning("não consegui devolver o diagnóstico à fila", exc_info=True)


_COMPONENT_UNSAFE = re.compile(r"[^a-z0-9_.]+")
_COMPONENT_PREFIXES: Final = ("uniover_agent.", "core.", "adapters.")


def component_of(logger_name: str) -> str | None:
    """`uniover_agent.core.tv.session` vira `tv.session` (cabe no formato do contrato)."""
    name = logger_name.lower()
    for prefix in _COMPONENT_PREFIXES:
        name = name.removeprefix(prefix)
    name = _COMPONENT_UNSAFE.sub("_", name).strip("._")[-32:].lstrip("._")
    return name if name and COMPONENT_PATTERN.fullmatch(name) else None


class DiagnosticsLogHandler(logging.Handler):
    """Cada registro de erro do agente vira também uma ocorrência de diagnóstico.

    É o caminho que garante que nada que o agente registrou como erro fica só no arquivo: a causa
    de uma falha que ninguém previu também chega à tela do administrador. Registros que quem os
    escreveu já gravou como ocorrência própria (`extra={"recorded": True}`) não duplicam.
    """

    def __init__(self, recorder: DiagnosticsRecorder, level: int = logging.ERROR) -> None:
        super().__init__(level)
        self._recorder = recorder

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(record, "recorded", False) or not record.name.startswith("uniover_agent"):
            return
        error = record.exc_info[1] if record.exc_info else None
        try:
            message = record.getMessage()
        except Exception:
            message = "mensagem de erro ilegível"
        self._recorder.record(
            "error.logged",
            "error",
            message,
            component=component_of(record.name),
            error=error,
        )
