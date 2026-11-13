r"""Os ids de `POWER` já aceitos, guardados em `runtime` (`power-ids.json`).

`POWER` é um interruptor: um reenvio do mesmo id depois de o agente reiniciar (ou de o PC passar
dias hibernado) o executaria de novo e alternaria a TV. O arquivo é gravado de forma atômica
(arquivo temporário e `os.replace`) e nada aqui levanta erro: ausente, grande demais, corrompido ou
com outro formato vale como lista vazia, com um aviso no registro (o botão nunca pode travar por
causa dele); disco cheio ou sem permissão vale como "não consegui gravar" e vai ao registro como
erro, com a causa (o POWER executa assim mesmo: recusar o botão por falha de disco seria pior).
"""

import json
import logging
import math
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

POWER_IDS_FILE: Final = "power-ids.json"
# 1000 ids de 36 caracteres com a hora ficam em ~70 KB; o dobro disso já não é arquivo nosso.
_MAX_BYTES: Final = 256 * 1024
_MAX_ID_LENGTH: Final = 128


class PowerIdFile:
    def __init__(self, runtime: Path) -> None:
        self._path = runtime / POWER_IDS_FILE

    def load(self) -> dict[str, float]:
        try:
            if self._path.stat().st_size > _MAX_BYTES:
                raise ValueError("arquivo grande demais")
            data = json.loads(self._path.read_text(encoding="utf-8-sig"))
            raw = data["ids"]
            if not isinstance(raw, dict):
                raise TypeError("ids não é um objeto")
        except FileNotFoundError:
            return {}
        except OSError, ValueError, TypeError, KeyError:
            # `UnicodeDecodeError` e `JSONDecodeError` são `ValueError`; um JSON que não é objeto
            # dá `TypeError` ou `KeyError`.
            _log.warning("lembrança dos POWER ilegível; seguindo sem ela", exc_info=True)
            return {}
        ids: dict[str, float] = {}
        for key, stamp in raw.items():
            if (
                isinstance(key, str)
                and 0 < len(key) <= _MAX_ID_LENGTH
                and isinstance(stamp, int | float)
                and not isinstance(stamp, bool)
                and math.isfinite(stamp)
            ):
                ids[key] = float(stamp)
        return ids

    def save(self, ids: Mapping[str, float]) -> bool:
        temporary = self._path.with_name(self._path.name + ".tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps({"ids": dict(ids)}), encoding="utf-8")
            os.replace(temporary, self._path)
        except OSError:
            # Aceito: o POWER executa mesmo assim, com o id só em memória (um reinício o esquece).
            _log.error(
                "não consegui gravar a lembrança dos POWER; o POWER segue com o id só em memória",
                exc_info=True,
            )
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                _log.debug("não consegui apagar o arquivo temporário dos POWER")
            return False
        return True
