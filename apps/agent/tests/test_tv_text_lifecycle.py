"""Limites do ciclo de vida do estado do campo: o que cada um descarta e o que mantém."""

from dataclasses import fields

from uniover_agent.core.tv.text_edit import (
    TextReconciler,
    _BufferedIme,
    _ErasePlan,
    _FieldState,
    _TextDoubt,
)
from uniover_agent.ports import TextFieldStatus

from .test_tv_text_edit import Rig


def report(value: str, counter: int) -> TextFieldStatus:
    return TextFieldStatus(value, len(value), len(value), "Buscar", counter)


def populated() -> _FieldState:
    """Um estado com todo membro fora do valor inicial."""
    return _FieldState(
        last="abc",
        last_at=5.0,
        owns_field=True,
        field_counter=7,
        echo=report("abc", 7),
        buffered_ime=_BufferedIme(7, "abc"),
        uncertain=_TextDoubt("abcd", 3, 4),
        doubt_counter=7,
        doubt_owns_field=True,
        erase=_ErasePlan(2, 4, None),
        erase_report=report("abc", 7),
        field_sequence=(7, 3),
        erase_sequence=3,
        pending_field=report("xyz", 8),
        dropped_fields=[report("old", 6)],
    )


ALL = {f.name for f in fields(_FieldState)}


def test_every_member_is_populated_by_the_fixture() -> None:
    """Um membro novo precisa entrar aqui e na tabela de limites abaixo."""
    state = populated()
    blank = _FieldState()
    assert {
        f.name for f in fields(state) if getattr(state, f.name) == getattr(blank, f.name)
    } == set()


def test_a_new_session_keeps_the_base_the_doubt_and_the_erase_range() -> None:
    state = populated()
    pending = state.pending_field
    state.end_session()
    assert state.dropped_fields[-1] is pending
    assert state.pending_field is None
    assert (state.field_counter, state.echo, state.owns_field) == (None, None, False)
    assert state.erase_report is None
    assert state.last == "abc"
    assert state.last_at == 5.0
    assert state.buffered_ime is not None
    assert state.uncertain is not None
    assert (state.doubt_counter, state.doubt_owns_field) == (7, True)
    assert state.erase is not None
    assert state.erase_sequence == 3
    # O contador de IME recomeça na reconexão: a sequência salva não vale na sessão nova.
    assert state.field_sequence is None


def test_an_app_change_drops_the_doubt_and_the_sequence() -> None:
    state = populated()
    state.end_focus(recovering=False)
    assert state.uncertain is None
    assert state.doubt_counter is None
    assert not state.doubt_owns_field
    assert state.erase is None
    assert state.erase_report is None
    assert state.erase_sequence is None
    assert state.field_sequence is None
    assert state.buffered_ime is None
    # Sem recuperação em curso a base fica: a pausa decide, como sem relato da TV.
    assert state.last == "abc"
    assert state.last_at == 5.0


def test_an_app_change_during_recovery_also_drops_the_base() -> None:
    state = populated()
    state.end_focus(recovering=True)
    assert state.last == ""
    assert state.last_at is None


def test_a_focus_change_inside_an_edit_keeps_the_pending_report_for_the_next_base() -> None:
    state = populated()
    pending, dropped = state.pending_field, list(state.dropped_fields)
    state.end_edit_focus()
    assert state.pending_field is pending
    assert state.dropped_fields == dropped
    assert state.field_sequence == (7, 3)
    assert (state.last, state.last_at, state.field_counter) == ("", None, None)
    assert state.echo is None
    assert not state.owns_field
    assert state.buffered_ime is None
    assert state.uncertain is None
    assert state.erase is None


def test_a_replaced_base_keeps_the_pause_and_the_doubt_decisions() -> None:
    state = populated()
    state.end_base()
    assert (state.last, state.owns_field, state.buffered_ime) == ("", False, None)
    assert state.last_at == 5.0
    assert state.field_counter == 7
    assert state.uncertain is not None
    assert state.erase is not None


def test_a_report_from_another_field_only_unanchors_the_base() -> None:
    state = populated()
    state.end_buffered_field()
    assert (state.buffered_ime, state.last_at, state.field_counter) == (None, None, None)
    assert state.last == "abc"
    assert state.owns_field
    assert state.uncertain is not None


def test_clearing_the_doubt_clears_the_whole_erase_record() -> None:
    state = populated()
    state.clear_doubt()
    assert (state.uncertain, state.doubt_counter, state.doubt_owns_field) == (None, None, False)
    assert (state.erase, state.erase_report, state.erase_sequence) == (None, None, None)
    assert state.last == "abc"


def test_every_boundary_is_classified() -> None:
    """Nenhum limite deixa passar um membro sem decisão: o que muda é o que a tabela diz."""
    table = {
        "end_session": {
            "field_counter",
            "pending_field",
            "echo",
            "owns_field",
            "erase_report",
            "field_sequence",
        },
        "end_edit_focus": {
            "last",
            "last_at",
            "field_counter",
            "echo",
            "owns_field",
            "buffered_ime",
            "uncertain",
            "doubt_counter",
            "doubt_owns_field",
            "erase",
            "erase_report",
            "erase_sequence",
        },
        "end_base": {"last", "owns_field", "buffered_ime"},
        "end_buffered_field": {"buffered_ime", "last_at", "field_counter"},
    }
    for name, expected in table.items():
        state = populated()
        before = {f.name: getattr(state, f.name) for f in fields(state)}
        getattr(state, name)()
        changed = {
            f.name
            for f in fields(state)
            if f.name != "dropped_fields" and getattr(state, f.name) != before[f.name]
        }
        assert changed == expected, name
    assert ALL >= set().union(*table.values())


async def test_a_new_session_keeps_what_the_agent_typed_but_not_the_owner_claim() -> None:
    rig = Rig()
    await rig.editor.set_text("abc")
    rig.editor.observe_field(report("abc", 1))
    assert rig.editor._f.owns_field
    rig.editor.forget_session()
    assert rig.editor.last_text == "abc"
    assert not rig.editor._f.owns_field
    assert rig.editor._f.field_counter is None


async def test_an_app_change_without_recovery_keeps_the_typed_base() -> None:
    rig = Rig()
    rig.editor.observe_app("com.a")
    await rig.editor.set_text("abc")
    rig.editor.observe_app("com.b")
    assert rig.editor.last_text == "abc"
    assert rig.editor._f.uncertain is None


def test_the_state_has_a_single_owner() -> None:
    rig = Rig()
    names = {f.name for f in fields(_FieldState)}
    leaked = [n for n in names if f"_{n}" in vars(rig.editor)]
    assert leaked == []
    assert isinstance(rig.editor, TextReconciler)
