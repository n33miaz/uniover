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

from uniover_agent.adapters import current_pointer
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.maintenance_signals import can_roll_back_to
from uniover_agent.adapters.update_basics import VERSION_FILE, UpdateResult, read_version
from uniover_agent.core.update_report import build_status, clean_reason, format_time
from uniover_agent.ports.remote_care import UpdateStatus

_log = logging.getLogger(__name__)

STATUS_FILE: Final = "update-status.json"
DEFERRED_REASON: Final = (
    "uma versão nova voltou por demora ou disco deste PC; fica adiada (Atualizar agora tenta já)"
)
PREPARED_REASON: Final = (
    "a versão nova está preparada e entra sem derrubar o agente (Atualizar agora entra já)"
)
BUSY_REASON: Final = (
    "a TV foi usada há pouco; a atualização espera ela ficar parada (Atualizar agora atualiza já)"
)
# Um arquivo de estado maior que isto não foi escrito por nós.
_MAX_BYTES: Final = 16 * 1024


def previous_dir(source: Path) -> Path:
    """A versão anterior guardada: a do ponteiro, ou a `app.previous` ao lado da `app`."""
    pointer = current_pointer.read(current_pointer.base_of(source))
    if pointer is not None and pointer.previous is not None:
        return pointer.previous.app
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


def _neutral_reason(outcome: str) -> str:
    if outcome == "deferred_busy":
        return BUSY_REASON
    return PREPARED_REASON if outcome == "prepared" else DEFERRED_REASON


def record_result(path: Path, result: UpdateResult, now: datetime) -> None:
    """O que a checagem concluiu. Atualizar com sucesso encerra a volta atrás e o bloqueio."""
    if result.outcome is None:
        return
    if result.outcome in {"deferred", "deferred_busy", "prepared"}:
        # Neutro: nada mudou. `record_updating` trocou o resultado por "atualizando"; devolve o
        # que havia (a volta atrás que acabou de acontecer, ou "em dia"), sem o rótulo de falha.
        state = _load(path)
        previous = "rolled_back" if state.get("rolledBack") is True else "up_to_date"
        record_status(
            path,
            {
                "outcome": previous,
                "checkedAt": format_time(now),
                # Neutro, mas o dono vê por que não há atualização ("Atualizar agora" a força).
                "reason": _neutral_reason(result.outcome),
                **({"latestSha": result.latest} if result.latest is not None else {}),
            },
        )
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
