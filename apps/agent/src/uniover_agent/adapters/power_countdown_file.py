r"""A contagem de desligar ou reiniciar em andamento, marcada em `runtime` (`power-countdown.json`).

A contagem vive só na memória do agente: se ele reiniciar no meio (atualização, queda, o dono
fechou), o PC não desliga e ninguém fica sabendo. A marca diz só qual ação estava contando e o
id opaco da contagem (nada de quem pediu): o agente que sobe e a acha registra no log e avisa a API
que a contagem se perdeu. Ela é apagada quando a contagem acaba: cancelada, ou entregue ao
Windows (antes de pedir, para um desligamento bem-sucedido nunca parecer perdido no logon).

A marca leva o número do processo: o agente recomeça `run` no mesmo processo (a TV mudou de
endereço), e o temporizador da montagem anterior segue vivo nele e ainda vai pedir ao Windows. Uma
marca do próprio processo não é contagem perdida: fica, e quem a apaga é esse temporizador.

A contagem perdida achada na partida passa para a sua própria lista (`power-countdown-lost.json`)
antes de a marca sair: uma contagem nova regrava a marca, e o aviso da perdida não pode sumir com
isso. Ela sai da lista só quando a API confirma que gravou o aviso (`confirm_lost`); até lá, cada
partida (e cada remontagem) a avisa de novo, e a API descarta a repetição.

Gravada de forma atômica (arquivo temporário e `os.replace`); nada aqui levanta erro. Falha de
disco só perde o aviso do reinício: a contagem segue igual.
"""

import json
import logging
import os
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

POWER_COUNTDOWN_FILE: Final = "power-countdown.json"
POWER_COUNTDOWN_LOST_FILE: Final = "power-countdown-lost.json"
_ACTIONS: Final = frozenset({"SHUTDOWN", "RESTART"})
_MAX_BYTES: Final = 4 * 1024
_MAX_ID: Final = 64
# Quantas contagens perdidas esperam a confirmação da API, no máximo (as mais antigas saem).
LOST_CAPACITY: Final = 4
# Uma trava por processo: cada remontagem cria o seu objeto, e a confirmação chega de outra thread.
_LOST_LOCK: Final = threading.Lock()


class PowerCountdownFile:
    def __init__(self, runtime: Path, pid: Callable[[], int] = os.getpid) -> None:
        self._path = runtime / POWER_COUNTDOWN_FILE
        self._lost = runtime / POWER_COUNTDOWN_LOST_FILE
        self._pid = pid

    def save(self, action: str, countdown_id: str) -> None:
        if not self._write(self._path, {"action": action, "id": countdown_id, "pid": self._pid()}):
            _log.warning(
                "não consegui marcar a contagem de energia; um reinício no meio dela não será "
                "avisado"
            )

    def clear(self) -> None:
        try:
            self._path.unlink(missing_ok=True)
        except OSError:
            _log.warning("não consegui apagar a marca da contagem de energia", exc_info=True)

    def take_lost(self) -> list[tuple[str, str]]:
        """A ação e o id de cada contagem perdida cujo aviso a API ainda não confirmou: as de
        partidas anteriores e a que corria quando o agente anterior parou (a marca dela passa para
        a lista e sai)."""
        with _LOST_LOCK:
            lost = self._read_lost()
            running = self._read_running()
            if running is None:
                return lost
            if running not in lost:
                kept = [*lost, running][-LOST_CAPACITY:]
                if not self._write(self._lost, [{"action": a, "id": i} for a, i in kept]):
                    # Sem a lista, a marca fica: a próxima partida tenta de novo.
                    _log.warning("não consegui guardar a contagem perdida até a API confirmar")
                    return [*lost, running]
                lost = kept
            self.clear()
            return lost

    def confirm_lost(self, countdown_id: str) -> None:
        """A API confirmou o aviso da contagem perdida `countdown_id`: ela sai da lista."""
        with _LOST_LOCK:
            lost = self._read_lost()
            rest = [
                (action, identifier) for action, identifier in lost if identifier != countdown_id
            ]
            if len(rest) == len(lost):
                return
            if rest:
                self._write(self._lost, [{"action": a, "id": i} for a, i in rest])
                return
            try:
                self._lost.unlink(missing_ok=True)
            except OSError:
                _log.warning("não consegui apagar a lista das contagens perdidas", exc_info=True)

    def _read_running(self) -> tuple[str, str] | None:
        """A contagem da marca, se ela é de outro processo (perdida); a marca ilegível sai."""
        try:
            data = self._load(self._path)
        except FileNotFoundError:
            return None
        except OSError, ValueError:
            _log.warning("marca da contagem de energia ilegível; descartada", exc_info=True)
            self.clear()
            return None
        if isinstance(data, dict) and data.get("pid") == self._pid():
            return None  # deste mesmo processo: a contagem ainda está viva (ver acima)
        entry = _entry(data)
        if entry is None:
            self.clear()
        return entry

    def _read_lost(self) -> list[tuple[str, str]]:
        try:
            data = self._load(self._lost)
        except FileNotFoundError:
            return []
        except OSError, ValueError:
            _log.warning("lista das contagens perdidas ilegível; descartada", exc_info=True)
            return []
        if not isinstance(data, list):
            return []
        entries = [entry for entry in map(_entry, data) if entry is not None]
        return entries[-LOST_CAPACITY:]

    @staticmethod
    def _load(path: Path) -> object:
        if path.stat().st_size > _MAX_BYTES:
            raise ValueError("arquivo grande demais")
        return json.loads(path.read_text(encoding="utf-8-sig"))

    @staticmethod
    def _write(path: Path, data: object) -> bool:
        temporary = path.with_name(path.name + ".tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps(data), encoding="utf-8")
            os.replace(temporary, path)
        except OSError:
            _log.debug("falha ao gravar %s", path.name, exc_info=True)
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                _log.debug("não consegui apagar o arquivo temporário da contagem")
            return False
        return True


def _entry(data: object) -> tuple[str, str] | None:
    """A ação e o id de uma marca, se ela é válida."""
    if not isinstance(data, dict):
        return None
    action, identifier = data.get("action"), data.get("id")
    if not isinstance(action, str) or action not in _ACTIONS:
        return None
    if not isinstance(identifier, str) or not 0 < len(identifier) <= _MAX_ID:
        return None
    return action, identifier
