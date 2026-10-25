"""Estado da auto-atualização para a tela do dono: limpeza dos dados e aviso quando a checagem roda.

O `self-update` roda em outro processo (o supervisor o chama) e deixa o resultado num arquivo; o
agente conectado lê esse arquivo para o `hello` e vigia mudanças para mandar
`agent.update.status.v1` na hora. Tudo o que sai passa por aqui: um valor fora do contrato
derrubaria o `hello` no portão de saída e o agente nunca conectaria, então o que não cabe é
descartado em vez de enviado.
"""

import asyncio
import logging
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.redaction import redact_line
from uniover_agent.ports import Clock, Transport, TransportError
from uniover_agent.ports.remote_care import UpdateStatus, UpdateStatusSource

_log = logging.getLogger(__name__)

UPDATE_STATUS_TYPE: Final = "agent.update.status.v1"
OUTCOMES: Final = frozenset(
    {"not_checked", "updating", "updated", "up_to_date", "failed", "blocked", "rolled_back"}
)
REASON_LIMIT: Final = 200
# Passou disto sem terminar: o processo morreu no meio, e isso conta como falha.
UPDATING_STALE_AFTER: Final = timedelta(minutes=30)
POLL_SECONDS: Final = 30.0
STALE_REASON: Final = "a atualização foi interrompida e não terminou"

_TIME_LIMIT = 40
_SHA = re.compile(r"[0-9a-f]{40}")


def clean_sha(value: object) -> str | None:
    if isinstance(value, str) and _SHA.fullmatch(value.strip().lower()):
        return value.strip().lower()
    return None


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value or len(value) > _TIME_LIMIT:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


def format_time(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _time(value: object) -> str | None:
    parsed = parse_time(value)
    return format_time(parsed) if parsed is not None else None


def clean_reason(value: object) -> str | None:
    """Motivo curto, em uma linha, sem segredos e dentro do limite do contrato."""
    if not isinstance(value, str):
        return None
    text = " ".join(redact_line(value).split())
    return text[:REASON_LIMIT] or None


def build_status(
    raw: Mapping[str, Any],
    *,
    installed_sha: str | None,
    installed_at: str | None,
    now: datetime,
    previous_sha: str | None = None,
) -> UpdateStatus:
    """Junta o que o arquivo diz com a versão instalada (lida do `.version`) e limpa tudo."""
    outcome = raw.get("outcome")
    clean_outcome = outcome if isinstance(outcome, str) and outcome in OUTCOMES else "not_checked"
    checked_at = _time(raw.get("checkedAt"))
    reason = clean_reason(raw.get("reason"))
    if clean_outcome == "updating":
        started = parse_time(raw.get("checkedAt"))
        if started is None or now - started > UPDATING_STALE_AFTER:
            clean_outcome, reason = "failed", STALE_REASON
    return UpdateStatus(
        outcome=clean_outcome,
        installed_sha=clean_sha(installed_sha),
        installed_at=_time(installed_at),
        latest_sha=clean_sha(raw.get("latestSha")),
        checked_at=checked_at,
        next_check_at=_time(raw.get("nextCheckAt")),
        reason=reason,
        blocked_sha=clean_sha(raw.get("blockedSha")),
        previous_sha=clean_sha(previous_sha),
        rolled_back=raw.get("rolledBack") is True,
    )


def update_body(status: UpdateStatus) -> dict[str, Any]:
    """O objeto `update` do `hello` e o corpo de `agent.update.status.v1` (só o que existe)."""
    body: dict[str, Any] = {"outcome": status.outcome}
    optional = {
        "installedSha": status.installed_sha,
        "installedAt": status.installed_at,
        "latestSha": status.latest_sha,
        "checkedAt": status.checked_at,
        "nextCheckAt": status.next_check_at,
        "reason": status.reason,
        "blockedSha": status.blocked_sha,
        "previousSha": status.previous_sha,
    }
    body.update({key: value for key, value in optional.items() if value is not None})
    if status.rolled_back:
        body["rolledBack"] = True
    return body


class UpdateStatusWatcher:
    """Manda `agent.update.status.v1` quando o estado da auto-atualização muda.

    Consulta o arquivo a cada `POLL_SECONDS`: o `self-update` é outro processo e não avisa este.
    Sem conexão o envio falha e a mudança fica pendente para a próxima rodada (e o `hello` da
    reconexão já leva o estado atual).
    """

    def __init__(
        self,
        source: UpdateStatusSource,
        transport: Transport,
        envelopes: EnvelopeFactory,
        clock: Clock,
        *,
        interval: float = POLL_SECONDS,
    ) -> None:
        self._source = source
        self._transport = transport
        self._envelopes = envelopes
        self._clock = clock
        self._interval = interval
        self._sent: UpdateStatus | None = None

    async def run(self) -> None:
        self._sent = await asyncio.to_thread(self._source.read)
        while True:
            await self._clock.sleep(self._interval)
            try:
                await self.poll()
            except Exception:
                # Informativo: nunca derruba o agente nem o laço que vigia.
                _log.exception("falha ao avisar o estado da atualização")

    async def poll(self) -> None:
        status = await asyncio.to_thread(self._source.read)
        if status == self._sent:
            return
        try:
            await self._transport.send(self._envelopes.agent_update_status(update_body(status)))
        except TransportError:
            return
        except Exception:
            _log.exception("não consegui montar o estado da atualização")
            self._sent = status
            return
        self._sent = status
