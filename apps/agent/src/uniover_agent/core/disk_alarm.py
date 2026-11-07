"""Alarme de espaço em disco: avisa uma vez por episódio, e de novo quando o espaço volta.

Disco cheio já derrubou o agente: as atualizações não cabem, o ambiente Python não pode ser refeito
e até gravar o registro falha. O supervisor se defende (nada de atualizar nem de apagar o ambiente),
mas ninguém ficava sabendo. Aqui o agente confere o espaço livre do disco da instalação de tempos em
tempos e registra uma ocorrência quando ele **piora** de nível, para a tela do administrador
mostrar:

- `ok`: espaço de sobra;
- `warn`: abaixo do aviso (padrão 2 GB);
- `critical`: abaixo do mínimo para atualizar (o mesmo do supervisor, 600 MB).

Uma ocorrência por mudança de nível (nunca uma por conferência) e uma de volta ao normal. A melhora
exige uma folga acima do limiar (`margin_bytes`), senão um disco que oscila na linha geraria um
aviso a cada conferência.

Nada aqui levanta erro: é aviso, e aviso não pode ser a causa de falha.
"""

import asyncio
import logging
from collections.abc import Callable
from typing import Final, Literal

from uniover_agent.core.diagnostics import DiagnosticsRecorder
from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

Level = Literal["ok", "warn", "critical"]

FIRST_RUN_SECONDS: Final = 60.0
INTERVAL_SECONDS: Final = 300.0
DEFAULT_MARGIN_BYTES: Final = 128 * 1024 * 1024
_RANK: Final[dict[Level, int]] = {"ok": 0, "warn": 1, "critical": 2}
_MIB: Final = 1024 * 1024


def _megabytes(value: int) -> int:
    return value // _MIB


class DiskAlarm:
    def __init__(  # noqa: PLR0913 - limiares, tempos e dependências injetados, todos nomeados
        self,
        free_bytes: Callable[[], int | None],
        recorder: DiagnosticsRecorder,
        clock: Clock,
        *,
        warn_bytes: int,
        critical_bytes: int,
        margin_bytes: int = DEFAULT_MARGIN_BYTES,
        interval: float = INTERVAL_SECONDS,
        first_run: float = FIRST_RUN_SECONDS,
    ) -> None:
        self._free_bytes = free_bytes
        self._recorder = recorder
        self._clock = clock
        # O aviso nunca fica abaixo do crítico, por mais que a configuração se confunda.
        self._warn = max(warn_bytes, critical_bytes)
        self._critical = critical_bytes
        self._margin = margin_bytes
        self._interval = interval
        self._first_run = first_run
        self._level: Level = "ok"

    @property
    def level(self) -> Level:
        return self._level

    def _classify(self, free: int) -> Level:
        if free < self._critical:
            return "critical"
        return "warn" if free < self._warn else "ok"

    def _next_level(self, free: int) -> Level:
        worse = self._classify(free)
        if _RANK[worse] > _RANK[self._level]:
            return worse
        # Melhorar só vale com folga acima do limiar do nível de que se sai.
        better = self._classify(free - self._margin)
        if _RANK[better] < _RANK[self._level]:
            return better
        return self._level

    def check(self) -> Level:
        """Confere uma vez; registra se o nível mudou. Devolve o nível de agora."""
        try:
            free = self._free_bytes()
        except OSError:
            return self._level
        if free is None:
            return self._level
        new = self._next_level(free)
        if new != self._level:
            before, self._level = self._level, new
            self._report(before, new, free)
        return self._level

    def _report(self, before: Level, now: Level, free: int) -> None:
        megabytes = _megabytes(free)
        if now == "critical":
            self._recorder.record(
                "disk.low",
                "error",
                f"espaço em disco quase no fim: {megabytes} MB livres (mínimo para atualizar: "
                f"{_megabytes(self._critical)} MB); as atualizações ficam adiadas",
                component="disk",
            )
        elif now == "warn" and before == "ok":
            self._recorder.record(
                "disk.low",
                "warn",
                f"pouco espaço em disco: {megabytes} MB livres (aviso abaixo de "
                f"{_megabytes(self._warn)} MB)",
                component="disk",
            )
        elif now == "warn":
            self._recorder.record(
                "disk.low",
                "info",
                f"o espaço em disco voltou acima do mínimo para atualizar ({megabytes} MB "
                f"livres), mas segue abaixo de {_megabytes(self._warn)} MB",
                component="disk",
            )
        else:
            self._recorder.record(
                "disk.recovered",
                "info",
                f"o espaço em disco voltou ao normal ({megabytes} MB livres)",
                component="disk",
            )
        _log.info("espaço em disco: %s -> %s (%d MB livres)", before, now, megabytes)

    async def run(self) -> None:
        await self._clock.sleep(self._first_run)
        while True:
            try:
                await asyncio.to_thread(self.check)
            except Exception:
                _log.exception("falha ao conferir o espaço em disco; sigo vigiando")
            await self._clock.sleep(self._interval)
