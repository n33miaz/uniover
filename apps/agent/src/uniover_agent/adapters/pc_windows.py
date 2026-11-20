"""Controle do PC no Windows: `SendInput`, bloqueio, suspensão, desligamento e abrir programas.

Só o Windows tem estas chamadas. Em outro sistema as classes existem (para a configuração e os
testes montarem o agente) e recusam com `PcUnsupported`. Os eventos já chegam prontos de
`pc_inputs.py`.
"""

import logging
import ntpath
import os
import sys
import threading
import time
from collections.abc import Callable, Sequence
from functools import partial
from typing import Any, Final, Protocol

from uniover_agent.adapters import pc_inputs
from uniover_agent.adapters.pc_inputs import RawInput
from uniover_agent.adapters.process import run_hidden
from uniover_agent.ports.pc import (
    CAUSE_ELEVATED_WINDOW,
    CAUSE_SESSION_LOCKED,
    CAUSE_UNKNOWN,
    PcInputRefused,
    PcUnsupported,
)

_log = logging.getLogger(__name__)

Sender = Callable[[Sequence[RawInput]], None]

# Sem nenhuma mensagem `pc.*` por este tempo, o que ainda está apertado é solto sozinho: o app
# fechou, a rede caiu ou o telefone dormiu no meio de um arrasto, e o botão não pode ficar preso no
# PC (o mesmo vale para um modificador segurado, como o Alt do Alt+Tab). Um arrasto com o dedo
# quieto por 30 s sem nenhuma chamada ao adaptador é solto. Contam como tráfego as chamadas ao
# adaptador que o Windows aceita (mover, rolar, clicar, tecla, texto, mídia), inclusive o
# movimento vazio (dx = dy = 0) que o app manda a cada 10 s enquanto segura um arrasto. Não
# contam as mensagens que o agente descarta por idade, nem energia e abrir programa, que não
# passam por aqui.
DEAD_MAN_SECONDS: Final = 30.0
RELEASE_RETRY_SECONDS: Final = 0.1
# `SystemParametersInfoW`: só as ações de leitura dos ajustes do mouse.
_SPI_GETMOUSE: Final = 0x0003
_SPI_GETMOUSESPEED: Final = 0x0070
_MAX_MOUSE_SPEED: Final = 20


class PartialSendError(PcInputRefused):
    """O Windows aceitou só parte dos eventos de um lote (`sent` deles, os primeiros).

    `cause` diz por quê, quando o adaptador conseguiu medir (ver `classify_refusal`)."""

    def __init__(
        self, sent: int, requested: int, cause: str = CAUSE_UNKNOWN, detail: str = ""
    ) -> None:
        super().__init__(
            f"o Windows aceitou {sent} de {requested} eventos de entrada", cause, detail
        )
        self.sent = sent


# Níveis de integridade do Windows (o RID do SID obrigatório): baixo, médio, alto, sistema.
INTEGRITY_LOW: Final = 0x1000
INTEGRITY_MEDIUM: Final = 0x2000
INTEGRITY_HIGH: Final = 0x3000
INTEGRITY_SYSTEM: Final = 0x4000
# Nome do desktop do usuário logado; a tela de bloqueio e o UAC rodam em outro (`Winlogon`).
USER_DESKTOP: Final = "default"


def integrity_name(level: int | None) -> str:
    """O nível de integridade em texto fixo, para o registro."""
    if level is None:
        return "desconhecido"
    if level >= INTEGRITY_SYSTEM:
        return "sistema"
    if level >= INTEGRITY_HIGH:
        return "alto"
    if level >= INTEGRITY_MEDIUM:
        return "médio"
    return "baixo"


