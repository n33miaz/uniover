"""Digitação por teclas do controle, ordem entre canais e o resumo de cada comando no log.

Nada aqui fala com uma TV: o controle e o ADB são dublês, e o relógio é o falso (`FakeClock`), que
só anda quando o teste manda. As durações do log são provadas fazendo o dublê "gastar" tempo.
"""

import asyncio
import logging
from collections.abc import Callable

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvAdb, FakeTvRemote
from uniover_agent.adapters.tv_remote_v2 import EDIT_KEY_CODES, KEY_CODES
from uniover_agent.core import (
    Command,
    ResultStatus,
    TextReconciler,
    TvSessionError,
    TvSessionManager,
    tv_text_handler,
)
from uniover_agent.core.tv.text_edit import FIELD_IDLE_SECONDS, TYPING_KEYS, typing_keys
from uniover_agent.ports import (
    AdbTimeout,
    AdbUnauthorized,
    TextFieldStatus,
    TvSendUncertain,
    TvUnreachable,
)

Events = list[tuple[str, str]]


class Rig:
    """Sessão com TV falsa e ADB falso, os dois gravando na mesma lista de eventos (a ordem)."""

    def __init__(self, *, keys: bool, adb: bool = False, key_pause: float = 0.0) -> None:
        self.events: Events = []
        self.clock = FakeClock()
        self.remote = FakeTvRemote(self.events)
        self.adb = FakeTvAdb(events=self.events)
        self.session = TvSessionManager(self.clock, self.remote)
        self.editor = TextReconciler(
            self.session,
            monotonic=self.clock.monotonic,
            keys=keys,
            key_pause_seconds=key_pause,
            sleep=self.clock.sleep,
        )
        if adb:
            self.editor.use_adb(self.adb)


def key_events(*names: str) -> Events:
    return [("tecla", name) for name in names]


# --- que caracteres têm tecla -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "keys"),
    [
        ("abc", ["TYPE_A", "TYPE_B", "TYPE_C"]),
        ("a1 b", ["TYPE_A", "NUM_1", "TYPE_SPACE", "TYPE_B"]),
        ("a.b,c-d/e", ["TYPE_A", "TYPE_PERIOD", "TYPE_B", "TYPE_COMMA", "TYPE_C"]),
    ],
)
def test_typing_keys_maps_each_character_to_one_key_in_order(text: str, keys: list[str]) -> None:
    mapped = typing_keys(text)
    assert mapped is not None
    assert len(mapped) == len(text)
    assert mapped[: len(keys)] == keys


@pytest.mark.parametrize(
    "text",
    [
        "",  # nada a digitar
        "Abc",  # maiúscula precisa de SHIFT
        "a_b",  # `_` precisa de SHIFT
        "a@b",  # símbolo que depende do mapa de teclas da TV
        "ação",  # acento
        "oi 😀",  # emoji
        "50%",  # símbolo
        "a\tb",  # controle
    ],
)
def test_one_character_without_a_safe_key_sends_the_whole_text_to_the_fallback(text: str) -> None:
    assert typing_keys(text) is None


def test_every_key_the_core_uses_exists_in_the_adapter_and_means_the_same_character() -> None:
    known = {**KEY_CODES, **EDIT_KEY_CODES}
    assert set(TYPING_KEYS.values()) <= set(known)
    # Duas letras nunca dividem a mesma tecla.
    assert len(set(TYPING_KEYS.values())) == len(TYPING_KEYS)
    for char, key in TYPING_KEYS.items():
        expected = {
            " ": "KEYCODE_SPACE",
            ".": "KEYCODE_PERIOD",
            ",": "KEYCODE_COMMA",
            "-": "KEYCODE_MINUS",
            "/": "KEYCODE_SLASH",
        }.get(char, f"KEYCODE_{char.upper()}")
        assert known[key] == expected, char


def test_digits_reuse_the_numeric_keys_of_the_contract() -> None:
    assert [TYPING_KEYS[str(digit)] for digit in range(10)] == [f"NUM_{d}" for d in range(10)]


# --- por teclas ---------------------------------------------------------------------------------


async def test_keys_can_be_disabled() -> None:
    rig = Rig(keys=False)
    assert rig.editor.keys_enabled is False
    await rig.editor.set_text("mat")
    assert rig.events == [("texto", "mat")]


async def test_a_mappable_addition_is_typed_key_by_key_in_order_and_last_text_follows() -> None:
    rig = Rig(keys=True, adb=True)
    await rig.editor.set_text("mat")
    assert rig.events == key_events("TYPE_M", "TYPE_A", "TYPE_T")
    assert rig.editor.last_text == "mat"
    # Só o acréscimo; e o ADB, que estava pronto, não é usado.
    await rig.editor.set_text("matrix")
    assert rig.events[3:] == key_events("TYPE_R", "TYPE_I", "TYPE_X")
    assert rig.adb.typed == []
    assert rig.remote.texts == []
    assert rig.editor.last_text == "matrix"


async def test_changing_the_middle_deletes_then_types_on_the_same_key_stream() -> None:
    rig = Rig(keys=True)
    await rig.editor.set_text("matrix")
    rig.events.clear()
    await rig.editor.set_text("matte")
    assert rig.events == key_events("DEL", "DEL", "DEL", "TYPE_T", "TYPE_E")
    assert rig.editor.last_text == "matte"


async def test_digits_and_punctuation_are_typed_by_keys() -> None:
    rig = Rig(keys=True)
    await rig.editor.set_text("tv 4.5-b")
    assert rig.events == key_events(
        "TYPE_T", "TYPE_V", "TYPE_SPACE", "NUM_4", "TYPE_PERIOD", "NUM_5", "TYPE_MINUS", "TYPE_B"
    )


async def test_deleting_down_to_empty_is_only_del_keys_and_no_typing() -> None:
    rig = Rig(keys=True)
    await rig.editor.set_text("abc")
    rig.events.clear()
    await rig.editor.set_text("")
    assert rig.events == key_events("DEL", "DEL", "DEL")
    assert rig.editor.last_text == ""
    await rig.editor.set_text("d")
    assert rig.events[3:] == key_events("TYPE_D")


async def test_a_pause_goes_between_keys_and_never_before_the_first() -> None:
    rig = Rig(keys=True, key_pause=0.05)
    await rig.editor.set_text("abc")
    assert rig.clock.sleeps == [0.05, 0.05]


async def test_without_a_pause_no_sleep_happens_at_all() -> None:
    rig = Rig(keys=True)
    await rig.editor.set_text("abc")
    assert rig.clock.sleeps == []


# --- mistura com o canal de sempre --------------------------------------------------------------


async def test_a_text_with_one_unmapped_character_goes_whole_by_the_adb_never_split() -> None:
    rig = Rig(keys=True, adb=True)
    await rig.editor.set_text("Mat")
    assert rig.events == [("adb", "Mat")]
    assert rig.editor.last_text == "Mat"


async def test_a_text_with_an_accent_goes_whole_by_the_remote_text_never_split() -> None:
    rig = Rig(keys=True, adb=True)
    await rig.editor.set_text("ola ação")
    assert rig.events == [("texto", "ola ação")]


