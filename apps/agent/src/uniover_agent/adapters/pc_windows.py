"""Controle do PC no Windows: `SendInput`, bloqueio, suspensão, desligamento e abrir programas.

Só o Windows tem estas chamadas. Em outro sistema as classes existem (para a configuração e os
testes montarem o agente) e recusam com `PcUnsupported`. Os eventos já chegam prontos de
`pc_inputs.py`.
"""

import logging
import os
import sys
import threading
import time
from collections.abc import Callable, Sequence
from functools import partial
from typing import Final, Protocol

from uniover_agent.adapters import pc_inputs
from uniover_agent.adapters.pc_inputs import RawInput
from uniover_agent.adapters.process import run_hidden
from uniover_agent.ports.pc import PcUnsupported

_log = logging.getLogger(__name__)

Sender = Callable[[Sequence[RawInput]], None]

# Sem nenhuma mensagem `pc.*` por este tempo, o que ainda está apertado é solto sozinho: o app
# fechou, a rede caiu ou o telefone dormiu no meio de um arrasto, e o botão não pode ficar preso no
# PC. Um arrasto com o dedo quieto por 30 s sem nenhuma chamada ao adaptador é solto. Contam como
# tráfego as chamadas ao adaptador (mover, rolar, clicar, tecla, texto, mídia), inclusive o
# movimento vazio (dx = dy = 0) que o app manda a cada 10 s enquanto segura um arrasto. Não
# contam as mensagens que o agente descarta por idade, nem energia e abrir programa, que não
# passam por aqui.
DEAD_MAN_SECONDS: Final = 30.0


class PartialSendError(OSError):
    """O Windows aceitou só parte dos eventos de um lote (`sent` deles, os primeiros)."""

    def __init__(self, sent: int, requested: int) -> None:
        super().__init__(f"o Windows aceitou {sent} de {requested} eventos de entrada")
        self.sent = sent


class _Cancelable(Protocol):
    def cancel(self) -> None: ...


TimerStarter = Callable[[float, Callable[[], None]], _Cancelable]