def classify_refusal(desktop: str | None, foreground: int | None, own: int | None) -> str:
    """A causa de um `SendInput` recusado, a partir do que foi medido depois da recusa.

    `desktop` é o nome do desktop que recebe a entrada agora (`None` se nem dá para abri-lo: é o
    desktop seguro, como a tela de bloqueio ou o UAC); `foreground` e `own` são os níveis de
    integridade da janela em primeiro plano e deste processo. Um desktop que não é o do usuário
    vale como PC bloqueado; uma janela com integridade acima da deste processo, como janela de
    administrador na frente (o Windows impede de propósito, UIPI); o resto não se sabe."""
    if desktop is None or desktop.lower() != USER_DESKTOP:
        return CAUSE_SESSION_LOCKED
    if foreground is not None and own is not None and foreground > own:
        return CAUSE_ELEVATED_WINDOW
    return CAUSE_UNKNOWN


class _Cancelable(Protocol):
    def cancel(self) -> None: ...


TimerStarter = Callable[[float, Callable[[], None]], _Cancelable]


def _start_timer(delay: float, callback: Callable[[], None]) -> _Cancelable:
    timer = threading.Timer(delay, callback)
    timer.daemon = True  # um temporizador pendente não pode segurar o encerramento do agente
    timer.start()
    return timer


