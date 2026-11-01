"""`tv.discover.v1`: as TVs compatíveis que o agente acha na rede local dele.

Reaproveita a descoberta que o `tv-find` já faz (varredura do /24 e mDNS): só leitura de
identificação, nada é enviado às TVs. O que sai para a API nunca leva endereço IP nem MAC: cada TV
vai com um `id` opaco e estável e a marca `controlled` (é a TV que este agente já controla).
"""

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Final, Literal

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.ports import Transport, TransportError

_log = logging.getLogger(__name__)

# Declarada no `agent.hello.v1`: a API só manda `tv.discover.v1` a quem a tem.
DISCOVERY_CAPABILITY: Final = "tv.discovery.v1"
DISCOVERY_FAILED: Final = "discovery_failed"
SEND_FAILED: Final = "send_failed"
NAME_MAX: Final = 60
LIST_MAX: Final = 50


@dataclass(frozen=True, slots=True)
class FoundTv:
    id: str
    kind: Literal["android", "samsung"]
    name: str | None
    controlled: bool


TvFinder = Callable[[], Awaitable[Sequence[FoundTv]]]


def tv_discover_handler(
    finder: TvFinder, transport: Transport, envelopes: EnvelopeFactory
) -> Handler:
    """O relatório sai antes do resultado do comando, como o da limpeza."""

    async def handle(command: Command) -> CommandResult:
        request_id = command.body.get("requestId")
        if not isinstance(request_id, str) or not request_id:
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'requestId' ausente")
        try:
            found = await finder()
        except Exception:
            _log.exception("falha ao procurar TVs na rede")
            return CommandResult(
                command.id,
                ResultStatus.FAILED,
                "não consegui procurar TVs na rede",
                DISCOVERY_FAILED,
            )
        tvs = [
            {
                "id": tv.id,
                "kind": tv.kind,
                "name": tv.name[:NAME_MAX] if tv.name else None,
                "controlled": tv.controlled,
            }
            for tv in found[:LIST_MAX]
        ]
        try:
            await transport.send(envelopes.tv_discovery(request_id, command.id, tvs))
        except TransportError:
            return CommandResult(
                command.id, ResultStatus.FAILED, "não consegui enviar a lista à API", SEND_FAILED
            )
        return CommandResult(command.id, ResultStatus.OK)

    return handle
