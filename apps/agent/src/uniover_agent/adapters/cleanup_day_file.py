r"""Em que dia a limpeza leve automática da TV já foi avaliada, guardado em `runtime`.

Sem isto o "já avaliei hoje" vivia só na memória e cada reinício do agente (o canal de
desenvolvimento reinicia várias vezes por dia) repetia a limpeza do dia. O arquivo é minúsculo
(`{"light": "2026-11-05"}`) e nada aqui levanta erro: é uma marca de conveniência, e ela nunca pode
impedir o agente de subir nem de limpar. Arquivo ausente, grande demais, corrompido ou com outro
formato vale como "não sei"; disco cheio ou sem permissão vale como "não consegui gravar" e vai ao
registro.
"""

import json
import logging
import os
from datetime import date
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

CLEANUP_DAY_FILE: Final = "cleanup-day.json"
_MAX_BYTES: Final = 1024


class CleanupDayFile:
    def __init__(self, runtime: Path) -> None:
        self._path = runtime / CLEANUP_DAY_FILE

    def load(self) -> date | None:
        try:
            if self._path.stat().st_size > _MAX_BYTES:
                return None
            data = json.loads(self._path.read_text(encoding="utf-8-sig"))
            return date.fromisoformat(data["light"])
        except OSError, ValueError, TypeError, KeyError:
            # `UnicodeDecodeError` e `JSONDecodeError` são `ValueError`; um JSON que não é objeto
            # dá `TypeError` ou `KeyError`; um dia que não é texto, `TypeError`.
            return None

    def save(self, day: date) -> None:
        temporary = self._path.with_name(self._path.name + ".tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps({"light": day.isoformat()}), encoding="utf-8")
            os.replace(temporary, self._path)
        except OSError:
            # Disco cheio, pasta somente leitura ou arquivo preso por outro programa.
            _log.warning("não consegui gravar o dia da limpeza da TV", exc_info=True)
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                _log.debug("não consegui apagar o arquivo temporário do dia da limpeza")
