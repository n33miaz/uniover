"""O registro nunca trava o laço de eventos, mesmo com o destino parado (console, disco)."""

import io
import logging
import sys
import threading
import time
from typing import Any

from uniover_agent.adapters.log_offload import OffloadHandler


class Blocked(logging.Handler):
    """Destino que trava na escrita até o teste soltar (um console oculto que não esvazia)."""

    def __init__(self) -> None:
        super().__init__()
        self.unblock = threading.Event()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.unblock.wait(10)
        self.lines.append(self.format(record))


def record(message: str, *args: object, exc_info: bool = False) -> logging.LogRecord:
    info: Any = None
    try:
        if exc_info:
            raise ValueError("falha de teste")
    except ValueError:
        info = sys.exc_info()
    return logging.LogRecord("t", logging.WARNING, __file__, 1, message, args, info)


def test_a_blocked_destination_never_blocks_the_caller() -> None:
    target = Blocked()
    handler = OffloadHandler(target, maxsize=3)
    started = time.monotonic()
    for number in range(50):
        handler.handle(record("linha %d", number))
    assert time.monotonic() - started < 1.0, "o chamador esperou pelo destino"
    assert handler.dropped > 40
    target.unblock.set()
    assert handler.drain(5)
    handler.close()
    # O que coube na fila saiu em ordem; o resto foi contado, não perdido em silêncio.
    assert target.lines[0].endswith("linha 0") or "linha 0" in target.lines[0]
    assert any("linhas foram descartadas" in line for line in target.lines)


def test_the_text_is_closed_at_the_call_and_the_traceback_survives() -> None:
    stream = io.StringIO()
    handler = OffloadHandler(logging.StreamHandler(stream))
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    arguments = ["a"]
    handler.handle(record("valor %s", arguments[0]))
    handler.handle(record("com pilha", exc_info=True))
    assert handler.drain(5)
    handler.close()
    text = stream.getvalue()
    assert "WARNING valor a" in text
    assert "ValueError: falha de teste" in text


def test_the_level_of_the_destination_is_kept() -> None:
    target = logging.StreamHandler(io.StringIO())
    target.setLevel(logging.ERROR)
    handler = OffloadHandler(target)
    assert handler.level == logging.ERROR
    handler.close()


def test_closing_does_not_wait_for_a_stuck_destination() -> None:
    target = Blocked()
    handler = OffloadHandler(target, drain=0.2)
    handler.handle(record("presa"))
    started = time.monotonic()
    handler.close()
    assert time.monotonic() - started < 2.0
    target.unblock.set()


def test_flush_and_close_at_shutdown_write_everything_that_was_queued() -> None:
    # `logging.shutdown()` chama `flush()` e `close()` em cada destino: o que estava na fila sai
    # antes de o processo acabar, mesmo com o destino lento.
    class Slow(logging.Handler):
        def __init__(self) -> None:
            super().__init__()
            self.lines: list[str] = []

        def emit(self, record: logging.LogRecord) -> None:
            time.sleep(0.005)
            self.lines.append(record.getMessage())

    target = Slow()
    handler = OffloadHandler(target, drain=5.0)
    for number in range(100):
        handler.handle(record("linha %d", number))
    handler.flush()
    assert len(target.lines) == 100
    handler.handle(record("ultima"))
    handler.close()
    assert target.lines[-1] == "ultima"


def test_closing_with_a_full_queue_still_ends_the_thread_once_the_destination_moves() -> None:
    target = Blocked()
    handler = OffloadHandler(target, maxsize=2, drain=2.0)
    for number in range(5):
        handler.handle(record("linha %d", number))
    threading.Timer(0.2, target.unblock.set).start()
    handler.close()  # espera lugar para o marcador de fim em vez de descartá-lo
    assert not handler._thread.is_alive()


def test_the_diagnostic_handler_behind_the_offload_keeps_the_exception_type() -> None:
    # A ocorrência de diagnóstico lê `exc_info[1]`: passar pela fila não pode perder a causa.
    from uniover_agent.adapters.diagnostics_file import DiagnosticsLogHandler  # noqa: PLC0415

    from .test_diagnostics import recorder  # noqa: PLC0415

    rec, store, _ = recorder()
    handler = OffloadHandler(DiagnosticsLogHandler(rec))
    log = logging.getLogger("uniover_agent.core.connection")
    log.addHandler(handler)
    try:
        try:
            raise ValueError("segredo")
        except ValueError:
            log.exception("falha inesperada na conexão; reconectando")
        assert handler.drain(5)
    finally:
        log.removeHandler(handler)
        handler.close()
    assert [e.kind for e in store.events] == ["error.logged"]
    assert "ValueError em" in store.events[0].detail
    assert "segredo" not in store.events[0].detail


def test_drain_does_not_leave_a_thread_behind_per_call() -> None:
    target = Blocked()
    handler = OffloadHandler(target, drain=0.1)
    handler.handle(record("presa"))
    before = threading.active_count()
    for _ in range(20):
        assert not handler.drain(0.01)
    assert threading.active_count() == before
    target.unblock.set()
    handler.close()


def test_dropped_lines_are_counted_exactly_across_threads() -> None:
    target = Blocked()
    handler = OffloadHandler(target, maxsize=1, drain=0.5)
    handler.handle(record("a"))  # a thread de fundo a pega e trava no destino
    time.sleep(0.1)
    handler.handle(record("b"))  # ocupa o único lugar da fila

    def spam() -> None:
        for _ in range(500):
            handler.handle(record("x"))

    workers = [threading.Thread(target=spam) for _ in range(4)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    assert handler.dropped == 2000
    target.unblock.set()
    handler.close()
