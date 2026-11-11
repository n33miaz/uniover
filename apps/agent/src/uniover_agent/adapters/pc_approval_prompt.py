"""A pergunta ao dono na tela do PC: uma janela do Windows, a primeira vez de cada aparelho.

O ícone da bandeja é outro processo (o PowerShell dela só lê o estado e devolve ações de menu):
mostrar uma pergunta de sim ou não ali pediria um protocolo de ida e volta por arquivos e o ouvido
da bandeja ligado, e uma pergunta que não aparece deixaria o aparelho pendente para sempre. O
agente roda na própria sessão do usuário (é por isso que o `SendInput` alcança a área de trabalho),
então ele mesmo mostra a janela. Ela fica por cima de tudo (`TOPMOST`), com "Não" como padrão:
apertar Enter sem ler nunca libera o PC.

O `MessageBoxW` bloqueia a thread que o chama, então cada janela roda numa thread própria
(daemon: nunca segura o encerramento do processo) e tem um título único. Para o agente encerrar com
a janela aberta, `aclose` acha a janela pelo título e manda o clique em "Não" (`WM_COMMAND`: uma
caixa Sim/Não ignora `WM_CLOSE`); a resposta dada assim vale como "sem resposta" e nunca vira
decisão. Depois espera a thread terminar, por pouco tempo.
"""

import asyncio
import contextlib
import logging
import secrets
import sys
import threading
from collections.abc import Callable
from typing import Final

_log = logging.getLogger(__name__)

TITLE: Final = "UniOver"
# MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST
_FLAGS: Final = 0x4 | 0x20 | 0x100 | 0x10000 | 0x40000
_IDYES: Final = 6
_IDNO: Final = 7
# Quanto o encerramento espera a janela sumir, e de quanto em quanto tempo tenta achá-la (a thread
# pode ainda não a ter criado).
CLOSE_WAIT_SECONDS: Final = 3.0
CLOSE_POLL_SECONDS: Final = 0.05
# A pergunta sem resposta por tanto tempo (o dono longe, a tela bloqueada) fecha como "sem resposta"
# e libera a vez dos outros aparelhos; o aparelho pergunta de novo depois.
ASK_TIMEOUT_SECONDS: Final = 120.0

MessageBox = Callable[[str, str, int], int]
# Fecha a janela de título `title` clicando em "Não"; `True` se achou a janela.
WindowCloser = Callable[[str], bool]


def question(name: str) -> str:
    """O texto da janela (o `name` já vem limpo: ver `clean_name`)."""
    return (
        f"Permitir que {name} controle este PC?\n\n"
        "Ele poderá mover o mouse, digitar e abrir programas. Só permita se foi você."
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
    return bool(user32.PostMessageW(window, 0x0111, _IDNO, 0))  # WM_COMMAND, IDNO


class _Window:
    """Uma janela aberta: o título, a thread e se foi o encerramento que a mandou fechar."""

    def __init__(self, title: str) -> None:
        self.title = title
        self.thread: threading.Thread | None = None
        self.dismissed = False


class WindowsApprovalPrompt:
    """Mostra a janela de verdade, uma por vez. `message_box` e `close_window` são trocáveis: os
    testes nunca abrem janela no desktop do dono."""

    def __init__(
        self,
        message_box: MessageBox | None = None,
        close_window: WindowCloser | None = None,
        ask_timeout_seconds: float | None = None,
    ) -> None:
        self._message_box = message_box
        self._close_window = close_window
        self._ask_timeout = ask_timeout_seconds or ASK_TIMEOUT_SECONDS
        self._open: set[_Window] = set()
        # Os fechamentos em andamento (cada um numa thread própria): quem encerra espera por eles.
        self._closers: set[threading.Thread] = set()

    def _show(self) -> MessageBox | None:
        if self._message_box is not None:
            return self._message_box
        return _windows_message_box if sys.platform == "win32" else None

    def _closer(self) -> WindowCloser:
        return self._close_window or (
            _windows_close if sys.platform == "win32" else lambda t: False
        )

    async def ask(self, name: str) -> bool | None:
        show = self._show()
        if show is None:
            return None
        loop = asyncio.get_running_loop()
        window = _Window(f"{TITLE} ({secrets.token_hex(2)})")
        answered: asyncio.Future[int] = loop.create_future()

        def deliver(value: int | BaseException) -> None:
            if answered.done():
                return
            if isinstance(value, BaseException):
                answered.set_exception(value)
            else:
                answered.set_result(value)

        def work() -> None:
            outcome: int | BaseException
            try:
                outcome = show(question(name), window.title, _FLAGS)
            except Exception as exc:
                outcome = exc
            with contextlib.suppress(RuntimeError):  # o laço já fechou (encerrando)
                loop.call_soon_threadsafe(deliver, outcome)

        window.thread = threading.Thread(target=work, name="uniover-approval", daemon=True)
        self._open.add(window)
        window.thread.start()
        try:
            async with asyncio.timeout(self._ask_timeout):
                answer = await answered
        except TimeoutError:
            _log.info("a pergunta ao dono ficou sem resposta; fechando a janela")
            window.dismissed = True
            self._dismiss_in_background(window)
            return None
        except asyncio.CancelledError:
            window.dismissed = True
            self._dismiss_in_background(window)  # nunca prende o laço de quem cancelou
            raise
        finally:
            self._open.discard(window)
        if window.dismissed:
            return None
        if answer == _IDYES:
            return True
        if answer == _IDNO:
            return False
        _log.warning("a janela de aprovação não devolveu uma resposta (%d)", answer)
        return None

    def _dismiss(self, window: _Window) -> None:
        """Clica em "Não" na janela (tentando por um instante, até ela existir). Nunca bloqueia
        mais que `CLOSE_WAIT_SECONDS`."""
        closer = self._closer()
        thread = window.thread
        waited = 0.0
        while thread is not None and thread.is_alive() and waited < CLOSE_WAIT_SECONDS:
            try:
                if closer(window.title):
                    thread.join(CLOSE_POLL_SECONDS * 10)
                    waited += CLOSE_POLL_SECONDS * 10
                    continue
            except Exception:
                _log.debug("não consegui fechar a janela de aprovação", exc_info=True)
            thread.join(CLOSE_POLL_SECONDS)
            waited += CLOSE_POLL_SECONDS

    def _dismiss_in_background(self, window: _Window) -> None:
        """Fecha a janela numa thread daemon: o laço que chama não espera. O `aclose` espera."""
        self._closers = {t for t in self._closers if t.is_alive()}  # poda as que já terminaram
        closer = threading.Thread(
            target=self._dismiss, args=(window,), name="uniover-approval-close", daemon=True
        )
        self._closers.add(closer)
        closer.start()

    def _dismiss_all(self, windows: list[_Window]) -> None:
        for window in windows:
            self._dismiss(window)

    async def aclose(self) -> None:
        """O agente está encerrando: fecha as janelas abertas (sem decisão) e espera as threads."""
        windows = list(self._open)
        for window in windows:
            window.dismissed = True
        closers = list(self._closers)
        if windows or closers:
            await asyncio.to_thread(self._finish_closing, windows, closers)

    def _finish_closing(self, windows: list[_Window], closers: list[threading.Thread]) -> None:
        self._dismiss_all(windows)
        for closer in closers:
            closer.join(CLOSE_WAIT_SECONDS)
        self._closers = {t for t in self._closers if t.is_alive()}
