"""Manutenção do agente: `diagnose` e `self-update`."""

import logging
import os
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from uniover_agent.adapters.installation import migrate_layout
from uniover_agent.adapters.self_update import DEFAULT_CHANNEL, UpdateResult, self_update
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.update_status import (
    default_status_path,
    record_failure,
    record_result,
    record_updating,
)
from uniover_agent.care_setup import (
    DiagnosticsKit,
    build_checks,
    build_diagnostics,
    describe_problems,
)
from uniover_agent.composition.connection import log_file_path
from uniover_agent.composition.system import EXIT_FAILURE, EXIT_OK
from uniover_agent.config import Settings, agent_source_dir
from uniover_agent.core.self_care import SelfCare

_log = logging.getLogger("uniover_agent")


async def diagnose(settings: Settings, *, repair: bool) -> int:
    """`diagnose`: roda o auto-diagnóstico uma vez, em palavras simples, e diz o que viu.

    Não abre conexão com a API nem mexe na TV. Sai com 1 se alguma verificação achou um problema de
    verdade (um aviso, como a TV desligada, não conta).
    """
    clock = SystemClock()
    kit = build_diagnostics(clock)
    checks = build_checks(settings, api_url=settings.api_url, watch=None, health=None)
    care = SelfCare(checks, kit.recorder, clock)
    outcomes = await care.run_once(repair=repair)
    lines = [(o.name, o.result.ok or o.repaired, o.result.detail) for o in outcomes]
    for line in describe_problems(lines):
        print(line)
    for outcome in outcomes:
        if outcome.repaired:
            print(f"Reparado: {outcome.name}.")
    print(f"Detalhes no registro: {log_file_path(settings)}")
    failed = [o for o in outcomes if not o.result.ok and o.result.severity == "error"]
    return EXIT_FAILURE if failed else EXIT_OK


def update_agent(
    *, sync: bool, settings: Settings | None = None, kit: DiagnosticsKit | None = None
) -> int:
    """Atualiza o agente instalado pelo ramo do canal; se falhar, o atual continua valendo."""
    migrate_layout()
    status_file = default_status_path()
    channel = settings.update_channel if settings is not None else DEFAULT_CHANNEL
    _safely(record_updating, status_file, datetime.now(UTC))
    try:
        # Um pedido explícito do dono (`update-now`), que o supervisor passa por esta variável, vale
        # mais que o adiamento de uma versão devolvida por culpa do PC.
        result = self_update(
            agent_source_dir(),
            sync=sync,
            channel=channel,
            ignore_deferral=os.environ.get("UNIOVER_UPDATE_FORCE") == "1",
        )
    except Exception as exc:
        # Não devia acontecer (a atualização devolve o motivo); se ocorrer, o estado diz que falhou.
        _log.exception("a auto-atualização falhou de forma inesperada")
        _safely(
            record_failure,
            status_file,
            f"erro inesperado na atualização ({type(exc).__name__})",
            datetime.now(UTC),
        )
        if kit is not None:
            # Toda falha de atualização chega ao dono (Sistema e alerta), mesmo a imprevista.
            kit.recorder.record(
                "update.failed",
                "error",
                "erro inesperado na atualização",
                component="update",
                error=exc,
            )
        print("A atualização falhou; o agente atual continua valendo.")
        return EXIT_OK
    _safely(record_result, status_file, result, datetime.now(UTC))
    if kit is not None:
        _note_update_outcome(kit, result)
    print(result.message)
    return EXIT_OK


def _note_update_outcome(kit: DiagnosticsKit, result: UpdateResult) -> None:
    """O que a atualização concluiu vira ocorrência (a recusa de um pacote é a que mais importa)."""
    if result.rejected:
        kit.recorder.record("update.rejected", "error", result.message, component="update")
    elif result.outcome == "failed":
        kit.recorder.record("update.failed", "error", result.message, component="update")
    elif result.outcome == "updated":
        kit.recorder.record("update.installed", "info", "versão nova instalada", component="update")


def _safely(action: Callable[..., None], *arguments: Any) -> None:
    """O estado da atualização é só informativo: nada nele pode atrapalhar o agente."""
    try:
        action(*arguments)
    except Exception:
        _log.exception("não consegui registrar o estado da atualização")
