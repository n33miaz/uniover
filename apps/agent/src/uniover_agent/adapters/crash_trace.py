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
import faulthandler
import logging
import sys
import threading
import time
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


def install_crash_trace(logs: Path, recorder: DiagnosticsRecorder) -> None:
    """Liga as redes de segurança. Idempotente o bastante para ser chamada uma vez por processo."""
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
            recorder.record(
                "process.crashed",
                "error",
                "uma exceção não tratada encerrou o agente",
                component="main",
                error=error,
            )
        previous_hook(kind, error, trace)

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
        recorder.record(
            "thread.failed",
            "error",
            f"a thread {name} terminou com exceção",
            component="main",
            error=args.exc_value,
        )

    threading.excepthook = thread_hook


def loop_exception_handler(recorder: DiagnosticsRecorder) -> Any:
    """Tratador para `loop.set_exception_handler`: tarefa que falhou sem ninguém esperar por ela."""

    def handle(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        error = context.get("exception")
        message = str(context.get("message", "erro no laço de eventos"))
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
