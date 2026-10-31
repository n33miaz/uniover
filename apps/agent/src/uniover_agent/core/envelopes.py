"""Montagem das mensagens que o agente envia; sempre validadas pelo portão antes de sair."""

import base64
import json
import uuid
from collections.abc import Sequence
from typing import Any, Literal

from uniover_agent.core.domain import TvState
from uniover_agent.core.envelope_gate import EnvelopeGate
from uniover_agent.ports import AppIcon, Clock

INVALID_MESSAGE = "invalid_message"


def serialized_size(envelope: dict[str, Any]) -> int:
    """Bytes que a mensagem ocupa no fio (a mesma serialização do transporte WebSocket).

    O servidor fecha a conexão de quem manda mensagem acima do limite dele, então quem monta
    mensagens grandes precisa medir antes de enviar.
    """
    return len(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class EnvelopeFactory:
    def __init__(self, agent_id: str, gate: EnvelopeGate, clock: Clock) -> None:
        self._agent_id = agent_id
        self._gate = gate
        self._clock = clock

    def _utc_now(self) -> str:
        # O contrato exige UTC com sufixo Z.
        return self._clock.now().isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _build(
        self, message_type: str, body: dict[str, Any], correlation_id: str | None
    ) -> dict[str, Any]:
        envelope: dict[str, Any] = {
            "v": 1,
            "id": str(uuid.uuid7()),
            "type": message_type,
            "source": f"agent:{self._agent_id}",
            "target": "api",
            "ts": self._utc_now(),
            "correlationId": correlation_id,
            "body": body,
        }
        self._gate.check_outbound(envelope)
        return envelope

    def hello(
        self,
        agent_version: str,
        capabilities: Sequence[str],
        *,
        os_description: str | None = None,
        tv: tuple[str, str] | None = None,
        update: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """`agent.hello.v1`. `os_description`, `tv` (tipo, endereço) e `update` (estado da
        auto-atualização) são só informativos."""
        body: dict[str, Any] = {"agentVersion": agent_version, "capabilities": list(capabilities)}
        if os_description:
            body["os"] = os_description
        if tv is not None:
            body["tv"] = {"kind": tv[0], "host": tv[1]}
        if update is not None:
            body["update"] = update
        return self._build("agent.hello.v1", body, None)

    def agent_update_status(self, body: dict[str, Any]) -> dict[str, Any]:
        """`agent.update.status.v1`: o estado da auto-atualização, quando a checagem roda."""
        return self._build("agent.update.status.v1", body, None)

    def agent_logs(
        self,
        request_id: str,
        correlation_id: str | None,
        text: str,
        lines: int,
        *,
        truncated: bool,
    ) -> dict[str, Any]:
        """`agent.logs.v1`: o fim do registro já higienizado, com o comando e o `requestId`."""
        body: dict[str, Any] = {
            "requestId": request_id,
            "text": text,
            "lines": lines,
            "truncated": truncated,
            "at": self._utc_now(),
        }
        return self._build("agent.logs.v1", body, correlation_id)

    def keepalive(self) -> dict[str, Any]:
        """`agent.keepalive.v1`: mantém o canal ativo sem efeito de negócio."""
        return self._build("agent.keepalive.v1", {}, None)

    def result(
        self, correlation_id: str, *, ok: bool, code: str = "", message: str = ""
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"ok": ok}
        if not ok:
            body["error"] = {"code": code or "failed", "message": message or code or "falha"}
        return self._build("command.result.v1", body, correlation_id)

    def tv_state(self, state: TvState) -> dict[str, Any]:
        body: dict[str, Any] = {
            "power": state.power,
            "volume": state.volume,
            "app": state.app,
            "connection": state.connection,
        }
        return self._build("tv.state.v1", body, None)

    def tv_apps(
        self, apps: Sequence[tuple[str, str]], correlation_id: str | None = None
    ) -> dict[str, Any]:
        """`tv.apps.v1`: pares (pacote, nome), pedidos pela API ou enviados pelo agente."""
        body: dict[str, Any] = {
            "apps": [{"package": package, "label": label} for package, label in apps],
            "at": self._utc_now(),
        }
        return self._build("tv.apps.v1", body, correlation_id)

    def tv_cleanup_result(  # noqa: PLR0913 - os campos do relatório, todos obrigatórios no contrato
        self,
        request_id: str,
        correlation_id: str,
        *,
        closed_apps: int,
        closed_packages: Sequence[str],
        memory_before_mb: int | None,
        memory_after_mb: int | None,
        freed_mb: int | None,
        failed_steps: Sequence[str],
        kind: str | None = None,
        trigger: str | None = None,
        result: str | None = None,
        reason: str | None = None,
        duration_ms: int | None = None,
        background_processes: int | None = None,
        session_open_ms: int | None = None,
    ) -> dict[str, Any]:
        """`tv.cleanup.result.v1`: o que a limpeza fez, com o comando e o `requestId` do pedido."""
        body: dict[str, Any] = {
            "requestId": request_id,
            "closedApps": closed_apps,
            "closedPackages": list(closed_packages),
            "memoryBeforeMb": memory_before_mb,
            "memoryAfterMb": memory_after_mb,
            "freedMb": freed_mb,
            "failedSteps": list(failed_steps),
            "at": self._utc_now(),
        }
        if kind is not None:
            body["kind"] = kind
        if trigger is not None:
            body["trigger"] = trigger
        if result is not None:
            body["result"] = result
        if reason is not None:
            body["reason"] = reason
        if duration_ms is not None:
            body["durationMs"] = max(0, duration_ms)
        if background_processes is not None:
            body["backgroundProcesses"] = max(0, background_processes)
        if session_open_ms is not None:
            body["sessionOpenMs"] = max(0, session_open_ms)
        return self._build("tv.cleanup.result.v1", body, correlation_id)

    def tv_watchdog(
        self, kind: str, severity: str, detail: str, attempts: int, at: str | None = None
    ) -> dict[str, Any]:
        """`tv.watchdog.v1`: um acontecimento do vigia que religa o serviço do controle da TV."""
        body: dict[str, Any] = {
            "kind": kind,
            "severity": severity,
            "detail": detail,
            "attempts": attempts,
            "at": at or self._utc_now(),
        }
        return self._build("tv.watchdog.v1", body, None)

    def tv_permission(self, state: Literal["needed", "granted"]) -> dict[str, Any]:
        """`tv.permission.v1`: a TV Samsung reconhece o UniOver (`granted`) ou não (`needed`)."""
        return self._build("tv.permission.v1", {"state": state, "at": self._utc_now()}, None)

    def tv_discovery(
        self, request_id: str, correlation_id: str, tvs: Sequence[dict[str, Any]]
    ) -> dict[str, Any]:
        """`tv.discovery.v1`: as TVs achadas na rede do agente (id opaco, nunca endereço)."""
        body: dict[str, Any] = {"requestId": request_id, "tvs": list(tvs), "at": self._utc_now()}
        return self._build("tv.discovery.v1", body, correlation_id)

    def tv_apps_v2(
        self,
        apps: Sequence[tuple[str, str, AppIcon | None]],
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        """`tv.apps.v2`: (pacote, nome, ícone). Sem ícone o campo some e a API mantém o dela."""
        items: list[dict[str, Any]] = []
        for package, label, icon in apps:
            item: dict[str, Any] = {"package": package, "label": label}
            if icon is not None:
                item["icon"] = {
                    "mime": icon.mime,
                    "data": base64.b64encode(icon.data).decode("ascii"),
                }
            items.append(item)
        body: dict[str, Any] = {"apps": items, "at": self._utc_now()}
        return self._build("tv.apps.v2", body, correlation_id)
