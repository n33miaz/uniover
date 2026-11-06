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
# Quantas vezes o ciclo de novas tentativas recomeça enquanto o estado continua pendente.
RETRY_CYCLES = 3
# Regrava o estado mesmo sem mudança: uma gravação perdida se corrige sozinha.
REWRITE_SECONDS = 60.0
# Regravações seguidas que ainda deixam o estado pendente antes de o log avisar (uma por minuto).
STALE_WARN_AFTER = 3
# Uma sobra `.new` mais nova que isto pode ser de uma gravação em andamento.
ORPHAN_AGE_SECONDS = 60.0
_READ_DELAYS = (0.02, 0.05, 0.1)


def status_path() -> Path:
    return installation_base() / "runtime" / "tray-status.json"


class TrayStatus:
    """Grava por troca atômica para que a bandeja nunca leia JSON pela metade.

    Duas travas, para o laço de eventos nunca esperar por disco: `_state_lock` protege só os campos
    (fica presa por instantes) e `_io_lock` serializa as gravações. Quem chama de dentro do laço
    só tenta `_io_lock` sem esperar; se outra gravação está em curso, ela vê o estado pendente e
    regrava ao terminar."""

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
        self._state_lock = threading.Lock()
        self._io_lock = threading.Lock()
        # O arquivo pode estar diferente dos campos: falta gravar (ou a última gravação falhou).
        self._dirty = True
        self._retrying = False
        self._retry_thread: threading.Thread | None = None
        self._last_error = ""
        self._stale_rewrites = 0
        self._sweep_orphans()
        self.write()

    @property
    def dirty(self) -> bool:
        return self._dirty

    def write(self) -> None:
        """Grava o estado atual. Nunca levanta nem dorme: se a troca falhar, refaz em segundo plano
        e o estado fica pendente para a regravação periódica."""
        with self._state_lock:
            self._dirty = True
        self._flush(blocking=False)

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
            self._note_rewrite()

    def _note_rewrite(self) -> None:
        if not self._dirty:
            self._stale_rewrites = 0
            return
        self._stale_rewrites += 1
        if self._stale_rewrites >= STALE_WARN_AFTER:
            # Cada regravação é de um minuto: o aviso sai no máximo uma vez por minuto.
            _log.warning(
                "o estado da bandeja segue sem gravar há %d regravações (%s)",
                self._stale_rewrites,
                self._last_error or "sem erro registrado",
            )

    def _flush(self, *, blocking: bool) -> bool:
        """Grava enquanto houver estado pendente. `False` se falhou ou se outra gravação, que
        cuidará do pendente, está em curso."""
        while True:
            if not self._io_lock.acquire(blocking=blocking):
                return False
            try:
                with self._state_lock:
                    if not self._dirty:
                        return True
                    self._dirty = False
                    payload = self._payload()
                if not self._attempt(payload):
                    with self._state_lock:
                        self._dirty = True
                    self._ensure_retry()
                    return False
            finally:
                self._io_lock.release()

    def _ensure_retry(self) -> None:
        with self._state_lock:
            if self._retrying:
                return
            self._retrying = True
        self._retry_thread = threading.Thread(
            target=self._retry, name="tray-status-retry", daemon=True
        )
        self._retry_thread.start()

    def _retry(self) -> None:
        cycles = 0
        while True:
            for delay in self._retry_delays:
                time.sleep(delay)
                if self._flush(blocking=True):
                    break
            with self._state_lock:
                cycles += 1
                # Uma falha nova no fim do ciclo não espera os 60 s: recomeça, até o limite.
                if not self._dirty or cycles >= RETRY_CYCLES:
                    self._retrying = False
                    return

    def _payload(self) -> str:
        """Texto a gravar; chamada com o `_state_lock` preso."""
        return json.dumps(
            {
                "connected": self._connected,
                "power": self._power,
                "tv_name": self._tv_name,
                "since": self._since.isoformat(timespec="seconds"),
            },
            ensure_ascii=False,
        )

    def _attempt(self, payload: str) -> bool:
        """Uma tentativa de gravação atômica; chamada com o `_io_lock` preso."""
        temporary = self._path.with_name(f"{self._path.name}.{uuid4().hex}.new")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(payload, encoding="utf-8")
            temporary.replace(self._path)
        except OSError as exc:
            # A bandeja pode estar lendo o arquivo sem compartilhar a troca no Windows.
            self._last_error = type(exc).__name__
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            return False
        return True

    def _sweep_orphans(self) -> None:
        """Apaga sobras `tray-status.json.*.new` de gravações que o processo não terminou."""
        cutoff = time.time() - ORPHAN_AGE_SECONDS
        try:
            for leftover in self._path.parent.glob(f"{self._path.name}.*.new"):
                try:
                    if leftover.stat().st_mtime < cutoff:
                        leftover.unlink()
                except OSError:
                    continue
        except OSError:
            return

    def connected(self) -> None:
        self._change(connected=True)

    def disconnected(self) -> None:
        self._change(connected=False)

    def _change(self, *, connected: bool) -> None:
        with self._state_lock:
            if self._connected != connected:
                self._since = datetime.now(UTC)
            self._connected = connected
        self.write()

    def tv_state(self, state: TvState) -> None:
        with self._state_lock:
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
