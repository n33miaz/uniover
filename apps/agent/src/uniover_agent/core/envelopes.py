"""Montagem das mensagens que o agente envia; sempre validadas pelo portão antes de sair."""

import uuid
from collections.abc import Sequence
from typing import Any

from uniover_agent.core.envelope_gate import EnvelopeGate
from uniover_agent.ports import Clock

INVALID_MESSAGE = "invalid_message"


class EnvelopeFactory:
    def __init__(self, agent_id: str, gate: EnvelopeGate, clock: Clock) -> None:
        self._agent_id = agent_id
        self._gate = gate
        self._clock = clock

    def _build(
        self, message_type: str, body: dict[str, Any], correlation_id: str | None
    ) -> dict[str, Any]:
        envelope: dict[str, Any] = {
            "v": 1,
            "id": str(uuid.uuid7()),
            "type": message_type,
            "source": f"agent:{self._agent_id}",
            "target": "api",
            # O contrato exige UTC com sufixo Z.
            "ts": self._clock.now().isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "correlationId": correlation_id,
            "body": body,
        }
        self._gate.check_outbound(envelope)
        return envelope

    def hello(self, agent_version: str, capabilities: Sequence[str]) -> dict[str, Any]:
        body = {"agentVersion": agent_version, "capabilities": list(capabilities)}
        return self._build("agent.hello.v1", body, None)

    def result(
        self, correlation_id: str, *, ok: bool, code: str = "", message: str = ""
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"ok": ok}
        if not ok:
            body["error"] = {"code": code or "failed", "message": message or code or "falha"}
        return self._build("command.result.v1", body, correlation_id)
