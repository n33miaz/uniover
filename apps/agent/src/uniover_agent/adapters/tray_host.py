"""Host visual Windows da bandeja; o controlador Python continua dono das acoes.

O PowerShell do sistema cria o icone e o menu WinForms no mesmo processo STA. Estado sem
segredos atravessa um arquivo atomico; pelo stdout voltam somente nomes de acoes e a confirmacao
do estado aplicado no icone (`APPLIED`, com a visualizacao mostrada). Se o host nao iniciar ou
cair, o chamador usa o menu nativo pystray.
"""

import json
import logging
import os
import queue
import subprocess
import textwrap
import threading
import time
from collections.abc import Callable
from pathlib import Path

from uniover_agent.adapters import pc_screen_presence
from uniover_agent.adapters.pc_screen_presence import (
    TrayBeat,
    acknowledge_viewing,
    close_tray_handle,
    create_tray_wake_event,
    wait_tray_wake,
    wake_tray,
)
from uniover_agent.adapters.process import popen_hidden
from uniover_agent.adapters.tray_controller import TrayController, promote_in_background
from uniover_agent.adapters.tray_registry import FilePromotionMarker, WindowsNotifyIconSettings
from uniover_agent.adapters.tray_win32 import own_image_path
from uniover_agent.adapters.update_basics import DRILL_ENV
from uniover_agent.core.tray_model import MENU, MenuEntry, TrayView
from uniover_agent.core.tray_promotion import find_entry
from uniover_agent.ports.diagnostics import Severity

_log = logging.getLogger(__name__)
# Caracteres por linha do aviso de rede no menu (o menu tem 280 px; Segoe UI 8).
_HINT_WIDTH = 46
_READY_TIMEOUT = 8.0
_REFRESH_SECONDS = 2.0
# Até 3,15 s entre as tentativas de trocar o arquivo de estado, que pode estar aberto no host
# ou preso por um antivírus. Esse total entra no prazo de confirmação da visualização.
_REPLACE_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.8, 1.6)
# ERROR_SHARING_VIOLATION e ERROR_LOCK_VIOLATION: o arquivo está aberto por outro processo.
_SHARING_ERRORS = frozenset({32, 33})
_WARN_EVERY_SECONDS = 60.0
_last_warning = float("-inf")
Record = Callable[[str, Severity, str], None]


def host_script() -> Path:
    return Path(__file__).resolve().parents[3] / "tools" / "tray-host.ps1"


class _HostStoppedError(Exception):
    pass


def _promote_host(
    base: Path,
    executable: str,
    record: Record,
    stopping: threading.Event,
) -> None:
    if os.environ.get(DRILL_ENV) == "1":
        return
    if stopping.is_set():
        return
    settings = WindowsNotifyIconSettings()
    marker = FilePromotionMarker(base / "runtime" / "tray-promoted.json")
    old_path = own_image_path()
    if marker.done(old_path):
        old_entry = find_entry(settings.entries(), old_path)
        if old_entry is None or settings.promoted(old_entry.key) is not True:
            # O icone antigo foi escondido, ou o Windows nao guardou a escolha.
            # A versao nova nao deve torna-lo visivel contra essa preferencia.
            marker.mark(executable)
            return

    def wait_or_stop(seconds: float) -> None:
        if stopping.wait(seconds):
            raise _HostStoppedError

    try:
        promote_in_background(settings, marker, executable, record, sleep=wait_or_stop)
    except _HostStoppedError:
        return


