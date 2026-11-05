"""Registro que nunca trava o laço de eventos: cada destino escreve numa thread própria.

Um `StreamHandler`/`RotatingFileHandler` escreve de forma síncrona, na thread que registrou. Se o
destino trava (console oculto que não esvazia, disco cheio ou em disputa, antivírus), a thread do
laço de eventos para dentro de `logging` e o agente inteiro fica mudo: nem batimento, nem
reconexão. Aqui o laço só enfileira (nunca espera) e uma thread de fundo faz a escrita. Fila
cheia descarta o registro mais novo e, quando o destino volta, uma linha avisa quantos se
perderam.
"""

import contextlib
import copy
import logging
import queue
import threading
import time
from typing import Final

_log = logging.getLogger(__name__)

QUEUE_SIZE: Final = 5000
# Ao encerrar, quanto esperar a fila esvaziar (o destino pode estar travado: não segura o
# encerramento).
DRAIN_SECONDS: Final = 5.0


class OffloadHandler(logging.Handler):
    """Entrega cada registro a `target` numa thread de fundo, sem nunca bloquear quem registra."""

    def __init__(
        self, target: logging.Handler, *, maxsize: int = QUEUE_SIZE, drain: float = DRAIN_SECONDS
    ) -> None:
        super().__init__(target.level)
        self.target = target
        self.dropped = 0
        self._drain = drain
        self._queue: queue.Queue[logging.LogRecord | None] = queue.Queue(maxsize)
        self._plain = logging.Formatter()
        self._thread = threading.Thread(target=self._pump, name="log-offload", daemon=True)
        self._thread.start()

    def setFormatter(self, fmt: logging.Formatter | None) -> None:  # noqa: N802 - nome da biblioteca
        super().setFormatter(fmt)
        self.target.setFormatter(fmt)

    def emit(self, record: logging.LogRecord) -> None:
        # O texto é fechado aqui (os argumentos podem mudar depois), mas nada que toque o destino.
        try:
            snapshot = copy.copy(record)
            snapshot.msg = record.getMessage()
            snapshot.args = None
            if record.exc_info and not record.exc_text:
                snapshot.exc_text = self._plain.formatException(record.exc_info)
            snapshot.exc_info = None
            self._queue.put_nowait(snapshot)
        except queue.Full:
            self.dropped += 1
        except Exception:
            self.handleError(record)

    def drain(self, timeout: float = DRAIN_SECONDS) -> bool:
        """Espera a fila esvaziar (testes e encerramento). `False` se o destino não acompanhou."""
        done = threading.Event()

        def wait() -> None:
            self._queue.join()
            done.set()

        threading.Thread(target=wait, name="log-offload-drain", daemon=True).start()
        return done.wait(timeout)

    def flush(self) -> None:
        # `logging.shutdown()` chama `flush()` e depois `close()` em cada destino: o que está na
        # fila é escrito antes de o processo sair, sem passar do prazo (destino travado não segura).
        self.drain(self._drain)

    def close(self) -> None:
        # O marcador de fim espera um lugar na fila (com prazo): descartá-lo deixaria a thread
        # viva e a fila sem esvaziar.
        deadline = time.monotonic() + self._drain
        try:
            self._queue.put(None, timeout=max(0.05, deadline - time.monotonic()))
        except queue.Full:
            pass
        self._thread.join(max(0.05, deadline - time.monotonic()))
        if not self._thread.is_alive():
            self.target.close()
        super().close()

    def _pump(self) -> None:
        while True:
            record = self._queue.get()
            try:
                if record is None:
                    return
                with contextlib.suppress(Exception):
                    # `handle` já trata erro de escrita; isto só protege a thread de uma falha
                    # imprevista.
                    self.target.handle(record)
                self._report_drops()
            finally:
                self._queue.task_done()

    def _report_drops(self) -> None:
        lost, self.dropped = self.dropped, 0
        if not lost:
            return
        note = logging.LogRecord(
            _log.name,
            logging.WARNING,
            __file__,
            0,
            "o destino do registro travou por um tempo: %d linhas foram descartadas",
            (lost,),
            None,
        )
        note.msg = note.getMessage()
        note.args = None
        try:
            self.target.handle(note)
        except Exception:
            return
