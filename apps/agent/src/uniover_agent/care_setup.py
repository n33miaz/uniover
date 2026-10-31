"""Montagem do diagnóstico e do auto-reparo (fica fora de `main` para ele não crescer mais).

Junta as peças: a fila local de ocorrências, o gravador (que higieniza), o envio à API e a lista de
verificações do auto-diagnóstico para este PC. Quem decide *o que* verificar em cada instalação é
esta montagem; *como* verificar está em `adapters.self_care_checks` e *quando* rodar em
`core.self_care`.
"""

import asyncio
import getpass
import logging
import os
import platform
import socket
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from uniover_agent.adapters.diagnostics_file import DiagnosticsLogHandler, FileDiagnosticStore
from uniover_agent.adapters.installation import _is_real_installation, anchor_dir, installation_base
from uniover_agent.adapters.maintenance_signals import RuntimeFlagSignals
from uniover_agent.adapters.pairing_http import probe_api
from uniover_agent.adapters.run_state import RunState
from uniover_agent.adapters.self_care_checks import (
    ConnectionWatch,
    api_check,
    background_tasks_check,
    connection_check,
    installation_check,
    startup_task_check,
    supervisor_check,
    tv_check,
)
from uniover_agent.adapters.self_update import update_in_trial
from uniover_agent.adapters.tv_discovery import (
    ANDROID_REMOTE_PORT,
    REFUSAL_WAIT_SECONDS,
    SAMSUNG_REST_PORT,
    PortState,
    tcp_probe,
)
from uniover_agent.config import Settings, agent_source_dir
from uniover_agent.core.diagnostics import DiagnosticsRecorder
from uniover_agent.core.self_care import Check, Outcome
from uniover_agent.core.supervision import TaskHealth
from uniover_agent.ports import Clock

SUPERVISED_ENV = "UNIOVER_SUPERVISED"
_log = logging.getLogger("uniover_agent")


@dataclass(frozen=True, slots=True)
class DiagnosticsKit:
    store: FileDiagnosticStore
    recorder: DiagnosticsRecorder


def personal_names() -> tuple[str, ...]:
    """O nome do usuário do Windows e o do computador: somem de qualquer texto que sai do PC."""
    names: list[str] = []
    for getter in (getpass.getuser, socket.gethostname, platform.node):
        try:
            value = getter()
        except OSError, KeyError:
            continue
        if value:
            names.append(value)
    return tuple(dict.fromkeys(names))


def build_diagnostics(clock: Clock) -> DiagnosticsKit:
    store = FileDiagnosticStore(installation_base() / "runtime")
    return DiagnosticsKit(store, DiagnosticsRecorder(store, clock, names=personal_names()))


def attach_log_handler(kit: DiagnosticsKit) -> logging.Handler:
    """Todo erro que o agente registrar vira também uma ocorrência (ver `DiagnosticsLogHandler`)."""
    handler = DiagnosticsLogHandler(kit.recorder)
    logging.getLogger("uniover_agent").addHandler(handler)
    return handler


def is_supervised() -> bool:
    """O agente foi aberto pelo supervisor do Windows (que o reinicia e deixa sinais)."""
    return os.environ.get(SUPERVISED_ENV) == "1"


def build_checks(  # noqa: PLR0913 - cada argumento é uma peça que a montagem escolhe
    settings: Settings,
    *,
    api_url: str | None,
    watch: ConnectionWatch | None,
    health: TaskHealth | None,
    signals: RuntimeFlagSignals | None = None,
    reachable_api: Callable[[str], Awaitable[bool]] = probe_api,
) -> list[Check]:
    """As verificações que fazem sentido neste PC (a tarefa do Windows só na instalação real)."""
    root = installation_base()
    anchor = anchor_dir()
    checks: list[Check] = []
    if (root / "app").is_dir():
        checks.append(installation_check(root))
    real = sys.platform == "win32" and _is_real_installation(anchor)
    if real:
        checks.append(startup_task_check(root, anchor))
    supervised = is_supervised()
    if supervised:
        checks.append(supervisor_check(root / "runtime"))
    if watch is not None and api_url:
        url = api_url

        async def api_reachable() -> bool:
            return await reachable_api(url)

        checks.append(
            connection_check(
                watch,
                api_reachable,
                request_restart=signals.request_restart if supervised and signals else None,
                restarts_marker=root / "runtime" / "self-care-restart.txt",
            )
        )
    if watch is None and api_url:
        checks.append(api_check(lambda: reachable_api(api_url)))
    if settings.tv_host:
        host = settings.tv_host
        port = SAMSUNG_REST_PORT if settings.tv_kind == "samsung" else ANDROID_REMOTE_PORT

        async def tv_reachable() -> bool:
            return await tcp_probe(host, port, wait=REFUSAL_WAIT_SECONDS) is PortState.OPEN

        checks.append(tv_check(tv_reachable))
    if health is not None:
        checks.append(background_tasks_check(health))
    return checks


def describe_problems(results: list[tuple[str, bool, str]]) -> list[str]:
    """Linhas para o terminal (`uniover-agent diagnose`): uma por verificação, sem jargão."""
    return [f"{'OK      ' if ok else 'PROBLEMA'}  {name}: {detail}" for name, ok, detail in results]


def announce_start(
    run_state: RunState, kit: DiagnosticsKit, settings: Settings, version: str
) -> None:
    """Marca a execução como em andamento e registra como a anterior terminou (o rastro)."""
    previous = run_state.begin(version)
    if previous is not None and previous.outcome == "abrupt":
        kit.recorder.record("process.ended_abruptly", "warn", previous.detail, component="main")
        _log.warning("a execução anterior não terminou de forma ordenada: %s", previous.detail)
    elif previous is not None and previous.outcome == "supervisor":
        kit.recorder.record("process.restarted", "info", previous.detail, component="main")
    kit.recorder.record(
        "agent.started",
        "info",
        f"agente {version} iniciado (atualiza pelo canal {settings.update_channel})",
        component="main",
    )


async def roll_back_if_in_trial(outcome: Outcome, kit: DiagnosticsKit) -> None:
    """Versão recém-instalada que não passa no auto-diagnóstico volta para a anterior.

    Só vale enquanto a versão está em prova e há uma anterior guardada: uma versão confirmada
    (que já rodou bem) nunca é revertida por uma verificação, que pode estar errada. O pedido vai
    ao supervisor, o mesmo caminho do botão de voltar à versão anterior.
    """
    if not is_supervised() or not update_in_trial(agent_source_dir()):
        return
    signals = RuntimeFlagSignals()
    if not await asyncio.to_thread(signals.previous_available):
        return
    kit.recorder.record(
        "update.rolled_back",
        "error",
        f"a versão nova não passou no auto-diagnóstico ({outcome.name}: {outcome.result.detail});"
        " voltando para a anterior",
        component="update",
    )
    await asyncio.to_thread(signals.request_rollback)
