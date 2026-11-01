"""Ícone da bandeja do Windows, isolado do processo que controla a TV.

O desenho (um disco redondo cuja cor segue o estado, com um selo quando algo pede atenção) vem de
`.ico` prontos em `assets/tray`, um por estado. Duas coisas do pystray são trocadas para o ícone
sair nítido e estável:

- O pystray reserializa a imagem e a carrega com o tamanho padrão do Windows (32 px), que depois é
  encolhido para 16, 20 ou 24 e borra. Aqui o `.ico` é carregado direto, no tamanho exato da bandeja
  (e o processo declara suporte a DPI, senão o Windows pede sempre 16 px e estica).
- O identificador do ícone no Windows (`hID`) passa a ser fixo. Com o `id()` do objeto, cada
  execução parecia um ícone novo e o Windows esquecia onde a pessoa o tinha colocado.

Ambos mexem em métodos internos do pystray (`_assert_icon_handle`, `_message`); um teste falha se
eles sumirem, e o ícone cai no desenho antigo, só menos nítido, em vez de quebrar.
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

from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.self_update import DRILL_ENV
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.tray_assets import assets_dir, frame
from uniover_agent.adapters.tray_controller import (
    TrayController,
    TrayEnv,
    promote_in_background,
)
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
from uniover_agent.config import Settings
from uniover_agent.core.diagnostics import describe_exception
from uniover_agent.core.tray_model import MENU, MenuEntry, TrayView
from uniover_agent.ports.diagnostics import Severity
from uniover_agent.ports.tray import ICON_ID

_log = logging.getLogger(__name__)

REFRESH_SECONDS: Final = 2.0
DEFAULT_SITE: Final = "https://uniover.onrender.com"


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

    def _message(self, code: int, flags: int, **kwargs: Any) -> None:
        from pystray._util import win32  # type: ignore[import-untyped]  # noqa: PLC0415 - só no Windows

        win32.Shell_NotifyIcon(
            code,
            win32.NOTIFYICONDATAW(
                cbSize=ctypes.sizeof(win32.NOTIFYICONDATAW),
                hWnd=self._hwnd,
                hID=ICON_ID,
                uFlags=flags,
                **kwargs,
            ),
        )


def _open_url(url: str) -> None:
    webbrowser.open(url)


def _open_file(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606 - abre o registro no programa padrão do usuário


class _Recorder:
    """Grava ocorrências de diagnóstico do ícone (componente `tray`); nunca levanta."""

    def __init__(self) -> None:
        from uniover_agent.care_setup import build_diagnostics  # noqa: PLC0415 - evita ciclo na importação

        self._kit = build_diagnostics(SystemClock())

    def __call__(self, kind: str, severity: Severity, detail: str) -> None:
        self._kit.recorder.record(kind, severity, detail, component="tray")

    def failure(self, kind: str, detail: str, error: BaseException) -> None:
        self._kit.recorder.record(kind, "error", detail, component="tray", error=error)


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
    settings = Settings()
    assets = assets_dir()
    holder: dict[str, SharpIcon] = {}

    def notify(message: str, title: str) -> bool:
        """Só há balão com o ícone já visível; devolve se foi mostrado."""
        icon = holder.get("icon")
        if icon is None or not icon.visible:
            return False
        icon.notify(message, title)
        return True

    def stop() -> None:
        holder["icon"].stop()

    env = TrayEnv(
        base=base,
        now=lambda: datetime.now(UTC),
        read_inputs=read_tray_inputs,
        open_url=_open_url,
        open_file=_open_file,
        notify=notify,
        stop=stop,
        record=recorder,
        site_url=settings.api_url or DEFAULT_SITE,
    )
    controller = TrayController(env)
    # Primeira leitura só para escolher o ícone: o balão espera o ícone aparecer (ver `refresh`).
    first = controller.refresh(announce=False)

    def item(entry: MenuEntry | None) -> Any:
        if entry is None:
            return pystray.Menu.SEPARATOR
        return pystray.MenuItem(
            entry.label, lambda *_: controller.handle(entry.action), default=entry.default
        )

    size = small_icon_size()
    icon = SharpIcon(
        "UniOver",
        frame(assets / first.icon_file, size),
        first.title,
        pystray.Menu(*[item(entry) for entry in MENU]),
    )
    icon.ico_file = assets / first.icon_file
    icon.icon_size = size
    holder["icon"] = icon

    def apply(view: TrayView) -> None:
        current = small_icon_size(getattr(icon, "_hwnd", None))
        path = assets / view.icon_file
        if path != icon.ico_file or current != icon.icon_size:
            icon.ico_file, icon.icon_size = path, current
            icon.icon = frame(path, current)
        icon.title = view.title

    def refresh_loop() -> None:
        while True:
            try:
                apply(controller.refresh())
            except Exception as exc:
                _log.warning("a bandeja não conseguiu atualizar o ícone", exc_info=True)
                recorder("tray.refresh_failed", "error", describe_exception(exc))
            time.sleep(REFRESH_SECONDS)

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
        icon.visible = True
        threading.Thread(target=refresh_loop, daemon=True).start()
        threading.Thread(target=promote, daemon=True).start()

    icon.run(setup=setup)
    return 0