def _start_timer(delay: float, callback: Callable[[], None]) -> _Cancelable:
    timer = threading.Timer(delay, callback)
    timer.daemon = True  # um temporizador pendente não pode segurar o encerramento do agente
    timer.start()
    return timer


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
            raise PartialSendError(sent, len(inputs))

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
    """Mouse e teclado do PC. `send` é trocável: os testes registram, em vez de enviar.

    Guarda quais botões do mouse estão apertados (DOWN ainda sem UP) para poder soltá-los: por
    `release_all`, depois de um lote que o Windows aceitou só em parte, e sozinho quando passam
    `dead_man_seconds` sem nenhuma chamada a este adaptador (um arrasto parado, sem nem o movimento
    vazio que o app manda para mantê-lo vivo, é solto). Num lote parcial também solta as teclas que
    entraram apertadas (um modificador não pode ficar preso). O relógio e o temporizador também são
    trocáveis. Os comandos chegam pelo laço do agente e o temporizador roda em outra thread, daí
    a trava.
    """

    def __init__(
        self,
        send: Sender | None = None,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        dead_man_seconds: float = DEAD_MAN_SECONDS,
        start_timer: TimerStarter = _start_timer,
    ) -> None:
        self._send = send or _send_input
        self._monotonic = monotonic
        self._dead_man = dead_man_seconds
        self._start_timer = start_timer
        self._lock = threading.RLock()
        self._held: frozenset[str] = frozenset()
        # Soltura de teclas que um lote parcial deixou apertadas e ainda não foi aceita.
        self._stuck: tuple[RawInput, ...] = ()
        self._last_activity = monotonic()
        self._timer: _Cancelable | None = None
        # Cada armação ganha um número: um disparo atrasado de um temporizador já trocado se ignora.
        self._generation = 0

    def move(self, dx: int, dy: int) -> None:
        if dx == 0 and dy == 0:
            # Movimento vazio: só prova que o app está vivo (mantém um arrasto), sem evento algum.
            with self._lock:
                self._last_activity = self._monotonic()
            return
        self._dispatch(pc_inputs.move_inputs(dx, dy))

    def scroll(self, horizontal: int, vertical: int) -> None:
        self._dispatch(pc_inputs.scroll_inputs(horizontal, vertical))

    def click(self, button: str, action: str) -> None:
        self._dispatch(pc_inputs.click_inputs(button, action))

    def key(self, key: str, modifiers: Sequence[str]) -> None:
        self._dispatch(pc_inputs.key_inputs(key, modifiers))

    def type_text(self, text: str) -> None:
        self._dispatch(pc_inputs.text_inputs(text))

    def media(self, action: str, steps: int) -> None:
        self._dispatch(pc_inputs.media_inputs(action, steps))

    def release_all(self) -> None:
        with self._lock:
            if not self._holding():
                return
            _log.warning("soltando à força o que ficou apertado no mouse e no teclado")
            self._release(self._held, self._stuck)
            self._sync_timer()

    def _holding(self) -> bool:
        return bool(self._held or self._stuck)

    def _dispatch(self, inputs: Sequence[RawInput]) -> None:
        with self._lock:
            self._last_activity = self._monotonic()
            if self._stuck:
                # Uma tecla que um lote parcial deixou apertada não espera o temporizador: tenta-se
                # soltar antes de enviar o próximo lote (que, sem isso, sairia com ela apertada).
                self._release(frozenset(), self._stuck, quiet=True)
            before = self._held
            try:
                self._send(inputs)
            except OSError as exc:
                # Num lote parcial só os primeiros eventos entraram: o que eles apertaram (botões
                # e teclas) é solto.
                accepted = inputs[: exc.sent if isinstance(exc, PartialSendError) else 0]
                self._held = pc_inputs.held_after(self._held, accepted)
                pressed_now = self._held - before
                keys = tuple(pc_inputs.dangling_key_ups(accepted))
                if pressed_now or keys:
                    self._release(pressed_now, keys)
                self._sync_timer()
                raise
            self._held = pc_inputs.held_after(self._held, inputs)
            self._sync_timer()

    def _release(
        self, buttons: frozenset[str], keys: tuple[RawInput, ...], *, quiet: bool = False
    ) -> None:
        """Manda a soltura de `buttons` e `keys`. Se o Windows recusar, eles seguem pendentes (o
        temporizador tenta de novo)."""
        try:
            self._send([*pc_inputs.release_inputs(buttons), *keys])
        except OSError as exc:
            # Na repetição a cada comando o aviso iria ao registro 30 vezes por segundo.
            (_log.debug if quiet else _log.warning)(
                "não foi possível soltar o que ficou apertado: %s", exc
            )
            self._stuck = tuple(dict.fromkeys((*self._stuck, *keys)))
            return
        self._held -= buttons
        self._stuck = tuple(event for event in self._stuck if event not in keys)

    def _sync_timer(self) -> None:
        if not self._holding():
            self._cancel_timer()
        elif self._timer is None:
            self._arm(self._dead_man)

    def _arm(self, delay: float) -> None:
        self._generation += 1
        self._timer = self._start_timer(delay, partial(self._on_timer, self._generation))

    def _cancel_timer(self) -> None:
        self._generation += 1
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _on_timer(self, generation: int) -> None:
        with self._lock:
            if generation != self._generation:
                return
            self._timer = None
            if not self._holding():
                return
            idle = self._monotonic() - self._last_activity
            if idle < self._dead_man:
                self._arm(self._dead_man - idle)  # houve mensagem no meio do caminho
                return
            _log.warning("algo ficou apertado sem mensagens do PC há %.0f s: soltando", idle)
            self._release(self._held, self._stuck)
            self._sync_timer()


# `ERROR_NO_SHUTDOWN_IN_PROGRESS`: o `shutdown /a` não tinha contagem para cancelar.
_NO_SHUTDOWN_IN_PROGRESS = 1116


def _run_shutdown(arguments: list[str]) -> int:
    """Roda o `shutdown.exe` e devolve o código de saída: quem chama decide o que é falha."""
    if not IS_WINDOWS:
        raise PcUnsupported(_UNSUPPORTED)
    # Executável do sistema e argumentos montados aqui (nunca texto vindo da rede).
    return run_hidden(["shutdown", *arguments], capture_output=True, timeout=10).returncode


class WindowsPcPower:
    """Energia do PC: bloquear, suspender, desligar com contagem e cancelar."""

    def __init__(
        self,
        run: Callable[[list[str]], int] | None = None,
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
        code = self._run(["/s", "/t", str(max(10, delay_seconds)), "/c", _SHUTDOWN_NOTICE])
        if code != 0:
            # Política, UAC ou erro do Windows: não pode virar "feito" nem auditoria de sucesso.
            raise OSError(f"o Windows recusou agendar o desligamento (código {code})")

    def cancel_shutdown(self) -> None:
        code = self._run(["/a"])
        # Sem contagem em andamento não é erro (já não há desligamento pendente); o resto é.
        if code not in (0, _NO_SHUTDOWN_IN_PROGRESS):
            raise OSError(f"o Windows recusou cancelar o desligamento (código {code})")


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
