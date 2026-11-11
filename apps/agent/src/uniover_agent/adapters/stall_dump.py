r"""Cão de guarda das paradas curtas do laço da entrada: grava a pilha de TODAS as threads no ato.

Medido em produção: os dois laços do agente (o principal e o da entrada do PC) param juntos por
0,3 a 4 s algumas vezes por hora, e um processo vizinho rodando ao mesmo tempo nunca parou. A causa
está dentro do processo (uma chamada de C que segura o GIL, uma coleta grande do GC, falta de
página), mas o registro só diz QUANTO parou, não ONDE. O `faulthandler.dump_traceback_later` roda
numa thread de C que não precisa do GIL: se o laço fica `STALL_SECONDS` sem re-armar o cão, ele
despeja a pilha de todas as threads em `logs\stalls.log` mesmo com o GIL preso.

Só diagnóstico. Há um único cão do `faulthandler` por processo: este é o único que usa o
`dump_traceback_later` (o `crash.log` usa `enable` e o `loop_watchdog` usa `dump_traceback`, que
são outros mecanismos e não entram em conflito).

Limites, para nunca virar ruído nem encher o disco: no máximo um despejo a cada 10 minutos, 20 por
dia e 2 MB no arquivo (ao passar, para de armar; na próxima execução o arquivo velho vira `.1`).
"""

import asyncio
import faulthandler
import logging
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Final, TextIO

_log = logging.getLogger(__name__)

STALL_FILE: Final = "stalls.log"
# A parada a partir da qual a pilha é gravada e a cadência do re-arme. Cada re-arme cria uma thread
# de C no CPython: 4 por segundo, e não 10, mantém o custo desprezível; as paradas medidas vão de
# 0,8 a 4 s, acima do prazo.
STALL_SECONDS: Final = 0.65
TICK_SECONDS: Final = 0.25
MIN_GAP_SECONDS: Final = 600.0
MAX_PER_DAY: Final = 20
MAX_FILE_BYTES: Final = 2 * 1024 * 1024


class DumpBudget:
    """Quanto despejo ainda cabe: um a cada `min_gap` s, `per_day` por dia e `max_bytes` no arquivo.

    Puro (relógio, dia e tamanho entram por parâmetro): é o que se testa sem esperar 10 minutos.
    """

    def __init__(
        self,
        *,
        min_gap: float = MIN_GAP_SECONDS,
        per_day: int = MAX_PER_DAY,
        max_bytes: int = MAX_FILE_BYTES,
    ) -> None:
        self._min_gap = min_gap
        self._per_day = per_day
        self._max_bytes = max_bytes
        self._last: float | None = None
        self._day = ""
        self._today = 0

    def allows(self, now: float, day: str, size: int) -> bool:
        """Pode armar o cão agora?"""
        if size >= self._max_bytes:
            return False
        if self._last is not None and now - self._last < self._min_gap:
            return False
        return not (day == self._day and self._today >= self._per_day)

    def record(self, now: float, day: str) -> None:
        """Um despejo aconteceu."""
        if day != self._day:
            self._day = day
            self._today = 0
        self._today += 1
        self._last = now


def format_stall_line(detected: str, stalled_ms: float) -> str:
    """A linha que vai logo depois da pilha (a pilha chega antes: só se sabe no tick seguinte)."""
    return (
        f"--- fim da pilha: parada detectada às {detected}, "
        f"laço sem responder por ~{stalled_ms:.0f} ms ---\n"
    )


def format_stall_log(stalled_ms: float) -> str:
    return f"pilha da trava gravada em {STALL_FILE} ({stalled_ms:.0f} ms)"


