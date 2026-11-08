"""Tradução do contrato do controle do PC para eventos de entrada: pura, sem tocar no sistema."""

import pytest

from uniover_agent.adapters import pc_inputs
from uniover_agent.adapters.pc_inputs import (
    KEY_EXTENDED,
    KEY_UNICODE,
    KEY_UP,
    MOUSE_HWHEEL,
    MOUSE_MOVE,
    MOUSE_WHEEL,
    RawInput,
    UnknownKey,
)


def test_move_is_relative_and_clamped() -> None:
    (event,) = pc_inputs.move_inputs(12, -4)
    assert (event.kind, event.flags, event.dx, event.dy) == ("mouse", MOUSE_MOVE, 12, -4)
    (huge,) = pc_inputs.move_inputs(99999, -99999)
    assert (huge.dx, huge.dy) == (pc_inputs.MAX_POINTER, -pc_inputs.MAX_POINTER)


def test_scroll_emits_one_event_per_axis_and_nothing_for_zero() -> None:
    assert pc_inputs.scroll_inputs(0, 0) == []
    vertical, horizontal = pc_inputs.scroll_inputs(-240, 120)
    assert (vertical.flags, vertical.data) == (MOUSE_WHEEL, 120)
    assert (horizontal.flags, horizontal.data) == (MOUSE_HWHEEL, -240)


@pytest.mark.parametrize(("action", "count"), [("CLICK", 2), ("DOUBLE", 4), ("DOWN", 1), ("UP", 1)])
def test_click_actions(action: str, count: int) -> None:
    assert len(pc_inputs.click_inputs("LEFT", action)) == count


def test_right_click_uses_the_right_button_flags() -> None:
    down, up = pc_inputs.click_inputs("RIGHT", "CLICK")
    assert (down.flags, up.flags) == (pc_inputs.MOUSE_RIGHTDOWN, pc_inputs.MOUSE_RIGHTUP)


def test_unknown_click_is_refused() -> None:
    with pytest.raises(UnknownKey):
        pc_inputs.click_inputs("BACK", "CLICK")
    with pytest.raises(UnknownKey):
        pc_inputs.click_inputs("LEFT", "TRIPLE")


def test_modifiers_are_pressed_around_the_key_and_always_released() -> None:
    events = pc_inputs.key_inputs("C", ["CTRL", "SHIFT"])
    assert [(e.vk, bool(e.flags & KEY_UP)) for e in events] == [
        (0x11, False),
        (0x10, False),
        (ord("C"), False),
        (ord("C"), True),
        (0x10, True),
        (0x11, True),
    ]


def test_arrow_keys_are_extended() -> None:
    down, up = pc_inputs.key_inputs("LEFT")
    assert down.flags == KEY_EXTENDED
    assert up.flags == KEY_EXTENDED | KEY_UP


@pytest.mark.parametrize(
    ("key", "vk"), [("ENTER", 0x0D), ("F1", 0x70), ("F12", 0x7B), ("A", 0x41), ("SPACE", 0x20)]
)
def test_virtual_keys(key: str, vk: int) -> None:
    assert pc_inputs.virtual_key(key)[0] == vk


@pytest.mark.parametrize("key", ["F13", "F0", "a", "AB", "D10", "DA", "PRINT", "NUMPAD0", ""])
def test_keys_outside_the_contract_are_refused(key: str) -> None:
    with pytest.raises(UnknownKey):
        pc_inputs.virtual_key(key)


# A tabela das teclas da v2: código virtual do Windows e se é estendida. D0 a D9 são a fileira de
# cima (VK_0..VK_9), e as quatro pontuações são as teclas OEM de layout americano.
V2_KEYS = [
    *((f"D{n}", 0x30 + n, False) for n in range(10)),
    ("MINUS", 0xBD, False),
    ("EQUALS", 0xBB, False),
    ("COMMA", 0xBC, False),
    ("PERIOD", 0xBE, False),
    ("INSERT", 0x2D, True),
    ("PRINT_SCREEN", 0x2C, True),
    ("APPS", 0x5D, True),
    ("WIN", 0x5B, False),
    ("CAPS_LOCK", 0x14, False),
    ("CTRL", 0x11, False),
    ("ALT", 0x12, False),
    ("SHIFT", 0x10, False),
]


@pytest.mark.parametrize(("key", "vk", "extended"), V2_KEYS)
def test_the_keys_only_the_v2_has_map_to_their_virtual_keys(
    key: str, vk: int, extended: bool
) -> None:
    assert pc_inputs.virtual_key(key) == (vk, extended)
    down, up = pc_inputs.key_inputs(key)
    assert (down.vk, up.vk) == (vk, vk)
    assert bool(down.flags & KEY_EXTENDED) is extended
    assert up.flags & KEY_UP


