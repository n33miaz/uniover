"""Tocando agora e área de transferência do PC: os adaptadores, os comandos que devolvem dados e
o contrato.

Nenhum teste inicia o PowerShell, toca a área de transferência nem a sessão de mídia de verdade: o
executor do script, a API da área e o relógio são dublês (e a guarda do `conftest` reprova quem
chegar às de verdade).
"""

import base64
import ctypes
import json
import sys
from types import SimpleNamespace
from typing import Any

import pytest

from uniover_agent.adapters import pc_clipboard
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.pc_clipboard import WindowsPcClipboard
from uniover_agent.adapters.pc_media_session import WindowsPcMediaSession, parse_now_playing
from uniover_agent.core import (
    Accepted,
    Command,
    CommandResult,
    EnvelopeFactory,
    EnvelopeGate,
    Rejected,
    ResultStatus,
    pc_clipboard_query_handler,
    pc_clipboard_set_handler,
    pc_media_query_handler,
)
from uniover_agent.core.pc import PcApp, pc_handlers
from uniover_agent.ports import TransportError
from uniover_agent.ports.pc import PcUnsupported
from uniover_agent.ports.pc_media import (
    MAX_CLIPBOARD_TEXT,
    STATUS_NONE,
    STATUS_PAUSED,
    STATUS_PLAYING,
    STATUS_STOPPED,
    NowPlaying,
)

from .support import AGENT_ID, envelope
from .test_pc_handlers import FakeInput, FakeLauncher, FakePower

# A área do sistema capturada ao importar, antes de a guarda do `conftest` trocá-la: só o teste de
# fora do Windows a usa, e lá ela recusa sem tocar em nada.
REAL_SYSTEM_API = pc_clipboard._system_api
REQUEST_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e00"
GUARD = "mídia ou a área de transferência"


def encoded(data: object) -> str:
    return base64.b64encode(json.dumps(data, ensure_ascii=False).encode("utf-8")).decode("ascii")


def factory() -> EnvelopeFactory:
    return EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock())


class FakeSession:
    def __init__(self, playing: NowPlaying | None = None) -> None:
        self.playing = playing or NowPlaying(STATUS_PLAYING, "Faixa", "Artista", "Spotify.exe")
        self.reads = 0
        self.error: Exception | None = None

    def read(self) -> NowPlaying:
        self.reads += 1
        if self.error is not None:
            raise self.error
        return self.playing


class FakeClipboard:
    def __init__(self, text: str = "texto copiado") -> None:
        self.text = text
        self.writes: list[str] = []
        self.error: Exception | None = None

    def read(self) -> str:
        if self.error is not None:
            raise self.error
        return self.text

    def write(self, text: str) -> None:
        if self.error is not None:
            raise self.error
        self.writes.append(text)
        self.text = text


def command(message_type: str, body: dict[str, Any] | None = None) -> Command:
    return Command(REQUEST_ID, message_type, body or {})


# ---- a leitura da sessão de mídia ---------------------------------------------------------------


def test_the_media_session_is_read_from_what_the_script_printed() -> None:
    output = encoded(
        {"status": "Playing", "title": "Águas de Março", "artist": "Elis", "app": "Spotify.exe"}
    )
    session = WindowsPcMediaSession(run=lambda: (0, output))
    assert session.read() == NowPlaying(STATUS_PLAYING, "Águas de Março", "Elis", "Spotify.exe")


@pytest.mark.parametrize(
    ("windows", "ours"),
    [
        ("Playing", STATUS_PLAYING),
        ("Paused", STATUS_PAUSED),
        ("Stopped", STATUS_STOPPED),
        ("Closed", STATUS_STOPPED),
        ("Opened", STATUS_STOPPED),
        ("Changing", STATUS_STOPPED),
    ],
)
def test_every_windows_state_becomes_one_of_the_contract_states(windows: str, ours: str) -> None:
    assert parse_now_playing(encoded({"status": windows, "title": "t"})).status == ours


def test_no_session_at_all_is_none_with_no_text() -> None:
    assert parse_now_playing(encoded({"status": "None"})) == NowPlaying(STATUS_NONE)


def test_the_text_is_cleaned_and_cut_at_the_contract_limit() -> None:
    playing = parse_now_playing(
        encoded({"status": "Playing", "title": "a\x00b\x07c" + "x" * 500, "artist": 7, "app": None})
    )
    assert playing.title.startswith("abc")
    assert len(playing.title) == 200
    assert (playing.artist, playing.app) == ("", "")