IS_WINDOWS = sys.platform == "win32"
KeyProbe = Callable[[int], bool]
_UNSUPPORTED = "o controle do PC só existe no Windows"
_SHUTDOWN_NOTICE = "O UniOver vai desligar este computador. Para cancelar: shutdown /a"
_RESTART_NOTICE = "O UniOver vai reiniciar este computador. Para cancelar: shutdown /a"

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

    # `use_last_error`: o código de erro do Windows é guardado por thread, logo depois da chamada,
    # e lido por `get_last_error` na MESMA thread (a da faixa do PC).
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    _user32.SendInput.argtypes = (wintypes.UINT, ctypes.c_void_p, ctypes.c_int)
    _user32.SendInput.restype = wintypes.UINT
    _user32.OpenInputDesktop.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _user32.OpenInputDesktop.restype = wintypes.HANDLE
    _user32.CloseDesktop.argtypes = (wintypes.HANDLE,)
    _user32.GetUserObjectInformationW.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    )
    _user32.GetForegroundWindow.restype = wintypes.HWND
    _user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
    _kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    _kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _advapi32.OpenProcessToken.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.HANDLE),
    )
    _advapi32.GetTokenInformation.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    )
    _advapi32.GetSidSubAuthorityCount.argtypes = (ctypes.c_void_p,)
    _advapi32.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
    _advapi32.GetSidSubAuthority.argtypes = (ctypes.c_void_p, wintypes.DWORD)
    _advapi32.GetSidSubAuthority.restype = ctypes.POINTER(wintypes.DWORD)

    _UOI_NAME = 2
    _DESKTOP_SWITCHDESKTOP = 0x0100
    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _TOKEN_QUERY = 0x0008
    _TOKEN_INTEGRITY_LEVEL = 25
    _ERROR_ACCESS_DENIED = 5

    def _input_desktop_name() -> str | None:
        """Nome do desktop que recebe a entrada agora; `None` se não dá nem para abri-lo."""
        desktop = _user32.OpenInputDesktop(0, False, _DESKTOP_SWITCHDESKTOP)
        if not desktop:
            return None
        try:
            needed = wintypes.DWORD(0)
            buffer = ctypes.create_unicode_buffer(256)
            ok = _user32.GetUserObjectInformationW(
                desktop, _UOI_NAME, buffer, ctypes.sizeof(buffer), ctypes.byref(needed)
            )
            return buffer.value if ok else ""
        finally:
            _user32.CloseDesktop(desktop)

    def _token_integrity(token: wintypes.HANDLE) -> int | None:
        size = wintypes.DWORD(0)
        _advapi32.GetTokenInformation(token, _TOKEN_INTEGRITY_LEVEL, None, 0, ctypes.byref(size))
        if not size.value:
            return None
        buffer = ctypes.create_string_buffer(size.value)
        if not _advapi32.GetTokenInformation(
            token, _TOKEN_INTEGRITY_LEVEL, buffer, size, ctypes.byref(size)
        ):
            return None
        # TOKEN_MANDATORY_LABEL começa com o ponteiro do SID; o último subautoridade é o nível.
        sid = ctypes.c_void_p.from_buffer(buffer).value
        if not sid:
            return None
        count = _advapi32.GetSidSubAuthorityCount(sid).contents.value
        return int(_advapi32.GetSidSubAuthority(sid, count - 1).contents.value)

    def _process_integrity(process: wintypes.HANDLE) -> int | None:
        token = wintypes.HANDLE()
        if not _advapi32.OpenProcessToken(process, _TOKEN_QUERY, ctypes.byref(token)):
            # Um processo comum não abre o token de outro de nível mais alto: negado vale "alto".
            return INTEGRITY_HIGH if ctypes.get_last_error() == _ERROR_ACCESS_DENIED else None
        try:
            return _token_integrity(token)
        finally:
            _kernel32.CloseHandle(token)

    def _foreground_integrity() -> int | None:
        """Integridade do processo da janela em primeiro plano (nunca lê o título dela)."""
        window = _user32.GetForegroundWindow()
        if not window:
            return None
        pid = wintypes.DWORD(0)
        _user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
        if not pid.value:
            return None
        process = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not process:
            return INTEGRITY_HIGH if ctypes.get_last_error() == _ERROR_ACCESS_DENIED else None
        try:
            return _process_integrity(process)
        finally:
            _kernel32.CloseHandle(process)

    _kernel32.QueryFullProcessImageNameW.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    )

    def _foreground_image() -> str | None:
        """Caminho do executável da janela em primeiro plano (nunca o título dela); `None` se não
        há janela ou o processo não abre (uma janela de administrador)."""
        window = _user32.GetForegroundWindow()
        if not window:
            return None
        pid = wintypes.DWORD(0)
        _user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
        if not pid.value:
            return None
        process = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not process:
            return None
        try:
            buffer = ctypes.create_unicode_buffer(1024)
            length = wintypes.DWORD(len(buffer))
            if not _kernel32.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(length)):
                return None
            return buffer.value or None
        finally:
            _kernel32.CloseHandle(process)

    def diagnose_refusal(last_error: int) -> tuple[str, str]:
        """Depois de um `SendInput` recusado: a causa (código estável) e os fatos medidos.

        Só roda depois da recusa (o caminho feliz não paga nada) e só olha o desktop de entrada e
        a integridade da janela em primeiro plano: nada de título, nome de programa nem endereço.
        """
        desktop = _input_desktop_name()
        foreground = _foreground_integrity()
        own = _process_integrity(_kernel32.GetCurrentProcess())
        cause = classify_refusal(desktop, foreground, own)
        shown = "inacessível" if desktop is None else (desktop or "?")
        detail = (
            f"erro do Windows {last_error}; desktop de entrada {shown}; primeiro plano "
            f"{integrity_name(foreground)}; este processo {integrity_name(own)}"
        )
        return cause, detail

    def _send_input(inputs: Sequence[RawInput]) -> None:
        if not inputs:
            return
        array = (_Input * len(inputs))(*(to_native(raw) for raw in inputs))
        sent = _user32.SendInput(len(inputs), array, ctypes.sizeof(_Input))
        if sent != len(inputs):
            # O Windows recusa na tela de bloqueio (desktop seguro) e quando outra janela com mais
            # privilégio (UAC) tem o foco. O erro é lido já, na mesma thread; o resto é medido só
            # agora (o envio que dá certo não paga).
            last_error = ctypes.get_last_error()
            try:
                cause, detail = diagnose_refusal(last_error)
            except Exception as exc:
                cause, detail = CAUSE_UNKNOWN, f"erro do Windows {last_error}; sem medida ({exc})"
            raise PartialSendError(sent, len(inputs), cause, detail)

    def _key_is_down(vk: int) -> bool:
        # O estado "de agora" do teclado e do mouse, inclusive do que outro processo apertou por
        # `SendInput`. O Windows responde sobre o botão físico: com os botões trocados, o esquerdo
        # lógico é o direito físico.
        user32 = ctypes.windll.user32
        if vk in (0x01, 0x02) and user32.GetSystemMetrics(23):  # SM_SWAPBUTTON
            vk = 3 - vk
        return bool(user32.GetAsyncKeyState(vk) & 0x8000)

    def _lock_workstation() -> bool:
        return bool(ctypes.windll.user32.LockWorkStation())

    def _suspend() -> bool:
        # Suspender (não hibernar), sem forçar: um app que recusa o aviso segura a suspensão.
        return bool(ctypes.windll.powrprof.SetSuspendState(False, False, False))

    def _hibernation_enabled() -> bool:
        # Só leitura (`GetPwrCapabilities`): preenche uma estrutura e nada mais.
        buffer = ctypes.create_string_buffer(256)
        if not ctypes.windll.powrprof.GetPwrCapabilities(buffer):
            return False
        return hiber_file_present(buffer.raw)

    def _monitor_off() -> bool:
        # `PostMessage` e não `SendMessage` para todas as janelas: um programa travado não segura o
        # agente. 2 é "desligar".
        return bool(ctypes.windll.user32.PostMessageW(0xFFFF, 0x0112, 0xF170, 2))

    def _mouse_parameters() -> tuple[int, int]:
        # Só leitura (`SystemParametersInfoW` com as ações GET; nenhuma ação SET existe aqui): a
        # aceleração (o terceiro dos três inteiros de `SPI_GETMOUSE`) e a velocidade (1 a 20).
        params = (ctypes.c_int * 3)()
        if not _user32.SystemParametersInfoW(_SPI_GETMOUSE, 0, params, 0):
            raise OSError(ctypes.get_last_error(), "SPI_GETMOUSE falhou")
        speed = ctypes.c_int()
        if not _user32.SystemParametersInfoW(_SPI_GETMOUSESPEED, 0, ctypes.byref(speed), 0):
            raise OSError(ctypes.get_last_error(), "SPI_GETMOUSESPEED falhou")
        return params[2], speed.value

