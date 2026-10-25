r"""Estado da auto-atualização em `runtime\update-status.json`.

Quem escreve: o `self-update` (resultado de cada checagem) e o supervisor `run-agent.ps1` (próxima
checagem, falha do próprio processo e volta à versão anterior). Quem lê: o agente conectado, para o
`hello` e para avisar a API. O arquivo é só informativo: nada aqui decide atualizar nem reverter.

Escrita por arquivo temporário e `os.replace` (o leitor nunca vê meio arquivo); leitura tolerante.
"""

import json
import logging
import os
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.maintenance_signals import can_roll_back_to
from uniover_agent.adapters.self_update import VERSION_FILE, UpdateResult, read_version
from uniover_agent.core.update_report import build_status, clean_reason, format_time
from uniover_agent.ports.remote_care import UpdateStatus

_log = logging.getLogger(__name__)

STATUS_FILE: Final = "update-status.json"
# Um arquivo de estado maior que isto não foi escrito por nós.
_MAX_BYTES: Final = 16 * 1024


def previous_dir(source: Path) -> Path:
    """A versão anterior que a atualização guarda ao lado da `app` (`app.previous`)."""
    return source.with_name(source.name + ".previous")


def default_status_path() -> Path:
    return installation_base() / "runtime" / STATUS_FILE


def _load(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > _MAX_BYTES:
            return {}
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except OSError, ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def record_status(path: Path, changes: Mapping[str, Any], *, now: datetime | None = None) -> None:
    """Junta `changes` ao que já está no arquivo e grava de uma vez. `None` apaga o campo.

    Falha de disco só vira aviso: o estado é informativo e não pode atrapalhar a atualização."""
    state = _load(path)
    for key, value in changes.items():
        if value is None:
            state.pop(key, None)
        else:
            state[key] = value
    if "reason" in changes and changes["reason"] is not None:
        state["reason"] = clean_reason(changes["reason"])
    if now is not None:
        state["writtenAt"] = format_time(now)
    temp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp.write_text(json.dumps(state, ensure_ascii=True, sort_keys=True), encoding="utf-8")
        os.replace(temp, path)
    except OSError as exc:
        _log.warning("não consegui gravar o estado da atualização (%s)", type(exc).__name__)


class FileUpdateStatus:
    """`UpdateStatusSource` sobre o arquivo; a versão instalada vem do `.version` da `app`."""

    def __init__(
        self,
        path: Path,
        source_dir: Path,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._path = path
        self._source = source_dir
        self._now = now

    def _installed_at(self) -> str | None:
        try:
            stamp = (self._source / VERSION_FILE).stat().st_mtime
        except OSError:
            return None
        return format_time(datetime.fromtimestamp(stamp, UTC))

    def _previous_sha(self) -> str | None:
        """A versão a que dá para voltar; uma sem manutenção remota não conta."""
        previous = previous_dir(self._source)
        return read_version(previous) if can_roll_back_to(previous) else None

    def read(self) -> UpdateStatus:
        try:
            return build_status(
                _load(self._path),
                installed_sha=read_version(self._source),
                installed_at=self._installed_at(),
                now=self._now(),
                previous_sha=self._previous_sha(),
            )
        except Exception:
            _log.exception("não consegui ler o estado da atualização")
            return UpdateStatus()


def record_updating(path: Path, now: datetime) -> None:
    """A checagem começou: a tela do dono mostra "Atualizando…" até o resultado chegar."""
    record_status(path, {"outcome": "updating", "checkedAt": format_time(now), "reason": None})


def record_result(path: Path, result: UpdateResult, now: datetime) -> None:
    """O que a checagem concluiu. Atualizar com sucesso encerra a volta atrás e o bloqueio."""
    if result.outcome is None:
        return
    changes: dict[str, Any] = {
        "outcome": result.outcome,
        "checkedAt": format_time(now),
        "reason": result.message if result.outcome == "failed" else None,
    }
    if result.latest is not None:
        changes["latestSha"] = result.latest
    if result.outcome == "updated":
        changes["rolledBack"] = None
        changes["blockedSha"] = None
    elif result.outcome == "blocked":
        changes["blockedSha"] = result.blocked
    record_status(path, changes)


def record_failure(path: Path, reason: str, now: datetime) -> None:
    record_status(path, {"outcome": "failed", "checkedAt": format_time(now), "reason": reason})
