r"""As verificações e os reparos concretos do auto-diagnóstico (a lógica de quando rodar está em
`core.self_care`).

Cada função devolve uma `Check` pronta. Nada aqui usa o agente em execução como cobaia: o
diagnóstico é de **outro olhar** sobre o mesmo PC (arquivos, a tarefa do Windows, a API por HTTP, a
porta da TV), nunca abre uma segunda conexão com a API (derrubaria a do agente) nem manda tecla à
TV.

Os reparos são os únicos que mexem em algo, e todos são seguros: refazer pastas, registrar de novo a
tarefa de início automático (pela rotina que já confere e desfaz se falhar) e pedir ao supervisor
que reinicie o agente.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from uniover_agent.adapters.housekeeping import STANDARD_FOLDERS, tidy
from uniover_agent.adapters.installation import (
    TASK_NAME,
    _powershell,
    _register_launcher_task,
)
from uniover_agent.adapters.process import run_hidden
from uniover_agent.core.self_care import Check, CheckResult
from uniover_agent.core.supervision import TaskHealth

_log = logging.getLogger(__name__)

LOW_DISK_BYTES: Final = 200 * 1024 * 1024
TIGHT_DISK_BYTES: Final = 1024 * 1024 * 1024
# O supervisor pode ficar ocupado numa atualização por vários minutos sem dar sinal (o `uv sync` tem
# 10 min).
SUPERVISOR_SILENCE_SECONDS: Final = 15 * 60.0
# Quanto tempo desconectado antes de olhar a API, e entre dois reinícios pedidos pelo auto-reparo.
CONNECTION_GRACE_SECONDS: Final = 10 * 60.0
RESTART_SPACING_SECONDS: Final = 3 * 3600.0
TV_CLOSED_RUNS: Final = 3
_VERSION = re.compile(r"[0-9a-f]{40}")


async def _in_thread[T](function: Callable[[], T]) -> T:
    return await asyncio.to_thread(function)


# --- Pasta de instalação
# ---------------------------------------------------------------------------------------


def _installation_result(root: Path) -> CheckResult:  # noqa: PLR0911 - um retorno por achado
    missing = [name for name in STANDARD_FOLDERS if not (root / name).is_dir()]
    if missing:
        return CheckResult(False, "faltam pastas: " + ", ".join(missing), fixable=True)
    app = root / "app"
    try:
        version = (app / ".version").read_text(encoding="utf-8").strip()
    except OSError:
        version = ""
    if not (app / "pyproject.toml").is_file() or not (app / "tools" / "run-agent.ps1").is_file():
        return CheckResult(False, "a pasta do agente está incompleta", critical=True)
    if not _VERSION.fullmatch(version):
        return CheckResult(False, "a pasta do agente não tem a marca da versão", critical=True)
    try:
        probe = root / "logs" / ".escrita"
        probe.write_text("ok", encoding="ascii")
        probe.unlink()
    except OSError:
        return CheckResult(False, "não consigo gravar na pasta de registros")
    try:
        free = shutil.disk_usage(root).free
    except OSError:
        return CheckResult(True, "pasta em ordem (espaço em disco desconhecido)")
    megabytes = free // (1024 * 1024)
    if free < LOW_DISK_BYTES:
        return CheckResult(
            False, f"quase sem espaço no disco ({megabytes} MB livres)", fixable=True
        )
    if free < TIGHT_DISK_BYTES:
        return CheckResult(False, f"pouco espaço no disco ({megabytes} MB livres)", severity="warn")
    return CheckResult(True, "pasta de instalação em ordem")


def installation_check(root: Path) -> Check:
    async def run() -> CheckResult:
        return await _in_thread(lambda: _installation_result(root))

    async def repair() -> str | None:
        await _in_thread(lambda: tidy(root))
        return None

    return Check("instalacao", run, repair, "pastas refeitas e restos de atualização removidos")


# --- Tarefa de início automático
# -------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TaskState:
    present: bool
    enabled: bool = True
    execute: str = ""
    arguments: str = ""
    triggers: int = 0


_QUERY_SCRIPT = (
    "$ErrorActionPreference='Stop';"
    "$t=Get-ScheduledTask -TaskName $env:UNIOVER_TASK -ErrorAction SilentlyContinue;"
    "if(-not $t){'{\"present\":false}';exit 0};"
    "$a=@($t.Actions)|Select-Object -First 1;"
    "@{present=$true;enabled=($t.State -ne 'Disabled');execute=[string]$a.Execute;"
    "arguments=[string]$a.Arguments;triggers=@($t.Triggers).Count}|ConvertTo-Json -Compress"
)
_ENABLE_SCRIPT = "Enable-ScheduledTask -TaskName $env:UNIOVER_TASK | Out-Null"


def _powershell_run(
    script: str, task: str, timeout: float = 60.0
) -> subprocess.CompletedProcess[str]:
    return run_hidden(
        [
            _powershell(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script,
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env={**os.environ, "UNIOVER_TASK": task},
    )


def query_task(task: str = TASK_NAME) -> TaskState | None:
    """O que o Agendador tem registrado com este nome; `None` se não deu para perguntar."""
    try:
        done = _powershell_run(_QUERY_SCRIPT, task)
        data = json.loads(done.stdout.strip().splitlines()[-1])
    except OSError, subprocess.TimeoutExpired, ValueError, IndexError:
        return None
    if done.returncode != 0 or not isinstance(data, dict):
        return None
    if not data.get("present"):
        return TaskState(False)
    return TaskState(
        True,
        bool(data.get("enabled", True)),
        str(data.get("execute", "")),
        str(data.get("arguments", "")),
        int(data.get("triggers", 0)),
    )


def _task_problem(state: TaskState, anchor: Path) -> str | None:
    if not state.present:
        return "a tarefa de início automático não existe mais"
    if not state.enabled:
        return "a tarefa de início automático foi desativada"
    expected = str(anchor / "launcher.vbs")
    uses_script_host = (
        os.path.normcase(state.execute).endswith("wscript.exe")
        and expected.lower() in state.arguments.lower()
    )
    uses_powershell = "launcher.ps1" in state.arguments and state.execute.lower().endswith(
        "powershell.exe"
    )
    if not uses_script_host and not uses_powershell:
        return "a tarefa de início automático não aponta mais para o lançador do UniOver"
    if state.triggers < 1:
        return "a tarefa de início automático ficou sem gatilho"
    return None


def startup_task_check(
    root: Path,
    anchor: Path,
    *,
    name: str = TASK_NAME,
    query: Callable[[str], TaskState | None] = query_task,
    register: Callable[[Path, Path, str], bool] | None = None,
) -> Check:
    """A tarefa que abre o agente no logon existe, está ativa e aponta para o lançador.

    Só se monta numa instalação de verdade (ou, nos testes, com um nome de tarefa só do teste): a
    tarefa é da máquina inteira.
    """

    def register_task(anchor_dir: Path, root_dir: Path, task: str) -> bool:
        return _register_launcher_task(anchor_dir, root_dir, name=task)

    do_register = register or register_task

    async def run() -> CheckResult:
        state = await _in_thread(lambda: query(name))
        if state is None:
            return CheckResult(True, "não consegui consultar o Agendador agora")
        launcher_missing = [
            item for item in ("launcher.ps1", "launcher.vbs") if not (anchor / item).is_file()
        ]
        if launcher_missing:
            return CheckResult(
                False,
                "faltam arquivos de inicialização: " + ", ".join(launcher_missing),
                fixable=True,
            )
        problem = _task_problem(state, anchor)
        if problem is not None:
            return CheckResult(False, problem, fixable=True)
        return CheckResult(True, "início automático em ordem")

    async def repair() -> str | None:
        def work() -> str | None:
            app_tools = root / "app" / "tools"
            for item in ("launcher.ps1", "launcher.vbs"):
                source = app_tools / item
                if source.is_file() and not (anchor / item).is_file():
                    shutil.copyfile(source, anchor / item)
            if not do_register(anchor, root, name):
                return "o Agendador não aceitou a tarefa nova"
            try:
                _powershell_run(_ENABLE_SCRIPT, name)
            except OSError, subprocess.TimeoutExpired:
                return "não consegui reativar a tarefa"
            return None

        return await _in_thread(work)

    return Check("inicio_automatico", run, repair, "tarefa de início automático refeita")


# --- Supervisor do Windows
# -------------------------------------------------------------------------------------


def supervisor_check(
    runtime: Path,
    *,
    name: str = TASK_NAME,
    now: Callable[[], float] = time.time,
    start_task: Callable[[str], bool] | None = None,
) -> Check:
    """O supervisor (script do Windows) deu sinal de vida há pouco? Sem ele, ninguém reinicia."""
    alive = runtime / "supervisor-alive"

    def launch(task: str) -> bool:
        try:
            done = _powershell_run("Start-ScheduledTask -TaskName $env:UNIOVER_TASK", task)
        except OSError, subprocess.TimeoutExpired:
            return False
        return done.returncode == 0

    do_start = start_task or launch

    async def run() -> CheckResult:
        try:
            age = now() - alive.stat().st_mtime
        except OSError:
            return CheckResult(False, "o supervisor nunca deu sinal de vida", fixable=True)
        if age > SUPERVISOR_SILENCE_SECONDS:
            return CheckResult(False, f"o supervisor está mudo há {age / 60:.0f} min", fixable=True)
        return CheckResult(True, "supervisor ativo")

    async def repair() -> str | None:
        started = await _in_thread(lambda: do_start(name))
        return None if started else "não consegui pedir ao Agendador que inicie o lançador"

    return Check("supervisor", run, repair, "lançador iniciado de novo pelo Agendador")


# --- Conexão com a API
# -----------------------------------------------------------------------------------------


class ConnectionWatch:
    """Desde quando o agente está sem conexão com a API (o diagnóstico só olha queda longa)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._since: float | None = None
        self.connected = False

    def connected_now(self) -> None:
        self.connected = True
        self._since = None

    def disconnected_now(self) -> None:
        if self.connected or self._since is None:
            self._since = self._clock()
        self.connected = False

    def seconds_down(self) -> float:
        """Há quanto tempo está fora; zero se conectado."""
        if self.connected:
            return 0.0
        if self._since is None:
            self._since = self._clock()
        return self._clock() - self._since


