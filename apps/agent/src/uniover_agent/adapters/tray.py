"""Ícone da bandeja do Windows, isolado do processo que controla a TV.

O desenho (um disco redondo cuja cor segue o estado, com um selo quando algo pede atenção) vem de
`.ico` prontos em `assets/tray`, um por estado. Duas coisas do pystray são trocadas para o ícone
sair nítido e estável:

- O pystray reserializa a imagem e a carrega com o tamanho padrão do Windows (32 px), que depois é
  encolhido para 16, 20 ou 24 e borra. Aqui o `.ico` é carregado direto, no tamanho exato da bandeja
  (e o processo declara suporte a DPI, senão o Windows pede sempre 16 px e estica).
- O identificador do ícone no Windows (`hID`) passa a ser fixo. Com o `id()` do objeto, cada
  execução parecia um ícone novo e o Windows esquecia onde a pessoa o tinha colocado.

O adaptador usa métodos internos do pystray para carregar o ícone e verificar o retorno do Windows
ao adicioná-lo ou atualizá-lo.
"""

import ctypes
import logging
import os
import sys
import threading
import time
import webbrowser
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

import pystray  # type: ignore[import-untyped]

from uniover_agent.adapters.diagnostics_file import open_diagnostics
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.pc_screen_presence import (
    TrayBeat,
    acknowledge_viewing,
    close_tray_handle,
    create_tray_wake_event,
    request_screen_stop,
    wait_tray_wake,
)
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.tray_assets import assets_dir, frame
from uniover_agent.adapters.tray_controller import (
    TrayController,
    TrayEnv,
    promote_in_background,
)
from uniover_agent.adapters.tray_host import run_host
from uniover_agent.adapters.tray_registry import FilePromotionMarker, WindowsNotifyIconSettings
from uniover_agent.adapters.tray_status import read_tray_inputs
from uniover_agent.adapters.tray_win32 import (
    SingleInstance,
    load_icon_handle,
    make_dpi_aware,
    mutex_name,
    own_image_path,
    small_icon_size,
)
from uniover_agent.adapters.update_basics import DRILL_ENV
from uniover_agent.config import Settings
from uniover_agent.core.diagnostics import describe_exception
from uniover_agent.core.tray_model import MenuEntry, TrayView, menu_for
from uniover_agent.ports.diagnostics import Severity
from uniover_agent.ports.tray import ICON_ID

_log = logging.getLogger(__name__)

REFRESH_SECONDS: Final = 2.0
DEFAULT_SITE: Final = "https://uniover.onrender.com"


class _ShellNotifyError(OSError):
    pass


class SharpIcon(pystray.Icon):  # type: ignore[misc]
    """`pystray.Icon` que carrega o `.ico` no tamanho exato e usa um `hID` fixo."""

    ico_file: Path | None = None
    icon_size: int = 16

    def _assert_icon_handle(self) -> None:
        if self._icon_handle:  # type: ignore[has-type]
            return
        if self.ico_file is not None:
            handle = load_icon_handle(self.ico_file, self.icon_size)
            if handle:
                self._icon_handle = handle
                return
        super()._assert_icon_handle()

    def _update_icon(self) -> None:
        # O pystray chama este método antes de NIM_ADD. Nessa hora só há um ícone para carregar.
        if self.visible:
            super()._update_icon()
        else:
            self._assert_icon_handle()

    def _message(self, code: int, flags: int, **kwargs: Any) -> None:
        from pystray._util import win32  # type: ignore[import-untyped]  # noqa: PLC0415 - só no Windows

        applied = win32.Shell_NotifyIcon(
            code,
            win32.NOTIFYICONDATAW(
                cbSize=ctypes.sizeof(win32.NOTIFYICONDATAW),
                hWnd=self._hwnd,
                hID=ICON_ID,
                uFlags=flags,
                **kwargs,
            ),
        )
        if not applied and code in (win32.NIM_ADD, win32.NIM_MODIFY):
            raise _ShellNotifyError(f"O Windows recusou a atualização do ícone ({code}).")

    def confirm_visible(self) -> None:
        """Confirma o ícone atual com o Windows, mesmo quando o estado não mudou."""
        from pystray._util import win32  # noqa: PLC0415 - só no Windows

        self._assert_icon_handle()
        self._message(
            win32.NIM_MODIFY,
            win32.NIF_ICON | win32.NIF_TIP,
            hIcon=self._icon_handle,
            szTip=self.title,
        )


def _open_url(url: str) -> None:
    webbrowser.open(url)


