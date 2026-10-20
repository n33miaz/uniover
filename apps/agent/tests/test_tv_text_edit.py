"""Digitação confiável: só a diferença vai à TV, apagar é `DEL`, o ADB digita o ASCII."""

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvAdb, FakeTvRemote
from uniover_agent.core import (
    Command,
    ResultStatus,
    TextReconciler,
    TvSessionError,
    TvSessionManager,
    tv_text_handler,
)
from uniover_agent.core.tv.text_edit import MAX_DELETIONS, TextEdit, plan_edit
from uniover_agent.ports import AdbCommandFailed, AdbTimeout, AdbUnauthorized, TvUnreachable


class Rig:
    """Sessão com TV falsa e, se pedido, o canal ADB falso, tudo com o relógio à mão."""

    def __init__(self, *, with_adb: bool = False) -> None:
        self.clock = FakeClock()
        self.remote = FakeTvRemote()
        self.adb = FakeTvAdb()
        self.session = TvSessionManager(self.clock, self.remote)
        self.editor = TextReconciler(self.session, monotonic=self.clock.monotonic)
        if with_adb:
            self.editor.use_adb(self.adb)

    @property
    def deletions(self) -> int:
        return self.remote.keys.count("DEL")

    def reset(self) -> None:
        self.remote.keys.clear()
        self.remote.texts.clear()
        self.adb.typed.clear()


# --- o diff -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("old", "new", "edit"),
    [
        ("", "abc", TextEdit(0, "abc")),
        ("ab", "abc", TextEdit(0, "c")),
        ("abc", "ab", TextEdit(1, "")),
        ("abc", "", TextEdit(3, "")),
        ("abc", "abc", TextEdit(0, "")),
        ("abcd", "abXY", TextEdit(2, "XY")),
        ("abc", "xyz", TextEdit(3, "xyz")),
        ("", "", TextEdit(0, "")),
        ("matrix", "matriz", TextEdit(1, "z")),
    ],
)
def test_plan_edit_keeps_the_common_prefix(old: str, new: str, edit: TextEdit) -> None:
    assert plan_edit(old, new) == edit


# --- sem ADB: tudo pelo Remote v2 ---------------------------------------------------------------


async def test_without_adb_only_the_addition_is_sent_by_the_remote() -> None:
    rig = Rig()
    await rig.editor.set_text("mat")
    await rig.editor.set_text("matrix")
    assert rig.remote.texts == ["mat", "rix"]
    assert rig.deletions == 0
    assert rig.editor.last_text == "matrix"


async def test_deleting_part_of_the_text_sends_del_keys_and_no_text() -> None:
    rig = Rig()
    await rig.editor.set_text("matrix")
    rig.reset()
    await rig.editor.set_text("mat")
    assert rig.deletions == 3
    assert rig.remote.texts == []
    assert rig.editor.last_text == "mat"


async def test_changing_the_middle_deletes_the_tail_and_types_the_new_tail() -> None:
    rig = Rig()
    await rig.editor.set_text("matrix")
    rig.reset()
    await rig.editor.set_text("matte")
    assert rig.deletions == 3
    assert rig.remote.texts == ["te"]
    assert rig.editor.last_text == "matte"


async def test_empty_text_erases_everything_the_agent_typed_and_resets_the_state() -> None:
    rig = Rig()
    await rig.editor.set_text("matrix")
    rig.reset()
    await rig.editor.set_text("")
    assert rig.deletions == 6
    assert rig.remote.texts == []
    assert rig.editor.last_text == ""
    # O próximo texto parte do campo vazio.
    await rig.editor.set_text("a")
    assert rig.remote.texts == ["a"]


async def test_empty_text_with_nothing_typed_does_not_even_open_the_session() -> None:
    rig = Rig()
    await rig.editor.set_text("")
    assert rig.remote.connects == 0
    assert rig.remote.keys == []


async def test_the_same_text_twice_sends_nothing_the_second_time() -> None:
    rig = Rig()
    await rig.editor.set_text("abc")
    rig.reset()
    await rig.editor.set_text("abc")
    assert rig.remote.texts == []
    assert rig.remote.keys == []