def connection_check(
    watch: ConnectionWatch,
    api_reachable: Callable[[], Awaitable[bool]],
    *,
    request_restart: Callable[[], None] | None,
    restarts_marker: Path,
    now: Callable[[], float] = time.time,
) -> Check:
    """Conectado ou fora há pouco: tudo bem. Fora há muito: a API responde? Se sim, é daqui."""

    async def run() -> CheckResult:
        down = watch.seconds_down()
        if down < CONNECTION_GRACE_SECONDS:
            return CheckResult(True, "conectado" if watch.connected else "reconectando")
        minutes = down / 60
        if not await api_reachable():
            return CheckResult(
                False,
                f"sem conexão há {minutes:.0f} min e a API não responde (internet ou servidor)",
                severity="warn",
            )
        return CheckResult(
            False,
            f"a API responde, mas o agente não conecta há {minutes:.0f} min",
            fixable=request_restart is not None and _may_restart(restarts_marker, now()),
        )

    async def repair() -> str | None:
        if request_restart is None:
            return "sem supervisor para reiniciar"
        await _in_thread(request_restart)
        await _in_thread(lambda: _mark_restart(restarts_marker))
        return None

    return Check("conexao", run, repair, "reinício do agente pedido ao supervisor")


def api_check(reachable: Callable[[], Awaitable[bool]]) -> Check:
    """A API responde por HTTP (sem abrir o canal do agente)? Dormindo ela demora a acordar."""

    async def run() -> CheckResult:
        if await reachable():
            return CheckResult(True, "a API responde")
        return CheckResult(
            False, "a API não respondeu agora (pode estar acordando)", severity="warn"
        )

    return Check("api", run)


