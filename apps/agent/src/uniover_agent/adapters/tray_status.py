"""Estado pequeno, sem segredo, que o ícone da bandeja consulta."""

import json
import os
import threading
from pathlib import Path
from typing import Literal
from uuid import uuid4

from uniover_agent.core.domain import TvState


def status_path() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    base = Path(local) if local else Path.home() / ".config"
    return base / "UniOver" / "runtime" / "tray-status.json"


class TrayStatus:
    """Grava por troca atômica para que a bandeja nunca leia JSON pela metade."""

    def __init__(self, tv_name: str) -> None:
        self._path = status_path()
        self._tv_name = tv_name
        self._connected = False
        self._power: Literal["on", "off", "unknown"] = "unknown"
        self._lock = threading.Lock()
        self.write()

    def write(self) -> None:
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._path.with_name(f"{self._path.name}.{uuid4().hex}.new")
            try:
                temporary.write_text(
                    json.dumps(
                        {
                            "connected": self._connected,
                            "power": self._power,
                            "tv_name": self._tv_name,
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                temporary.replace(self._path)
            except OSError:
                # A bandeja pode estar lendo o arquivo sem compartilhar a troca no Windows.
                # O próximo evento atualiza o estado; o processo que controla a TV não para.
                temporary.unlink(missing_ok=True)

    def connected(self) -> None:
        self._connected = True
        self.write()

    def disconnected(self) -> None:
        self._connected = False
        self.write()

    def tv_state(self, state: TvState) -> None:
        self._power = state.power
        self.write()
