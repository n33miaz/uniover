"""Tradução do contrato do controle do PC para eventos de entrada do Windows (`SendInput`).

Aqui só há dados e funções puras: nada toca no sistema, então a tabela de teclas e a ordem dos
eventos são testadas em qualquer máquina. O envio de verdade fica em `pc_windows.py`.
"""

from collections.abc import Iterable, Mapping, Sequence
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
# Quantas vezes uma só mensagem aperta a mesma tecla (o contrato limita; isto protege o adaptador).
MAX_KEY_REPEAT: Final = 50
# Limite de segurança de um único toque do sistema: o contrato já limita, isto protege o adaptador.
MAX_POINTER: Final = 2000
MAX_SCROLL: Final = 1200

_BUTTONS: Final = {
    "LEFT": (MOUSE_LEFTDOWN, MOUSE_LEFTUP),
    "RIGHT": (MOUSE_RIGHTDOWN, MOUSE_RIGHTUP),
    "MIDDLE": (MOUSE_MIDDLEDOWN, MOUSE_MIDDLEUP),
}
# Flag do evento para (botão, apertado?): é o que diz que botões o Windows acha que estão apertados.
_BUTTON_OF_FLAG: Final = {
    flag: (name, pressed)
    for name, (down, up) in _BUTTONS.items()
    for flag, pressed in ((down, True), (up, False))
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
    # Teclas que só a mensagem v2 traz. Insert, Print Screen e a tecla de menu são "estendidas".
    "INSERT": (0x2D, True),
    "PRINT_SCREEN": (0x2C, True),
    "APPS": (0x5D, True),
    "CAPS_LOCK": (0x14, False),
    "WIN": (0x5B, False),
    "CTRL": (0x11, False),
    "ALT": (0x12, False),
    "SHIFT": (0x10, False),
    # Pontuação: só as quatro que o Windows mantém no mesmo código em qualquer layout (VK_OEM_PLUS
    # é o "=" e o "+" do teclado americano, VK_OEM_MINUS o "-"). Atenção ao ABNT2: lá a tecla do
    # "/" e do "?" e a do "'" e do '"' ganham códigos próprios, e por isso (como todo o resto da
    # pontuação) saem pelo `pc.text`, que digita Unicode e não depende do layout.
    "MINUS": (0xBD, False),
    "EQUALS": (0xBB, False),
    "COMMA": (0xBC, False),
    "PERIOD": (0xBE, False),
}
_MODIFIERS: Final = {"CTRL": 0x11, "ALT": 0x12, "SHIFT": 0x10, "WIN": 0x5B}
# O que dá para segurar (DOWN) e soltar (UP): só os modificadores. Uma letra presa não teria uso e
# deixaria o PC repetindo caractere.
HOLDABLE_KEYS: Final = frozenset(_MODIFIERS)
KEY_ACTIONS: Final = ("PRESS", "DOWN", "UP")
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
    if len(key) == 2 and key[0] == "D" and "0" <= key[1] <= "9":  # noqa: PLR2004 - D0 a D9
        return 0x30 + int(key[1]), False  # VK_0..VK_9: a fileira de cima, não o teclado numérico
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


def held_after(held: Iterable[str], events: Iterable[RawInput]) -> frozenset[str]:
    """Botões do mouse que ficam apertados depois de `events`, partindo de `held`.

    Segue a ordem dos eventos (um CLICK aperta e solta; um DOWN sozinho deixa o botão apertado).
    """
    state = set(held)
    for event in events:
        effect = _BUTTON_OF_FLAG.get(event.flags) if event.kind == "mouse" else None
        if effect is None:
            continue
        name, pressed = effect
        if pressed:
            state.add(name)
        else:
            state.discard(name)
    return frozenset(state)


def dangling_key_ups(events: Iterable[RawInput]) -> list[RawInput]:
    """Os eventos que soltam cada tecla apertada em `events` e não solta ali mesmo.

    Serve para um lote que o Windows aceitou só em parte: o que entrou apertou teclas (um
    modificador, uma letra) cuja soltura ficou de fora. A ordem é a inversa da de apertar.
    """
    pressed: dict[tuple[int, int, int], RawInput] = {}
    for event in events:
        if event.kind != "keyboard":
            continue
        # A mesma tecla é a mesma `vk`/`scan` e a mesma flag de tecla estendida ou Unicode.
        identity = key_identity(event)
        if event.flags & KEY_UP:
            pressed.pop(identity, None)
        else:
            pressed[identity] = event
    return [
        RawInput("keyboard", flags=event.flags | KEY_UP, vk=event.vk, scan=event.scan)
        for event in reversed(pressed.values())
    ]