@pytest.mark.parametrize(
    "output",
    ["", "não é base64!!", encoded({"nope": 1}), encoded([1]), encoded({"status": 3})],
)
def test_garbage_from_the_system_is_a_failure_not_an_invented_track(output: str) -> None:
    with pytest.raises(OSError, match="sessão de mídia"):
        parse_now_playing(output)


def test_a_script_that_failed_is_reported() -> None:
    with pytest.raises(OSError, match="código 1"):
        WindowsPcMediaSession(run=lambda: (1, "")).read()


@pytest.mark.skipif(sys.platform == "win32", reason="fora do Windows o sistema recusa")
def test_outside_windows_the_media_session_is_refused() -> None:
    # Sem executor injetado: o da produção, que fora do Windows recusa antes de iniciar
    # qualquer coisa.
    with pytest.raises(PcUnsupported):
        WindowsPcMediaSession().read()


@pytest.mark.skipif(sys.platform != "win32", reason="o executor só chega ao PowerShell no Windows")
def test_the_test_suite_can_never_start_the_real_powershell() -> None:
    # A guarda do `conftest` troca `run_hidden`: o executor de verdade reprova o teste em vez de
    # iniciar o PowerShell.
    with pytest.raises(AssertionError, match=GUARD):
        WindowsPcMediaSession().read()


# ---- a área de transferência --------------------------------------------------------------------


class FakeClipboardApi:
    def __init__(self, text: str | None = "copiado") -> None:
        self.text = text
        self.written: list[str] = []

    def read_text(self) -> str | None:
        return self.text

    def write_text(self, text: str) -> None:
        self.written.append(text)


def test_the_clipboard_reads_only_text_and_cuts_at_the_limit() -> None:
    api = FakeClipboardApi("x" * (MAX_CLIPBOARD_TEXT + 40))
    assert len(WindowsPcClipboard(lambda: api).read()) == MAX_CLIPBOARD_TEXT
    assert WindowsPcClipboard(lambda: FakeClipboardApi(None)).read() == ""


def test_the_clipboard_writes_text_and_refuses_what_is_too_big() -> None:
    api = FakeClipboardApi()
    clipboard = WindowsPcClipboard(lambda: api)
    clipboard.write("olá, mundo")
    assert api.written == ["olá, mundo"]
    with pytest.raises(ValueError, match="grande demais"):
        clipboard.write("x" * (MAX_CLIPBOARD_TEXT + 1))
    assert api.written == ["olá, mundo"]


@pytest.mark.skipif(sys.platform == "win32", reason="fora do Windows o sistema recusa")
def test_outside_windows_the_clipboard_is_refused() -> None:
    with pytest.raises(PcUnsupported):
        WindowsPcClipboard(REAL_SYSTEM_API).read()
    with pytest.raises(PcUnsupported):
        WindowsPcClipboard(REAL_SYSTEM_API).write("x")


def test_no_test_touches_the_real_clipboard() -> None:
    # A guarda do `conftest` troca `_system_api`, a única porta para a área de verdade.
    with pytest.raises(AssertionError, match=GUARD):
        WindowsPcClipboard().read()
    with pytest.raises(AssertionError, match=GUARD):
        WindowsPcClipboard().write("x")


@pytest.mark.skipif(sys.platform != "win32", reason="adaptador Win32")
def test_clipboard_write_opens_with_a_message_only_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[object, ...]] = []
    buffer = ctypes.create_string_buffer(32)

    def create(*args: object) -> int:
        assert args[8] == -3
        calls.append(("create",))
        return 42

    def note(*args: object) -> bool:
        calls.append(args)
        return True

    monkeypatch.setattr(
        pc_clipboard,
        "_user32",
        SimpleNamespace(
            CreateWindowExW=create,
            OpenClipboard=lambda window: note("open", window),
            EmptyClipboard=lambda: note("empty"),
            SetClipboardData=lambda fmt, block: note("set", fmt, block),
            CloseClipboard=lambda: note("close"),
            DestroyWindow=lambda window: note("destroy", window),
        ),
    )
    monkeypatch.setattr(
        pc_clipboard,
        "_kernel32",
        SimpleNamespace(
            GlobalAlloc=lambda flags, size: 99,
            GlobalLock=lambda block: ctypes.addressof(buffer),
            GlobalUnlock=lambda block: None,
            GlobalFree=lambda block: note("free", block),
        ),
    )
    WindowsPcClipboard(REAL_SYSTEM_API).write("olá")
    assert calls == [
        ("create",),
        ("open", 42),
        ("empty",),
        ("set", 13, 99),
        ("close",),
        ("destroy", 42),
    ]
    assert buffer.raw[:8] == "olá\x00".encode("utf-16-le")


