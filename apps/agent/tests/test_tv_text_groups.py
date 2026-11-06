"""Digitação em grupos pelo ADB: o que vai em cada `input text`, a ordem e a falha no meio.

Nada fala com uma TV: o controle e o ADB são dublês que gravam na mesma lista de eventos (a ordem
entre os canais), e o relógio é o falso, que só anda quando o teste manda.
"""

import asyncio

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvAdb, FakeTvRemote
from uniover_agent.adapters.tv_adb_parsing import input_text_command
from uniover_agent.core import (
    Command,
    ResultStatus,
    TextReconciler,
    TvSessionError,
    TvSessionManager,
    tv_text_handler,
)
from uniover_agent.ports import AdbCommandFailed, AdbTimeout, AdbUnauthorized, adb_text_groups

Events = list[tuple[str, str]]


class Rig:
    def __init__(
        self,
        *,
        adb_group_chars: int = 80,
        remote_settle: float = 0.0,
        adb: FakeTvAdb | None = None,
    ) -> None:
        self.events: Events = []
        self.clock = FakeClock()
        self.remote = FakeTvRemote(self.events)
        self.adb = adb or FakeTvAdb(events=self.events)
        self.adb.events = self.events
        self.session = TvSessionManager(self.clock, self.remote)
        self.editor = TextReconciler(
            self.session,
            monotonic=self.clock.monotonic,
            sleep=self.clock.sleep,
            adb_group_chars=adb_group_chars,
            remote_settle_seconds=remote_settle,
        )
        self.editor.use_adb(self.adb)


# --- a tabela de escape: grupos e o comando de cada um ------------------------------------------


@pytest.mark.parametrize(
    ("text", "groups", "commands"),
    [
        # As cadeias do teste do dono: `%ab`, `éab` e `caf` + pausa + `é`.
        ("%ab", ["%ab"], ["input text '%ab'"]),
        ("caf", ["caf"], ["input text 'caf'"]),
        # Espaço vira `%s`; o `%` literal antes de espaço fica `%%s` (o Android lê `%` + espaço).
        ("a b", ["a b"], ["input text 'a%sb'"]),
        ("% ", ["% "], ["input text '%%s'"]),
        ("50% off", ["50% off"], ["input text '50%%soff'"]),
        # O par `%s` literal nunca vai num comando só: viraria um espaço.
        ("%s", ["%", "s"], ["input text '%'", "input text 's'"]),
        ("100%sure", ["100%", "sure"], ["input text '100%'", "input text 'sure'"]),
        ("%%s", ["%%", "s"], ["input text '%%'", "input text 's'"]),
        ("%s%s", ["%", "s%", "s"], ["input text '%'", "input text 's%'", "input text 's'"]),
        # O shell da TV: aspas simples, e a aspa simples vira `'\''`.
        ("it's", ["it's"], ["input text 'it'\\''s'"]),
        ('say "hi"', ['say "hi"'], ["input text 'say%s\"hi\"'"]),
        ("a&b;c|d", ["a&b;c|d"], ["input text 'a&b;c|d'"]),
        ("a\\b", ["a\\b"], ["input text 'a\\b'"]),
        ("$HOME `id` $(x)", ["$HOME `id` $(x)"], ["input text '$HOME%s`id`%s$(x)'"]),
        ("a*b?c<d>e~f#g!h", ["a*b?c<d>e~f#g!h"], ["input text 'a*b?c<d>e~f#g!h'"]),
    ],
)
def test_escaping_table(text: str, groups: list[str], commands: list[str]) -> None:
    assert adb_text_groups(text) == groups
    assert "".join(groups) == text
    assert [input_text_command(group) for group in groups] == commands


@pytest.mark.parametrize("text", ["éab", "é", "ação", "😀", "a\nb", "a\tb", "x\x7f", ""])
def test_what_the_adb_cannot_type_is_not_grouped(text: str) -> None:
    with pytest.raises(ValueError, match="fidelidade"):
        adb_text_groups(text)


