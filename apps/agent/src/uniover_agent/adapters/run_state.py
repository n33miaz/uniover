r"""Rastro das execuções do agente: como a anterior terminou e por que a atual ainda existe.

Duas marcas em `runtime\`:

- `run-state.json`: gravada ao subir (`running`, com o PID e a versão) e ao sair de forma ordenada
  (`stopped`, com o motivo). Se ao subir a anterior ainda está `running`, ela não terminou de forma
  ordenada: foi morta, travou ou o PC desligou.
- `stop-reason.txt`: escrita pelo supervisor do Windows (um script) antes de encerrar o agente de
  propósito (reinício pedido, atualização, volta à versão anterior, agente travado). O agente a lê e
  apaga ao subir; sem ela, uma execução `running` que sumiu é uma queda de verdade.

Nada aqui levanta erro: é rastro, e rastro não pode impedir o agente de subir.
"""

import json
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from uniover_agent.adapters.absence_diary import windows_uptime_seconds

_log = logging.getLogger(__name__)

STATE_FILE: Final = "run-state.json"
STOP_REASON_FILE: Final = "stop-reason.txt"
# O que o supervisor escreve (`stop-reason.txt`) e o que isto sabe explicar em português.
SUPERVISOR_REASONS: Final = {
    "restart": "reinício pedido",
    "update": "atualização para uma versão nova",
    "rollback": "volta para a versão anterior",
    "unresponsive": "o agente parou de dar sinal de vida e foi reiniciado",
}
_MAX_BYTES: Final = 4096


@dataclass(frozen=True, slots=True)
class PreviousRun:
    """O que se sabe de como a execução anterior terminou."""

    outcome: str
    detail: str


def _now() -> datetime:
    return datetime.now(UTC)


class RunState:
    def __init__(
        self,
        runtime: Path,
        *,
        pid: int | None = None,
        now: Callable[[], datetime] = _now,
        uptime: Callable[[], float | None] = windows_uptime_seconds,
    ) -> None:
        self._path = runtime / STATE_FILE
        self._stop_reason = runtime / STOP_REASON_FILE
        self._pid = pid if pid is not None else os.getpid()
        self._now = now
        self._uptime = uptime
        self._ended = False

    def _load(self) -> dict[str, Any]:
        try:
            if self._path.stat().st_size > _MAX_BYTES:
                return {}
            data = json.loads(self._path.read_text(encoding="utf-8-sig"))
        except OSError, ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, data: dict[str, Any]) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._path.with_name(self._path.name + ".tmp")
            temporary.write_text(
                json.dumps(data, ensure_ascii=True, sort_keys=True), encoding="utf-8"
            )
            os.replace(temporary, self._path)
        except OSError:
            _log.warning("não consegui gravar o rastro da execução", exc_info=True)

    def _read_stop_reason(self) -> str | None:
        try:
            text = self._stop_reason.read_text(encoding="utf-8-sig").strip().lower()
            self._stop_reason.unlink(missing_ok=True)
        except OSError:
            return None
        return text if text in SUPERVISOR_REASONS else None

    def begin(self, version: str) -> PreviousRun | None:
        """Marca esta execução como em andamento e diz como a anterior terminou.

        `None`: não há rastro de execução anterior.
        """
        previous = self._load()
        reason = self._read_stop_reason()
        started = self._now()
        self._write(
            {
                "state": "running",
                "pid": self._pid,
                "version": version,
                "startedAt": started.isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
        )
        if not previous:
            return None
        if previous.get("state") == "stopped":
            return PreviousRun(
                "clean", f"saiu de forma ordenada ({previous.get('reason', 'sem motivo')})"
            )
        if reason is not None:
            return PreviousRun(
                "supervisor", f"encerrado de propósito: {SUPERVISOR_REASONS[reason]}"
            )
        return PreviousRun("abrupt", self._explain_abrupt(previous, started))

    def _explain_abrupt(self, previous: dict[str, Any], started: datetime) -> str:
        """Sem aviso do supervisor, a anterior sumiu: o PC reiniciou ou o processo morreu."""
        uptime = self._uptime()
        try:
            before = datetime.fromisoformat(str(previous.get("startedAt")))
            gap = (started - before).total_seconds()
        except ValueError:
            gap = None
        if uptime is not None and gap is not None and uptime < gap:
            return (
                f"o PC foi ligado ou reiniciado há {uptime / 60:.0f} min; "
                "a execução anterior não se despediu"
            )
        return (
            "a execução anterior terminou sem se despedir "
            "(processo encerrado à força, travado ou sem energia)"
        )

    def end(self, reason: str) -> None:
        """Marca esta execução como encerrada de forma ordenada. Só a primeira chamada vale."""
        if self._ended:
            return
        self._ended = True
        data = self._load()
        if data.get("pid") not in (None, self._pid):
            # Outra execução já assumiu o arquivo: não cabe a esta dizer que ela terminou.
            return
        data.update(state="stopped", reason=reason[:60])
        self._write(data)