def _open_file(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606 - abre o registro no programa padrão do usuário


class _Recorder:
    """Grava ocorrências de diagnóstico do ícone (componente `tray`); nunca levanta."""

    def __init__(self) -> None:
        # A mesma fila e os mesmos nomes apagados do agente, sem a montagem dele (`care_setup`).
        _, self._recorder = open_diagnostics(SystemClock())

    def __call__(self, kind: str, severity: Severity, detail: str) -> None:
        self._recorder.record(kind, severity, detail, component="tray")

    def failure(self, kind: str, detail: str, error: BaseException) -> None:
        self._recorder.record(kind, "error", detail, component="tray", error=error)


def run_tray() -> int:
    """Roda até o ícone fechar; falta de bandeja é uma falha inofensiva para o supervisor."""
    base = installation_base()
    instance = SingleInstance(mutex_name(base))
    if not instance.first:
        return 0
    make_dpi_aware()
    recorder = _Recorder()
    try:
        return _run(base, recorder)
    except Exception as exc:
        _log.exception("o ícone da bandeja parou")
        recorder.failure("tray.failed", "o ícone da bandeja parou", exc)
        return 1


def _run(base: Path, recorder: _Recorder) -> int:
    indicator = TrayBeat()
    try:
        return _show(base, recorder, indicator)
    finally:
        indicator.withdraw()


def _show(  # noqa: PLR0915 - integra dois hosts de bandeja
    base: Path, recorder: _Recorder, indicator: TrayBeat
) -> int:
    settings = Settings()
    assets = assets_dir()
    holder: dict[str, Any] = {}

    def notify(message: str, title: str) -> bool:
        """Só há balão com o ícone já visível; devolve se foi mostrado."""
        native_notify = holder.get("native_notify")
        if native_notify is not None:
            return bool(native_notify(message, title))
        icon = holder.get("icon")
        if icon is None or not icon.visible:
            return False
        icon.notify(message, title)
        return True

    def stop() -> None:
        # Antes de fechar: o "Sair" encerra a tela já, sem esperar o processo do ícone acabar.
        indicator.withdraw()
        callback = holder.get("stop")
        if callback is not None:
            callback()

    env = TrayEnv(
        base=base,
        now=lambda: datetime.now(UTC),
        read_inputs=read_tray_inputs,
        open_url=_open_url,
        open_file=_open_file,
        notify=notify,
        stop=stop,
        stop_screen=request_screen_stop,
        record=recorder,
        site_url=settings.api_url or DEFAULT_SITE,
    )
    controller = TrayController(env)
    # Primeira leitura só para escolher o ícone: o balão espera o ícone aparecer (ver `refresh`).
    first = controller.refresh(announce=False)

    if sys.platform == "win32" and os.environ.get("UNIOVER_TRAY_NATIVE") != "0":
        try:
            if run_host(
                base,
                assets,
                first,
                controller,
                lambda callback: holder.__setitem__("stop", callback),
                lambda callback: holder.__setitem__("native_notify", callback),
                recorder,
                indicator,
            ):
                return 0
        except Exception as exc:
            _log.warning("o host visual da bandeja falhou", exc_info=True)
            recorder("tray.host_failed", "warn", describe_exception(exc))
        holder.clear()

    def item(entry: MenuEntry | None, session: str | None) -> Any:
        if entry is None:
            return pystray.Menu.SEPARATOR
        return pystray.MenuItem(
            entry.label,
            lambda *_: controller.handle(entry.action, session),
            default=entry.default,
        )

    # O aviso de rede (sem internet, servidor fora, PC sem rede) fica no topo, sem ação, e só
    # aparece quando há motivo.
    hint = {"text": first.hint}
    hint_item = pystray.MenuItem(
        lambda _item: hint["text"],
        None,
        enabled=False,
        visible=lambda _item: bool(hint["text"]),
    )
    screen = {"session": first.screen_session}

    def items() -> tuple[Any, ...]:
        # Montado a cada `update_menu`: o item de parar leva a visualização que o menu mostra.
        session = screen["session"]
        return (hint_item, *[item(entry, session) for entry in menu_for(session)])

    size = small_icon_size()
    icon = SharpIcon(
        "UniOver",
        frame(assets / first.icon_file, size),
        first.title,
        pystray.Menu(items),
    )
    icon.ico_file = assets / first.icon_file
    icon.icon_size = size
    holder["icon"] = icon
    holder["stop"] = icon.stop

    def apply(view: TrayView) -> None:
        current = small_icon_size(getattr(icon, "_hwnd", None))
        path = assets / view.icon_file
        if path != icon.ico_file or current != icon.icon_size:
            image = frame(path, current)
            icon.ico_file, icon.icon_size = path, current
            icon.icon = image
        icon.title = view.title
        if view.hint != hint["text"] or view.screen_session != screen["session"]:
            hint["text"] = view.hint
            screen["session"] = view.screen_session
            icon.update_menu()

    def refresh_loop() -> None:
        wake = create_tray_wake_event()
        try:
            while True:
                try:
                    icon.visible = True
                    view = controller.refresh()
                    apply(view)
                    if icon.visible:
                        icon.confirm_visible()
                        indicator.beat()
                        if view.screen_session:
                            acknowledge_viewing(view.screen_session)
                except Exception as exc:
                    indicator.suspend()
                    if isinstance(exc, _ShellNotifyError):
                        # Permite tentar NIM_ADD de novo se o Explorer perdeu o ícone.
                        icon.visible = False
                    _log.warning("a bandeja não conseguiu atualizar o ícone", exc_info=True)
                    recorder("tray.refresh_failed", "error", describe_exception(exc))
                if wake:
                    wait_tray_wake(wake, REFRESH_SECONDS)
                else:
                    time.sleep(REFRESH_SECONDS)
        finally:
            close_tray_handle(wake)

    def promote() -> None:
        # O ensaio de atualização roda um ícone de verdade numa instalação isolada: nunca mexe no
        # registro real.
        if os.environ.get(DRILL_ENV) == "1":
            return
        try:
            promote_in_background(
                WindowsNotifyIconSettings(), FilePromotionMarker(), own_image_path(), recorder
            )
        except Exception as exc:
            _log.warning("a promoção do ícone falhou", exc_info=True)
            recorder("tray.promote_failed", "error", describe_exception(exc))

    def setup(_: pystray.Icon) -> None:
        threading.Thread(target=refresh_loop, daemon=True).start()
        threading.Thread(target=promote, daemon=True).start()

    icon.run(setup=setup)
    return 0
