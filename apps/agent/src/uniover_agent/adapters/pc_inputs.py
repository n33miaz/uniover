"""Tradução do contrato do controle do PC para eventos de entrada do Windows (`SendInput`).

Aqui só há dados e funções puras: nada toca no sistema, então a tabela de teclas e a ordem dos
eventos são testadas em qualquer máquina. O envio de verdade fica em `pc_windows.py`.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Literal

# Eventos do mouse (MOUSEEVENTF_*).
MOUSE_MOVE: Final = 0x0001
MOUSE_LEFTDOWN: Final = 0x0002
MOUSE_LEFTUP: Final = 0x0004
MOUSE_RIGHTDOWN: Final = 0x0008
MOUSE_RIGHTUP: Final = 0x0010
MOUSE_MIDDLEDOWN: Final = 0x0020
MOUSE_MIDDLEUP: Final = 0x0040
MOUSE_WHEEL: Final = 0x0800
MOUSE_HWHEEL: Final = 0x1000

# Eventos do teclado (KEYEVENTF_*).
KEY_EXTENDED: Final = 0x0001
KEY_UP: Final = 0x0002
KEY_UNICODE: Final = 0x0004

WHEEL_DELTA: Final = 120
# Limite de segurança de um único toque do sistema: o contrato já limita, isto protege o adaptador.
MAX_POINTER: Final = 2000
MAX_SCROLL: Final = 1200

_BUTTONS: Final = {
    "LEFT": (MOUSE_LEFTDOWN, MOUSE_LEFTUP),
    "RIGHT": (MOUSE_RIGHTDOWN, MOUSE_RIGHTUP),
    "MIDDLE": (MOUSE_MIDDLEDOWN, MOUSE_MIDDLEUP),
}

# Teclas do contrato para o código virtual do Windows e se são "estendidas" (setas, Home...).
_NAMED_KEYS: Final[dict[str, tuple[int, bool]]] = {
    "ENTER": (0x0D, False),
    "BACKSPACE": (0x08, False),
    "DELETE": (0x2E, True),
    "TAB": (0x09, False),
    "ESCAPE": (0x1B, False),
    "SPACE": (0x20, False),
    "LEFT": (0x25, True),
    "UP": (0x26, True),
    "RIGHT": (0x27, True),
    "DOWN": (0x28, True),
    "HOME": (0x24, True),
    "END": (0x23, True),
    "PAGE_UP": (0x21, True),
    "PAGE_DOWN": (0x22, True),
}
_MODIFIERS: Final = {"CTRL": 0x11, "ALT": 0x12, "SHIFT": 0x10, "WIN": 0x5B}
_MEDIA: Final = {
    "PLAY_PAUSE": 0xB3,
    "NEXT": 0xB0,
    "PREVIOUS": 0xB1,
    "STOP": 0xB2,
    "VOLUME_UP": 0xAF,
    "VOLUME_DOWN": 0xAE,
    "MUTE": 0xAD,
}
_REPEATABLE_MEDIA: Final = frozenset({"VOLUME_UP", "VOLUME_DOWN"})


class UnknownKey(ValueError):  # noqa: N818 - lê-se como fato: a tecla não é do contrato
    """Tecla ou ação fora das listas do contrato (a validação do contrato deveria ter barrado)."""


@dataclass(frozen=True, slots=True)
class RawInput:
    """Um evento de entrada, ainda sem a estrutura do Windows."""

    kind: Literal["mouse", "keyboard"]
    flags: int = 0
    # Mouse: deslocamento e `mouseData` (rolagem). Teclado: `vk` e `scan` (o caractere, no Unicode).
    dx: int = 0
    dy: int = 0
    data: int = 0
    vk: int = 0
    scan: int = 0


def _clamp(value: int, limit: int) -> int:
    return max(-limit, min(limit, value))


def virtual_key(key: str) -> tuple[int, bool]:
    """Código virtual e flag de tecla estendida de uma tecla do contrato (`ENTER`, `F5`, `C`)."""
    if key in _NAMED_KEYS:
        return _NAMED_KEYS[key]
    if len(key) == 1 and "A" <= key <= "Z":
        return ord(key), False
    if key.startswith("F") and key[1:].isdigit() and 1 <= int(key[1:]) <= 12:  # noqa: PLR2004
        return 0x70 + int(key[1:]) - 1, False
    raise UnknownKey(f"tecla fora do contrato: {key}")


def _key(vk: int, *, extended: bool = False, up: bool = False) -> RawInput:
    flags = (KEY_EXTENDED if extended else 0) | (KEY_UP if up else 0)
    return RawInput("keyboard", flags=flags, vk=vk)


def move_inputs(dx: int, dy: int) -> list[RawInput]:
    """Movimento relativo do ponteiro (os pixels passam pela aceleração do Windows)."""
    return [RawInput("mouse", MOUSE_MOVE, _clamp(dx, MAX_POINTER), _clamp(dy, MAX_POINTER))]


def scroll_inputs(horizontal: int, vertical: int) -> list[RawInput]:
    """Rolagem em unidades de roda; positivo é para cima e para a direita, como o Windows."""
    inputs: list[RawInput] = []
    if vertical:
        inputs.append(RawInput("mouse", MOUSE_WHEEL, data=_clamp(vertical, MAX_SCROLL)))
    if horizontal:
        inputs.append(RawInput("mouse", MOUSE_HWHEEL, data=_clamp(horizontal, MAX_SCROLL)))
    return inputs


def click_inputs(button: str, action: str) -> list[RawInput]:
    if button not in _BUTTONS:
        raise UnknownKey(f"botão fora do contrato: {button}")
    down, up = (RawInput("mouse", flag) for flag in _BUTTONS[button])
    if action == "DOWN":
        return [down]
    if action == "UP":
        return [up]
    if action == "CLICK":
        return [down, up]
    if action == "DOUBLE":
        return [down, up, down, up]
    raise UnknownKey(f"ação de clique fora do contrato: {action}")


def key_inputs(key: str, modifiers: Sequence[str] = ()) -> list[RawInput]:
    """Modificadores apertados, a tecla apertada e solta, modificadores soltos na ordem inversa.

    Os modificadores sempre são soltos: uma tecla presa no PC atrapalharia tudo o que a pessoa
    fizer.
    """
    vk, extended = virtual_key(key)
    held = []
    for name in modifiers:
        if name not in _MODIFIERS:
            raise UnknownKey(f"modificador fora do contrato: {name}")
        held.append(_MODIFIERS[name])
    inputs = [_key(code) for code in held]
    inputs += [_key(vk, extended=extended), _key(vk, extended=extended, up=True)]
    inputs += [_key(code, up=True) for code in reversed(held)]
    return inputs


def text_inputs(text: str) -> list[RawInput]:
    """Cada unidade UTF-16 do texto, apertada e solta como Unicode (não depende do layout)."""
    units = text.encode("utf-16-le", errors="replace")
    inputs: list[RawInput] = []
    for index in range(0, len(units), 2):
        unit = int.from_bytes(units[index : index + 2], "little")
        inputs.append(RawInput("keyboard", KEY_UNICODE, scan=unit))
        inputs.append(RawInput("keyboard", KEY_UNICODE | KEY_UP, scan=unit))
    return inputs


def media_inputs(action: str, steps: int = 1) -> list[RawInput]:
    if action not in _MEDIA:
        raise UnknownKey(f"ação de mídia fora do contrato: {action}")
    repeat = max(1, min(10, steps)) if action in _REPEATABLE_MEDIA else 1
    vk = _MEDIA[action]
    return [_key(vk), _key(vk, up=True)] * repeat


__all__ = [
    "KEY_EXTENDED",
    "KEY_UNICODE",
    "KEY_UP",
    "MOUSE_HWHEEL",
    "MOUSE_MOVE",
    "MOUSE_WHEEL",
    "RawInput",
    "UnknownKey",
    "click_inputs",
    "key_inputs",
    "media_inputs",
    "move_inputs",
    "scroll_inputs",
    "text_inputs",
    "virtual_key",
]
