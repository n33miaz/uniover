r"""Rastro das falhas de partida: o que impediu o agente de chegar à conexão com a API.

Antes de abrir o canal o agente passa por passos que podem falhar (estrutura de pastas,
configuração, cofre de credenciais, pareamento). A mensagem ia só para o erro padrão de um processo
sem janela e se perdia: o PC ligado, o agente reiniciando em laço e nenhuma pista, nem no servidor
nem no disco.

Cada falha vira uma linha em `logs\startup.log` (para quem olha o PC) e uma ocorrência
`startup.failed` na fila de diagnóstico (vai à API na próxima conexão). O mesmo motivo não se repete
dentro da janela: o supervisor reinicia o agente a cada poucos minutos e isto não pode encher o
disco.

A janela é por motivo e só começa quando a ocorrência entrou na fila de verdade: fila trancada ou
disco cheio não calam as tentativas seguintes. Dois processos (a tarefa agendada e uma execução
manual) disputam a mesma janela por um arquivo de reserva criado de forma atômica: só um grava.

Nada aqui levanta erro: é rastro, e rastro não pode piorar a partida.
"""

import contextlib
import os
import re
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from uniover_agent.adapters.diagnostics_file import FileDiagnosticStore
from uniover_agent.adapters.installation import installation_base
from uniover_agent.core.diagnostics import DETAIL_LIMIT
from uniover_agent.core.redaction import REDACTED, scrub_personal
from uniover_agent.ports.diagnostics import DiagnosticEvent

LOG_FILE: Final = "startup.log"
KIND: Final = "startup.failed"
# O mesmo motivo só é gravado de novo depois disto.
REPEAT_SECONDS: Final = 6 * 3600.0
# Uma reserva esquecida por um processo que caiu no meio deixa de valer depois disto.
CLAIM_STALE_SECONDS: Final = 60.0
_LOG_LIMIT_BYTES: Final = 64 * 1024
_REASON = re.compile(r"[a-z0-9_]{1,32}")
# Sequência longa e opaca (token, chave, código) mesmo sem palavra-chave por perto.
_OPAQUE = re.compile(r"[A-Za-z0-9_+/=-]{24,}")


def sanitize(text: str) -> str:
    """Uma linha só, sem segredo, caminho, endereço nem nome do usuário ou do PC."""
    names = [os.environ.get("USERNAME", ""), os.environ.get("COMPUTERNAME", "")]
    one_line = " ".join(text.split())
    return _OPAQUE.sub(REDACTED, scrub_personal(one_line, names))


def _marker(root: Path, reason: str) -> Path:
    return root / "runtime" / f"startup-failure.{reason}.txt"


def _recently_recorded(marker: Path, now: float) -> bool:
    try:
        return 0 <= now - float(marker.read_text(encoding="utf-8").strip()) < REPEAT_SECONDS
    except OSError, ValueError:
        return False


def _claim(path: Path, now: float) -> bool:
    """Cria a reserva de forma atômica; só um processo por vez a tem."""
    for _ in range(2):
        try:
            os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            try:
                if now - path.stat().st_mtime < CLAIM_STALE_SECONDS:
                    return False
                path.unlink(missing_ok=True)
            except OSError:
                return False
            continue
        return True
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
    livre, higienizado aqui. A janela só fecha quando a ocorrência entrou na fila de diagnóstico.
    """
    if not _REASON.fullmatch(reason):
        return False
    claim: Path | None = None
    try:
        root = base or installation_base()
        now = clock()
        marker = _marker(root, reason)
        marker.parent.mkdir(parents=True, exist_ok=True)
        claim = marker.with_name(marker.name + ".claim")
        if not _claim(claim, now):
            claim = None
            return False
        if _recently_recorded(marker, now):
            return False
        text = f"{reason}: {sanitize(detail)}"[:DETAIL_LIMIT].strip()
        _write_log(root / "logs", now, text)
        at = datetime.fromtimestamp(now, UTC).isoformat(timespec="milliseconds")
        event = DiagnosticEvent(
            id=str(uuid.uuid7()),
            at=at.replace("+00:00", "Z"),
            kind=KIND,
            severity="error",
            detail=text,
            component="startup",
        )
        if not FileDiagnosticStore(root / "runtime").append_confirmed(event):
            return False
        temporary = marker.with_name(marker.name + ".tmp")
        temporary.write_text(str(now), encoding="utf-8")
        os.replace(temporary, marker)
    except Exception:  # rastro nunca pode derrubar a partida
        return False
    finally:
        if claim is not None:
            with contextlib.suppress(OSError):
                claim.unlink(missing_ok=True)
    return True


def _write_log(logs: Path, now: float, text: str) -> None:
    logs.mkdir(parents=True, exist_ok=True)
    path = logs / LOG_FILE
    if path.exists() and path.stat().st_size > _LOG_LIMIT_BYTES:
        path.replace(path.with_name(LOG_FILE + ".1"))
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"{stamp} ERROR startup: {text}\n")