def test_a_group_never_holds_a_literal_percent_s() -> None:
    with pytest.raises(ValueError, match="dois comandos"):
        input_text_command("%s")


def test_groups_are_cut_at_the_size_limit_and_join_back_in_order() -> None:
    groups = adb_text_groups("abcdefgh", 3)
    assert groups == ["abc", "def", "gh"]
    assert adb_text_groups("a%sb%sc", 3) == ["a%", "sb%", "sc"]
    with pytest.raises(ValueError, match="ao menos"):
        adb_text_groups("a", 0)


# --- as cadeias do dono, pelo reconciliador -----------------------------------------------------


async def test_percent_text_goes_by_the_adb_in_one_call() -> None:
    rig = Rig()
    await rig.editor.set_text("%ab")
    assert rig.events == [("adb", "%ab")]
    assert rig.editor.last_text == "%ab"


async def test_percent_followed_by_s_goes_in_two_calls_in_order() -> None:
    rig = Rig()
    await rig.editor.set_text("%s")
    assert rig.events == [("adb", "%"), ("adb", "s")]
    assert rig.editor.last_text == "%s"


async def test_a_text_with_an_accent_goes_whole_by_the_remote_never_split() -> None:
    rig = Rig()
    await rig.editor.set_text("éab")
    assert rig.events == [("texto", "éab")]
    assert rig.adb.typed == []


async def test_caf_then_a_pause_then_accent_keeps_the_order_across_the_fallback() -> None:
    rig = Rig()
    await rig.editor.set_text("caf")
    rig.clock.advance(3.0)
    await rig.editor.set_text("café")
    assert rig.events == [("adb", "caf"), ("texto", "é")]
    assert rig.editor.last_text == "café"
    # E o que vem depois da letra acentuada continua depois dela.
    await rig.editor.set_text("café!")
    assert rig.events[-1] == ("adb", "!")


async def test_after_the_remote_the_first_adb_group_waits_for_it_to_arrive() -> None:
    rig = Rig(remote_settle=0.15)
    await rig.editor.set_text("é")
    rig.clock.sleeps.clear()
    await rig.editor.set_text("é!")
    assert rig.clock.sleeps == [pytest.approx(0.15)]
    assert rig.events == [("texto", "é"), ("adb", "!")]


async def test_the_settle_counts_from_the_remote_send_and_is_skipped_when_it_has_passed() -> None:
    rig = Rig(remote_settle=0.15)
    await rig.editor.set_text("é")
    rig.clock.advance(1.0)
    rig.clock.sleeps.clear()
    await rig.editor.set_text("é!")
    assert rig.clock.sleeps == []


async def test_the_adb_after_the_adb_never_waits() -> None:
    rig = Rig(remote_settle=0.15)
    await rig.editor.set_text("ab")
    await rig.editor.set_text("abc")
    assert rig.clock.sleeps == []


async def test_after_erasing_with_keys_the_adb_text_does_not_wait() -> None:
    rig = Rig(remote_settle=0.15)
    await rig.editor.set_text("abc")
    await rig.editor.set_text("ab")
    rig.clock.sleeps.clear()
    await rig.editor.set_text("abd")
    # Corrigir com backspace é o caso comum: nenhuma espera a mais antes do ADB.
    assert rig.clock.sleeps == []
    assert rig.events[-2:] == [("tecla", "DEL"), ("adb", "d")]


# --- falha no meio de um texto em vários grupos -------------------------------------------------


class FailsOnCall(FakeTvAdb):
    """Falha na N-ésima chamada de `input_text` (a partir de 1) e digita normalmente nas outras."""

    def __init__(self, fail_at: int, error: Exception) -> None:
        super().__init__()
        self.fail_at = fail_at
        self.error = error
        self.calls = 0

    async def input_text(self, text: str) -> None:
        self.calls += 1
        if self.calls == self.fail_at:
            raise self.error
        await super().input_text(text)