def _write_state(  # noqa: PLR0913 - estado, destino e opções da gravação
    path: Path,
    view: TrayView,
    assets: Path,
    *,
    balloon: dict[str, str] | None = None,
    exit_host: bool = False,
    record: Record | None = None,
) -> bool:
    """Grava o estado que o host mostra; `False` se não deu (o host segue com o anterior)."""
    data = {
        "icon": str(assets / view.icon_file),
        "title": view.title,
        "status": view.status_text + (" · Atenção" if view.attention else ""),
        # Codigo ASCII do estado: o host o compara no lugar do texto acentuado (`tray-host.ps1`).
        "code": view.state,
        # O que fazer com a queda, em linhas curtas (vazio esconde o item no menu).
        "hint": textwrap.wrap(view.hint, _HINT_WIDTH),
        # A visualização da tela em curso (nulo esconde o item de parar).
        "viewing": view.screen_session,
        "menu": [
            None if entry is None else {"action": entry.action, "label": entry.label}
            for entry in MENU
        ],
        "balloon": balloon,
        "exit": exit_host,
    }
    # Temporário com o número do processo: dois ícones (um antigo que ainda não saiu e o novo)
    # nunca disputam o mesmo arquivo de troca, que era o "arquivo em uso" / "Acesso negado".
    temporary = path.with_name(f"{path.name}.{os.getpid()}.new")
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        _replace_with_retry(temporary, path)
    except OSError as exc:
        # Não derruba o laço da bandeja: a próxima atualização (a cada poucos segundos) regrava.
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        _warn_state_not_written(exc, record)
        return False
    return True


def _replace_with_retry(temporary: Path, path: Path) -> None:
    # O host WinForms (ou um antivírus) pode estar lendo o destino; no Windows isso impede a troca.
    for delay in _REPLACE_DELAYS:
        try:
            os.replace(temporary, path)
            return
        except OSError as exc:
            if not _is_transient(exc):
                raise
            time.sleep(delay)
    os.replace(temporary, path)


def _is_transient(exc: OSError) -> bool:
    """Acesso negado ou arquivo em uso por outro processo: passa sozinho, vale tentar de novo."""
    return isinstance(exc, PermissionError) or getattr(exc, "winerror", None) in _SHARING_ERRORS


def _warn_state_not_written(exc: OSError, record: Record | None) -> None:
    """No máximo um aviso por minuto, sem traceback."""
    global _last_warning  # noqa: PLW0603 - limite de frequência do processo
    now = time.monotonic()
    if now - _last_warning >= _WARN_EVERY_SECONDS:
        _last_warning = now
        _log.warning("nao consegui gravar o estado da bandeja (%s); tento de novo", exc)
        if record is not None:
            record("tray.state_write_failed", "warn", type(exc).__name__)


def _confirm_applied(
    applied: tuple[str, int], awaited: str | None, indicator: TrayBeat | None
) -> None:
    """Renova a prova de vida só quando o host diz que aplicou no ícone o estado esperado.

    `awaited` é a visualização do último estado gravado (vazia sem ninguém vendo); `None` quando a
    gravação falhou e nenhuma confirmação vale."""
    viewing, received_tick = applied
    if (
        indicator is None
        or viewing != awaited
        or not pc_screen_presence.fresh_tray_tick(received_tick)
    ):
        return
    indicator.beat(received_tick)
    if awaited:
        acknowledge_viewing(awaited)