async def test_without_the_adb_an_unmapped_text_goes_by_the_remote_text() -> None:
    rig = Rig(keys=True)
    await rig.editor.set_text("Mat")
    assert rig.events == [("texto", "Mat")]


async def test_order_is_kept_across_messages_that_alternate_between_all_three_paths() -> None:
    rig = Rig(keys=True, adb=True)
    for text in ["ab", "abC", "abCd", "abCd ç", "abCd çe"]:
        await rig.editor.set_text(text)
    assert rig.events == [
        ("tecla", "TYPE_A"),
        ("tecla", "TYPE_B"),
        ("adb", "C"),
        ("tecla", "TYPE_D"),
        ("texto", " ç"),
        ("tecla", "TYPE_E"),
    ]
    assert rig.editor.last_text == "abCd çe"


# --- falha no meio ------------------------------------------------------------------------------


class DropsAfter(FakeTvRemote):
    """O canal cai depois de `limit` teclas (e continua caído na tentativa de reabrir)."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self.limit = limit

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if len(self.keys) >= self.limit:
            raise TvUnreachable("caiu")
        await super().send_key(key, direction)


async def test_last_text_stops_at_the_last_key_that_went_when_the_channel_drops_mid_word() -> None:
    clock = FakeClock()
    remote = DropsAfter(2)
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True)
    with pytest.raises(TvSessionError):
        await editor.set_text("abcd")
    # "a" e "b" foram; o campo tem "ab" e é isso que o agente guarda.
    assert editor.last_text == "ab"
    assert remote.keys == ["TYPE_A", "TYPE_B"]
    # A volta digita só o que faltava: nada duplicado.
    remote.limit = 99
    await editor.set_text("abcd")
    assert remote.keys == ["TYPE_A", "TYPE_B", "TYPE_C", "TYPE_D"]
    assert editor.last_text == "abcd"


class ForgetsTheKey(FakeTvRemote):
    """Adaptador de tabelas fora de sincronia: não conhece a tecla e cita o caractere no erro."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if key.startswith("TYPE_"):
            raise ValueError(f"tecla desconhecida: {key}")
        await super().send_key(key, direction)


async def test_unknown_key_falls_back_to_adb() -> None:
    clock = FakeClock()
    adb = FakeTvAdb()
    editor = TextReconciler(
        TvSessionManager(clock, ForgetsTheKey()), monotonic=clock.monotonic, keys=True
    )
    editor.use_adb(adb)
    await editor.set_text("x")
    assert adb.typed == ["x"]
    assert editor.last_text == "x"


async def test_remote_failure_before_any_key_falls_back_to_adb_for_the_whole_text() -> None:
    clock = FakeClock()
    remote = DropsAfter(0)
    adb = FakeTvAdb()
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True, sleep=clock.sleep)
    editor.use_adb(adb)
    await editor.set_text("abcd")
    assert remote.keys == []
    assert adb.typed == ["abcd"]
    assert editor.last_text == "abcd"


class FieldRemote(FakeTvRemote):
    """O campo da TV de verdade: `DEL` apaga, letra insere; perde as teclas de `lose` (pacote que
    ficou no socket quando ele caiu) e o socket cai na tecla `fail_on` enquanto ela estiver
    marcada. Com `editor`, ecoa o campo a cada tecla aplicada (como a TV faz)."""

    def __init__(self, *, lose: set[str], fail_on: str | None) -> None:
        super().__init__()
        self.field = ""
        self.lose = set(lose)
        self.fail_on = fail_on
        self.editor: TextReconciler | None = None

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if key == self.fail_on:
            raise TvUnreachable("caiu")
        await super().send_key(key, direction)
        if key in self.lose:
            self.lose.discard(key)
            return
        if key == "DEL":
            self.field = self.field[:-1]
        elif key.startswith("TYPE_"):
            self.field += key.removeprefix("TYPE_").lower()
        if self.editor is not None:
            self.editor.observe_field(TextFieldStatus(self.field, 0, 0, "", counter=1))


class FieldAdb(FakeTvAdb):
    def __init__(self, remote: FieldRemote) -> None:
        super().__init__()
        self.remote = remote

    async def input_text(self, text: str, *, before_send: Callable[[], None] | None = None) -> None:
        if before_send is not None:
            before_send()
        await super().input_text(text)
        self.remote.field += text


def field_rig(remote: FieldRemote) -> tuple[TextReconciler, FieldAdb]:
    clock = FakeClock()
    adb = FieldAdb(remote)
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True, sleep=clock.sleep)
    editor.use_adb(adb)
    return editor, adb


@pytest.mark.parametrize("change_app", [False, True])
async def test_edit_preserves_the_new_field_when_focus_changes_during_wake(
    change_app: bool,
) -> None:
    remote = FieldRemote(lose=set(), fail_on=None)
    clock = FakeClock()
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True, sleep=clock.sleep)
    adb = FieldAdb(remote)
    editor.use_adb(adb)
    session.on_session_opening(editor.forget_session)
    remote.on_app(editor.observe_app)
    remote.on_text_field(editor.observe_field)
    remote.push_app("app.um")
    remote.field = "matrix"
    remote.push_text_field(TextFieldStatus(remote.field, 6, 6, "", counter=1))

    def switch_field() -> None:
        if change_app:
            remote.push_app("app.dois")
        remote.field = "dono"
        counter = 1 if change_app else 2
        remote.push_text_field(TextFieldStatus(remote.field, 4, 4, "", counter=counter))

    remote.on_connect = switch_field
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("mate")
    assert caught.value.code == "text_resync_abandoned"
    assert remote.field == editor.last_text == "dono"
    assert remote.keys == remote.texts == adb.typed == []

    await editor.set_text("dono!")
    assert remote.field == "dono!"
    assert adb.typed == ["!"]


class FocusMovesThenDropsRemote(FieldRemote):
    """No segundo `DEL` o foco vai para o campo do dono, o relato do campo novo chega e o socket
    cai antes de aplicar a tecla: a sessão reabre e a TV não repete o relato do campo."""

    def __init__(self) -> None:
        super().__init__(lose=set(), fail_on=None)
        self.dels = 0

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if key == "DEL":
            self.dels += 1
            if self.dels == 2:
                self.field = "dono"
                self.push_text_field(TextFieldStatus(self.field, 4, 4, "", counter=2))
                self._connected = False
                raise TvUnreachable("caiu")
        await super().send_key(key, direction)


async def test_a_new_field_report_dropped_by_a_reconnect_still_stops_the_old_plan() -> None:
    remote = FocusMovesThenDropsRemote()
    clock = FakeClock()
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True, sleep=clock.sleep)
    editor.use_adb(FieldAdb(remote))
    session.on_session_opening(editor.forget_session)
    remote.on_app(editor.observe_app)
    remote.on_text_field(editor.observe_field)
    await session.wake()
    remote.push_app("app.um")
    remote.field = "matrix"
    remote.push_text_field(TextFieldStatus(remote.field, 6, 6, "", counter=1))
    connects = remote.connects

    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("mat")
    assert caught.value.code == "text_resync_abandoned"
    assert remote.connects == connects + 1  # a sessão reabriu no meio da edição
    assert remote.field == "dono"  # o plano do campo antigo não chegou ao campo novo
    assert remote.keys == ["DEL"]

    # Sem relato fresco do campo novo, o comando seguinte não apaga nada do dono: na dúvida, sobra.
    await editor.set_text("mat")
    assert remote.field == "donomat"
    assert remote.keys == ["DEL", "TYPE_M", "TYPE_A", "TYPE_T"]  # nenhum `DEL` no campo do dono