@pytest.mark.parametrize("error", [AdbCommandFailed("x"), AdbTimeout("x")])
async def test_a_failing_middle_group_keeps_the_confirmed_ones_and_the_retry_types_only_the_rest(
    error: Exception,
) -> None:
    rig = Rig(adb_group_chars=3, adb=FailsOnCall(2, error))
    with pytest.raises(TvSessionError):
        await rig.editor.set_text("abcdefgh")
    # O primeiro grupo foi confirmado; o do meio falhou e o último nem saiu.
    assert rig.adb.typed == ["abc"]
    assert rig.editor.last_text == "abc"
    assert rig.remote.texts == []
    # O app reenvia o texto completo: só o que falta é digitado, sem repetir "abc".
    await rig.editor.set_text("abcdefgh")
    assert rig.adb.typed == ["abc", "def", "gh"]
    assert rig.editor.last_text == "abcdefgh"


async def test_a_failing_last_group_is_retried_alone_and_nothing_is_duplicated() -> None:
    rig = Rig(adb_group_chars=3, adb=FailsOnCall(3, AdbCommandFailed("x")))
    with pytest.raises(TvSessionError):
        await rig.editor.set_text("abcdefgh")
    assert rig.editor.last_text == "abcdef"
    await rig.editor.set_text("abcdefgh")
    assert rig.adb.typed == ["abc", "def", "gh"]


async def test_the_adb_going_away_in_the_middle_sends_the_rest_by_the_remote_in_order() -> None:
    rig = Rig(adb_group_chars=3, adb=FailsOnCall(2, AdbUnauthorized("x")))
    await rig.editor.set_text("abcdefgh")
    assert rig.events == [("adb", "abc"), ("texto", "defgh")]
    assert rig.editor.last_text == "abcdefgh"


# --- digitar depressa: um comando por lote, nada perdido nem fora de ordem ----------------------


class GatedAdb(FakeTvAdb):
    """O primeiro `input_text` só termina quando o teste libera (o ADB lento da TV)."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()
        self.started = asyncio.Event()

    async def input_text(self, text: str) -> None:
        if not self.typed and not self.started.is_set():
            self.started.set()
            await self.gate.wait()
        await super().input_text(text)


async def test_typing_fast_during_a_slow_adb_call_is_one_call_for_the_whole_batch() -> None:
    adb = GatedAdb()
    rig = Rig(adb=adb)
    handler = tv_text_handler(rig.session, reconciler=rig.editor, monotonic=rig.clock.monotonic)

    first = asyncio.ensure_future(handler(Command("0", "tv.text.v1", {"text": "h"})))
    await adb.started.wait()
    # O app digita mais cinco letras enquanto o primeiro `input text` ainda roda na TV.
    rest = [
        asyncio.ensure_future(handler(Command(str(index), "tv.text.v1", {"text": text})))
        for index, text in enumerate(["he", "hel", "hell", "hello", "hello!"], start=1)
    ]
    await asyncio.sleep(0)
    adb.gate.set()
    results = await asyncio.gather(first, *rest)

    assert [result.status for result in results] == [ResultStatus.OK] * 6
    # Dois comandos no total: a primeira letra e o lote inteiro, na ordem.
    assert adb.typed == ["h", "ello!"]
    assert rig.editor.last_text == "hello!"


async def test_a_long_burst_never_reorders_or_drops_letters_across_batches() -> None:
    rig = Rig(adb_group_chars=4)
    text = "the quick brown fox"
    for end in range(1, len(text) + 1, 5):
        await rig.editor.set_text(text[:end])
    await rig.editor.set_text(text)
    assert "".join(rig.adb.typed) == text
    assert all(len(group) <= 4 for group in rig.adb.typed)
    assert rig.editor.last_text == text
