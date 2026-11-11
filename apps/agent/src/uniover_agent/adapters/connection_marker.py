r"""Marca de quando esta execução conectou: `runtime\connected.json`.

O supervisor do Windows lê a marca para medir a janela de uma atualização (do instante em que a
versão nova entrou até ela estar conectada e, na passagem sem queda, até ela virar a dona da TV
e do PC).
Só informativo: nada aqui decide atualizar, reverter ou reiniciar, e nada levanta erro.

Escrita por arquivo temporário e `os.replace` (o leitor nunca vê meio arquivo).
"""

import json
import logging
import os
import re
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

_log = logging.getLogger(__name__)

MARKER_FILE: Final = "connected.json"
TOKEN_ENV: Final = "UNIOVER_WINDOW_TOKEN"  # noqa: S105 - nome de variável, não um segredo


def _now() -> datetime:
    return datetime.now(UTC)


def _stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class ConnectionMarker:
    def __init__(
        self,
        runtime: Path,
        *,
        pid: int | None = None,
        now: Callable[[], datetime] = _now,
    ) -> None:
        self._path = runtime / MARKER_FILE
        self._pid = pid if pid is not None else os.getpid()
        self._now = now
        self._data: dict[str, Any] = {"pid": self._pid}
        # O supervisor passa um código só ao processo da passagem para reconhecer a marca dele: o
        # pid que ele conhece é o do `uv`, e o deste processo é o do Python que o `uv` abriu.
        token = os.environ.get(TOKEN_ENV, "")
        if re.fullmatch(r"[0-9a-f]{32}", token):
            self._data["token"] = token

    def connected(self, *, refresh: bool = False) -> None:
        """A primeira conexão deste processo, ou a confirmação renovada da passagem.

        Na passagem, um 4409 pode derrubar uma candidatura antes do ACK seguinte. O prazo para a
        candidata tomar a instalação recomeça nesse ACK, portanto a marca também precisa
        representar essa confirmação, e não a tentativa anterior. Nas reconexões comuns a primeira
        marca continua sendo a medida da janela de reinício.
        """
        if not refresh and "connectedAt" in self._data:
            return
        self._data["connectedAt"] = _stamp(self._now())
        self._write()

    def ready(self) -> None:
        """Esta execução já é a dona da TV e do PC (a anterior saiu e a nova abriu o que há)."""
        if "readyAt" in self._data:
            return
        self._data["readyAt"] = _stamp(self._now())
        self._write()

    def _write(self) -> None:
        temp = self._path.with_name(self._path.name + ".tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temp.write_text(json.dumps(self._data, sort_keys=True), encoding="utf-8")
            os.replace(temp, self._path)
        except OSError as exc:
            _log.warning("não consegui gravar a marca de conexão (%s)", type(exc).__name__)