def _may_restart(marker: Path, moment: float) -> bool:
    try:
        return moment - marker.stat().st_mtime >= RESTART_SPACING_SECONDS
    except OSError:
        return True


def _mark_restart(marker: Path) -> None:
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(str(int(time.time())), encoding="ascii")
    except OSError:
        _log.warning("não consegui anotar o reinício pedido pelo auto-reparo", exc_info=True)


# --- TV e tarefas de fundo
# -------------------------------------------------------------------------------------


def tv_check(reachable: Callable[[], Awaitable[bool]]) -> Check:
    """A TV responde na porta do controle? Desligada é normal: só avisa depois de várias vezes."""
    closed = 0

    async def run() -> CheckResult:
        nonlocal closed
        if await reachable():
            closed = 0
            return CheckResult(True, "TV alcançável")
        closed += 1
        if closed < TV_CLOSED_RUNS:
            return CheckResult(True, "a TV não respondeu (talvez desligada)")
        return CheckResult(False, "a TV não responde há um bom tempo", severity="warn")

    return Check("tv", run)


def background_tasks_check(health: TaskHealth, *, limit: int = 3) -> Check:
    """Alguma tarefa de fundo caiu várias vezes na última hora? Elas voltam, mas vale olhar."""

    async def run() -> CheckResult:
        shaky = {name: count for name, count in health.recent_failures().items() if count >= limit}
        if not shaky:
            return CheckResult(True, "tarefas de fundo estáveis")
        listed = ", ".join(f"{name} ({count} vezes)" for name, count in sorted(shaky.items()))
        return CheckResult(False, f"tarefas de fundo que caíram na última hora: {listed}")

    return Check("tarefas", run)
