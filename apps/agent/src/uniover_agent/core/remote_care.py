"""Manutenção remota: o fim do registro (sem segredos) e os sinais de atualizar e reiniciar.

Só o administrador pede, pela API, e só chega aqui o que passou pelo portão de contrato. Nada vindo
da rede escolhe um arquivo: o registro é o do próprio agente, fixo na configuração local.
"""

import asyncio
import json
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory, serialized_size
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.redaction import redact
from uniover_agent.ports import Transport, TransportError
from uniover_agent.ports.remote_care import LogSource, LogUnavailable, MaintenanceSignals

_log = logging.getLogger(__name__)

LOGS_REQUEST_TYPE: Final = "agent.logs.request.v1"
MAINTENANCE_TYPE: Final = "agent.maintenance.v1"
LOGS_CAPABILITY: Final = "agent.logs.v1"
MAINTENANCE_CAPABILITY: Final = "agent.maintenance.v1"

LOG_UNAVAILABLE: Final = "log_unavailable"
MAINTENANCE_UNAVAILABLE: Final = "maintenance_unavailable"
SEND_FAILED: Final = "send_failed"
NO_PREVIOUS_VERSION: Final = "no_previous_version"

# O transporte fecha a conexão de quem manda mais de 64 KiB: a folga cobre envelope e escapes.
FRAME_LIMIT_BYTES: Final = 60_000
# O mesmo teto do esquema (`maxLength` de `text`), contado em caracteres.
TEXT_LIMIT_CHARS: Final = 49_152
_CUT_MARK: Final = "[...] "


@dataclass(frozen=True, slots=True)
class LogExcerpt:
    text: str
    lines: int
    truncated: bool


def _escaped_bytes(text: str) -> int:
    """Bytes que o texto ocupa dentro de uma string JSON (UTF-8, com escapes), sem as aspas."""
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8")) - 2


def fit_excerpt(
    lines: list[str], budget_bytes: int, *, max_chars: int = TEXT_LIMIT_CHARS
) -> LogExcerpt:
    """Fica com as linhas mais novas que cabem em `budget_bytes` e `max_chars`.

    Linha nunca é cortada ao meio, a não ser a mais nova quando sozinha já não cabe: aí fica o
    fim dela, com uma marca de corte. `truncated` diz que o orçamento cortou algo (e não que
    o pedido de N linhas foi atendido).
    """
    kept: list[str] = []
    used_bytes = 0
    used_chars = 0
    truncated = False
    for line in reversed(lines):
        cost_bytes = _escaped_bytes(line) + 1  # a quebra de linha entre elas
        cost_chars = len(line) + 1
        if used_bytes + cost_bytes > budget_bytes or used_chars + cost_chars > max_chars:
            truncated = True
            break
        kept.append(line)
        used_bytes += cost_bytes
        used_chars += cost_chars
    if not kept and lines:
        tail = lines[-1]
        # Só o fim da linha mais nova: encolhe até caber (o escape pode multiplicar os bytes).
        size = min(len(tail), max_chars - len(_CUT_MARK) - 1)
        while size > 0 and _escaped_bytes(_CUT_MARK + tail[-size:]) + 1 > budget_bytes:
            size = size * 3 // 4
        kept.append(_CUT_MARK + tail[-size:] if size > 0 else _CUT_MARK.strip())
        truncated = True
    kept.reverse()
    return LogExcerpt("\n".join(kept), len(kept), truncated)


def _fail(command: Command, detail: str, code: str) -> CommandResult:
    return CommandResult(command.id, ResultStatus.FAILED, detail, code)


def agent_logs_handler(
    source: LogSource,
    transport: Transport,
    envelopes: EnvelopeFactory,
    known_secrets: Callable[[], Iterable[str]] = lambda: (),
) -> Handler:
    """`agent.logs.request.v1`: lê o fim do registro, higieniza, ajusta ao quadro e envia.

    O quadro sai antes do resultado do comando (a API junta os dois pelo `requestId`). Nunca
    levanta e nunca escreve o conteúdo do registro no próprio registro.
    """

    async def handle(command: Command) -> CommandResult:
        request_id = command.body.get("requestId")
        wanted = command.body.get("lines")
        if not isinstance(request_id, str) or not request_id:
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'requestId' ausente")
        if not isinstance(wanted, int) or isinstance(wanted, bool) or wanted < 1:
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'lines' inválido")
        try:
            raw = await asyncio.to_thread(source.tail, wanted)
        except LogUnavailable as exc:
            return _fail(command, str(exc), LOG_UNAVAILABLE)
        except Exception:
            _log.exception("falha ao ler o registro do agente")
            return _fail(command, "não consegui ler o registro", LOG_UNAVAILABLE)

        # Primeiro higieniza, depois corta: um segredo partido pelo corte não casaria mais.
        clean = redact(raw[-wanted:], known_secrets())
        empty = envelopes.agent_logs(request_id, command.id, "", 0, truncated=False)
        excerpt = fit_excerpt(clean, FRAME_LIMIT_BYTES - serialized_size(empty))
        try:
            await transport.send(
                envelopes.agent_logs(
                    request_id,
                    command.id,
                    excerpt.text,
                    excerpt.lines,
                    truncated=excerpt.truncated,
                )
            )
        except TransportError:
            return _fail(command, "não consegui enviar o registro à API", SEND_FAILED)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


def agent_maintenance_handler(signals: MaintenanceSignals) -> Handler:
    """`agent.maintenance.v1`: entrega o pedido ao supervisor e responde; ele é quem age."""

    async def handle(command: Command) -> CommandResult:
        action = command.body.get("action")
        try:
            if action == "update":
                await asyncio.to_thread(signals.request_update)
            elif action == "restart":
                await asyncio.to_thread(signals.request_restart)
            elif action == "rollback":
                # Sem versão guardada não há para onde voltar: o supervisor só apagaria o pedido.
                if not await asyncio.to_thread(signals.previous_available):
                    return _fail(command, "não há versão anterior guardada", NO_PREVIOUS_VERSION)
                await asyncio.to_thread(signals.request_rollback)
            else:
                return CommandResult(command.id, ResultStatus.REJECTED, "ação desconhecida")
        except Exception:
            _log.exception("não consegui entregar o pedido de %s ao supervisor", action)
            return _fail(command, "não consegui avisar o supervisor", MAINTENANCE_UNAVAILABLE)
        _log.info("manutenção remota: %s pedido ao supervisor", action)
        return CommandResult(command.id, ResultStatus.OK)

    return handle