async def test_a_radical_change_after_more_than_20_seconds_is_a_new_field() -> None:
    rig = Rig()
    await rig.editor.set_text("antigo")
    rig.reset()
    rig.clock.advance(20.5)
    await rig.editor.set_text("novo")
    # Nada é apagado (o campo em foco pode ser outro): o texto inteiro é digitado.
    assert rig.deletions == 0
    assert rig.remote.texts == ["novo"]
    assert rig.editor.last_text == "novo"


async def test_a_continuation_after_a_long_pause_types_only_the_suffix() -> None:
    rig = Rig()
    await rig.editor.set_text("mat")
    rig.reset()
    rig.clock.advance(300.0)
    await rig.editor.set_text("matrix")
    # Sem duplicar ("matmatrix"): é o mesmo campo, só o acréscimo vai.
    assert rig.remote.texts == ["rix"]
    assert rig.deletions == 0
    assert rig.editor.last_text == "matrix"


async def test_deleting_after_a_long_pause_still_erases_the_excess() -> None:
    rig = Rig()
    await rig.editor.set_text("matrix")
    rig.reset()
    rig.clock.advance(300.0)
    await rig.editor.set_text("mat")
    assert rig.deletions == 3
    assert rig.remote.texts == []
    assert rig.editor.last_text == "mat"


async def test_empty_text_after_a_long_pause_still_erases_everything_typed() -> None:
    rig = Rig()
    await rig.editor.set_text("matrix")
    rig.reset()
    rig.clock.advance(300.0)
    await rig.editor.set_text("")
    assert rig.deletions == 6
    assert rig.editor.last_text == ""


async def test_changing_the_middle_within_20_seconds_deletes_the_tail() -> None:
    rig = Rig()
    await rig.editor.set_text("matrix")
    rig.reset()
    rig.clock.advance(19.0)
    await rig.editor.set_text("matte")
    assert rig.deletions == 3
    assert rig.remote.texts == ["te"]


async def test_changing_the_middle_after_a_long_pause_is_a_new_field() -> None:
    rig = Rig()
    await rig.editor.set_text("matrix")
    rig.reset()
    rig.clock.advance(30.0)
    await rig.editor.set_text("matte")
    # Não é continuação nem apagar parcial: campo novo, nada é apagado.
    assert rig.deletions == 0
    assert rig.remote.texts == ["matte"]


async def test_within_20_seconds_it_is_the_same_field() -> None:
    rig = Rig()
    await rig.editor.set_text("ab")
    rig.reset()
    rig.clock.advance(19.0)
    await rig.editor.set_text("abc")
    assert rig.remote.texts == ["c"]
    # Cada digitação renova a janela.
    rig.clock.advance(19.0)
    await rig.editor.set_text("abcd")
    assert rig.remote.texts == ["c", "d"]


async def test_accents_and_emoji_are_typed_by_the_remote() -> None:
    rig = Rig()
    await rig.editor.set_text("ação 😀")
    assert rig.remote.texts == ["ação 😀"]


async def test_decomposed_accents_are_normalized_before_the_diff() -> None:
    rig = Rig()
    await rig.editor.set_text("café")  # e + acento combinante
    assert rig.remote.texts == ["café"]
    assert rig.editor.last_text == "café"


# --- com ADB ------------------------------------------------------------------------------------


async def test_ascii_addition_is_typed_by_the_adb_and_deletions_stay_on_the_remote() -> None:
    rig = Rig(with_adb=True)
    await rig.editor.set_text("mat")
    await rig.editor.set_text("matrix")
    assert rig.adb.typed == ["mat", "rix"]
    assert rig.remote.texts == []
    await rig.editor.set_text("matte")
    assert rig.deletions == 3
    assert rig.adb.typed == ["mat", "rix", "te"]


async def test_a_non_ascii_addition_goes_to_the_remote_as_a_whole_never_split_across_channels() -> (
    None
):
    rig = Rig(with_adb=True)
    await rig.editor.set_text("ola ação")
    assert rig.remote.texts == ["ola ação"]
    assert rig.adb.typed == []


@pytest.mark.parametrize("text", ["50%", "100% certo"])
async def test_percent_is_not_typed_by_the_adb(text: str) -> None:
    rig = Rig(with_adb=True)
    await rig.editor.set_text(text)
    assert rig.remote.texts == [text]
    assert rig.adb.typed == []