# ---- os comandos que devolvem dados -------------------------------------------------------------


async def test_the_media_query_sends_the_state_before_the_result_and_answers_ok() -> None:
    transport, session = FakeTransport(), FakeSession()
    handler = pc_media_query_handler(session, transport, factory())
    result = await handler(command("pc.media.query.v1"))
    assert result.status is ResultStatus.OK
    (message,) = transport.sent
    assert message["type"] == "pc.media.state.v1"
    assert message["correlationId"] == REQUEST_ID
    assert message["body"]["title"] == "Faixa"
    assert message["body"]["status"] == STATUS_PLAYING


async def test_with_no_media_session_the_state_goes_out_empty_and_valid() -> None:
    transport = FakeTransport()
    handler = pc_media_query_handler(FakeSession(NowPlaying(STATUS_NONE)), transport, factory())
    await handler(command("pc.media.query.v1"))
    (message,) = transport.sent
    EnvelopeGate(AGENT_ID).check_outbound(message)
    assert message["body"] == {
        "status": "none",
        "title": "",
        "artist": "",
        "app": "",
        "at": message["body"]["at"],
    }


async def test_asking_again_inside_the_cache_window_does_not_read_again() -> None:
    now = [100.0]
    transport, session = FakeTransport(), FakeSession()
    handler = pc_media_query_handler(
        session, transport, factory(), monotonic=lambda: now[0], cache_seconds=2.0
    )
    await handler(command("pc.media.query.v1"))
    now[0] += 1.0
    await handler(command("pc.media.query.v1"))
    assert session.reads == 1
    assert len(transport.sent) == 2, "cada pergunta recebe a sua resposta"
    now[0] += 5.0
    await handler(command("pc.media.query.v1"))
    assert session.reads == 2


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (PcUnsupported("só no Windows"), ResultStatus.REJECTED, "unsupported"),
        (OSError("falhou"), ResultStatus.FAILED, "failed"),
    ],
)
async def test_a_media_query_that_cannot_be_read_is_reported_not_raised(
    error: Exception, status: ResultStatus, code: str
) -> None:
    transport, session = FakeTransport(), FakeSession()
    session.error = error
    result = await pc_media_query_handler(session, transport, factory())(
        command("pc.media.query.v1")
    )
    assert (result.status, result.code) == (status, code)
    assert transport.sent == []


