"""Digitação com o estado real do campo: a TV informa o valor, e o diff parte dele."""

from uniover_agent.adapters.fakes import FakeTvRemote
from uniover_agent.ports import TextFieldStatus

from .test_tv_text_edit import Rig


def wired_rig() -> Rig:
    """Como a composição do agente: o que a TV informa do campo chega ao reconciliador."""
    rig = Rig()
    rig.remote.on_text_field(rig.editor.observe_field)
    return rig


def field(value: str, counter: int = 1) -> TextFieldStatus:
    return TextFieldStatus(value, len(value), len(value), "Buscar", counter)


async def test_the_real_value_seeds_what_the_agent_believes_is_in_the_field() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("Matrix"))
    assert rig.editor.last_text == "Matrix"
    await rig.editor.set_text("Matrix 2")
    # Só o acréscimo vai, e nada é apagado às cegas.
    assert rig.remote.texts == [" 2"]
    assert rig.deletions == 0


async def test_text_already_in_the_field_is_not_typed_again() -> None:
    """Sem o estado, o agente digitaria "abd" por cima do "abc" que já estava lá."""
    rig = wired_rig()
    rig.remote.push_text_field(field("abc"))
    await rig.editor.set_text("abd")
    assert rig.deletions == 1
    assert rig.remote.texts == ["d"]


async def test_the_same_text_as_the_field_sends_nothing() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("matrix"))
    await rig.editor.set_text("matrix")
    assert rig.remote.keys == []
    assert rig.remote.texts == []
    assert rig.remote.connects == 0


async def test_with_the_state_known_the_idle_time_no_longer_decides_a_new_field() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("abc"))
    rig.clock.advance(60)
    # Pela pausa, "xyz" parecia campo novo e o "abc" ficava; o valor real manda apagar.
    await rig.editor.set_text("xyz")
    assert rig.deletions == 3
    assert rig.remote.texts == ["xyz"]


async def test_a_new_field_arrives_as_a_new_state_and_nothing_is_erased() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("abc", counter=4))
    await rig.editor.set_text("abc def")
    rig.reset()
    # A TV passou a outro campo, vazio, e o disse.
    rig.remote.push_text_field(field("", counter=5))
    await rig.editor.set_text("novo")
    assert rig.deletions == 0
    assert rig.remote.texts == ["novo"]


async def test_without_any_state_the_idle_heuristic_is_the_same_as_before() -> None:
    rig = wired_rig()
    await rig.editor.set_text("abc")
    rig.reset()
    rig.clock.advance(60)
    await rig.editor.set_text("xyz")
    assert rig.deletions == 0
    assert rig.remote.texts == ["xyz"]


async def test_the_value_is_normalized_like_the_text_the_owner_sends() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("café"))
    await rig.editor.set_text("café")
    assert rig.remote.keys == []
    assert rig.remote.texts == []


async def test_an_echo_that_arrives_during_our_own_edit_does_not_rewrite_what_we_know() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("abcd", counter=1))
    send_key = rig.remote.send_key

    async def send_key_with_a_late_echo(key: str, direction: str = "SHORT") -> None:
        await send_key(key, direction)
        rig.remote.push_text_field(field("abcd", counter=1))  # eco atrasado de um passo anterior

    rig.remote.send_key = send_key_with_a_late_echo  # type: ignore[method-assign]
    await rig.editor.set_text("ab")
    assert rig.deletions == 2
    assert rig.editor.last_text == "ab"


async def test_a_field_change_in_the_middle_of_an_edit_is_applied_when_it_ends() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("abc", counter=1))
    send_text = rig.remote.send_text

    async def send_text_while_the_focus_moves(text: str) -> None:
        await send_text(text)
        # A TV passou a outro campo enquanto a edição ainda estava em andamento.
        rig.remote.push_text_field(field("xyz", counter=2))

    rig.remote.send_text = send_text_while_the_focus_moves  # type: ignore[method-assign]
    await rig.editor.set_text("abcd")
    assert rig.editor.last_text == "xyz"
    rig.reset()
    # O comando seguinte continua o campo novo: nada do campo anterior é apagado nem repetido.
    await rig.editor.set_text("xyzw")
    assert rig.deletions == 0
    assert rig.remote.texts == ["w"]


async def test_forgetting_the_field_brings_back_the_conservative_idle_rule() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("abc", counter=1))
    rig.editor.forget_field()
    rig.clock.advance(60)
    await rig.editor.set_text("xyz")
    assert rig.deletions == 0
    assert rig.remote.texts == ["xyz"]


async def test_a_pending_state_is_dropped_when_the_field_is_forgotten() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("abc", counter=1))
    send_text = rig.remote.send_text

    async def send_text_then_forget(text: str) -> None:
        await send_text(text)
        rig.remote.push_text_field(field("xyz", counter=2))
        rig.editor.forget_field()

    rig.remote.send_text = send_text_then_forget  # type: ignore[method-assign]
    await rig.editor.set_text("abcd")
    assert rig.editor.last_text == "abcd"


async def test_only_a_real_app_change_forgets_the_field() -> None:
    rig = wired_rig()
    rig.editor.observe_app("com.exemplo.video")
    rig.remote.push_text_field(field("abc", counter=1))
    rig.editor.observe_app("com.exemplo.video")  # o eco repete o app
    rig.clock.advance(60)
    await rig.editor.set_text("abcd")
    assert rig.remote.texts == ["d"]
    rig.editor.observe_app("com.exemplo.musica")
    rig.clock.advance(60)
    rig.reset()
    await rig.editor.set_text("xyz")
    assert rig.deletions == 0
    assert rig.remote.texts == ["xyz"]


async def test_a_late_echo_with_the_same_counter_does_not_rewrite_what_we_know() -> None:
    rig = wired_rig()
    rig.remote.push_text_field(field("abcd", counter=1))
    await rig.editor.set_text("abc")
    # O eco do passo "abcd" chega depois de a edição acabar.
    rig.remote.push_text_field(field("abcd", counter=1))
    assert rig.editor.last_text == "abc"
    rig.reset()
    await rig.editor.set_text("abcd")
    assert rig.remote.texts == ["d"]
    assert rig.deletions == 0


async def test_the_first_state_after_the_agent_already_typed_only_records_the_counter() -> None:
    rig = wired_rig()
    await rig.editor.set_text("ab")
    rig.remote.push_text_field(field("a", counter=3))  # passo intermediário
    assert rig.editor.last_text == "ab"
    # Já com o contador conhecido, outro campo volta a semear a base.
    rig.remote.push_text_field(field("zz", counter=4))
    assert rig.editor.last_text == "zz"


def test_a_remote_without_the_state_channel_just_never_calls_back() -> None:
    remote = FakeTvRemote()
    seen: list[TextFieldStatus] = []
    remote.on_text_field(seen.append)
    assert seen == []
