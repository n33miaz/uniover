r"""Rastro das falhas de partida: o que impediu o agente de chegar à conexão com a API.

Antes de abrir o canal o agente passa por passos que podem falhar (estrutura de pastas,
configuração, cofre de credenciais, pareamento). A mensagem ia só para o erro padrão de um processo
sem janela e se perdia: o PC ligado, o agente reiniciando em laço e nenhuma pista, nem no servidor
nem no disco.

Cada falha vira uma linha em `logs\startup.log` (para quem olha o PC) e uma ocorrência
`startup.failed` na fila de diagnóstico (vai à API na próxima conexão). O mesmo motivo não se repete
dentro da janela: o supervisor reinicia o agente a cada poucos minutos e isto não pode encher o
disco.

Nada aqui levanta erro: é rastro, e rastro não pode piorar a partida.
"""

import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from uniover_agent.adapters.diagnostics_file import FileDiagnosticStore
from uniover_agent.adapters.installation import installation_base
from uniover_agent.core.diagnostics import DETAIL_LIMIT
from uniover_agent.core.redaction import scrub_personal
from uniover_agent.ports.diagnostics import DiagnosticEvent

LOG_FILE: Final = "startup.log"
MARKER_FILE: Final = "startup-failure.txt"
KIND: Final = "startup.failed"
# O mesmo motivo só é gravado de novo depois disto.
REPEAT_SECONDS: Final = 6 * 3600.0
_LOG_LIMIT_BYTES: Final = 64 * 1024


def _single_line(text: str) -> str:
    return scrub_personal(" ".join(text.split()))


def _recently_recorded(marker: Path, reason: str, now: float) -> bool:
    try:
        stamp, _, last_reason = marker.read_text(encoding="utf-8").partition("|")
        return last_reason.strip() == reason and 0 <= now - float(stamp) < REPEAT_SECONDS
    except OSError, ValueError:
        return False


def record_startup_failure(
    reason: str,
    detail: str,
    *,
    base: Path | None = None,
    clock: Callable[[], float] = time.time,
) -> bool:
    """Grava a falha de partida; `False` se foi contida por repetição ou não deu para gravar.

    `reason` é um código curto e fixo (`configuracao`, `cofre`, `nao_pareado`,
    `credencial_recusada`, `excecao`): é ele que decide se o motivo é repetido. `detail` é o texto
    livre, higienizado.
    """
    try:
        root = base or installation_base()
        now = clock()
        marker = root / "runtime" / MARKER_FILE
        if _recently_recorded(marker, reason, now):
            return False
        text = f"{reason}: {_single_line(detail)}"[:DETAIL_LIMIT].strip()
        logs = root / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        path = logs / LOG_FILE
        if path.exists() and path.stat().st_size > _LOG_LIMIT_BYTES:
            path.replace(path.with_name(LOG_FILE + ".1"))
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} ERROR startup: {text}\n")
        at = datetime.fromtimestamp(now, UTC).isoformat(timespec="milliseconds")
        FileDiagnosticStore(root / "runtime").append(
            DiagnosticEvent(
                id=str(uuid.uuid7()),
                at=at.replace("+00:00", "Z"),
                kind=KIND,
                severity="error",
                detail=text,
                component="startup",
            )
        )
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(f"{now}|{reason}", encoding="utf-8")
    except Exception:
        return False
    return True
