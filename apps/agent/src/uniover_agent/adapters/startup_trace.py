r"""Rastro das falhas de partida: o que impediu o agente de chegar à conexão com a API.

Antes de abrir o canal o agente passa por passos que podem falhar (estrutura de pastas,
configuração, cofre de credenciais, pareamento). A mensagem ia só para o erro padrão de um processo
sem janela e se perdia: o PC ligado, o agente reiniciando em laço e nenhuma pista, nem no servidor
nem no disco.

Cada falha vira uma linha em `logs\startup.log` (para quem olha o PC) e uma ocorrência
`startup.failed` na fila de diagnóstico (vai à API na próxima conexão). As duas gravações são
independentes: log trancado ou sem espaço não impede a fila, e a fila trancada não impede o log. O
mesmo motivo não se repete dentro da janela: o supervisor reinicia o agente a cada poucos minutos e
isto não pode encher o disco.

A janela é por motivo e só começa quando a ocorrência entrou na fila de verdade: fila trancada ou
disco cheio não calam as tentativas seguintes. Dois processos (a tarefa agendada e uma execução
manual) disputam a mesma janela por um arquivo de reserva criado de forma atômica que leva o número
do processo dono: só um grava, e a reserva só é tomada de volta quando esse processo já não existe.

Texto livre de exceção inesperada nunca entra aqui (a mensagem pode ser um segredo curto que
nenhum padrão reconhece): só o tipo e o ponto do código onde ela foi levantada.

Nada aqui levanta erro: é rastro, e rastro não pode piorar a partida.
"""

import contextlib
import os
import re
import sys
import time
import traceback
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
# Reserva sem número de processo legível (processo caiu entre criar e gravar): vale por pouco tempo.
CLAIM_UNREADABLE_SECONDS: Final = 60.0
# Mesmo com o processo dono vivo, uma reserva tão velha é de número de processo reaproveitado.
CLAIM_MAX_SECONDS: Final = 3600.0
_LOG_LIMIT_BYTES: Final = 64 * 1024
_REASON = re.compile(r"[a-z0-9_]{1,32}")
# Sequência longa e opaca (token, chave, código) mesmo sem palavra-chave por perto.
_OPAQUE = re.compile(r"[A-Za-z0-9_+/=-]{24,}")
# Windows: `OpenProcess` com direito mínimo, e o código de saída de um processo que ainda roda.
_PROCESS_QUERY_LIMITED_INFORMATION: Final = 0x1000
_STILL_ACTIVE: Final = 259
_ERROR_ACCESS_DENIED: Final = 5


def sanitize(text: str) -> str:
    """Uma linha só, sem segredo, caminho, endereço nem nome do usuário ou do PC.

    Serve a texto que o agente mesmo escreveu. Mensagem de exceção inesperada não passa por aqui:
    ver `describe_exception`."""
    names = [os.environ.get("USERNAME", ""), os.environ.get("COMPUTERNAME", "")]
    one_line = " ".join(text.split())
    return _OPAQUE.sub(REDACTED, scrub_personal(one_line, names))


def describe_exception(exc: BaseException) -> str:
    """Só o tipo da exceção e onde ela foi levantada (arquivo, linha e função); nunca a mensagem."""
    where = ""
    with contextlib.suppress(Exception):
        frame = traceback.extract_tb(exc.__traceback__)[-1]
        where = f" em {Path(frame.filename).name}:{frame.lineno} ({frame.name})"
    return f"{type(exc).__name__}{where}"


def _marker(root: Path, reason: str) -> Path:
    return root / "runtime" / f"startup-failure.{reason}.txt"


def _recently_recorded(marker: Path, now: float) -> bool:
    try:
        return 0 <= now - float(marker.read_text(encoding="utf-8").strip()) < REPEAT_SECONDS
    except OSError, ValueError:
        return False


def _windows_process_alive(pid: int) -> bool:
    import ctypes  # noqa: PLC0415 - só existe no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ctypes.get_last_error() == _ERROR_ACCESS_DENIED
    try:
        code = wintypes.DWORD()
        return not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) or (
            code.value == _STILL_ACTIVE
        )
    finally:
        kernel32.CloseHandle(handle)