async def test_a_media_state_that_could_not_be_sent_is_a_failure() -> None:
    class BrokenTransport(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            raise TransportError("caiu")

    result = await pc_media_query_handler(FakeSession(), BrokenTransport(), factory())(
        command("pc.media.query.v1")
    )
    assert (result.status, result.code) == (ResultStatus.FAILED, "failed")


async def test_the_clipboard_query_sends_the_text_and_never_logs_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    transport, clipboard = FakeTransport(), FakeClipboard("senha-secreta-123")
    handler = pc_clipboard_query_handler(clipboard, transport, factory())
    with caplog.at_level("DEBUG"):
        result = await handler(command("pc.clipboard.query.v1"))
    assert result.status is ResultStatus.OK
    (message,) = transport.sent
    assert (message["type"], message["correlationId"]) == ("pc.clipboard.v1", REQUEST_ID)
    assert message["body"]["text"] == "senha-secreta-123"
    assert "senha-secreta-123" not in caplog.text


async def test_an_empty_clipboard_goes_out_as_empty_text() -> None:
    transport = FakeTransport()
    await pc_clipboard_query_handler(FakeClipboard(""), transport, factory())(
        command("pc.clipboard.query.v1")
    )
    (message,) = transport.sent
    EnvelopeGate(AGENT_ID).check_outbound(message)
    assert message["body"]["text"] == ""


async def test_a_clipboard_that_could_not_be_read_sends_nothing() -> None:
    transport, clipboard = FakeTransport(), FakeClipboard()
    clipboard.error = OSError("em uso")
    result = await pc_clipboard_query_handler(clipboard, transport, factory())(
        command("pc.clipboard.query.v1")
    )
    assert (result.status, result.code) == (ResultStatus.FAILED, "failed")
    assert transport.sent == []


async def test_the_clipboard_set_writes_the_text_and_never_logs_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clipboard = FakeClipboard()
    with caplog.at_level("DEBUG"):
        result = await pc_clipboard_set_handler(clipboard)(
            command("pc.clipboard.set.v1", {"text": "token-super-secreto"})
        )
    assert result.status is ResultStatus.OK
    assert clipboard.writes == ["token-super-secreto"]
    assert "token-super-secreto" not in caplog.text


@pytest.mark.parametrize("text", ["", None, 5, "x" * (MAX_CLIPBOARD_TEXT + 1)])
async def test_a_text_outside_the_contract_never_reaches_the_clipboard(text: object) -> None:
    clipboard = FakeClipboard()
    result = await pc_clipboard_set_handler(clipboard)(
        command("pc.clipboard.set.v1", {"text": text})
    )
    assert (result.status, result.code) == (ResultStatus.REJECTED, "invalid_message")
    assert clipboard.writes == []


async def test_a_clipboard_that_refused_the_text_is_a_failure() -> None:
    clipboard = FakeClipboard()
    clipboard.error = OSError("em uso")
    result = await pc_clipboard_set_handler(clipboard)(
        command("pc.clipboard.set.v1", {"text": "x"})
    )
    assert (result.status, result.code) == (ResultStatus.FAILED, "failed")


async def test_the_extra_commands_join_the_pc_commands() -> None:
    ran: list[str] = []

    async def noted(command: Command) -> CommandResult:
        ran.append(command.type)
        return CommandResult(command.id, ResultStatus.OK)

    handlers = pc_handlers(
        FakeInput(),
        FakePower(),
        FakeLauncher(),
        [PcApp("notas", "Notas", "notepad")],
        shutdown_delay_seconds=30,
        extra={"pc.media.query.v1": noted, "pc.clipboard.set.v1": noted},
    )
    assert "pc.clipboard.query.v1" not in handlers
    result = await handlers["pc.media.query.v1"](command("pc.media.query.v1"))
    assert result.status is ResultStatus.OK
    assert ran == ["pc.media.query.v1"]


# ---- o contrato ---------------------------------------------------------------------------------


def check(message_type: str, body: dict[str, Any]) -> object:
    return EnvelopeGate(AGENT_ID).check_inbound(json.dumps(envelope(message_type, body)))


@pytest.mark.parametrize(
    ("message_type", "body"),
    [
        ("pc.media.query.v1", {}),
        ("pc.clipboard.query.v1", {}),
        ("pc.clipboard.set.v1", {"text": "olá"}),
        ("pc.clipboard.set.v1", {"text": "linha 1\r\nlinha 2\tcom tab"}),
        ("pc.clipboard.set.v1", {"text": "x" * 5000}),
    ],
)
def test_the_gate_accepts_the_valid_new_commands(message_type: str, body: dict[str, Any]) -> None:
    assert isinstance(check(message_type, body), Accepted)


@pytest.mark.parametrize(
    ("message_type", "body"),
    [
        ("pc.media.query.v1", {"all": True}),
        ("pc.clipboard.query.v1", {"all": True}),
        ("pc.clipboard.set.v1", {}),
        ("pc.clipboard.set.v1", {"text": ""}),
        ("pc.clipboard.set.v1", {"text": "x" * 5001}),
        ("pc.clipboard.set.v1", {"text": "a\x00b"}),
        ("pc.clipboard.set.v1", {"text": "a\x1bb"}),
        ("pc.clipboard.set.v1", {"text": "x", "append": True}),
    ],
)
def test_the_gate_refuses_what_the_contract_refuses(
    message_type: str, body: dict[str, Any]
) -> None:
    assert isinstance(check(message_type, body), Rejected)


def test_the_clipboard_and_media_messages_the_agent_builds_match_the_contract() -> None:
    envelopes, gate = factory(), EnvelopeGate(AGENT_ID)
    media = envelopes.pc_media_state(NowPlaying(STATUS_PAUSED, "t", "a", "app"), REQUEST_ID)
    clipboard = envelopes.pc_clipboard("texto", REQUEST_ID)
    gate.check_outbound(media)
    gate.check_outbound(clipboard)
    assert set(media["body"]) == {"status", "title", "artist", "app", "at"}
    assert set(clipboard["body"]) == {"text", "at"}