def test_the_digit_row_is_not_the_numeric_keypad() -> None:
    # VK_NUMPAD0 é 0x60: a fileira de cima é VK_0 (0x30), que é o que Ctrl+0 do navegador usa.
    assert pc_inputs.virtual_key("D0")[0] == 0x30
    assert pc_inputs.virtual_key("D9")[0] == 0x39


def test_repeat_presses_the_key_that_many_times_in_one_batch_with_the_modifiers_around_all() -> (
    None
):
    events = pc_inputs.key_inputs("BACKSPACE", ["CTRL"], repeat=3)
    assert [(e.vk, bool(e.flags & KEY_UP)) for e in events] == [
        (0x11, False),
        *[(0x08, False), (0x08, True)] * 3,
        (0x11, True),
    ]


def test_repeat_is_bounded_even_if_the_contract_failed_to_bound_it() -> None:
    assert len(pc_inputs.key_inputs("BACKSPACE", repeat=50)) == 100
    assert len(pc_inputs.key_inputs("BACKSPACE", repeat=5000)) == 2 * pc_inputs.MAX_KEY_REPEAT
    assert len(pc_inputs.key_inputs("BACKSPACE", repeat=0)) == 2
    assert len(pc_inputs.key_inputs("BACKSPACE", repeat=-4)) == 2


def test_the_default_is_still_one_press_like_the_v1() -> None:
    assert pc_inputs.key_inputs("C", ["CTRL"]) == pc_inputs.key_inputs(
        "C", ["CTRL"], repeat=1, action="PRESS"
    )


@pytest.mark.parametrize("key", ["CTRL", "ALT", "SHIFT", "WIN"])
def test_down_and_up_press_or_release_a_single_modifier_without_the_other_half(key: str) -> None:
    vk = pc_inputs.virtual_key(key)[0]
    (down,) = pc_inputs.key_inputs(key, action="DOWN")
    (up,) = pc_inputs.key_inputs(key, action="UP")
    assert (down.vk, down.flags & KEY_UP) == (vk, 0)
    assert (up.vk, up.flags & KEY_UP) == (vk, KEY_UP)


@pytest.mark.parametrize(
    ("key", "modifiers", "repeat", "action"),
    [
        ("A", [], 1, "DOWN"),
        ("TAB", [], 1, "UP"),
        ("CAPS_LOCK", [], 1, "DOWN"),
        ("ALT", ["SHIFT"], 1, "DOWN"),
        ("ALT", [], 1, "HOLD"),
        ("ALT", [], 1, ""),
    ],
)
def test_holding_anything_but_a_lone_modifier_is_refused_and_nothing_is_produced(
    key: str, modifiers: list[str], repeat: int, action: str
) -> None:
    with pytest.raises(UnknownKey):
        pc_inputs.key_inputs(key, modifiers, repeat, action)


def test_held_keys_follow_the_order_of_the_events() -> None:
    alt_down, alt_up = (
        pc_inputs.key_inputs("ALT", action="DOWN")[0],
        pc_inputs.key_inputs("ALT", action="UP")[0],
    )
    held = pc_inputs.held_keys_after({}, [alt_down])
    assert list(held.values()) == [alt_up], "guarda o evento que solta"
    assert pc_inputs.held_keys_after(held, pc_inputs.key_inputs("TAB")) == held, (
        "uma batida completa não muda nada"
    )
    assert pc_inputs.held_keys_after(held, [alt_up]) == {}
    assert pc_inputs.held_keys_after({}, pc_inputs.key_inputs("C", ["CTRL"], repeat=4)) == {}


def test_a_unicode_batch_never_leaves_a_held_key() -> None:
    assert pc_inputs.held_keys_after({}, pc_inputs.text_inputs("olá 😀")) == {}


def test_unknown_modifier_is_refused_before_anything_is_pressed() -> None:
    with pytest.raises(UnknownKey):
        pc_inputs.key_inputs("C", ["CTRL", "META"])


def test_text_is_typed_as_unicode_independent_of_the_layout() -> None:
    events = pc_inputs.text_inputs("aç")
    assert [(e.scan, e.flags) for e in events] == [
        (ord("a"), KEY_UNICODE),
        (ord("a"), KEY_UNICODE | KEY_UP),
        (ord("ç"), KEY_UNICODE),
        (ord("ç"), KEY_UNICODE | KEY_UP),
    ]
    assert all(event.vk == 0 for event in events)


def test_text_outside_the_basic_plane_becomes_a_surrogate_pair() -> None:
    events = pc_inputs.text_inputs("\U0001f600")
    assert [e.scan for e in events[::2]] == [0xD83D, 0xDE00]


def test_media_keys_and_volume_steps() -> None:
    assert pc_inputs.media_inputs("MUTE") == [
        RawInput("keyboard", vk=0xAD),
        RawInput("keyboard", KEY_UP, vk=0xAD),
    ]
    assert len(pc_inputs.media_inputs("VOLUME_UP", 3)) == 6
    # Passos só valem para o volume; e nunca mais que o contrato deixa.
    assert len(pc_inputs.media_inputs("NEXT", 5)) == 2
    assert len(pc_inputs.media_inputs("VOLUME_DOWN", 99)) == 20
    with pytest.raises(UnknownKey):
        pc_inputs.media_inputs("EJECT")