def run_host(  # noqa: PLR0912, PLR0913, PLR0917, PLR0915 - integra processo e comandos
    base: Path,
    assets: Path,
    first: TrayView,
    controller: TrayController,
    set_stop: Callable[[Callable[[], None]], None],
    set_notify: Callable[[Callable[[str, str], bool] | None], None],
    record: Record,
    indicator: TrayBeat | None = None,
) -> bool:
    """Retorna True apos Sair; False quando o host falha e o pystray deve assumir.

    `indicator` recebe a prova de vida enquanto o host confirma que aplica o estado no ícone."""
    script = host_script()
    if not script.is_file():
        return False
    runtime = base / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    state = runtime / "tray-host-state.json"
    written = _write_state(state, first, assets, record=record)
    events: queue.Queue[str] = queue.Queue()
    applied_lock = threading.Lock()
    latest_applied: tuple[str, int] | None = None
    pending: queue.Queue[dict[str, str]] = queue.Queue()
    stopping = threading.Event()
    executable = (
        Path(os.environ.get("SystemRoot", r"C:\Windows"))
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    log_path = base / "logs" / "tray-host.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as errors:
        try:
            process = popen_hidden(
                [
                    str(executable),
                    "-NoProfile",
                    "-Sta",
                    "-WindowStyle",
                    "Hidden",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script),
                    "-StatePath",
                    str(state),
                    # O host sai sozinho quando este processo some (morto por fora): nunca
                    # fica um ícone órfão segurando o arquivo de estado do próximo.
                    "-ParentPid",
                    str(os.getpid()),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=errors,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except OSError as exc:
            record("tray.host_failed", "warn", f"host visual indisponível: {type(exc).__name__}")
            state.unlink(missing_ok=True)
            return False
        stdout = process.stdout
        if stdout is None:
            process.terminate()
            record("tray.host_failed", "warn", "host visual sem canal de comandos")
            return False

        def read_actions() -> None:
            nonlocal latest_applied
            try:
                for line in stdout:
                    command = line.strip()
                    kind, _, viewing = command.partition(" ")
                    if kind != "APPLIED":
                        events.put(command)
                        continue
                    received_tick = pc_screen_presence.tray_tick()
                    # Um só aviso na fila aponta para a confirmação mais recente. As ações de
                    # menu continuam na fila, na ordem em que chegaram.
                    with applied_lock:
                        if latest_applied is None:
                            events.put("APPLIED")
                        latest_applied = viewing, received_tick
            finally:
                events.put("EXIT")

        threading.Thread(target=read_actions, name="tray-host-actions", daemon=True).start()
        try:
            ready = events.get(timeout=_READY_TIMEOUT)
        except queue.Empty:
            ready = ""
        if ready != "READY":
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
            record("tray.host_failed", "warn", "host visual nao iniciou; menu nativo mantido")
            state.unlink(missing_ok=True)
            return False

        def notify(message: str, title: str) -> bool:
            if process.poll() is not None:
                return False
            pending.put({"message": message, "title": title})
            return True

        set_stop(stopping.set)
        set_notify(notify)
        threading.Thread(
            target=_promote_host,
            args=(base, str(executable), record, stopping),
            name="tray-host-promotion",
            daemon=True,
        ).start()

        def watch_wake() -> None:
            wake = create_tray_wake_event()
            if not wake:
                return
            try:
                while not stopping.is_set():
                    if wait_tray_wake(wake, 0.5) and not stopping.is_set():
                        events.put("WAKE")
            finally:
                close_tray_handle(wake)

        threading.Thread(target=watch_wake, name="tray-host-wake", daemon=True).start()
        view = first
        # `READY` não conta como prova de vida: ela espera a primeira confirmação do estado.
        awaited = (first.screen_session or "") if written else None
        next_refresh = time.monotonic() + _REFRESH_SECONDS
        try:
            while not stopping.is_set():
                try:
                    line = events.get(timeout=max(0.0, next_refresh - time.monotonic()))
                except queue.Empty:
                    line = ""
                if line == "EXIT" or process.poll() is not None:
                    stopping.set()
                    record("tray.host_failed", "warn", "host visual fechou; menu nativo restaurado")
                    return False
                if line == "APPLIED":
                    with applied_lock:
                        applied, latest_applied = latest_applied, None
                    if applied is not None:
                        _confirm_applied(applied, awaited, indicator)
                    # As confirmações chegam sem parar: não regravam o estado antes da hora, nem
                    # adiam a próxima atualização.
                    if time.monotonic() < next_refresh:
                        continue
                elif line.startswith("ACTION "):
                    # "Parar de mostrar a tela" traz junto a visualização que o menu mostrava.
                    action, _, session = line[7:].partition(" ")
                    if any(
                        isinstance(entry, MenuEntry) and entry.action == action for entry in MENU
                    ):
                        controller.handle(action, session or None)
                if stopping.is_set():
                    break
                try:
                    awaited = None
                    view = controller.refresh()
                    balloon = None if pending.empty() else pending.get_nowait()
                    if _write_state(state, view, assets, balloon=balloon, record=record):
                        awaited = view.screen_session or ""
                except Exception as exc:
                    _log.warning("nao consegui atualizar o painel da bandeja", exc_info=True)
                    record("tray.refresh_failed", "error", type(exc).__name__)
                next_refresh = time.monotonic() + _REFRESH_SECONDS
            _write_state(state, view, assets, exit_host=True, record=record)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.terminate()
            return True
        finally:
            # Antes de esperar o processo: daqui em diante não há ícone garantido.
            if indicator is not None:
                indicator.suspend()
            stopping.set()
            wake_tray()
            set_notify(None)
            stdout.close()
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
            state.unlink(missing_ok=True)
