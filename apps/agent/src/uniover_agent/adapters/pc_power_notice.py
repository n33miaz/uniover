"""O aviso na tela do PC durante a contagem de desligar ou reiniciar.

O pedido vem do app, às vezes de outra pessoa (o convidado confirma só na folha do celular): quem
está na frente do PC precisa ver que ele vai desligar, quando, e como impedir. É a mesma janela
leve da pergunta de aprovação (`pc_approval_prompt`): um `MessageBoxW` numa thread própria, por
cima de tudo, com título único. Sem `MB_SETFOREGROUND`: o aviso aparece sem roubar o foco de quem
está digitando (um Enter no meio do texto não decide nada por engano).

"Cancelar" (ou Esc) cancela a contagem; "OK" só fecha o aviso, e a contagem segue. O texto de uma
caixa dessas não muda depois de aberta, então ele diz a hora do fim e quantos segundos faltavam.
Quando a contagem acaba ou o app a cancela, o agente fecha a janela clicando em "OK" por ela
(`WM_COMMAND`); a resposta dada assim nunca vale como pedido de cancelamento. Nada vai a disco.
"""

import contextlib
import logging
import secrets
import sys
import threading
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Final

_log = logging.getLogger(__name__)

TITLE: Final = "UniOver"
# MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON1 | MB_TOPMOST
_FLAGS: Final = 0x1 | 0x30 | 0x0 | 0x40000
_IDOK: Final = 1
_IDCANCEL: Final = 2
# Quanto o fechamento tenta achar a janela (a thread pode ainda não a ter criado).
CLOSE_WAIT_SECONDS: Final = 3.0
CLOSE_POLL_SECONDS: Final = 0.05

MessageBox = Callable[[str, str, int], int]
# Fecha a janela de título `title` clicando em "OK"; `True` se achou a janela.
WindowCloser = Callable[[str], bool]

_VERB: Final = {"SHUTDOWN": "desligar", "RESTART": "reiniciar"}
_APP_BUTTON: Final = {"SHUTDOWN": "Cancelar Desligamento", "RESTART": "Cancelar Reinício"}


def notice_text(action: str, seconds: int, deadline: datetime) -> str:
    """O texto do aviso: o que vai acontecer, quando, e os dois jeitos de cancelar."""
    verb = _VERB.get(action, "desligar")
    button = _APP_BUTTON.get(action, _APP_BUTTON["SHUTDOWN"])
    return (
        f"Este PC vai {verb} às {deadline:%H:%M:%S} (em {seconds} s), a pedido do app UniOver.\n\n"
        f'Para impedir, clique em Cancelar aqui ou toque em "{button}" no app. '
        "OK só fecha este aviso."
    )


def _windows_message_box(text: str, title: str, flags: int) -> int:
    import ctypes  # noqa: PLC0415 - só no Windows

    return int(ctypes.windll.user32.MessageBoxW(None, text, title, flags))


def _windows_close(title: str) -> bool:
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.FindWindowW.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR)
    user32.FindWindowW.restype = wintypes.HWND
    user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    user32.PostMessageW.restype = wintypes.BOOL
    window = user32.FindWindowW("#32770", title)  # a classe das caixas de diálogo
    if not window:
        return False
    return bool(user32.PostMessageW(window, 0x0111, _IDOK, 0))  # WM_COMMAND, IDOK


class _Window:
    def __init__(self, title: str, countdown_id: str) -> None:
        self.title = title
        self.countdown_id = countdown_id
        self.thread: threading.Thread | None = None
        # O agente mandou fechar: o que a caixa devolver depois disso não é decisão de ninguém.
        self.dismissed = False


class WindowsPowerNotice:
    """Um aviso por vez. `message_box`, `close_window` e `now` são trocáveis: os testes nunca abrem
    janela no desktop de quem os roda."""

    def __init__(
        self,
        message_box: MessageBox | None = None,
        close_window: WindowCloser | None = None,
        now: Callable[[], datetime] = datetime.now,
    ) -> None:
        self._message_box = message_box
        self._close_window = close_window
        self._now = now
        self._lock = threading.Lock()
        self._current: _Window | None = None

    def _show_box(self) -> MessageBox | None:
        if self._message_box is not None:
            return self._message_box
        # Lido na hora (não no `__init__`): a guarda dos testes troca a função do módulo.
        return _windows_message_box if sys.platform == "win32" else None

    def _closer(self) -> WindowCloser:
        if self._close_window is not None:
            return self._close_window
        return _windows_close if sys.platform == "win32" else (lambda title: False)

    def show(
        self, countdown_id: str, action: str, seconds: int, cancel: Callable[[], None]
    ) -> None:
        box = self._show_box()
        if box is None:
            return
        self._close_current()
        window = _Window(f"{TITLE} ({secrets.token_hex(2)})", countdown_id)
        text = notice_text(action, seconds, self._now() + timedelta(seconds=seconds))

        def work() -> None:
            try:
                answer = box(text, window.title, _FLAGS)
            except Exception:
                _log.warning("não consegui mostrar o aviso da contagem na tela", exc_info=True)
                return
            finally:
                with self._lock:
                    if self._current is window:
                        self._current = None
            if window.dismissed or answer != _IDCANCEL:
                return
            try:
                cancel()
            except Exception:
                _log.warning("o cancelamento pedido no aviso da tela falhou", exc_info=True)

        window.thread = threading.Thread(target=work, name="uniover-power-notice", daemon=True)
        with self._lock:
            self._current = window
        window.thread.start()

    def close(self, countdown_id: str) -> None:
        with self._lock:
            window = self._current
            if window is None or window.countdown_id != countdown_id:
                return  # o aviso aberto é de outra contagem: fica
            self._current = None
        self._dismiss_in_background(window)

    def _close_current(self) -> None:
        with self._lock:
            window, self._current = self._current, None
        if window is not None:
            self._dismiss_in_background(window)

    def _dismiss_in_background(self, window: _Window) -> None:
        window.dismissed = True
        threading.Thread(
            target=self._dismiss, args=(window,), name="uniover-power-notice-close", daemon=True
        ).start()

    def _dismiss(self, window: _Window) -> None:
        """Clica em "OK" na janela, tentando por um instante até ela existir."""
        closer = self._closer()
        thread = window.thread
        waited = 0.0
        while thread is not None and thread.is_alive() and waited < CLOSE_WAIT_SECONDS:
            with contextlib.suppress(Exception):
                if closer(window.title):
                    thread.join(CLOSE_POLL_SECONDS * 10)
                    waited += CLOSE_POLL_SECONDS * 10
                    continue
            thread.join(CLOSE_POLL_SECONDS)
            waited += CLOSE_POLL_SECONDS