def process_alive(pid: int) -> bool:
    """O processo `pid` ainda existe? Na dúvida (sem permissão para olhar), sim."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _windows_process_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _claim_is_abandoned(path: Path, now: float) -> bool:
    """A reserva é de um processo que já não existe (ou velha demais para ser dele)?"""
    try:
        age = now - path.stat().st_mtime
        if age > CLAIM_MAX_SECONDS:
            return True
        text = path.read_text(encoding="ascii").strip()
    except OSError, ValueError:
        return False
    if not text.isdigit():
        return age > CLAIM_UNREADABLE_SECONDS
    return not process_alive(int(text))


def _claim(path: Path, now: float) -> bool:
    """Cria a reserva de forma atômica, com o número deste processo; só um a tem por vez."""
    for _ in range(2):
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if not _claim_is_abandoned(path, now):
                return False
            try:
                path.unlink(missing_ok=True)
            except OSError:
                return False
            continue
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(str(os.getpid()))
        return True
    return False


def record_startup_failure(
    reason: str,
    detail: str,
    *,
    base: Path | None = None,
    clock: Callable[[], float] = time.time,
) -> bool:
    """Grava a falha de partida; `False` se foi contida por repetição ou não entrou na fila.

    `reason` é um código curto e fixo (`configuracao`, `cofre`, `nao_pareado`,
    `credencial_recusada`, `excecao`): é ele que decide se o motivo é repetido. `detail` é texto do
    próprio agente, higienizado aqui. A janela só fecha quando a ocorrência entrou na fila.
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
        return _record_claimed(root, marker, reason, detail, now)
    except Exception:  # rastro nunca pode derrubar a partida
        return False
    finally:
        if claim is not None:
            with contextlib.suppress(OSError):
                claim.unlink(missing_ok=True)


def _record_claimed(root: Path, marker: Path, reason: str, detail: str, now: float) -> bool:
    if _recently_recorded(marker, now):
        return False
    text = f"{reason}: {sanitize(detail)}"[:DETAIL_LIMIT].strip()
    # Sem o marcador (disco, permissão) a regra das 6 h não se sustenta sozinha: o que ainda espera
    # na fila com o mesmo motivo basta para não repetir.
    if _queued(root / "runtime", reason):
        return False
    # Cada gravação por conta própria: uma falha numa não leva a outra junto.
    with contextlib.suppress(Exception):
        _write_log(root / "logs", now, text)
    if not _enqueue(root / "runtime", now, text):
        return False
    _write_marker(marker, now)
    return True


def log_only(detail: str, *, base: Path | None = None) -> None:
    """Só a linha em `startup.log`, sem tocar na fila (quem não é o dono dela não pode mexer)."""
    with contextlib.suppress(Exception):
        _write_log((base or installation_base()) / "logs", time.time(), sanitize(detail))


def _queued(runtime: Path, reason: str) -> bool:
    try:
        return FileDiagnosticStore(runtime).has_kind(KIND, f"{reason}:")
    except Exception:
        return False


def _enqueue(runtime: Path, now: float, text: str) -> bool:
    try:
        at = datetime.fromtimestamp(now, UTC).isoformat(timespec="milliseconds")
        event = DiagnosticEvent(
            id=str(uuid.uuid7()),
            at=at.replace("+00:00", "Z"),
            kind=KIND,
            severity="error",
            detail=text,
            component="startup",
        )
        return FileDiagnosticStore(runtime).append_confirmed(event)
    except Exception:
        return False


def _write_marker(marker: Path, now: float) -> None:
    # Falhar aqui só deixa a janela aberta (a próxima partida tenta de novo): a fila já tem a linha.
    with contextlib.suppress(OSError):
        temporary = marker.with_name(marker.name + ".tmp")
        temporary.write_text(str(now), encoding="utf-8")
        os.replace(temporary, marker)


def _write_log(logs: Path, now: float, text: str) -> None:
    logs.mkdir(parents=True, exist_ok=True)
    path = logs / LOG_FILE
    if path.exists() and path.stat().st_size > _LOG_LIMIT_BYTES:
        path.replace(path.with_name(LOG_FILE + ".1"))
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"{stamp} ERROR startup: {text}\n")
