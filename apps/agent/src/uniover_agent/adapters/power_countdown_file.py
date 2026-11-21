r"""A contagem de desligar ou reiniciar em andamento, marcada em `runtime` (`power-countdown.json`).

A contagem vive só na memória do agente: se ele reiniciar no meio (atualização, queda, o dono
fechou), o PC não desliga e ninguém fica sabendo. A marca diz só qual ação estava contando e o
id opaco da contagem (nada de quem pediu): o agente que sobe e a acha registra no log e avisa a API
que a contagem se perdeu. Ela é apagada quando a contagem acaba: cancelada, ou entregue ao
Windows (antes de pedir, para um desligamento bem-sucedido nunca parecer perdido no logon).

A marca leva o número do processo: o agente recomeça `run` no mesmo processo (a TV mudou de
endereço), e o temporizador da montagem anterior segue vivo nele e ainda vai pedir ao Windows. Uma
marca do próprio processo não é contagem perdida: fica, e quem a apaga é esse temporizador.

Gravada de forma atômica (arquivo temporário e `os.replace`); nada aqui levanta erro. Falha de
disco só perde o aviso do reinício: a contagem segue igual.
"""

import json
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

POWER_COUNTDOWN_FILE: Final = "power-countdown.json"
_ACTIONS: Final = frozenset({"SHUTDOWN", "RESTART"})
_MAX_BYTES: Final = 4 * 1024
_MAX_ID: Final = 64


class PowerCountdownFile:
    def __init__(self, runtime: Path, pid: Callable[[], int] = os.getpid) -> None:
        self._path = runtime / POWER_COUNTDOWN_FILE
        self._pid = pid

    def save(self, action: str, countdown_id: str) -> None:
        temporary = self._path.with_name(self._path.name + ".tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(
                json.dumps({"action": action, "id": countdown_id, "pid": self._pid()}),
                encoding="utf-8",
            )
            os.replace(temporary, self._path)
        except OSError:
            _log.warning(
                "não consegui marcar a contagem de energia; um reinício no meio dela não será "
                "avisado",
                exc_info=True,
            )
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                _log.debug("não consegui apagar o arquivo temporário da contagem")

    def clear(self) -> None:
        try:
            self._path.unlink(missing_ok=True)
        except OSError:
            _log.warning("não consegui apagar a marca da contagem de energia", exc_info=True)

    def take(self) -> tuple[str, str] | None:
        """A ação e o id da contagem que corria quando o agente anterior parou, ou `None`; a marca
        sai."""
        try:
            if self._path.stat().st_size > _MAX_BYTES:
                raise ValueError("arquivo grande demais")
            data = json.loads(self._path.read_text(encoding="utf-8-sig"))
            action = data["action"] if isinstance(data, dict) else None
            identifier = data["id"] if isinstance(data, dict) else None
        except FileNotFoundError:
            return None
        except OSError, ValueError, KeyError:
            _log.warning("marca da contagem de energia ilegível; descartada", exc_info=True)
            action = identifier = data = None
        if isinstance(data, dict) and data.get("pid") == self._pid():
            return None  # deste mesmo processo: a contagem ainda está viva (ver acima)
        self.clear()
        if not isinstance(action, str) or action not in _ACTIONS:
            return None
        if not isinstance(identifier, str) or not 0 < len(identifier) <= _MAX_ID:
            return None
        return action, identifier
