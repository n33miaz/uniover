"""Tarefas de fundo supervisionadas: nenhuma morre calada e as que são laços voltam sozinhas.

Antes, uma tarefa de fundo (`asyncio.create_task`) que levantava exceção só aparecia quando o agente
encerrava, no `gather` final: até lá ela estava morta e ninguém sabia (por exemplo o vigia que
hiberna a sessão com a TV). Aqui cada uma roda dentro de um laço que registra a causa com a pilha
(no registro local) e como ocorrência de diagnóstico, espera com recuo crescente e recomeça.
"""

import asyncio
import logging
from collections.abc import Callable, Coroutine
from typing import Any, Final

from uniover_agent.core.diagnostics import DiagnosticsRecorder, component_safe
from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

FIRST_DELAY_SECONDS: Final = 1.0
MAX_DELAY_SECONDS: Final = 300.0
# Rodou este tempo sem cair: a falha seguinte volta a esperar pouco.
STABLE_SECONDS: Final = 60.0


class TaskHealth:
    """Quantas vezes cada tarefa de fundo caiu na última hora (o auto-diagnóstico lê daqui)."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._failures: dict[str, list[float]] = {}

    def note_failure(self, name: str) -> None:
        self._failures.setdefault(name, []).append(self._clock.monotonic())

    def recent_failures(self, within: float = 3600.0) -> dict[str, int]:
        now = self._clock.monotonic()
        counts: dict[str, int] = {}
        for name, moments in self._failures.items():
            recent = [moment for moment in moments if now - moment < within]
            self._failures[name] = recent
            if recent:
                counts[name] = len(recent)
        return counts


async def run_supervised(  # noqa: PLR0913 - recuo, relógio e destino do aviso, todos injetados
    name: str,
    job: Callable[[], Coroutine[Any, Any, Any]],
    *,
    clock: Clock,
    recorder: DiagnosticsRecorder | None = None,
    health: TaskHealth | None = None,
    first_delay: float = FIRST_DELAY_SECONDS,
    max_delay: float = MAX_DELAY_SECONDS,
    stable_after: float = STABLE_SECONDS,
) -> bool:
    """Roda `job` até ele terminar sozinho (devolve `True`) ou a tarefa ser cancelada.

    Exceção não encerra: registra e recomeça depois de uma espera que dobra a cada falha seguida
    (até `max_delay`) e volta ao início se a tarefa viveu `stable_after` sem cair. Só o cancelamento
    passa.
    """
    delay = first_delay
    while True:
        started = clock.monotonic()
        try:
            await job()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if clock.monotonic() - started >= stable_after:
                delay = first_delay
            _log.exception(
                "a tarefa de fundo %s falhou; recomeça em %.0f s",
                name,
                delay,
                extra={"recorded": True},
            )
            if health is not None:
                health.note_failure(name)
            if recorder is not None:
                recorder.record(
                    "background.failed",
                    "error",
                    f"a tarefa {name} falhou e foi reiniciada",
                    component=component_safe(name),
                    error=exc,
                )
            await clock.sleep(delay)
            delay = min(max_delay, delay * 2)
            continue
        return True


async def keep_running(
    name: str,
    job: Callable[[], Coroutine[Any, Any, None]],
    *,
    clock: Clock,
    recorder: DiagnosticsRecorder | None = None,
    health: TaskHealth | None = None,
) -> None:
    """Como `run_supervised`, para laços que não deviam terminar: se terminar, avisa no registro."""
    finished = await run_supervised(name, job, clock=clock, recorder=recorder, health=health)
    if finished:
        _log.warning("a tarefa de fundo %s terminou por conta própria", name)
