"""Digitação por teclas do controle, ordem entre canais e o resumo de cada comando no log.

Nada aqui fala com uma TV: o controle e o ADB são dublês, e o relógio é o falso (`FakeClock`), que
só anda quando o teste manda. As durações do log são provadas fazendo o dublê "gastar" tempo.
"""

import asyncio
import logging

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
from uniover_agent.core.tv.text_edit import TEXT_KEY_UNSUPPORTED, TYPING_KEYS, typing_keys
from uniover_agent.ports import AdbTimeout, AdbUnauthorized, TvUnreachable

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


async def test_keys_are_off_by_default_and_the_text_goes_the_old_way() -> None:
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


async def test_a_key_the_adapter_does_not_know_fails_without_repeating_the_character() -> None:
    clock = FakeClock()
    editor = TextReconciler(
        TvSessionManager(clock, ForgetsTheKey()), monotonic=clock.monotonic, keys=True
    )
    with pytest.raises(TvSessionError) as caught:
        await editor.set_text("x")
    assert caught.value.code == TEXT_KEY_UNSUPPORTED
    assert "TYPE_X" not in caught.value.message
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__ is True
    assert editor.last_text == ""


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

        async def input_text(text: str) -> None:
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
