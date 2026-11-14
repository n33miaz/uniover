"""Quando cada endereço foi sondado pela última vez, guardado em `runtime`.

O limite de uma sonda por endereço a cada 5 minutos precisa durar a um reinício do agente (o canal
de desenvolvimento reinicia várias vezes por dia): sem isto cada partida sondaria de novo. O
arquivo é minúsculo (`{"probes": {"192.168.1.6:5555": 1794614651.4}}`, hora de parede) e nada aqui
levanta erro: é uma marca de conveniência, e ela nunca pode impedir o agente de subir. Arquivo
ausente, grande demais, corrompido ou com outro formato vale como "não sei"; disco cheio ou sem
permissão vale como "não consegui gravar" e vai ao registro. Quem grava o chama fora do laço de
eventos (ver `AdbSilentLink`).
"""

import json
import logging
import math
import os
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

PROBE_TIMES_FILE: Final = "adb-probe.json"
_MAX_BYTES: Final = 8192
_MAX_ENTRIES: Final = 32


class AdbProbeTimesFile:
    def __init__(self, runtime: Path) -> None:
        self._path = runtime / PROBE_TIMES_FILE

    def load(self) -> dict[str, float]:
        try:
            if self._path.stat().st_size > _MAX_BYTES:
                return {}
            data = json.loads(self._path.read_text(encoding="utf-8-sig"))
            probes = data["probes"]
            if not isinstance(probes, dict):
                return {}
            return {
                address: float(moment)
                for address, moment in list(probes.items())[:_MAX_ENTRIES]
                if isinstance(address, str)
                and isinstance(moment, int | float)
                and not isinstance(moment, bool)
                and math.isfinite(moment)
            }
        except OSError, ValueError, TypeError, KeyError:
            # `UnicodeDecodeError` e `JSONDecodeError` são `ValueError`; um JSON que não é objeto
            # dá `TypeError` ou `KeyError`.
            return {}

    def save(self, times: dict[str, float]) -> None:
        temporary = self._path.with_name(self._path.name + ".tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps({"probes": times}), encoding="utf-8")
            os.replace(temporary, self._path)
        except OSError:
            _log.warning("não consegui gravar o horário da sonda do ADB", exc_info=True)
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                _log.debug("não consegui apagar o arquivo temporário da sonda do ADB")
