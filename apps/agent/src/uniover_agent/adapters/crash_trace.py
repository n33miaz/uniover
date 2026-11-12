r"""Rastro da queda do agente: o que o Python sabe dizer quando algo dá errado de verdade.

Três redes de segurança, todas escrevendo onde o dono (e a manutenção remota) já olham:

- exceção que ninguém tratou, na thread principal ou em outra, vai para o registro com a pilha e
vira
  ocorrência de diagnóstico (antes o processo caía sem uma linha);
- falha fatal do interpretador (erro de memória nativa, travamento de uma biblioteca em C) deixa a
pilha
  de todas as threads em `logs\crash.log`, pelo `faulthandler`;
- exceção solta numa tarefa do laço de eventos (nunca esperada por ninguém) também é registrada.

O supervisor do Windows deixou de jogar fora a saída dele: o que ele diz vai para
`logs\supervisor.log`.
"""

import asyncio
import errno
import faulthandler
import logging
import sys
import threading
import time
from asyncio import proactor_events
from pathlib import Path
from types import TracebackType
from typing import Any, Final, TextIO

from uniover_agent.core.diagnostics import DiagnosticsRecorder

_log = logging.getLogger("uniover_agent.crash")

CRASH_FILE: Final = "crash.log"
_CRASH_LIMIT_BYTES: Final = 256 * 1024
# O `faulthandler` escreve no descritor para sempre: o arquivo precisa continuar aberto.
_keep_open: list[TextIO] = []


def _open_crash_file(logs: Path) -> TextIO | None:
    path = logs / CRASH_FILE
    try:
        logs.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > _CRASH_LIMIT_BYTES:
            path.replace(path.with_name(CRASH_FILE + ".1"))
        handle = path.open("a", encoding="utf-8", buffering=1)
        handle.write(f"--- execução iniciada {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
    except OSError:
        return None
    return handle


# O gravador que os ganchos usam: `run` roda de novo no mesmo processo quando a TV muda de
# endereço, e cada chamada embrulharia o gancho outra vez (a mesma queda registrada várias vezes).
_active_recorder: list[DiagnosticsRecorder] = []
_HOOK_MARK = "_uniover_crash_hook"


def install_crash_trace(logs: Path, recorder: DiagnosticsRecorder) -> None:
    """Liga as redes de segurança; chamada de novo no mesmo processo, só troca o gravador."""
    _active_recorder[:] = [recorder]
    if getattr(sys.excepthook, _HOOK_MARK, False):
        return
    handle = _open_crash_file(logs)
    if handle is not None:
        _keep_open.append(handle)
        try:
            faulthandler.enable(file=handle, all_threads=True)
        except RuntimeError, ValueError, OSError:
            _log.warning("não consegui ligar o rastro de falha fatal", exc_info=True)

    previous_hook = sys.excepthook

    def main_thread_hook(
        kind: type[BaseException], error: BaseException, trace: TracebackType | None
    ) -> None:
        if not issubclass(kind, KeyboardInterrupt):
            _log.critical(
                "exceção não tratada encerrou o agente",
                exc_info=(kind, error, trace),
                extra={"recorded": True},
            )
            _active_recorder[0].record(
                "process.crashed",
                "error",
                "uma exceção não tratada encerrou o agente",
                component="main",
                error=error,
            )
        previous_hook(kind, error, trace)

    setattr(main_thread_hook, _HOOK_MARK, True)
    sys.excepthook = main_thread_hook

    def thread_hook(args: threading.ExceptHookArgs) -> None:
        if args.exc_value is None or issubclass(args.exc_type, SystemExit):
            return
        name = args.thread.name if args.thread is not None else "desconhecida"
        _log.error(
            "a thread %s terminou com exceção",
            name,
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
            extra={"recorded": True},
        )
        _active_recorder[0].record(
            "thread.failed",
            "error",
            f"a thread {name} terminou com exceção",
            component="main",
            error=args.exc_value,
        )

    threading.excepthook = thread_hook


_TASK_REPR_LIMIT: Final = 400


# `WSAECONNRESET`: o par derrubou a conexão.
_WSA_CONNECTION_RESET: Final = 10054
# Privado do asyncio (e fora dos tipos publicados): buscado pelo nome, comparado por identidade.
_PROACTOR_CONNECTION_LOST: Final = getattr(
    proactor_events._ProactorBasePipeTransport, "_call_connection_lost", None
)


def is_benign_proactor_reset(context: dict[str, Any]) -> bool:
    """O asyncio do Windows (3.14) chama `sock.shutdown` sem proteção ao fechar um transporte cujo
    par já derrubou a conexão: sai um `ConnectionResetError` (10054) de
    `_ProactorBasePipeTransport._call_connection_lost` depois de o protocolo já saber da perda. Não
    é defeito do agente (a conexão já tinha caído e o protocolo foi avisado); o soquete fica para o
    coletor fechar.

    Só esse caso exato: o erro 10054 (ou `ECONNRESET`) E o callback ser o método do próprio
    `asyncio.proactor_events` (não qualquer função com esse nome). O resto continua erro gravado."""
    error = context.get("exception")
    if not isinstance(error, ConnectionResetError):
        return False
    if getattr(error, "winerror", None) != _WSA_CONNECTION_RESET and error.errno not in {
        errno.ECONNRESET,
        _WSA_CONNECTION_RESET,
    }:
        return False
    callback = getattr(context.get("handle"), "_callback", None)
    function = getattr(callback, "__func__", None)
    return function is not None and function is _PROACTOR_CONNECTION_LOST


def describe_loop_context(context: dict[str, Any]) -> str:
    """A mensagem do laço e, quando há, QUAL tarefa: "Task was destroyed but it is pending!" sem
    a tarefa (o nome da corrotina e onde ela parou) não diz o que perdeu a referência."""
    message = str(context.get("message", "erro no laço de eventos"))
    task = context.get("task") or context.get("future")
    if task is None:
        return message
    described = repr(task)
    if len(described) > _TASK_REPR_LIMIT:
        described = described[:_TASK_REPR_LIMIT] + "..."
    return f"{message} ({described})"


def loop_exception_handler(recorder: DiagnosticsRecorder) -> Any:
    """Tratador para `loop.set_exception_handler`: tarefa que falhou sem ninguém esperar por ela."""

    def handle(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        error = context.get("exception")
        if is_benign_proactor_reset(context):
            _log.info("o par derrubou a conexão antes do fechamento (aviso conhecido do asyncio)")
            return
        message = describe_loop_context(context)
        _log.error(
            "%s",
            message,
            exc_info=error if isinstance(error, BaseException) else None,
            extra={"recorded": True},
        )
        recorder.record(
            "loop.error",
            "error",
            "uma tarefa falhou sem ninguém esperar por ela",
            component="main",
            error=error if isinstance(error, BaseException) else None,
        )

    return handle
