"""Montagem das mensagens que o agente envia; sempre validadas pelo portão antes de sair."""

import base64
import json
import uuid
from collections.abc import Sequence
from typing import Any, Literal

from uniover_agent.core.domain import TvState, WireConnection
from uniover_agent.core.envelope_gate import EnvelopeGate
from uniover_agent.ports import AppIcon, Clock
from uniover_agent.ports.diagnostics import DiagnosticEvent

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

    def hello(  # noqa: PLR0913 - os campos opcionais do hello, todos por nome
        self,
        agent_version: str,
        capabilities: Sequence[str],
        *,
        os_description: str | None = None,
        tv: tuple[str, str] | None = None,
        update: dict[str, Any] | None = None,
        instance_id: str | None = None,
        handover: bool = False,
    ) -> dict[str, Any]:
        """`agent.hello.v1`. `os_description`, `tv` (tipo, endereço) e `update` (estado da
        auto-atualização) são só informativos."""
        body: dict[str, Any] = {"agentVersion": agent_version, "capabilities": list(capabilities)}
        if instance_id is not None:
            body["instanceId"] = instance_id
        if handover:
            body["handover"] = True
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

    def agent_diagnostics(self, events: Sequence[DiagnosticEvent]) -> dict[str, Any]:
        """`agent.diagnostics.v1`: um lote de ocorrências do agente (já sem dados pessoais)."""
        items: list[dict[str, Any]] = []
        for event in events:
            item: dict[str, Any] = {
                "id": event.id,
                "at": event.at,
                "kind": event.kind,
                "severity": event.severity,
                "detail": event.detail,
            }
            if event.component:
                item["component"] = event.component
            if event.count > 1:
                item["count"] = event.count
            items.append(item)
        return self._build("agent.diagnostics.v1", {"events": items}, None)

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

    def tv_state(
        self,
        state: TvState,
        connection: WireConnection | None = None,
        adb_permission: str | None = None,
        adb_permission_reason: str | None = None,
    ) -> dict[str, Any]:
        """`connection` troca o valor da sessão pelo do fio (o publicador decide, por API).

        `adb_permission` (`granted`, `missing` ou `pending`) só entra no corpo quando dito: o
        campo é opcional no contrato e uma API anterior o recusaria.
        """
        body: dict[str, Any] = {
            "power": state.power,
            "volume": state.volume,
            "app": state.app,
            "connection": connection or state.connection,
        }
        if adb_permission is not None:
            body["adbPermission"] = adb_permission
            if adb_permission_reason is not None:
                body["adbPermissionReason"] = adb_permission_reason
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

    def tv_livre_state(  # noqa: PLR0913 - os campos do estado, como no contrato
        self,
        request_id: str,
        correlation_id: str,
        *,
        supported: bool,
        sdk: int | None,
        installed: bool,
        version: str | None,
        is_home: bool,
        factory_launcher: str | None,
        disabled_packages: Sequence[str],
        apps: Sequence[tuple[str, bool, bool]],
    ) -> dict[str, Any]:
        """`tv.livre.state.v1`: o estado do TV Livre na TV (apps: pacote, de fábrica, desativado)"""
        body: dict[str, Any] = {
            "requestId": request_id,
            "supported": supported,
            "installed": installed,
            "isHome": is_home,
            "apps": [
                {"package": package, "factory": factory, "disabled": disabled}
                for package, factory, disabled in apps
            ],
            "at": self._utc_now(),
        }
        if sdk is not None:
            body["sdk"] = sdk
        if version is not None:
            body["version"] = version
        if factory_launcher is not None:
            body["factoryLauncher"] = factory_launcher
        if disabled_packages:
            body["disabledPackages"] = list(disabled_packages)
        return self._build("tv.livre.state.v1", body, correlation_id)

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

    def pc_apps(self, apps: Sequence[tuple[str, str]]) -> dict[str, Any]:
        """`pc.apps.v1`: pares (identificador, nome) dos favoritos que este PC deixa abrir."""
        body: dict[str, Any] = {
            "apps": [{"id": app_id, "label": label} for app_id, label in apps],
            "at": self._utc_now(),
        }
        return self._build("pc.apps.v1", body, None)

    def pc_volume_state(self, level: int, muted: bool) -> dict[str, Any]:
        """`pc.volume.state.v1`: o volume de agora do PC (nível de 0 a 100 e mudo)."""
        body: dict[str, Any] = {"level": level, "muted": muted, "at": self._utc_now()}
        return self._build("pc.volume.state.v1", body, None)

    def pc_device_state(self, device_id: str, state: str) -> dict[str, Any]:
        """`pc.device.state.v1`: a decisão do dono do PC sobre um aparelho (pendente, recusado,
        aprovado). O identificador é o que a API mandou no envelope."""
        body: dict[str, Any] = {"deviceId": device_id, "state": state, "at": self._utc_now()}
        return self._build("pc.device.state.v1", body, None)

    def pc_rtc_answer(
        self, session_id: str, sdp: str, correlation_id: str | None
    ) -> dict[str, Any]:
        """`pc.rtc.answer.v1`: a resposta à oferta do canal direto (`correlationId` da oferta)."""
        return self._build(
            "pc.rtc.answer.v1", {"sessionId": session_id, "sdp": sdp}, correlation_id
        )

    def pc_rtc_closed(
        self,
        session_id: str,
        reason: str,
        tv_keys: int | None = None,
        tv_texts: int | None = None,
    ) -> dict[str, Any]:
        """`pc.rtc.closed.v1`: o canal direto da sessão fechou (o agente avisa a API). `tv_keys` e
        `tv_texts` só vão de um canal com o escopo `tv` (a soma que a trilha da TV recebe)."""
        body: dict[str, Any] = {"sessionId": session_id, "reason": reason}
        if tv_keys is not None and tv_texts is not None:
            body["tvKeys"] = tv_keys
            body["tvTexts"] = tv_texts
        return self._build("pc.rtc.closed.v1", body, None)

    def pc_rtc_reconcile(self, session_id: str, ticket: str) -> dict[str, Any]:
        """`pc.rtc.reconcile.v1`: o canal direto que ficou aberto na reconexão, com o bilhete que a
        API assinou na oferta (a API o reconhece e o confere de novo)."""
        return self._build(
            "pc.rtc.reconcile.v1", {"sessions": [{"sessionId": session_id, "ticket": ticket}]}, None
        )

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
