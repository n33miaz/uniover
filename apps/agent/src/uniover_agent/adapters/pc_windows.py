"""Controle do PC no Windows: `SendInput`, bloqueio, suspensão, desligamento e abrir programas.

Só o Windows tem estas chamadas. Em outro sistema as classes existem (para a configuração e os
testes montarem o agente) e recusam com `PcUnsupported`. Os eventos já chegam prontos de
`pc_inputs.py`.
"""

import logging
import os
import sys
from collections.abc import Callable, Sequence

from uniover_agent.adapters import pc_inputs
from uniover_agent.adapters.pc_inputs import RawInput
from uniover_agent.adapters.process import run_hidden
from uniover_agent.ports.pc import PcUnsupported

_log = logging.getLogger(__name__)

Sender = Callable[[Sequence[RawInput]], None]

IS_WINDOWS = sys.platform == "win32"
_UNSUPPORTED = "o controle do PC só existe no Windows"
_SHUTDOWN_NOTICE = "O UniOver vai desligar este computador. Para cancelar: shutdown /a"

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    class _MouseInput(ctypes.Structure):
        _fields_ = (
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.c_size_t),
        )

    class _KeyboardInput(ctypes.Structure):
        _fields_ = (
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.c_size_t),
        )

    class _InputUnion(ctypes.Union):
        # `mi` define o tamanho da união (é a maior): sem ela o `sizeof(INPUT)` sai errado.
        _fields_ = (("mi", _MouseInput), ("ki", _KeyboardInput))

    class _Input(ctypes.Structure):
        _fields_ = (("type", wintypes.DWORD), ("union", _InputUnion))

    _INPUT_MOUSE = 0
    _INPUT_KEYBOARD = 1

    def to_native(raw: RawInput) -> _Input:
        """Um evento no formato do Windows (separado do envio, para ser conferido sem enviar)."""
        if raw.kind == "mouse":
            mouse = _MouseInput(raw.dx, raw.dy, raw.data & 0xFFFFFFFF, raw.flags, 0, 0)
            return _Input(_INPUT_MOUSE, _InputUnion(mi=mouse))
        keyboard = _KeyboardInput(raw.vk, raw.scan, raw.flags, 0, 0)
        return _Input(_INPUT_KEYBOARD, _InputUnion(ki=keyboard))

    def native_size() -> int:
        return ctypes.sizeof(_Input)

    def _send_input(inputs: Sequence[RawInput]) -> None:
        if not inputs:
            return
        array = (_Input * len(inputs))(*(to_native(raw) for raw in inputs))
        sent = ctypes.windll.user32.SendInput(len(inputs), array, ctypes.sizeof(_Input))
        if sent != len(inputs):
            # O Windows recusa quando outra janela com mais privilégio (UAC) tem o foco.
            raise OSError(f"o Windows aceitou {sent} de {len(inputs)} eventos de entrada")

    def _lock_workstation() -> bool:
        return bool(ctypes.windll.user32.LockWorkStation())

    def _suspend() -> bool:
        # Suspender (não hibernar), sem forçar: um app que recusa o aviso segura a suspensão.
        return bool(ctypes.windll.powrprof.SetSuspendState(False, False, False))

else:

    def _send_input(inputs: Sequence[RawInput]) -> None:
        raise PcUnsupported(_UNSUPPORTED)

    def _lock_workstation() -> bool:
        raise PcUnsupported(_UNSUPPORTED)

    def _suspend() -> bool:
        raise PcUnsupported(_UNSUPPORTED)


class WindowsPcInput:
    """Mouse e teclado do PC. `send` é trocável: os testes registram, em vez de enviar."""

    def __init__(self, send: Sender | None = None) -> None:
        self._send = send or _send_input

    def move(self, dx: int, dy: int) -> None:
        self._send(pc_inputs.move_inputs(dx, dy))

    def scroll(self, horizontal: int, vertical: int) -> None:
        self._send(pc_inputs.scroll_inputs(horizontal, vertical))

    def click(self, button: str, action: str) -> None:
        self._send(pc_inputs.click_inputs(button, action))

    def key(self, key: str, modifiers: Sequence[str]) -> None:
        self._send(pc_inputs.key_inputs(key, modifiers))

    def type_text(self, text: str) -> None:
        self._send(pc_inputs.text_inputs(text))

    def media(self, action: str, steps: int) -> None:
        self._send(pc_inputs.media_inputs(action, steps))


def _run_shutdown(arguments: list[str]) -> None:
    if not IS_WINDOWS:
        raise PcUnsupported(_UNSUPPORTED)
    # Executável do sistema e argumentos montados aqui (nunca texto vindo da rede).
    run_hidden(["shutdown", *arguments], capture_output=True, timeout=10)


class WindowsPcPower:
    """Energia do PC: bloquear, suspender, desligar com contagem e cancelar."""

    def __init__(
        self,
        run: Callable[[list[str]], None] | None = None,
        lock: Callable[[], bool] | None = None,
        suspend: Callable[[], bool] | None = None,
    ) -> None:
        self._run = run or _run_shutdown
        self._lock = lock or _lock_workstation
        self._suspend = suspend or _suspend

    def lock(self) -> None:
        if not self._lock():
            raise OSError("o Windows não conseguiu bloquear a sessão")

    def sleep(self) -> None:
        if not self._suspend():
            raise OSError("o Windows não conseguiu suspender")

    def shutdown(self, delay_seconds: int) -> None:
        self._run(["/s", "/t", str(max(10, delay_seconds)), "/c", _SHUTDOWN_NOTICE])

    def cancel_shutdown(self) -> None:
        self._run(["/a"])


def _start_file(target: str) -> None:
    if sys.platform != "win32":
        raise PcUnsupported(_UNSUPPORTED)
    os.startfile(target)  # noqa: S606 - o destino vem da configuração do dono, nunca da rede


class WindowsPcLauncher:
    """Abre o destino de um favorito (programa, documento ou endereço) como o Explorer abriria."""

    def __init__(self, start: Callable[[str], None] | None = None) -> None:
        self._start = start or _start_file

    def launch(self, target: str) -> None:
        self._start(target)