else:

    def _foreground_image() -> str | None:
        return None

    def _send_input(inputs: Sequence[RawInput]) -> None:
        raise PcUnsupported(_UNSUPPORTED)

    def _key_is_down(vk: int) -> bool:
        return False

    def _lock_workstation() -> bool:
        raise PcUnsupported(_UNSUPPORTED)

    def _suspend() -> bool:
        raise PcUnsupported(_UNSUPPORTED)

    def _hibernation_enabled() -> bool:
        raise PcUnsupported(_UNSUPPORTED)

    def _monitor_off() -> bool:
        raise PcUnsupported(_UNSUPPORTED)

    def _mouse_parameters() -> tuple[int, int]:
        raise PcUnsupported(_UNSUPPORTED)


def read_mouse_settings(
    read: Callable[[], tuple[int, int]] | None = None,
) -> dict[str, Any] | None:
    """Os ajustes do mouse do Windows, como o `hello` os leva (`pcMouse`): `acceleration` (o
    "aprimorar a precisão do ponteiro") e `speed` (1 a 20). Só lê; sem resposta do Windows (ou fora
    dele) devolve `None` e o `hello` segue sem eles."""
    try:
        acceleration, speed = (read or _mouse_parameters)()
    except Exception as exc:
        _log.debug("ajustes do mouse do Windows não lidos: %s", exc)
        return None
    if not 1 <= speed <= _MAX_MOUSE_SPEED:
        return None
    return {"acceleration": acceleration != 0, "speed": speed}


# Posição de `HiberFilePresent` em `SYSTEM_POWER_CAPABILITIES` (depois de oito BOOLEAN de um byte).
_HIBER_FILE_PRESENT = 8


def hiber_file_present(capabilities: bytes) -> bool:
    """O arquivo de hibernação existe (a hibernação está ligada), pela `SYSTEM_POWER_CAPABILITIES`
    que o Windows preencheu. Estrutura curta demais conta como desligada."""
    return len(capabilities) > _HIBER_FILE_PRESENT and bool(capabilities[_HIBER_FILE_PRESENT])


