"""Estado pequeno, sem segredo, que o ícone da bandeja consulta."""

import asyncio
import json
import logging
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.update_status import FileUpdateStatus, default_status_path
from uniover_agent.config import agent_source_dir
from uniover_agent.core.domain import TvState
from uniover_agent.core.tray_model import TrayInputs
from uniover_agent.core.update_report import parse_time
from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

# Espera entre as novas tentativas de uma gravação que falhou (rodam fora do laço de eventos).
RETRY_DELAYS = (0.05, 0.1, 0.2)
# Regrava o estado mesmo sem mudança: uma gravação perdida se corrige sozinha.
REWRITE_SECONDS = 60.0
_READ_DELAYS = (0.02, 0.05, 0.1)


def status_path() -> Path:
    return installation_base() / "runtime" / "tray-status.json"


class TrayStatus:
    """Grava por troca atômica para que a bandeja nunca leia JSON pela metade."""

    def __init__(
        self,
        tv_name: str,
        clock: Clock | None = None,
        retry_delays: tuple[float, ...] = RETRY_DELAYS,
    ) -> None:
        self._path = status_path()
        self._tv_name = tv_name
        self._clock = clock or SystemClock()
        self._retry_delays = retry_delays
        self._connected = False
        # Quando `connected` mudou pela última vez: a bandeja distingue "reconectando" de "sem
        # conexão" por ele.
        self._since = datetime.now(UTC)
        self._power: Literal["on", "off", "unknown"] = "unknown"
        self._lock = threading.Lock()
        # Gravação que falhou e ainda não foi refeita: a próxima regravação periódica a cobre.
        self._dirty = False
        self._retrying = False
        self._retry_thread: threading.Thread | None = None
        self.write()

    @property
    def dirty(self) -> bool:
        return self._dirty

    def write(self) -> None:
        """Grava o estado atual. Nunca levanta nem dorme: se a troca falhar, refaz em segundo plano
        e deixa o estado marcado como pendente para a regravação periódica."""
        with self._lock:
            done = self._attempt()
            self._dirty = not done
            start = not done and not self._retrying
            if start:
                self._retrying = True
        if start:
            self._retry_thread = threading.Thread(
                target=self._retry, name="tray-status-retry", daemon=True
            )
            self._retry_thread.start()

    def wait_retries(self, timeout: float = 5.0) -> None:
        """Espera as novas tentativas em segundo plano terminarem (útil em testes)."""
        thread = self._retry_thread
        if thread is not None:
            thread.join(timeout)

    async def run(self) -> None:
        """Regrava o arquivo a cada minuto, mesmo sem mudança, para uma gravação perdida não deixar
        a bandeja com o estado velho."""
        while True:
            await self._clock.sleep(REWRITE_SECONDS)
            await asyncio.to_thread(self.write)

    def _retry(self) -> None:
        for index, delay in enumerate(self._retry_delays):
            time.sleep(delay)
            with self._lock:
                done = self._attempt()
                if done:
                    self._dirty = False
                if done or index == len(self._retry_delays) - 1:
                    self._retrying = False
                    return
        with self._lock:
            self._retrying = False

    def _attempt(self) -> bool:
        """Uma tentativa de gravação atômica; chamada com o `_lock` preso."""
        temporary = self._path.with_name(f"{self._path.name}.{uuid4().hex}.new")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
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
            # A bandeja pode estar lendo o arquivo sem compartilhar a troca no Windows.
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            return False
        return True

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


def read_state_text(path: Path) -> str:
    """Lê o arquivo de estado, repetindo por instantes se o Windows o negar.

    No Windows, a troca atômica do agente e uma leitura aberta se bloqueiam mutuamente (nem o
    compartilhamento de remoção ajuda: a troca por cima de um arquivo aberto é negada). Os dois
    lados são curtos, então repetir basta: aqui, a leitura; no agente, a gravação."""
    for delay in _READ_DELAYS:
        try:
            return path.read_text(encoding="utf-8")
        except PermissionError:
            time.sleep(delay)
    return path.read_text(encoding="utf-8")


def read_tray_inputs(now: datetime) -> TrayInputs:
    """Junta o que a bandeja consulta: estado da conexão e da TV, atualização e sinal de vida. Nunca
    levanta."""
    raw: dict[str, Any] = {}
    try:
        decoded: object = json.loads(read_state_text(status_path()))
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