async def test_when_the_adb_is_not_ready_the_remote_types_the_same_text() -> None:
    rig = Rig(with_adb=True)
    rig.adb.errors = [AdbUnauthorized("x")]
    await rig.editor.set_text("abc")
    assert rig.remote.texts == ["abc"]
    assert rig.editor.last_text == "abc"
    await rig.editor.set_text("abcd")
    assert rig.adb.typed == ["d"]


@pytest.mark.parametrize("error", [AdbTimeout("x"), AdbCommandFailed("x")])
async def test_an_adb_failure_that_may_have_typed_is_not_repeated_by_the_remote(
    error: Exception,
) -> None:
    rig = Rig(with_adb=True)
    rig.adb.errors = [error]  # type: ignore[list-item]
    with pytest.raises(TvSessionError) as caught:
        await rig.editor.set_text("abc")
    assert caught.value.code in {"adb_timeout", "adb_failed"}
    assert rig.remote.texts == []
    assert rig.editor.last_text == ""


# --- falha no meio ------------------------------------------------------------------------------


class DropsAfterThree(FakeTvRemote):
    """O canal cai depois de três teclas `DEL`."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if len(self.keys) >= 3:
            raise TvUnreachable("caiu")
        await super().send_key(key, direction)


async def test_last_text_follows_what_really_happened_when_a_failure_hits_halfway() -> None:
    clock = FakeClock()
    remote = DropsAfterThree()
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic)
    await editor.set_text("abcdef")
    remote.keys.clear()
    # Três `DEL` saem, a quarta falha: o campo agora tem "abc", e é isso que o agente guarda.
    remote.connect_errors = []
    with pytest.raises(TvSessionError):
        await editor.set_text("")
    assert editor.last_text == "abc"
    assert remote.keys.count("DEL") == 3


async def test_a_failure_before_anything_changed_keeps_last_text() -> None:
    clock = FakeClock()
    remote = FakeTvRemote()
    session = TvSessionManager(clock, remote, backoff=(), hibernate_seconds=10)
    editor = TextReconciler(session, monotonic=clock.monotonic, field_idle_seconds=1000)
    await editor.set_text("ab")
    clock.advance(11.0)
    assert await session.hibernate_if_idle()
    remote.connect_errors = [TvUnreachable("x")]
    with pytest.raises(TvSessionError):
        await editor.set_text("abc")
    assert editor.last_text == "ab"
    assert remote.texts == ["ab"]


async def test_deletions_are_capped_per_message() -> None:
    clock = FakeClock()
    remote = FakeTvRemote()
    editor = TextReconciler(TvSessionManager(clock, remote), monotonic=clock.monotonic)
    editor._last = "x" * (MAX_DELETIONS + 50)
    editor._last_at = clock.monotonic()
    await editor.set_text("")
    assert remote.keys.count("DEL") == MAX_DELETIONS


# --- o handler ----------------------------------------------------------------------------------


async def test_the_handler_accepts_empty_text_and_erases() -> None:
    rig = Rig()
    handler = tv_text_handler(rig.session, reconciler=rig.editor)
    await handler(Command("1", "tv.text.v1", {"text": "abc"}))
    rig.reset()
    result = await handler(Command("2", "tv.text.v1", {"text": ""}))
    assert result.status is ResultStatus.OK
    assert rig.deletions == 3


async def test_the_handler_reports_adb_failures_with_their_code() -> None:
    rig = Rig(with_adb=True)
    rig.adb.errors = [AdbTimeout("a TV demorou demais para responder ao ADB")]
    handler = tv_text_handler(rig.session, reconciler=rig.editor)
    result = await handler(Command("1", "tv.text.v1", {"text": "abc"}))
    assert (result.status, result.code) == (ResultStatus.FAILED, "adb_timeout")


async def test_a_failed_message_does_not_block_the_next() -> None:
    rig = Rig(with_adb=True)
    rig.adb.errors = [AdbCommandFailed("x")]
    handler = tv_text_handler(rig.session, reconciler=rig.editor)
    assert (await handler(Command("1", "tv.text.v1", {"text": "a"}))).status is ResultStatus.FAILED
    assert (await handler(Command("2", "tv.text.v1", {"text": "ab"}))).status is ResultStatus.OK
    assert rig.adb.typed == ["ab"]
