"""Estado pequeno, sem segredo, que o ícone da bandeja consulta."""

import json
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.update_status import FileUpdateStatus, default_status_path
from uniover_agent.config import agent_source_dir
from uniover_agent.core.domain import TvState
from uniover_agent.core.tray_model import TrayInputs
from uniover_agent.core.update_report import parse_time


def status_path() -> Path:
    return installation_base() / "runtime" / "tray-status.json"


class TrayStatus:
    """Grava por troca atômica para que a bandeja nunca leia JSON pela metade."""

    def __init__(self, tv_name: str) -> None:
        self._path = status_path()
        self._tv_name = tv_name
        self._connected = False
        # Quando `connected` mudou pela última vez: a bandeja distingue "reconectando" de "sem
        # conexão" por ele.
        self._since = datetime.now(UTC)
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
                            "since": self._since.isoformat(timespec="seconds"),
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                temporary.replace(self._path)
            except OSError:
                # A bandeja pode estar lendo o arquivo sem compartilhar a troca no Windows. O
                # próximo evento atualiza o estado; o processo que controla a TV não para.
                temporary.unlink(missing_ok=True)

    def connected(self) -> None:
        self._change(True)

    def disconnected(self) -> None:
        self._change(False)

    def _change(self, connected: bool) -> None:
        if self._connected != connected:
            self._since = datetime.now(UTC)
        self._connected = connected
        self.write()

    def tv_state(self, state: TvState) -> None:
        self._power = state.power
        self.write()


def heartbeat_age(now: datetime) -> timedelta | None:
    """Há quanto tempo o agente regravou o `last-alive` (a cada minuto); `None` se ele nunca
    existiu."""
    try:
        stamp = (installation_base() / "runtime" / "last-alive").stat().st_mtime
    except OSError:
        return None
    return max(timedelta(0), now - datetime.fromtimestamp(stamp, UTC))


def read_tray_inputs(now: datetime) -> TrayInputs:
    """Junta o que a bandeja consulta: estado da conexão e da TV, atualização e sinal de vida. Nunca
    levanta."""
    raw: dict[str, Any] = {}
    try:
        decoded: object = json.loads(status_path().read_text(encoding="utf-8"))
        if isinstance(decoded, dict):
            raw = decoded
    except OSError, ValueError:
        pass
    update = FileUpdateStatus(default_status_path(), agent_source_dir()).read()
    return TrayInputs(
        now=now,
        connected=raw.get("connected") is True,
        since=parse_time(raw.get("since")),
        power=str(raw.get("power") or "unknown"),
        tv_name=str(raw.get("tv_name") or "TV"),
        update_outcome=update.outcome,
        update_checked_at=parse_time(update.checked_at),
        heartbeat_age=heartbeat_age(now),
    )