class WindowsPcInput:
    """Mouse e teclado do PC. `send` é trocável: os testes registram, em vez de enviar.

    Guarda quais botões do mouse e quais teclas (um modificador segurado por `DOWN`) estão
    apertados, para poder soltá-los: por `release_all`, depois de um lote que o Windows aceitou só
    em parte, e sozinho quando passam `dead_man_seconds` sem nenhuma chamada a este adaptador (um
    arrasto parado, sem nem o movimento vazio que o app manda para mantê-lo vivo, é solto). Num
    lote parcial também solta as teclas que entraram apertadas (um modificador não pode ficar
    preso). O relógio e o temporizador também são trocáveis. Os comandos chegam pelo laço do
    agente e o temporizador roda em outra thread, daí a trava.
    """

    def __init__(
        self,
        send: Sender | None = None,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        dead_man_seconds: float = DEAD_MAN_SECONDS,
        start_timer: TimerStarter = _start_timer,
        key_probe: KeyProbe | None = None,
    ) -> None:
        self._send = send or _send_input
        self._key_probe = key_probe or _key_is_down
        self._monotonic = monotonic
        self._dead_man = dead_man_seconds
        self._start_timer = start_timer
        self._lock = threading.RLock()
        self._held: frozenset[str] = frozenset()
        # Teclas apertadas de propósito (`DOWN` sem `UP`): tecla -> evento que a solta, na ordem em
        # que foram apertadas.
        self._held_keys: dict[tuple[int, int, int], RawInput] = {}
        # Soltura de teclas que um lote parcial deixou apertadas e ainda não foi aceita.
        self._stuck: tuple[RawInput, ...] = ()
        self._last_activity = monotonic()
        self._timer: _Cancelable | None = None
        self._retry_timer = False
        # Cada armação ganha um número: um disparo atrasado de um temporizador já trocado se ignora.
        self._generation = 0

    def move(self, dx: int, dy: int) -> None:
        if dx == 0 and dy == 0:
            # Movimento vazio: só prova que o app está vivo (mantém um arrasto), sem evento algum.
            # Também tenta soltar uma tecla pendente, como o início de qualquer envio.
            with self._lock:
                self._last_activity = self._monotonic()
                self._retry_stuck()
                self._sync_timer()
            return
        self._dispatch(pc_inputs.move_inputs(dx, dy))

    def scroll(self, horizontal: int, vertical: int) -> None:
        self._dispatch(pc_inputs.scroll_inputs(horizontal, vertical))

    def zoom(self, steps: int) -> None:
        """Ctrl apertado, a roda e Ctrl solto num lote só (se o Windows aceitar só parte, o que
        ficou apertado é solto como em qualquer lote). Com o Ctrl já segurado por um `DOWN`, ele
        fica como está."""
        with self._lock:
            held = frozenset(identity[0] for identity in self._held_keys)
            self._dispatch(pc_inputs.zoom_inputs(steps, held))

    def click(self, button: str, action: str, modifiers: Sequence[str] = ()) -> None:
        with self._lock:
            # O que já está segurado (o Alt do Alt+Tab) não é apertado nem solto por este clique.
            held = frozenset(identity[0] for identity in self._held_keys)
            self._dispatch(pc_inputs.click_inputs(button, action, modifiers, held))

    def key(
        self, key: str, modifiers: Sequence[str], *, repeat: int = 1, action: str = "PRESS"
    ) -> None:
        with self._lock:
            # O que já está segurado (o Alt do Alt+Tab) não é apertado nem solto por esta tecla.
            # Se a pessoa soltou o Alt no teclado físico do PC, o agente ainda o dá por segurado e
            # o próximo atalho sai sem ele, até o `UP` do app (ou a soltura automática) limpar o
            # estado; nada fica preso.
            held = frozenset(identity[0] for identity in self._held_keys)
            self._dispatch(pc_inputs.key_inputs(key, modifiers, repeat, action, held))

    def type_text(self, text: str) -> None:
        self._dispatch_text(pc_inputs.text_inputs(text))

    def edit_text(self, erase: int, text: str, key: str | None = None) -> None:
        """Apaga, digita e aperta a tecla final na mesma ordem."""
        self._dispatch_text(pc_inputs.edit_inputs(erase, text, key))

    def _dispatch_text(self, inputs: Sequence[RawInput]) -> None:
        # Limita a quantidade entregue ao Windows de uma vez. Cada par de apertar e soltar
        # fica no mesmo lote, inclusive as duas unidades UTF-16 de um caractere suplementar.
        limit = 256
        low_surrogates = range(0xDC00, 0xE000)
        with self._lock:
            start = 0
            while start < len(inputs):
                end = min(start + limit, len(inputs))
                if end < len(inputs):
                    following = inputs[end]
                    if following.flags & pc_inputs.KEY_UNICODE and following.scan in low_surrogates:
                        end -= 2
                self._dispatch(inputs[start:end])
                start = end

    def media(self, action: str, steps: int) -> None:
        self._dispatch(pc_inputs.media_inputs(action, steps))

    def release_all(self) -> None:
        with self._lock:
            if not self._holding():
                return
            _log.warning("soltando à força o que ficou apertado no mouse e no teclado")
            self._release(self._held, self._pending_key_ups())
            self._sync_timer()

    def release_orphans(self) -> None:
        """Solta os modificadores e os botões do mouse que o Windows dá por apertados e que este
        processo não apertou (os de uma execução anterior do agente, que saiu segurando uma tecla).

        Só manda o que está apertado de verdade: um evento de soltura sem a tecla apertada ativaria
        o menu da janela (Alt) ou o menu de contexto (botão direito). Nunca levanta erro."""
        try:
            with self._lock:
                keys = {vk for vk, _ in pc_inputs.ORPHAN_MODIFIER_KEYS if self._key_probe(vk)}
                buttons = [
                    name for name, vk in pc_inputs.BUTTON_PROBE_KEYS.items() if self._key_probe(vk)
                ]
                events = pc_inputs.orphan_release_inputs(keys, buttons)
                if not events:
                    return
                _log.warning(
                    "soltando o que a execução anterior deixou apertado (%d evento(s))", len(events)
                )
                self._send(events)
                self._held = self._held.difference(buttons)
        except Exception as exc:
            _log.warning("não foi possível soltar o que a execução anterior deixou: %s", exc)

    def _holding(self) -> bool:
        return bool(self._held or self._stuck or self._held_keys)

    def _pending_key_ups(self) -> tuple[RawInput, ...]:
        """A soltura de tudo o que o teclado tem apertado: o que um lote parcial deixou e o que um
        `DOWN` segurou (este na ordem inversa de apertar)."""
        return tuple(dict.fromkeys((*self._stuck, *reversed(self._held_keys.values()))))

    def _retry_stuck(self) -> None:
        if self._stuck:
            # Uma tecla que um lote parcial deixou apertada não espera o temporizador: tenta-se
            # soltar antes do próximo envio (que, sem isso, sairia com ela apertada).
            self._release(frozenset(), self._stuck, quiet=True)

    def _dispatch(self, inputs: Sequence[RawInput]) -> None:
        with self._lock:
            self._retry_stuck()
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
                # O que o lote parcial apertou passa a ser da soltura abaixo (e, se ela falhar, do
                # `_stuck`); o que já estava segurado de antes continua segurado.
                gone = {pc_inputs.key_identity(event) for event in keys}
                self._held_keys = {
                    identity: up
                    for identity, up in pc_inputs.held_keys_after(self._held_keys, accepted).items()
                    if identity not in gone
                }
                # Um `UP` explícito que o Windows recusou (janela elevada) deixa de ser "segurado" e
                # vira soltura pendente, tentada no começo do próximo envio (como no lote parcial).
                refused_ups = tuple(
                    self._held_keys.pop(identity)
                    for event in inputs[len(accepted) :]
                    if event.kind == "keyboard"
                    and event.flags & pc_inputs.KEY_UP
                    and (identity := pc_inputs.key_identity(event)) in self._held_keys
                )
                if refused_ups:
                    self._stuck = tuple(dict.fromkeys((*self._stuck, *refused_ups)))
                if pressed_now or keys:
                    self._release(pressed_now, keys)
                self._sync_timer()
                raise
            # Só um envio que o Windows aceitou conta como tráfego: um recusado (janela elevada) não
            # adia a soltura automática do que está apertado.
            self._last_activity = self._monotonic()
            self._held = pc_inputs.held_after(self._held, inputs)
            self._held_keys = pc_inputs.held_keys_after(self._held_keys, inputs)
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
            # O que não soltou vira pendência (deixa de ser "segurado"): a soltura se repete.
            self._stuck = tuple(dict.fromkeys((*self._stuck, *keys)))
            self._held_keys = {i: up for i, up in self._held_keys.items() if up not in keys}
            return
        self._held -= buttons
        self._stuck = tuple(event for event in self._stuck if event not in keys)
        self._held_keys = {i: up for i, up in self._held_keys.items() if up not in keys}

    def _sync_timer(self) -> None:
        if not self._holding():
            self._cancel_timer()
        elif self._stuck and not self._retry_timer:
            self._cancel_timer()
            self._retry_timer = True
            self._arm(RELEASE_RETRY_SECONDS)
        elif self._timer is None:
            self._arm(self._dead_man)

    def _arm(self, delay: float) -> None:
        self._generation += 1
        self._timer = self._start_timer(delay, partial(self._on_timer, self._generation))

    def _cancel_timer(self) -> None:
        self._generation += 1
        self._retry_timer = False
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _on_timer(self, generation: int) -> None:
        with self._lock:
            if generation != self._generation:
                return
            self._timer = None
            self._retry_timer = False
            if not self._holding():
                return
            idle = self._monotonic() - self._last_activity
            if idle < self._dead_man:
                # Solturas recusadas têm de ser tentadas mesmo durante um arrasto ativo.
                self._retry_stuck()
                if self._stuck:
                    self._sync_timer()
                elif self._holding():
                    self._arm(self._dead_man - idle)
                return
            _log.warning("algo ficou apertado sem mensagens do PC há %.0f s: soltando", idle)
            self._release(self._held, self._pending_key_ups())
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
    """Energia do PC: bloquear, suspender, hibernar, desligar ou reiniciar com contagem, cancelar,
    encerrar a sessão e apagar o monitor. Cada primitiva do sistema é trocável: os testes nunca
    executam nenhuma delas de verdade."""

    def __init__(
        self,
        run: Callable[[list[str]], int] | None = None,
        lock: Callable[[], bool] | None = None,
        suspend: Callable[[], bool] | None = None,
        hibernation: Callable[[], bool] | None = None,
        monitor_off: Callable[[], bool] | None = None,
    ) -> None:
        self._run = run or _run_shutdown
        self._lock = lock or _lock_workstation
        self._suspend = suspend or _suspend
        self._hibernation = hibernation or _hibernation_enabled
        self._monitor_off = monitor_off or _monitor_off

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

    def restart(self, delay_seconds: int) -> None:
        code = self._run(["/r", "/t", str(max(10, delay_seconds)), "/c", _RESTART_NOTICE])
        if code != 0:
            raise OSError(f"o Windows recusou agendar o reinício (código {code})")

    def hibernation_available(self) -> bool:
        return self._hibernation()

    def hibernate(self) -> None:
        code = self._run(["/h"])
        if code != 0:
            raise OSError(f"o Windows recusou hibernar (código {code})")

    def log_off(self) -> None:
        # Sem `/f`: os programas são chamados a fechar e podem perguntar se salvam.
        code = self._run(["/l"])
        if code != 0:
            raise OSError(f"o Windows recusou encerrar a sessão (código {code})")

    def monitor_off(self) -> None:
        if not self._monitor_off():
            raise OSError("o Windows não conseguiu apagar o monitor")

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


class WindowsPcForeground:
    """O executável da janela em primeiro plano, só o nome do arquivo em minúsculas. Nunca o título
    da janela, e nunca vai para o registro (quem chama só compara)."""

    def __init__(self, image: Callable[[], str | None] | None = None) -> None:
        self._image = image or _foreground_image

    def program(self) -> str | None:
        try:
            path = self._image()
        except OSError:
            return None
        if not path:
            return None
        return ntpath.basename(path).lower() or None
