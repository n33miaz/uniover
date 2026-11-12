"""Mede atrasos curtos do laço sem produzir ruído no registro."""

import asyncio
import gc
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from uniover_agent.adapters.process_memory import MemoryCounters, read_memory_counters

_log = logging.getLogger(__name__)

_MEGABYTE = 1024 * 1024
_GENERATIONS = 3
# Enquanto o conjunto de trabalho segue abaixo do piso, o aviso se repete a cada meia hora.
FLOOR_REPEAT_SECONDS = 1_800.0


class GcPauseTracker:
    """Quanto durou a maior coleta de cada geração do GC desde a última leitura.

    Uma coleta grande da geração 2 segura o GIL e para os dois laços ao mesmo tempo: é uma das
    suspeitas das paradas. O `gc.callbacks` avisa o início e o fim de cada coleta, na thread que a
    provocou (e uma coleta nunca se mistura com outra, pois o GIL a serializa).
    """

    def __init__(self, clock: Callable[[], float] = time.perf_counter) -> None:
        self._clock = clock
        self._started = 0.0
        self._longest = [0.0] * _GENERATIONS
        self._count = [0] * _GENERATIONS

    def callback(self, phase: str, info: dict[str, Any]) -> None:
        if phase == "start":
            self._started = self._clock()
            return
        generation = int(info.get("generation", 0))
        if 0 <= generation < _GENERATIONS:
            self._longest[generation] = max(
                self._longest[generation], self._clock() - self._started
            )
            self._count[generation] += 1

    def install(self) -> None:
        if self.callback not in gc.callbacks:
            gc.callbacks.append(self.callback)

    def uninstall(self) -> None:
        if self.callback in gc.callbacks:
            gc.callbacks.remove(self.callback)

    def take(self) -> tuple[float, tuple[int, ...]]:
        """A maior coleta da geração 2 (s) e quantas houve de cada geração; zera a janela."""
        longest, counts = self._longest[2], tuple(self._count)
        self._longest = [0.0] * _GENERATIONS
        self._count = [0] * _GENERATIONS
        return longest, counts


def format_extras(
    faults: int | None, working_set: int | None, gc_longest: float, gc_counts: tuple[int, ...]
) -> str:
    """O que se soma à linha de atraso: memória do processo e pausas do GC no minuto."""
    parts: list[str] = []
    if faults is not None:
        parts.append(f"falhas de página +{faults}")
    if working_set is not None:
        parts.append(f"conjunto de trabalho {working_set / _MEGABYTE:.0f} MB")
    counts = "/".join(map(str, gc_counts))
    parts.append(f"gc: gen2 máx {gc_longest * 1_000:.1f} ms; coletas g0/g1/g2 {counts}")
    return "; " + "; ".join(parts)


class LoopLagMonitor:
    """Registra, uma vez por minuto, somente atrasos relevantes de UM laço.

    O agente tem dois laços (o principal e o da entrada do PC): cada um roda o seu medidor, com o
    `name` que o identifica na linha do registro, para saber qual deles parou.
    """

    def __init__(  # noqa: PLR0913 - tudo opcional e trocável para os testes
        self,
        *,
        name: str = "principal",
        interval: float = 1.0,
        threshold: float = 0.25,
        report_every: float = 60.0,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        memory: Callable[[], MemoryCounters | None] = read_memory_counters,
        gc_pauses: GcPauseTracker | None = None,
        working_set_floor: int = 0,
        floor_repeat: float = FLOOR_REPEAT_SECONDS,
    ) -> None:
        """`working_set_floor` (bytes; 0 desliga): abaixo disto o conjunto de trabalho só cai
        porque o Windows (ou um limpador de memória) tirou o agente da memória, e isso é avisado
        na hora, com ou sem atraso no minuto. Um só medidor por processo deve ter o piso."""
        self._floor = working_set_floor
        self._floor_repeat = floor_repeat
        self._below_since: float | None = None
        self._floor_warned_at: float | None = None
        self._name = name
        self._interval = interval
        self._threshold = threshold
        self._report_every = report_every
        self._monotonic = monotonic
        self._sleep = sleep
        self._memory = memory
        self._gc = gc_pauses or GcPauseTracker()
        self._faults_before: int | None = None
        self._maximum = 0.0
        self._count = 0

    def observe(self, delay: float) -> None:
        """Acumula uma amostra; exposto para testar sem esperar um minuto."""
        if delay > self._threshold:
            self._maximum = max(self._maximum, delay)
            self._count += 1

    def _extras(self) -> str:
        """Falhas de página do minuto, conjunto de trabalho e pausas do GC (zera as janelas)."""
        longest, counts = self._gc.take()
        sample = self._memory()
        faults = working_set = None
        if sample is not None:
            working_set = sample.working_set_bytes
            if self._faults_before is not None:
                faults = sample.page_faults - self._faults_before
            self._faults_before = sample.page_faults
            self._check_floor(working_set, faults)
        return format_extras(faults, working_set, longest, counts)

    def _check_floor(self, working_set: int, faults: int | None) -> None:
        """Avisa quando o conjunto de trabalho cai abaixo do piso: uma vez ao cair e de novo a
        cada `floor_repeat` enquanto continuar abaixo; e uma linha quando volta."""
        if self._floor <= 0:
            return
        now = self._monotonic()
        if working_set >= self._floor:
            if self._below_since is not None:
                _log.info(
                    "conjunto de trabalho do agente de volta a %.0f MB (ficou abaixo de %.0f MB "
                    "por %.0f s)",
                    working_set / _MEGABYTE,
                    self._floor / _MEGABYTE,
                    now - self._below_since,
                )
            self._below_since = None
            self._floor_warned_at = None
            return
        if self._below_since is None:
            self._below_since = now
        if self._floor_warned_at is not None and now - self._floor_warned_at < self._floor_repeat:
            return
        self._floor_warned_at = now
        _log.warning(
            "o agente foi tirado da memória: conjunto de trabalho %.0f MB, abaixo do esperado "
            "(%.0f MB)%s; cada ação volta do disco e o controle pode parar por segundos (o "
            "Windows sob pouca memória ou um limpador de memória)",
            working_set / _MEGABYTE,
            self._floor / _MEGABYTE,
            f", falhas de página +{faults} no minuto" if faults is not None else "",
        )

    def report(self) -> None:
        # Sempre lê (mesmo sem atraso) para as janelas valerem só o último minuto; só escreve quando
        # há atraso, para não fazer ruído.
        extras = self._extras()
        if self._count:
            _log.info(
                "atraso do laço %s no último minuto: máximo %.0f ms em %d amostras%s",
                self._name,
                self._maximum * 1_000,
                self._count,
                extras,
            )
        self._maximum = 0.0
        self._count = 0

    async def run(self) -> None:
        sample = self._memory()
        self._faults_before = sample.page_faults if sample is not None else None
        self._gc.install()
        try:
            next_report = self._monotonic() + self._report_every
            while True:
                expected = self._monotonic() + self._interval
                await self._sleep(self._interval)
                now = self._monotonic()
                self.observe(max(0.0, now - expected))
                if now >= next_report:
                    self.report()
                    next_report = now + self._report_every
        finally:
            self._gc.uninstall()
