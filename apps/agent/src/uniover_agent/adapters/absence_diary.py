"""Diário de presença: explica, no registro local, por que o agente ficou fora do ar.

O agente grava a cada minuto "estava vivo às X". Ao subir (ou reconectar) depois de uma ausência
longa, compara com o relógio e com o tempo ligado do Windows e registra o motivo provável: PC
reiniciado, PC suspenso/desligado ou só rede/servidor. É só registro local (enviar à API seria um
contrato novo); a linha entra no `agent.log`, que o dono já consulta pelo envio de logs.
"""

import logging
import sys
from collections.abc import Callable
from pathlib import Path

from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

BEAT_SECONDS = 60.0
# Abaixo disto é uma queda comum de conexão, sem nada a explicar.
LONG_ABSENCE_SECONDS = 180.0


def windows_uptime_seconds() -> float | None:
    """Tempo desde que o Windows ligou (`GetTickCount64`); `None` fora do Windows."""
    if sys.platform != "win32":
        return None
    import ctypes  # noqa: PLC0415 - só existe no Windows

    function = ctypes.windll.kernel32.GetTickCount64
    function.restype = ctypes.c_uint64
    return float(function()) / 1000.0


def likely_reason(absence: float, uptime: float | None, *, process_restarted: bool) -> str:
    """Motivo mais provável de uma ausência de `absence` segundos."""
    minutes = absence / 60
    if process_restarted and uptime is not None and uptime < absence:
        return (
            f"o PC foi ligado ou reiniciado há {uptime / 60:.0f} min (o agente ficou "
            f"{minutes:.0f} min fora; sem logon ele não sobe)"
        )
    if process_restarted:
        return (
            f"o agente ficou parado por {minutes:.0f} min com o PC ligado "
            "(encerrado, atualização ou suspensão do PC)"
        )
    return f"a conexão com a API ficou fora por {minutes:.0f} min (rede ou servidor)"


class AbsenceDiary:
    def __init__(
        self,
        path: Path,
        clock: Clock,
        uptime: Callable[[], float | None] = windows_uptime_seconds,
    ) -> None:
        self._path = path
        self._clock = clock
        self._uptime = uptime
        self._lost_at: float | None = None
        self.reasons: list[str] = []

    def start(self) -> None:
        """Lê a última marca da execução anterior e explica o intervalo, se foi longo."""
        try:
            previous: float | None = float(self._path.read_text(encoding="ascii").strip())
        except OSError, ValueError:
            previous = None
        self.beat()
        if previous is None:
            return
        gap = self._clock.now().timestamp() - previous
        if gap >= LONG_ABSENCE_SECONDS:
            self._report(likely_reason(gap, self._uptime(), process_restarted=True))

    def beat(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(f"{self._clock.now().timestamp():.0f}", encoding="ascii")
        except OSError:
            return

    def disconnected(self) -> None:
        self._lost_at = self._clock.monotonic()

    def connected(self) -> None:
        if self._lost_at is None:
            return
        gap = self._clock.monotonic() - self._lost_at
        self._lost_at = None
        if gap >= LONG_ABSENCE_SECONDS:
            self._report(likely_reason(gap, self._uptime(), process_restarted=False))

    async def run(self) -> None:
        """Marca de vida a cada minuto, para a próxima execução saber quando esta parou."""
        while True:
            await self._clock.sleep(BEAT_SECONDS)
            self.beat()

    def _report(self, reason: str) -> None:
        self.reasons.append(reason)
        _log.warning("de volta depois de uma ausência longa: %s", reason)