def test_an_emoji_is_both_surrogate_units_each_pressed_and_released_in_order() -> None:
    events = pc_inputs.text_inputs("a\U0001f600b")
    assert [(e.scan, e.flags) for e in events] == [
        (ord("a"), KEY_UNICODE),
        (ord("a"), KEY_UNICODE | KEY_UP),
        (0xD83D, KEY_UNICODE),
        (0xD83D, KEY_UNICODE | KEY_UP),
        (0xDE00, KEY_UNICODE),
        (0xDE00, KEY_UNICODE | KEY_UP),
        (ord("b"), KEY_UNICODE),
        (ord("b"), KEY_UNICODE | KEY_UP),
    ]


@pytest.mark.parametrize("text", ["\ud800", "senha\udc00", "\ud83d x", "\ude00\ud83d", "ok \ud83d"])
def test_half_of_a_character_is_refused_and_no_event_is_produced(text: str) -> None:
    produced: list[RawInput] = []
    with pytest.raises(UnknownKey, match="par substituto incompleto"):
        produced = pc_inputs.text_inputs(text)
    assert produced == []


def test_the_refusal_of_half_a_character_never_repeats_the_text() -> None:
    with pytest.raises(UnknownKey) as refused:
        pc_inputs.text_inputs("senha-secreta\ud800")
    assert "senha" not in str(refused.value)
    assert "secreta" not in str(refused.value)


def test_a_whole_emoji_is_not_mistaken_for_half_a_character() -> None:
    # `\U0001f600` é um só caractere (o par substituto só existe na codificação UTF-16).
    assert len(pc_inputs.text_inputs("\U0001f600")) == 4


def test_dangling_key_ups_release_what_a_partial_batch_left_pressed() -> None:
    events = pc_inputs.key_inputs("T", ["CTRL", "SHIFT"])
    # Só CTRL e SHIFT entraram: soltam-se na ordem inversa.
    ups = pc_inputs.dangling_key_ups(events[:2])
    assert [(e.vk, e.flags) for e in ups] == [(0x10, KEY_UP), (0x11, KEY_UP)]
    # Entrou também o T apertado: ele é solto primeiro.
    ups = pc_inputs.dangling_key_ups(events[:3])
    assert [(e.vk, e.flags) for e in ups] == [(ord("T"), KEY_UP), (0x10, KEY_UP), (0x11, KEY_UP)]
    # O T já foi solto dentro do que entrou: sobram só os modificadores.
    ups = pc_inputs.dangling_key_ups(events[:4])
    assert [e.vk for e in ups] == [0x10, 0x11]
    # Um lote inteiro não deixa nada para soltar.
    assert pc_inputs.dangling_key_ups(events) == []
    # Evento do mouse não é tecla.
    assert pc_inputs.dangling_key_ups(pc_inputs.click_inputs("LEFT", "DOWN")) == []


def test_dangling_key_ups_keep_extended_and_unicode_flags() -> None:
    (up,) = pc_inputs.dangling_key_ups(pc_inputs.key_inputs("LEFT")[:1])
    assert up.flags == KEY_EXTENDED | KEY_UP
    unicode_up = pc_inputs.dangling_key_ups(pc_inputs.text_inputs("a")[:1])
    assert [(e.scan, e.flags) for e in unicode_up] == [(ord("a"), KEY_UNICODE | KEY_UP)]


def test_held_buttons_follow_the_order_of_the_events() -> None:
    down = pc_inputs.click_inputs("LEFT", "DOWN")
    up = pc_inputs.click_inputs("LEFT", "UP")
    assert pc_inputs.held_after([], down) == {"LEFT"}
    assert pc_inputs.held_after({"LEFT"}, up) == frozenset()
    assert pc_inputs.held_after([], pc_inputs.click_inputs("LEFT", "DOUBLE")) == frozenset()
    # Só o que foi apertado e não solto fica: o direito é um clique inteiro, o do meio ficou.
    events = [
        *pc_inputs.click_inputs("RIGHT", "CLICK"),
        *pc_inputs.click_inputs("MIDDLE", "DOWN"),
        *pc_inputs.move_inputs(3, 3),
        *pc_inputs.key_inputs("A"),
    ]
    assert pc_inputs.held_after([], events) == {"MIDDLE"}


def test_release_inputs_lifts_each_button_in_a_fixed_order() -> None:
    assert pc_inputs.release_inputs({"RIGHT", "LEFT"}) == [
        *pc_inputs.click_inputs("LEFT", "UP"),
        *pc_inputs.click_inputs("RIGHT", "UP"),
    ]
    assert pc_inputs.release_inputs(()) == []