class StallDumper:
    """Re-arma o cão a cada volta do laço (`tick`); se o laço parar, a pilha vai para o arquivo."""

    def __init__(  # noqa: PLR0913 - tudo trocável para os testes
        self,
        logs: Path,
        *,
        stall: float = STALL_SECONDS,
        tick: float = TICK_SECONDS,
        budget: DumpBudget | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        today: Callable[[], str] = lambda: time.strftime("%Y-%m-%d"),
        stamp: Callable[[], str] = lambda: time.strftime("%Y-%m-%d %H:%M:%S"),
        arm: Callable[[float, TextIO], None] | None = None,
        disarm: Callable[[], None] = faulthandler.cancel_dump_traceback_later,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._path = logs / STALL_FILE
        self._stall = stall
        self._tick = tick
        self._budget = budget or DumpBudget()
        self._monotonic = monotonic
        self._today = today
        self._stamp = stamp
        self._arm = arm or _arm_faulthandler
        self._disarm = disarm
        self._sleep = sleep
        self._handle: TextIO | None = None
        self._armed = False
        self._last_tick: float | None = None
        self._seen = 0  # tamanho do arquivo já conferido
        self._growing: int | None = None  # tamanho visto no tick anterior, se estava crescendo
        self._gap = 0.0  # a demora do tick que viu o arquivo crescer
        self._broken = False
        self.dumps = 0

    @property
    def armed(self) -> bool:
        return self._armed

    def _open(self) -> bool:
        if self._handle is not None:
            return True
        if self._broken:
            return False
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            if self._path.exists() and self._path.stat().st_size >= MAX_FILE_BYTES:
                self._path.replace(self._path.with_name(STALL_FILE + ".1"))
            # Aberto uma vez e mantido: o `faulthandler` escreve no descritor sem pedir licença.
            self._handle = self._path.open("a", encoding="utf-8", newline="\n", buffering=1)
            self._seen = self._path.stat().st_size
        except OSError:
            _log.warning("não consegui abrir %s; sigo sem o cão das paradas", STALL_FILE)
            self._broken = True
            return False
        return True

    def _size(self) -> int:
        try:
            return self._path.stat().st_size
        except OSError:
            return self._seen

    def tick(self) -> None:
        """Uma volta do laço: confere se um despejo aconteceu e re-arma o cão (se ainda couber)."""
        if not self._open() or self._handle is None:
            return
        now = self._monotonic()
        gap = 0.0 if self._last_tick is None else now - self._last_tick
        self._last_tick = now
        # Só consulta o disco quando o laço demorou o bastante para o cão ter disparado (ou quando
        # o despejo ainda estava sendo gravado no tick anterior): fora isso, nenhuma chamada extra.
        if self._growing is not None or gap >= self._stall:
            self._check_dump(gap)
        if self._budget.allows(now, self._today(), self._seen):
            self._arm(self._stall, self._handle)
            self._armed = True
        elif self._armed:
            self._disarm()
            self._armed = False

    def _check_dump(self, gap: float) -> None:
        size = self._size()
        if size <= self._seen:
            self._growing = None
            return
        # A thread do cão ainda pode estar gravando: só vale quando o tamanho parou de crescer.
        if size != self._growing:
            self._growing = size
            self._gap = max(gap, self._gap)
            return
        self._growing = None
        self._seen = size
        stalled_ms = max(self._gap, gap, self._stall) * 1_000
        self._gap = 0.0
        self._budget.record(self._monotonic(), self._today())
        self.dumps += 1
        if self._handle is not None:
            try:
                self._handle.write(format_stall_line(self._stamp(), stalled_ms))
                self._seen = self._size()
            except OSError, ValueError:
                _log.debug("não consegui anotar a parada em %s", STALL_FILE, exc_info=True)
        _log.info(format_stall_log(stalled_ms))

    def close(self) -> None:
        """Desarma o cão e solta o arquivo (o `faulthandler` não pode mais escrever nele)."""
        if self._armed:
            self._disarm()
            self._armed = False
        handle, self._handle = self._handle, None
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass

    async def run(self) -> None:
        """Tarefa a rodar no laço vigiado (o da entrada do PC)."""
        try:
            while True:
                self.tick()
                await self._sleep(self._tick)
        finally:
            self.close()


def _arm_faulthandler(timeout: float, handle: TextIO) -> None:
    faulthandler.dump_traceback_later(timeout, repeat=False, file=handle, exit=False)