class SameFieldDropRemote(FieldRemote):
    """A cada abertura a TV repete o relato do mesmo campo; o socket cai uma vez no segundo `DEL`,
    antes de aplicá-lo, sem nenhuma troca de foco."""

    def __init__(self) -> None:
        super().__init__(lose=set(), fail_on=None)
        self.dels = 0
        self.on_connect = lambda: self.push_text_field(
            TextFieldStatus(self.field, len(self.field), len(self.field), "", counter=1)
        )

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if key == "DEL":
            self.dels += 1
            if self.dels == 2:
                self._connected = False
                raise TvUnreachable("caiu")
        await super().send_key(key, direction)


async def test_a_reconnect_that_reports_the_same_field_lets_the_edit_finish() -> None:
    remote = SameFieldDropRemote()
    clock = FakeClock()
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True, sleep=clock.sleep)
    editor.use_adb(FieldAdb(remote))
    session.on_session_opening(editor.forget_session)
    remote.on_app(editor.observe_app)
    remote.on_text_field(editor.observe_field)
    remote.push_app("app.um")
    remote.field = "matrix"
    remote.push_text_field(TextFieldStatus(remote.field, 6, 6, "", counter=1))

    # A abertura da própria edição e a reabertura no meio dela repetem o campo do plano.
    await editor.set_text("mat")
    assert remote.connects == 2
    assert remote.field == editor.last_text == "mat"
    assert remote.keys == ["DEL", "DEL", "DEL"]


async def test_a_lost_key_before_the_drop_is_never_completed_by_adb_as_if_it_went() -> None:
    # "b" ficou no socket que caiu e "c" é a primeira tecla a falhar: a TV tem só "a".
    remote = FieldRemote(lose={"TYPE_B"}, fail_on="TYPE_C")
    editor, adb = field_rig(remote)
    editor.observe_field(TextFieldStatus("", 0, 0, "", counter=1))
    with pytest.raises(TvSessionError):
        await editor.set_text("abcd")
    # Nada de "cd" pelo ADB (a TV ficaria com "acd" e o agente acharia "abcd").
    assert adb.typed == []
    assert remote.field == "a"
    assert editor.last_text == ""

    # Com o socket de volta, o próximo texto (o app manda sempre o campo inteiro) refaz o campo.
    remote.fail_on = None
    await editor.set_text("abcd")
    assert remote.field == "abcd"
    assert editor.last_text == "abcd"


@pytest.mark.parametrize("delete_applied", [False, True])
async def test_socket_drop_after_delete_recovers_on_the_next_edit(delete_applied: bool) -> None:
    remote = FieldRemote(lose=set() if delete_applied else {"DEL"}, fail_on=None)
    editor, adb = field_rig(remote)
    editor.observe_field(TextFieldStatus("", 0, 0, "", counter=1))
    await editor.set_text("abc")
    remote.fail_on = "TYPE_D"

    with pytest.raises(TvSessionError):
        await editor.set_text("abd")

    assert adb.typed == []
    assert editor.last_text == "abc"
    assert remote.field == ("ab" if delete_applied else "abc")

    editor.forget_field()
    if delete_applied:
        editor.observe_field(TextFieldStatus("ab", 0, 0, "", counter=1))
    remote.fail_on = None
    remote.keys.clear()
    await editor.set_text("abd")

    assert remote.field == editor.last_text == "abd"
    assert remote.keys.count("DEL") == (0 if delete_applied else 3)


async def test_a_drop_while_retyping_keeps_the_unconfirmed_resync_deletes_in_doubt() -> None:
    remote = FieldRemote(lose={"DEL"}, fail_on=None)
    editor, _ = field_rig(remote)
    editor.observe_field(TextFieldStatus("", 0, 0, "", counter=1))
    await editor.set_text("abc")
    remote.fail_on = "TYPE_D"
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    assert remote.field == "abc"

    # O refazer apaga três, mas um `DEL` fica no socket e a primeira letra cai: a TV tem "a".
    remote.lose = {"DEL"}
    remote.fail_on = "TYPE_A"
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    assert remote.field == "a"

    # Sem eco, o próximo texto refaz de novo em vez de acrescentar ao "a" que sobrou.
    remote.fail_on = None
    await editor.set_text("abd")
    assert remote.field == editor.last_text == "abd"


class EraseDropRemote(FieldRemote):
    """Conta os `DEL` (1, 2...): os de `lost_deletes` voltam sem chegar (ficaram no socket) e, do
    `drop_at`-ésimo em diante, o socket cai, inclusive na repetição da sessão. Com `drop_once` só
    o primeiro envio cai: a sessão reabre e repete sem erro. Com `applied_on_drop`, o primeiro
    `DEL` que cai chega antes da queda (`TvSendUncertain`); a repetição da sessão não chega."""

    def __init__(self) -> None:
        super().__init__(lose=set(), fail_on=None)
        self.deletes = 0
        self.lost_deletes: set[int] = set()
        self.drop_at: int | None = None
        self.drop_once = False
        self.applied_on_drop = False

    def reset_deletes(self, *, lost: set[int], drop_at: int | None) -> None:
        self.deletes, self.lost_deletes, self.drop_at = 0, lost, drop_at
        self.keys.clear()

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if key == "DEL":
            self.deletes += 1
            if self.drop_at is not None and self.deletes >= self.drop_at:
                if self.drop_once:
                    self.drop_at = None
                if self.applied_on_drop:
                    self.applied_on_drop = False
                    self.field = self.field[:-1]
                    raise TvSendUncertain("caiu no envio")
                raise TvUnreachable("caiu")
            if self.deletes in self.lost_deletes:
                self.lose.add("DEL")
        await super().send_key(key, direction)


async def erase_doubt_of_three(
    remote: EraseDropRemote, *, owned: bool, adb: bool = True
) -> tuple[TextReconciler, TvSessionManager]:
    """Campo com "abc": a edição deixa três `DEL` seguros ou a posse para usar o teto."""
    clock = FakeClock()
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True, sleep=clock.sleep)
    if adb:
        editor.use_adb(FieldAdb(remote))
    if owned:
        editor.observe_field(TextFieldStatus("", 0, 0, "", counter=1))
    await editor.set_text("abc")
    remote.lose, remote.fail_on = ({"DEL"}, "TYPE_D") if owned else (set(), "DEL")
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    remote.lose, remote.fail_on = set(), None
    return editor, session


async def test_a_resync_cut_after_a_delete_the_socket_accepted_restarts_the_whole_erase() -> None:
    remote = EraseDropRemote()
    editor, _ = await erase_doubt_of_three(remote, owned=True)
    assert remote.field == "abc"

    # Dos dois primeiros `DEL` só um chega (o primeiro ficou no socket) e o terceiro cai.
    remote.reset_deletes(lost={1}, drop_at=3)
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    assert remote.field == "ab"

    # Sem relato, o saldo descontado (um `DEL`) deixaria o "a" sob o texto refeito.
    remote.reset_deletes(lost=set(), drop_at=None)
    await editor.set_text("abd")
    assert remote.keys.count("DEL") == len("abc")
    assert remote.field == editor.last_text == "abd"


