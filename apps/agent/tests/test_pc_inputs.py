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


@pytest.mark.parametrize("key", ["F13", "F0", "a", "AB", "PRINT_SCREEN", ""])
def test_keys_outside_the_contract_are_refused(key: str) -> None:
    with pytest.raises(UnknownKey):
        pc_inputs.virtual_key(key)


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
