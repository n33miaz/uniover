r"""Vigia do laço de eventos: se ele para, deixa em `logs\crash.log` onde cada thread estava.

O agente já foi dado como "vivo e mudo" por mais de 10 minutos (o registro parou entre duas linhas
seguidas, sem nenhum erro): o processo existia, mas o laço de eventos estava parado dentro de uma
chamada síncrona. Quem reinicia um agente assim é o supervisor (o `last-alive` para de mudar), mas
o reinício apagava a única pista. Esta thread, que não depende do laço, o confere a cada poucos
segundos e, passado o prazo, grava a pilha de todas as threads. Só registra: nunca encerra o
processo (um PC suspenso e retomado pareceria uma parada).
"""

import asyncio
import faulthandler
import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

BEAT_SECONDS: Final = 1.0
CHECK_SECONDS: Final = 5.0
STALL_SECONDS: Final = 60.0
CRASH_FILE: Final = "crash.log"


def dump_all_threads(logs: Path, header: str) -> bool:
    """Acrescenta a pilha de todas as threads a `crash.log`; `False` se não deu para gravar."""
    try:
        logs.mkdir(parents=True, exist_ok=True)
        with (logs / CRASH_FILE).open("a", encoding="utf-8") as handle:
            handle.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} {header} ---\n")
            handle.flush()
            faulthandler.dump_traceback(file=handle, all_threads=True)
        return True
    except OSError, ValueError, RuntimeError:
        return False


class LoopWatchdog:
    def __init__(  # noqa: PLR0913 - tempos e destino injetáveis para o teste
        self,
        logs: Path,
        *,
        stall_after: float = STALL_SECONDS,
        check_every: float = CHECK_SECONDS,
        beat: float = BEAT_SECONDS,
        monotonic: Callable[[], float] = time.monotonic,
        dump: Callable[[Path, str], bool] = dump_all_threads,
    ) -> None:
        self._logs = logs
        self._stall_after = stall_after
        self._check_every = check_every
        self._beat = beat
        self._monotonic = monotonic
        self._dump = dump
        self._stamp = monotonic()
        self._dumped = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.dumps = 0

    async def run(self) -> None:
        """Tarefa do laço de eventos: só carimba a hora. Se o laço para, o carimbo envelhece."""
        self.start()
        try:
            while True:
                self._stamp = self._monotonic()
                await asyncio.sleep(self._beat)
        finally:
            self.stop()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stamp = self._monotonic()
        self._thread = threading.Thread(target=self._watch, name="loop-watchdog", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def check_now(self) -> None:
        """Uma conferência (a thread chama a cada `check_every`; o teste, direto)."""
        stalled = self._monotonic() - self._stamp
        if stalled < self._stall_after:
            self._dumped = False
            return
        if self._dumped:
            return
        # Sem `logging` aqui: se o travamento for dentro dele, esta thread travaria junto.
        # Só vale como feito se o arquivo foi gravado: disco cheio tenta de novo na próxima
        # conferência (e a próxima parada ainda gera o seu).
        if self._dump(self._logs, f"o laço de eventos está parado há {stalled:.0f} s"):
            self._dumped = True
            self.dumps += 1

    def _watch(self) -> None:
        while not self._stop.wait(self._check_every):
            try:
                self.check_now()
            except Exception:
                _log.debug("o vigia do laço falhou", exc_info=True)