async def test_a_fresh_report_after_the_cut_sets_how_much_is_left_to_erase() -> None:
    remote = EraseDropRemote()
    editor, session = await erase_doubt_of_three(remote, owned=True)
    editor.observe_field(TextFieldStatus("abc", 3, 3, "", counter=1, ime_counter=10))
    remote.reset_deletes(lost={1}, drop_at=3)
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")

    # Reconectou e a TV informa o mesmo campo: "ab" é o que de fato sobrou.
    editor.forget_field()
    await session.wake()
    editor.observe_field(TextFieldStatus("ab", 2, 2, "", counter=1, ime_counter=11))
    remote.reset_deletes(lost=set(), drop_at=None)
    await editor.set_text("abd")
    assert remote.keys.count("DEL") == len("ab")
    assert remote.field == editor.last_text == "abd"


async def test_a_reconnect_inside_a_resync_delete_leaves_the_erase_for_the_next_command() -> None:
    remote = EraseDropRemote()
    editor, session = await erase_doubt_of_three(remote, owned=True)
    # Como na composição: a sessão nova esquece o campo (só agora, para a dúvida nascer com posse).
    session.on_session_opened(lambda _elapsed: editor.forget_field())

    # O primeiro DEL fica no socket antigo e a reabertura impede o reenvio do segundo.
    remote.reset_deletes(lost={1}, drop_at=2)
    remote.drop_once = True
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abd")
    assert caught.value.code == "text_resync_abandoned"
    assert remote.deletes == 2
    assert remote.field == "abc"

    remote.reset_deletes(lost=set(), drop_at=None)
    await editor.set_text("abd")
    assert remote.field == editor.last_text == "abd"