def key_identity(event: RawInput) -> tuple[int, int, int]:
    """Quem é a tecla de um evento: a mesma `vk`/`scan` e a mesma flag de estendida ou Unicode."""
    return (event.vk, event.scan, event.flags & ~KEY_UP)


def held_keys_after(
    held: Mapping[tuple[int, int, int], RawInput], events: Iterable[RawInput]
) -> dict[tuple[int, int, int], RawInput]:
    """As teclas apertadas depois de `events`, partindo de `held` (tecla -> evento que a solta).

    Segue a ordem dos eventos: apertar entra, soltar sai. Um lote completo de `key_inputs` não
    deixa nada apertado; só um `DOWN` sozinho deixa, e o valor guardado é o evento que o solta.
    """
    state = dict(held)
    for event in events:
        if event.kind != "keyboard":
            continue
        identity = key_identity(event)
        if event.flags & KEY_UP:
            state.pop(identity, None)
        else:
            state.pop(identity, None)  # reaperta: passa para o fim, a soltura segue a ordem inversa
            state[identity] = RawInput(
                "keyboard", flags=event.flags | KEY_UP, vk=event.vk, scan=event.scan
            )
    return state


def release_inputs(buttons: Iterable[str]) -> list[RawInput]:
    """Os eventos que soltam `buttons` (numa ordem fixa, para o teste conferir)."""
    return [event for name in sorted(buttons) for event in click_inputs(name, "UP")]


def key_inputs(
    key: str, modifiers: Sequence[str] = (), repeat: int = 1, action: str = "PRESS"
) -> list[RawInput]:
    """Modificadores apertados, a tecla apertada e solta `repeat` vezes, modificadores soltos na
    ordem inversa. Tudo num lote só: os modificadores valem para todas as repetições.

    Nesse caminho os modificadores sempre são soltos: uma tecla presa no PC atrapalharia tudo o
    que a pessoa fizer. Só `action` `DOWN` ou `UP` deixa uma tecla apertada de propósito, e só
    para um modificador, sozinho (sem outros modificadores nem repetição): quem chama (o
    adaptador) guarda o que ficou apertado e o solta ao desconectar, ao encerrar e sem tráfego.
    """
    if action not in KEY_ACTIONS:
        raise UnknownKey(f"ação de tecla fora do contrato: {action}")
    vk, extended = virtual_key(key)
    if action != "PRESS":
        if key not in HOLDABLE_KEYS:
            raise UnknownKey(f"só um modificador pode ser segurado ou solto: {key}")
        if modifiers:
            raise UnknownKey("segurar ou soltar uma tecla não leva modificadores")
        return [_key(vk, extended=extended, up=action == "UP")]
    held = []
    for name in modifiers:
        if name not in _MODIFIERS:
            raise UnknownKey(f"modificador fora do contrato: {name}")
        held.append(_MODIFIERS[name])
    times = max(1, min(MAX_KEY_REPEAT, repeat))
    inputs = [_key(code) for code in held]
    inputs += [_key(vk, extended=extended), _key(vk, extended=extended, up=True)] * times
    inputs += [_key(code, up=True) for code in reversed(held)]
    return inputs


def text_inputs(text: str) -> list[RawInput]:
    """Cada unidade UTF-16 do texto, apertada e solta como Unicode (não depende do layout).

    O Windows espera um caractere fora do plano básico (emoji) como as duas unidades do par
    substituto, na ordem, cada uma apertada e solta; ele monta o caractere. Tudo vai no mesmo lote
    de quem chama. Uma unidade substituta sozinha (metade de um par) não forma caractere: é
    recusada em vez de digitar "?" no lugar, e a mensagem de erro não repete o texto (pode ser
    uma senha).
    """
    try:
        units = text.encode("utf-16-le")
    except UnicodeEncodeError:
        raise UnknownKey("texto com metade de um caractere (par substituto incompleto)") from None
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
    "HOLDABLE_KEYS",
    "KEY_ACTIONS",
    "KEY_EXTENDED",
    "KEY_UNICODE",
    "KEY_UP",
    "MAX_KEY_REPEAT",
    "MOUSE_HWHEEL",
    "MOUSE_MOVE",
    "MOUSE_WHEEL",
    "RawInput",
    "UnknownKey",
    "click_inputs",
    "dangling_key_ups",
    "held_after",
    "held_keys_after",
    "key_identity",
    "key_inputs",
    "media_inputs",
    "move_inputs",
    "release_inputs",
    "scroll_inputs",
    "text_inputs",
    "virtual_key",
]
