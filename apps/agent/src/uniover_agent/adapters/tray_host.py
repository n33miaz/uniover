"""Host visual Windows da bandeja; o controlador Python continua dono das acoes.

O PowerShell do sistema cria o icone e o menu WinForms no mesmo processo STA. Estado sem
segredos atravessa um arquivo atomico; somente nomes de acoes voltam pelo stdout. Se o host
nao iniciar ou cair, o chamador usa o menu nativo pystray.
"""

import json
import logging
import os
import queue
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path

from uniover_agent.adapters.process import popen_hidden
from uniover_agent.adapters.self_update import DRILL_ENV
from uniover_agent.adapters.tray_controller import TrayController, promote_in_background
from uniover_agent.adapters.tray_registry import FilePromotionMarker, WindowsNotifyIconSettings
from uniover_agent.adapters.tray_win32 import own_image_path
from uniover_agent.core.tray_model import MENU, MenuEntry, TrayView
from uniover_agent.core.tray_promotion import find_entry
from uniover_agent.ports.diagnostics import Severity

_log = logging.getLogger(__name__)
_STATE_TEXT = {
    "connected": "Conectado",
    "reconnecting": "Reconectando",
    "error": "Sem conexão",
    "updating": "Atualizando",
}
_READY_TIMEOUT = 8.0
_REFRESH_SECONDS = 2.0
_REPLACE_ATTEMPTS = 5
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


def _write_state(
    path: Path,
    view: TrayView,
    assets: Path,
    *,
    balloon: dict[str, str] | None = None,
    exit_host: bool = False,
) -> None:
    data = {
        "icon": str(assets / view.icon_file),
        "title": view.title,
        "status": _STATE_TEXT[view.state] + (" · Atenção" if view.attention else ""),
        "menu": [
            None if entry is None else {"action": entry.action, "label": entry.label}
            for entry in MENU
        ],
        "balloon": balloon,
        "exit": exit_host,
    }
    temporary = path.with_suffix(".json.new")
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    # O host WinForms pode estar lendo o destino; no Windows essa leitura breve impede a troca.
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            os.replace(temporary, path)
            break
        except PermissionError:
            if attempt == _REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(0.02)


def run_host(  # noqa: PLR0912, PLR0913, PLR0917, PLR0915 - integra processo e comandos
    base: Path,
    assets: Path,
    first: TrayView,
    controller: TrayController,
    set_stop: Callable[[Callable[[], None]], None],
    set_notify: Callable[[Callable[[str, str], bool] | None], None],
    record: Record,
) -> bool:
    """Retorna True apos Sair; False quando o host falha e o pystray deve assumir."""
    script = host_script()
    if not script.is_file():
        return False
    runtime = base / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    state = runtime / "tray-host-state.json"
    _write_state(state, first, assets)
    events: queue.Queue[str] = queue.Queue()
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
            for line in stdout:
                events.put(line.strip())
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
        view = first
        try:
            while not stopping.is_set():
                try:
                    line = events.get(timeout=_REFRESH_SECONDS)
                except queue.Empty:
                    line = ""
                if line == "EXIT" or process.poll() is not None:
                    stopping.set()
                    record("tray.host_failed", "warn", "host visual fechou; menu nativo restaurado")
                    return False
                if line.startswith("ACTION "):
                    action = line[7:]
                    if any(
                        isinstance(entry, MenuEntry) and entry.action == action for entry in MENU
                    ):
                        controller.handle(action)
                if stopping.is_set():
                    break
                try:
                    view = controller.refresh()
                    balloon = None if pending.empty() else pending.get_nowait()
                    _write_state(state, view, assets, balloon=balloon)
                except Exception as exc:
                    _log.warning("nao consegui atualizar o painel da bandeja", exc_info=True)
                    record("tray.refresh_failed", "error", type(exc).__name__)
            _write_state(state, view, assets, exit_host=True)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.terminate()
            return True
        finally:
            stopping.set()
            set_notify(None)
            stdout.close()
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
            state.unlink(missing_ok=True)