class RepeatedUncertainDeleteRemote(EraseDropRemote):
    """Toda tentativa de DEL a partir do segundo chega antes de o canal cair."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if key == "DEL" and self.drop_at is not None and self.deletes + 1 >= self.drop_at:
            self.applied_on_drop = True
        await super().send_key(key, direction)


async def test_resync_never_retries_an_uncertain_delete_in_an_unowned_field() -> None:
    remote = RepeatedUncertainDeleteRemote()
    remote.field = "hi"
    editor, _ = await erase_doubt_of_three(remote, owned=False)
    assert remote.field == "hiabc"

    remote.reset_deletes(lost=set(), drop_at=2)
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abd")
    assert caught.value.may_have_sent
    attempts = remote.deletes

    remote.reset_deletes(lost=set(), drop_at=None)
    await editor.set_text("abd")
    assert remote.field == "hiabd"
    assert attempts == 2


@pytest.mark.parametrize("change_app", [True, False])
async def test_resync_abandons_if_app_or_link_changes_during_wake(change_app: bool) -> None:
    remote = EraseDropRemote()
    editor, session = await erase_doubt_of_three(remote, owned=True)
    editor.observe_app("app.um")
    await remote.disconnect()
    if change_app:
        remote.on_connect = lambda: editor.observe_app("app.dois")
    else:
        session.on_session_opened(lambda _: editor.forget_field())
    remote.field = "usuario"
    remote.reset_deletes(lost=set(), drop_at=None)
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abd")
    assert caught.value.code == "text_resync_abandoned"
    assert remote.field == "usuario"
    assert remote.keys == []


@pytest.mark.parametrize("change_app", [True, False])
async def test_resync_does_not_retry_a_delete_after_focus_changes_on_reopen(
    change_app: bool,
) -> None:
    remote = EraseDropRemote()
    editor, session = await erase_doubt_of_three(remote, owned=True)
    editor.observe_app("app.um")
    session.on_session_opening(editor.forget_field)

    def switch_field() -> None:
        if change_app:
            editor.observe_app("app.dois")
        remote.field = "usuario"
        editor.observe_field(TextFieldStatus("usuario", 7, 7, "", counter=2))

    remote.on_connect = switch_field
    remote.reset_deletes(lost=set(), drop_at=1)
    remote.drop_once = True
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abd")
    assert caught.value.code == "text_resync_abandoned"
    assert remote.field == "usuario"
    assert remote.keys == []
    assert editor.last_text == "usuario"


@pytest.mark.parametrize("owned", [True, False])
async def test_a_resync_abandoned_by_a_dropped_field_report_forgets_the_old_doubt(
    owned: bool,
) -> None:
    remote = EraseDropRemote()
    editor, _ = await erase_doubt_of_three(remote, owned=owned)
    editor.observe_app("app.um")

    # A queda no meio dos DEL deixa um plano de limpeza do campo antigo.
    remote.reset_deletes(lost={1}, drop_at=2)
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    await remote.disconnect()

    def switch_field() -> None:
        # A reabertura invalida o relato pendente do campo novo para a próxima edição.
        remote.field = "ab"
        editor.observe_field(TextFieldStatus("ab", 2, 2, "", counter=2))
        editor.forget_field()

    remote.on_connect = switch_field
    remote.reset_deletes(lost=set(), drop_at=None)
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abd")
    assert caught.value.code == "text_resync_abandoned"
    assert remote.field == "ab"
    assert remote.keys == []

    # O texto novo continua o esperado da dúvida antiga, mas ela era do outro campo: nada se apaga.
    remote.on_connect = None
    await editor.set_text("abd")
    assert "DEL" not in remote.keys
    assert remote.field == "ababd"
    assert editor.last_text == "abd"


@pytest.mark.parametrize("ime_counter", [None, 9, 10])
async def test_resync_ignores_a_delayed_report_without_a_new_ime_counter(
    ime_counter: int | None,
) -> None:
    remote = EraseDropRemote()
    editor, _ = await erase_doubt_of_three(remote, owned=True)
    editor.observe_field(TextFieldStatus("abc", 3, 3, "", counter=1, ime_counter=10))
    remote.reset_deletes(lost={1}, drop_at=3)
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    assert remote.field == "ab"

    editor.observe_field(TextFieldStatus("a", 1, 1, "", counter=1, ime_counter=ime_counter))
    remote.reset_deletes(lost=set(), drop_at=None)
    await editor.set_text("abd")
    assert remote.field == "abd"
    assert remote.keys.count("DEL") == 3


class AppSwitchRemote(EraseDropRemote):
    """No `DEL` de número `switch_at`, a TV avisa que outro app tomou o foco."""

    def __init__(self) -> None:
        super().__init__()
        self.switch_at: int | None = None
        self.target: TextReconciler | None = None

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        await super().send_key(key, direction)
        if key == "DEL" and self.deletes == self.switch_at and self.target is not None:
            self.target.observe_app("app.dois")


async def test_an_app_switch_inside_the_resync_erase_stops_before_touching_the_new_field() -> None:
    remote = AppSwitchRemote()
    editor, _ = await erase_doubt_of_three(remote, owned=True)
    editor.observe_app("app.um")
    remote.target = editor
    remote.reset_deletes(lost=set(), drop_at=None)
    remote.switch_at = 2

    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abd")
    assert caught.value.code == "text_resync_abandoned"
    assert remote.keys == ["DEL", "DEL"]


@pytest.mark.parametrize("applied_on_drop", [False, True])
async def test_a_cut_resync_never_erases_the_user_text_left_of_an_unowned_field(
    applied_on_drop: bool,
) -> None:
    remote = EraseDropRemote()
    remote.field = "hi"  # do dono, antes do agente; a TV nunca informou o campo
    editor, _ = await erase_doubt_of_three(remote, owned=False)
    assert remote.field == "hiabc"

    if applied_on_drop:
        # Os dois primeiros chegam e o terceiro cai depois de chegar: só "hi" sobrou.
        remote.reset_deletes(lost=set(), drop_at=3)
        remote.applied_on_drop = True
    else:
        remote.reset_deletes(lost={1}, drop_at=3)
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")

    remote.reset_deletes(lost=set(), drop_at=None)
    await editor.set_text("abd")
    # Pode sobrar texto do agente, mas nunca se apaga além do que ele pode ter escrito.
    assert remote.field.startswith("hi")
    assert remote.field.endswith("abd")
    assert editor.last_text == "abd"


async def test_initial_delete_reduces_the_safe_erase_after_a_second_failure() -> None:
    remote = EraseDropRemote()
    remote.field = "hi"
    clock = FakeClock()
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True)
    await editor.set_text("abc")
    remote.fail_on = "TYPE_D"
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    assert remote.field == "hiab"

    # O terceiro DEL falharia antes de sair. Só dois são seguros e necessários.
    remote.reset_deletes(lost=set(), drop_at=3)
    remote.fail_on = "TYPE_A"
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    assert remote.field == "hi"

    remote.reset_deletes(lost=set(), drop_at=None)
    remote.fail_on = None
    await editor.set_text("abd")
    assert remote.field == "hiabd"
    assert "DEL" not in remote.keys


async def test_an_ordinary_edit_does_not_retry_an_uncertain_delete() -> None:
    remote = RepeatedUncertainDeleteRemote()
    remote.field = "hi"
    clock = FakeClock()
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True)
    await editor.set_text("abc")

    remote.reset_deletes(lost=set(), drop_at=1)
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abd")
    assert caught.value.may_have_sent
    assert remote.deletes == 1
    assert remote.field == "hiab"

    remote.reset_deletes(lost=set(), drop_at=None)
    await editor.set_text("abd")
    assert remote.field == "hiabd"


@pytest.mark.parametrize("switch_app", [False, True])
async def test_retype_interruption_preserves_user_text(switch_app: bool) -> None:
    remote = EraseDropRemote()
    remote.field = "" if switch_app else "hi"
    clock = FakeClock()
    session = TvSessionManager(clock, remote, backoff=())
    interrupt = False

    async def pause(_seconds: float) -> None:
        if interrupt:
            if switch_app:
                editor.observe_app("app.dois")
                editor.observe_app("app.um")
                remote.field = "usuario"
            else:
                raise asyncio.CancelledError

    editor = TextReconciler(
        session, monotonic=clock.monotonic, keys=True, key_pause_seconds=0.1, sleep=pause
    )
    editor.observe_app("app.um")
    if switch_app:
        editor.observe_field(TextFieldStatus("", 0, 0, "", counter=1))
    await editor.set_text("abc")
    remote.reset_deletes(lost=set(), drop_at=1)
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    remote.reset_deletes(lost=set(), drop_at=None)

    interrupt = True
    with pytest.raises(TvSessionError if switch_app else asyncio.CancelledError):
        await editor.set_text("abd")
    assert remote.field == ("usuario" if switch_app else "hia")

    interrupt = False
    remote.keys.clear()
    await editor.set_text("abd")
    assert "DEL" not in remote.keys
    assert remote.field == ("usuarioabd" if switch_app else "hiaabd")


async def test_a_link_change_after_an_erase_stopped_at_the_cap_restarts_an_owned_erase() -> None:
    remote = EraseDropRemote()
    clock = FakeClock()
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True, sleep=clock.sleep)
    editor.use_adb(FieldAdb(remote))
    remote.field = "x" * 199
    editor.observe_field(TextFieldStatus(remote.field, 199, 199, "", counter=1))
    await editor.set_text("x" * 199 + "abc")
    target = "x" * 199 + "abd"
    remote.lose, remote.fail_on = {"DEL"}, "TYPE_D"
    with pytest.raises(TvSessionError):
        await editor.set_text(target)
    remote.lose, remote.fail_on = set(), None
    assert remote.field == "x" * 199 + "abc"

    # A limpeza para no teto de 200 e os 200 `DEL` ficam no socket que depois cai.
    remote.reset_deletes(lost=set(range(1, 201)), drop_at=None)
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text(target)
    assert caught.value.code == "text_resync_incomplete"
    editor.forget_field()
    assert remote.field == "x" * 199 + "abc"

    # Com a posse, a conexão nova recomeça a limpeza inteira: o saldo de 2 deixaria o antigo.
    remote.reset_deletes(lost=set(), drop_at=None)
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text(target)
    assert caught.value.code == "text_resync_incomplete"
    await editor.set_text(target)
    assert remote.deletes == len("x" * 199 + "abc")
    assert remote.field == editor.last_text == target


class LetterDropRemote(EraseDropRemote):
    """A tecla `drop_letter` derruba o socket uma vez; a sessão reabre e tenta de novo."""

    def __init__(self) -> None:
        super().__init__()
        self.drop_letter: str | None = None

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if key == self.drop_letter:
            self.drop_letter = None
            raise TvUnreachable("caiu")
        await super().send_key(key, direction)


@pytest.mark.parametrize("adb", [True, False])
async def test_a_reconnect_before_the_first_retyped_key_keeps_the_erase_in_doubt(
    adb: bool,
) -> None:
    remote = LetterDropRemote()
    editor, session = await erase_doubt_of_three(remote, owned=True, adb=adb)
    session.on_session_opened(lambda _elapsed: editor.forget_field())

    # Os três `DEL` ficaram no socket que caiu na primeira letra: o campo ainda tem "abc".
    remote.reset_deletes(lost={1, 2, 3}, drop_at=None)
    remote.drop_letter = "TYPE_A"
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abd")
    assert caught.value.code == "text_resync_abandoned"
    assert remote.field == "abc"

    remote.reset_deletes(lost=set(), drop_at=None)
    await editor.set_text("abd")
    assert remote.field == editor.last_text == "abd"


async def test_a_reconnect_inside_the_retype_of_an_unowned_field_never_erases_the_user_text() -> (
    None
):
    remote = LetterDropRemote()
    remote.field = "hi"  # do dono, antes do agente; a TV nunca informou o campo
    editor, session = await erase_doubt_of_three(remote, owned=False, adb=False)
    session.on_session_opened(lambda _elapsed: editor.forget_field())
    assert remote.field == "hiabc"

    # A limpeza chega; "a" e "b" saem pelo socket e se perdem com a queda no "d".
    remote.reset_deletes(lost=set(), drop_at=None)
    remote.lose = {"TYPE_A", "TYPE_B"}
    remote.drop_letter = "TYPE_D"
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abd")
    assert caught.value.code == "text_resync_abandoned"
    assert remote.field == "hi"

    remote.reset_deletes(lost=set(), drop_at=None)
    remote.lose = set()
    await editor.set_text("abd")
    assert remote.field == "hiabd"
    assert editor.last_text == "abd"


async def test_a_failed_retype_on_the_same_connection_preserves_the_user_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote = EraseDropRemote()
    remote.field = "hi"
    editor, session = await erase_doubt_of_three(remote, owned=False, adb=False)
    assert remote.field == "hiabc"

    reopened: list[float] = []
    session.on_session_opened(reopened.append)
    remote.reset_deletes(lost=set(), drop_at=None)
    send_key = remote.send_key

    async def reject_first_letter(key: str, direction: str = "SHORT") -> None:
        if key == "TYPE_A":
            raise ValueError("tecla desconhecida")
        await send_key(key, direction)

    # Todos os DEL chegam e a TV recusa a primeira letra sem derrubar a conexão.
    with monkeypatch.context() as patch:
        patch.setattr(remote, "send_key", reject_first_letter)
        with pytest.raises(TvSessionError) as caught:
            await editor.set_text("abd")
    assert caught.value.code == "text_key_unsupported"
    assert remote.keys == ["DEL", "DEL", "DEL"]
    assert remote.field == "hi"

    remote.keys.clear()
    await editor.set_text("abd")
    assert reopened == []
    assert remote.field == "hiabd"
    assert "DEL" not in remote.keys
    assert editor.last_text == "abd"


async def test_a_failed_retype_after_a_resumed_erase_never_counts_its_deletes_twice() -> None:
    remote = EraseDropRemote()
    remote.field = "hi"  # do dono, antes do agente; a TV nunca informou o campo
    editor, _ = await erase_doubt_of_three(remote, owned=False)
    assert remote.field == "hiabc"
    # O primeiro chega e o segundo cai depois de chegar: o piso já conta os dois.
    remote.reset_deletes(lost=set(), drop_at=2)
    remote.applied_on_drop = True
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    assert remote.field == "hia"

    # A retomada apaga o "a" que faltava e a primeira letra da redigitação cai.
    remote.reset_deletes(lost=set(), drop_at=None)
    remote.fail_on = "TYPE_A"
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")
    assert remote.field == "hi"

    remote.fail_on = None
    await editor.set_text("abd")
    assert remote.field == "hiabd"
    assert editor.last_text == "abd"


class StaleEchoRemote(FieldRemote):
    """Entrega, na tecla `trigger`, um eco atrasado com `stale` (como a TV faz com ecos velhos)."""

    def __init__(self) -> None:
        super().__init__(lose=set(), fail_on=None)
        self.stale: str | None = None
        self.trigger = "DEL"
        self.target: TextReconciler | None = None

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        await super().send_key(key, direction)
        if key == self.trigger and self.stale is not None and self.target is not None:
            self.target.observe_field(TextFieldStatus(self.stale, 0, 0, "", counter=1))
            self.stale = None


@pytest.mark.parametrize("trigger", ["DEL", "TYPE_H"])
async def test_an_old_echo_never_proves_the_keys_of_a_resync(trigger: str) -> None:
    remote = StaleEchoRemote()
    editor, adb = field_rig(remote)
    remote.target = editor
    editor.observe_field(TextFieldStatus("", 0, 0, "", counter=1))
    await editor.set_text("hel")
    remote.lose, remote.fail_on = {"DEL"}, "TYPE_X"
    with pytest.raises(TvSessionError):
        await editor.set_text("hex")
    assert remote.field == "hel"

    # No refazer chega um eco velho igual ao prefixo; o "e" fica no socket e o "l" cai.
    remote.stale, remote.trigger = "he", trigger
    remote.lose, remote.fail_on = {"TYPE_E"}, "TYPE_L"
    with pytest.raises(TvSessionError):
        await editor.set_text("hello")
    assert adb.typed == []  # o ADB não completa por cima do "h" sem prova

    remote.fail_on = None
    await editor.set_text("hello")
    assert remote.field == editor.last_text == "hello"


async def test_a_doubt_is_dropped_when_another_field_reports_after_a_reconnect() -> None:
    remote = FieldRemote(lose={"DEL"}, fail_on=None)
    editor, _ = field_rig(remote)
    editor.observe_field(TextFieldStatus("", 0, 0, "", counter=1))
    await editor.set_text("abc")
    remote.fail_on = "TYPE_D"
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")

    # Reconectou e o foco está em outro campo do mesmo app, com texto que o agente não digitou.
    editor.forget_field()
    remote.field = "xyz"
    editor.observe_field(TextFieldStatus("xyz", 0, 0, "", counter=2))
    remote.fail_on = None
    remote.keys.clear()
    await editor.set_text("xyzw")

    assert "DEL" not in remote.keys
    assert remote.field == editor.last_text == "xyzw"


async def test_without_field_reports_a_doubt_ends_with_the_field_idle_pause() -> None:
    clock = FakeClock()
    remote = FieldRemote(lose={"DEL"}, fail_on=None)
    session = TvSessionManager(clock, remote, backoff=())
    editor = TextReconciler(session, monotonic=clock.monotonic, keys=True, sleep=clock.sleep)
    editor.use_adb(FieldAdb(remote))
    await editor.set_text("abc")
    remote.fail_on = "TYPE_D"
    with pytest.raises(TvSessionError):
        await editor.set_text("abd")

    # Muito depois, um texto sem relação: é outro campo, e nada se apaga nele.
    clock.advance(FIELD_IDLE_SECONDS + 1)
    remote.field = ""
    remote.fail_on = None
    remote.keys.clear()
    await editor.set_text("qq")

    assert "DEL" not in remote.keys
    assert remote.field == editor.last_text == "qq"


# Como o `send_text` falha: antes de enviar (nada saiu), já dentro do envio sem o trecho chegar,
# ou já dentro do envio com o trecho no campo (só a confirmação se perdeu).
BEFORE_SEND = "antes"
LOST_IN_SEND = "perdido"
DELIVERED_IN_SEND = "entregue"


class TextDropRemote(FieldRemote):
    """O `send_text` falha do jeito de `fail_text` (`None`: funciona e o texto entra no campo).

    O trecho entregue entra uma vez só, mesmo com a nova tentativa da sessão, que cai de novo. Com
    `drop_deletes`, todo `DEL` fica no socket que caiu. Com `editor`, a TV ecoa o campo."""

    def __init__(self) -> None:
        super().__init__(lose=set(), fail_on=None)
        self.fail_text: str | None = None
        self.drop_deletes = False

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if self.drop_deletes and key == "DEL":
            self.lose.add(key)
        await super().send_key(key, direction)

    async def send_text(self, text: str) -> None:
        await super().send_text(text)
        failure = self.fail_text
        if failure == BEFORE_SEND:
            raise TvUnreachable("a conexão não está aberta")
        if failure in {None, DELIVERED_IN_SEND}:
            self.field += text
            if self.editor is not None:
                self.editor.observe_field(TextFieldStatus(self.field, 0, 0, "", counter=1))
        if failure is not None:
            if failure == DELIVERED_IN_SEND:
                self.fail_text = LOST_IN_SEND  # a nova tentativa da sessão não entrega de novo
            raise TvSendUncertain("caiu no envio")


async def typed_abc(remote: TextDropRemote, *, field_reported: bool = True) -> TextReconciler:
    editor, _ = field_rig(remote)
    if field_reported:
        editor.observe_field(TextFieldStatus(remote.field, 0, 0, "", counter=1))
    await editor.set_text("abc")
    return editor


@pytest.mark.parametrize("failure", [BEFORE_SEND, LOST_IN_SEND, DELIVERED_IN_SEND])
@pytest.mark.parametrize("delete_applied", [False, True])
async def test_a_failed_remote_text_counts_in_how_much_the_next_edit_may_erase(
    delete_applied: bool, failure: str
) -> None:
    # "é" não tem tecla nem vai pelo ADB: depois do `DEL` do "c", segue pelo `send_text`, que cai.
    remote = TextDropRemote()
    editor = await typed_abc(remote)
    remote.drop_deletes = not delete_applied
    remote.fail_text = failure
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abé")
    assert caught.value.may_have_sent is (failure != BEFORE_SEND)
    delivered = "é" if failure == DELIVERED_IN_SEND else ""
    assert remote.field == ("ab" if delete_applied else "abc") + delivered

    # Sem eco, o refazer apaga o maior campo possível e nem um a mais: com o envio incerto,
    # "abcé" (o `DEL` perdido e o "é" entregue); com a falha antes do envio, só "abc".
    remote.drop_deletes, remote.fail_text = False, None
    remote.keys.clear()
    await editor.set_text("abé")
    assert remote.keys.count("DEL") == len("abc" if failure == BEFORE_SEND else "abcé")
    assert remote.field == editor.last_text == "abé"


@pytest.mark.parametrize("failure", [BEFORE_SEND, LOST_IN_SEND])
async def test_without_field_reports_a_failed_remote_text_never_erases_text_from_before(
    failure: str,
) -> None:
    # O campo já tinha "X", que o agente não conhece (a TV não informa o campo).
    remote = TextDropRemote()
    remote.field = "X"
    editor = await typed_abc(remote, field_reported=False)
    assert remote.field == "Xabc"
    remote.drop_deletes, remote.fail_text = True, failure
    with pytest.raises(TvSessionError):
        await editor.set_text("abé")
    assert remote.field == "Xabc"

    remote.drop_deletes, remote.fail_text = False, None
    remote.keys.clear()
    await editor.set_text("abé")
    assert remote.keys.count("DEL") == len("ab")
    assert remote.field == "Xaabé"
    assert editor.last_text == "abé"


async def test_a_field_report_that_does_not_match_the_base_never_widens_the_erase() -> None:
    # 1) O campo tem "Xabc" e o agente acha que tem "abc"; o `DEL` se perde e o "é" falha antes
    # de sair: só dois DEL são seguros, porque o primeiro pode ter chegado.
    remote = TextDropRemote()
    remote.field = "X"
    editor = await typed_abc(remote, field_reported=False)
    remote.drop_deletes, remote.fail_text = True, BEFORE_SEND
    with pytest.raises(TvSessionError):
        await editor.set_text("abé")
    assert remote.field == "Xabc"

    # 2) A TV informa "Xabc": registra o contador, mas o valor não bate com a base e é recusado.
    editor.observe_field(TextFieldStatus("Xabc", 0, 0, "", counter=1))
    assert editor.last_text == "abc"

    # 3) O refazer apaga dois e sobra "Xa"; 4) redigitar "abé" cai já dentro do envio.
    remote.drop_deletes, remote.fail_text = False, DELIVERED_IN_SEND
    remote.keys.clear()
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("abé")
    assert caught.value.may_have_sent
    assert remote.keys.count("DEL") == len("ab")
    assert remote.field == "Xaabé"

    # A recuperação não apaga o lote sem confirmação: o "X" sobrevive.
    remote.fail_text = None
    remote.keys.clear()
    await editor.set_text("abé")
    assert "DEL" not in remote.keys
    assert remote.field == "Xaabéabé"
    assert editor.last_text == "abé"


async def test_the_echo_of_a_remote_text_that_failed_after_going_out_proves_it() -> None:
    remote = TextDropRemote()
    editor = await typed_abc(remote, field_reported=False)
    remote.editor = editor
    remote.fail_text = DELIVERED_IN_SEND
    with pytest.raises(TvSessionError):
        await editor.set_text("abé")
    assert remote.field == editor.last_text == "abé"

    remote.fail_text = None
    remote.keys.clear()
    await editor.set_text("abé")
    assert remote.keys == []
    assert remote.field == "abé"


async def test_a_failed_remote_text_while_retyping_counts_in_the_next_resync() -> None:
    remote = TextDropRemote()
    editor = await typed_abc(remote)
    remote.drop_deletes, remote.fail_text = True, LOST_IN_SEND
    with pytest.raises(TvSessionError):
        await editor.set_text("abé")
    assert remote.field == "abc"

    # O refazer manda quatro `DEL`, que ficam no socket, e o "abé" redigitado entra antes da queda.
    remote.fail_text = DELIVERED_IN_SEND
    remote.keys.clear()
    with pytest.raises(TvSessionError):
        await editor.set_text("abé")
    assert remote.keys.count("DEL") == len("abcé")
    assert remote.field == "abcabé"

    # O próximo refazer apaga também o trecho que pode ter entrado: os quatro de antes e "abé".
    remote.drop_deletes, remote.fail_text = False, None
    remote.keys.clear()
    await editor.set_text("abé")
    assert remote.keys.count("DEL") == len("abcé") + len("abé")
    assert remote.field == editor.last_text == "abé"


async def test_the_field_echo_proves_the_keys_and_adb_completes_the_text() -> None:
    remote = FieldRemote(lose=set(), fail_on="TYPE_C")
    editor, adb = field_rig(remote)
    editor.observe_field(TextFieldStatus("", 0, 0, "", counter=1))
    remote.editor = editor
    await editor.set_text("abcd")
    assert adb.typed == ["cd"]
    assert remote.field == "abcd"
    assert editor.last_text == "abcd"


async def test_an_echo_that_misses_a_key_does_not_prove_the_prefix() -> None:
    remote = FieldRemote(lose={"TYPE_B"}, fail_on="TYPE_C")
    editor, adb = field_rig(remote)
    editor.observe_field(TextFieldStatus("", 0, 0, "", counter=1))
    remote.editor = editor
    with pytest.raises(TvSessionError):
        await editor.set_text("abcd")
    assert adb.typed == []
    remote.fail_on = None
    await editor.set_text("abcd")
    assert remote.field == "abcd"


async def test_the_handler_keeps_the_newest_wins_rule_with_keys_on() -> None:
    rig = Rig(keys=True)
    handler = tv_text_handler(rig.session, reconciler=rig.editor, monotonic=rig.clock.monotonic)
    commands = [
        Command(str(index), "tv.text.v1", {"text": text})
        for index, text in enumerate(["a", "ab", "abc"])
    ]
    results = await asyncio.gather(*(handler(command) for command in commands))
    assert [r.status for r in results] == [ResultStatus.OK] * 3
    # O texto do meio é descartado; o campo termina com "abc" e cada tecla vai uma vez só.
    typed = [name for kind, name in rig.events if kind == "tecla"]
    assert sorted(typed) == sorted(["TYPE_A", "TYPE_B", "TYPE_C"])
    assert typed == ["TYPE_A", "TYPE_B", "TYPE_C"]
    assert rig.editor.last_text == "abc"


# --- o resumo no log ----------------------------------------------------------------------------


class Timed:
    """Faz os dublês "gastarem" tempo no relógio falso, para provar as durações do resumo."""

    def __init__(self, rig: Rig) -> None:
        clock = rig.clock

        async def connect() -> None:
            clock.advance(0.3)
            rig.remote.connects += 1
            rig.remote._connected = True

        async def input_text(text: str, *, before_send: Callable[[], None] | None = None) -> None:
            if before_send is not None:
                before_send()
            clock.advance(0.4)
            rig.adb.typed.append(text)
            rig.adb.events.append(("adb", text))

        async def send_key(key: str, direction: str = "SHORT") -> None:
            clock.advance(0.002)
            rig.remote.keys.append(key)
            rig.remote.events.append(("tecla", key))

        rig.remote.connect = connect  # type: ignore[method-assign]
        rig.adb.input_text = input_text  # type: ignore[method-assign]
        rig.remote.send_key = send_key  # type: ignore[method-assign]
        rig.adb.last_input_wait_seconds = 0.25  # type: ignore[attr-defined]


def summary_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if record.name.endswith("text_edit") and record.levelno == logging.INFO
    ]


async def test_one_summary_line_with_sizes_channel_and_the_time_of_each_phase(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = Rig(keys=False, adb=True)
    Timed(rig)
    caplog.set_level(logging.DEBUG)
    await rig.editor.set_text("abc", queued=0.1)
    # Sessão fria: o `wake` levou 0,3 s; o ADB esperou a trava 0,25 s e digitou em 0,4 s.
    assert summary_lines(caplog) == [
        "texto anterior=0 apagar=0 inserir=3 canal=adb resultado=ok | ms "
        "vez=100 adb=250 wake=300 apagar=0 digitar=400 total=800"
    ]


async def test_the_summary_times_the_erasing_and_the_keys_separately(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = Rig(keys=True)
    Timed(rig)
    caplog.set_level(logging.DEBUG)
    await rig.editor.set_text("matrix")
    caplog.clear()
    await rig.editor.set_text("mate")
    # 3 `DEL` e 1 tecla a 2 ms, mais nada: a sessão já estava quente.
    assert summary_lines(caplog) == [
        "texto anterior=6 apagar=3 inserir=1 canal=teclas resultado=ok | ms "
        "vez=0 adb=- wake=0 apagar=6 digitar=2 total=8"
    ]


async def test_a_text_that_changes_nothing_still_leaves_its_line(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = Rig(keys=True)
    caplog.set_level(logging.DEBUG)
    await rig.editor.set_text("abc")
    caplog.clear()
    await rig.editor.set_text("abc")
    assert summary_lines(caplog) == [
        "texto anterior=3 apagar=0 inserir=0 canal=nenhum resultado=ok | ms "
        "vez=0 adb=- wake=0 apagar=0 digitar=0 total=0"
    ]


async def test_a_failure_leaves_the_line_too_with_its_code(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = Rig(keys=False, adb=True)
    rig.adb.errors = [AdbTimeout("a TV demorou demais para responder ao ADB")]
    caplog.set_level(logging.DEBUG)
    with pytest.raises(TvSessionError):
        await rig.editor.set_text("abc")
    (line,) = summary_lines(caplog)
    assert "canal=adb resultado=falha:adb_timeout" in line


async def test_a_cancelled_command_leaves_its_line_as_interrupted(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = Rig(keys=True)
    never = asyncio.Event()

    async def connect_forever() -> None:
        await never.wait()

    rig.remote.connect = connect_forever  # type: ignore[method-assign]
    caplog.set_level(logging.DEBUG)
    task = asyncio.create_task(rig.editor.set_text("abc"))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    (line,) = summary_lines(caplog)
    assert "resultado=interrompido" in line
    assert rig.editor.last_text == ""


async def test_when_the_adb_is_not_ready_the_line_says_so_and_names_the_remote(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = Rig(keys=False, adb=True)
    rig.adb.errors = [AdbUnauthorized("x")]
    caplog.set_level(logging.DEBUG)
    await rig.editor.set_text("abc")
    (line,) = summary_lines(caplog)
    assert "canal=remote adb_indisponivel=adb_unauthorized resultado=ok" in line


async def test_the_handler_reports_how_long_a_message_waited_and_logs_the_discarded_one(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = Rig(keys=True)
    handler = tv_text_handler(rig.session, reconciler=rig.editor, monotonic=rig.clock.monotonic)
    caplog.set_level(logging.DEBUG)
    commands = [
        Command(str(index), "tv.text.v1", {"text": text})
        for index, text in enumerate(["a", "ab", "abc"])
    ]
    await asyncio.gather(*(handler(command) for command in commands))
    handler_lines = [
        record.getMessage()
        for record in caplog.records
        if record.name.endswith("handlers") and record.levelno == logging.INFO
    ]
    assert handler_lines == ["texto descartado: chegou um mais novo | ms vez=0"]
    # Uma linha de resumo por comando que de fato foi à TV (o do meio foi descartado).
    assert len(summary_lines(caplog)) == 2


# --- o texto digitado nunca aparece no log ------------------------------------------------------

SECRETS = ["segredo-9x", "Segredo_9X", "sênha-ção-😀", "tv 4.5/b"]


@pytest.mark.parametrize("secret", SECRETS)
@pytest.mark.parametrize("keys", [True, False])
@pytest.mark.parametrize("adb", [True, False])
async def test_what_is_typed_never_reaches_any_log_record(
    secret: str, keys: bool, adb: bool, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(keys=keys, adb=adb)
    handler = tv_text_handler(rig.session, reconciler=rig.editor, monotonic=rig.clock.monotonic)
    caplog.set_level(logging.DEBUG)
    for end in range(1, len(secret) + 1):
        await handler(Command(str(end), "tv.text.v1", {"text": secret[:end]}))
    await handler(Command("apagar", "tv.text.v1", {"text": secret[:3]}))
    await handler(Command("limpar", "tv.text.v1", {"text": ""}))
    assert caplog.records
    rendered = "\n".join(
        f"{record.getMessage()}\n{record.exc_text or ''}\n{record.args}"
        for record in caplog.records
    )
    for size in (3, 4):
        for start in range(len(secret) - size + 1):
            piece = secret[start : start + size]
            assert piece not in rendered, piece


async def test_what_is_typed_never_reaches_the_log_when_the_typing_fails_either() -> None:
    rig = Rig(keys=True)
    rig.remote.connect_errors = [TvUnreachable("x") for _ in range(4)]
    handler = tv_text_handler(rig.session, reconciler=rig.editor, monotonic=rig.clock.monotonic)
    result = await handler(Command("1", "tv.text.v1", {"text": "segredo-9x"}))
    assert result.status is ResultStatus.FAILED
    assert "segredo" not in (result.detail or "")
