"""O programa que precisa estar na frente (`target`): a tecla e o texto dos controles por programa
só saem com aquele programa na frente; sem `target`, nada muda."""

import json

import pytest

from tests.test_pc_handlers import APPS, FakeInput, FakeLauncher, FakePower
from uniover_agent.adapters.pc_windows import WindowsPcForeground
from uniover_agent.composition.connection import API_LISTED_CAPABILITIES
from uniover_agent.core import Command, Handler, ResultStatus
from uniover_agent.core.domain import CommandResult
from uniover_agent.core.envelope_gate import Accepted, EnvelopeGate
from uniover_agent.core.pc import pc_handlers
from uniover_agent.core.pc.focus import (
    APP_NOT_IN_FRONT,
    PC_TARGET_CAPABILITY,
    focus_guarded,
    in_front,
)


class FakeForeground:
    def __init__(self, program: str | None) -> None:
        self.current = program
        self.asked = 0
        self.error: OSError | None = None

    def program(self) -> str | None:
        self.asked += 1
        if self.error is not None:
            raise self.error
        return self.current


def build(program: str | None) -> tuple[dict[str, Handler], FakeInput, FakeForeground]:
    pc, foreground = FakeInput(), FakeForeground(program)
    handlers = pc_handlers(
        pc, FakePower(), FakeLauncher(), APPS, shutdown_delay_seconds=45, foreground=foreground
    )
    return dict(handlers), pc, foreground


async def send(handlers: dict[str, Handler], kind: str, body: dict[str, object]) -> CommandResult:
    return await handlers[kind](Command("1", kind, body))


@pytest.mark.parametrize(
    ("target", "program", "expected"),
    [
        ("browser", "chrome.exe", True),
        ("browser", "msedge.exe", True),
        ("browser", "firefox.exe", True),
        ("browser", "brave.exe", True),
        ("browser", "opera.exe", True),
        ("browser", "CHROME.EXE", True),
        ("browser", "spotify.exe", False),
        ("browser", "winword.exe", False),
        ("spotify", "spotify.exe", True),
        ("spotify", "chrome.exe", False),
        ("vlc", "vlc.exe", True),
        ("vlc", "wmplayer.exe", False),
        ("browser", None, False),
        ("youtube", "chrome.exe", False),
    ],
)
def test_in_front_knows_each_program_by_its_executables(
    target: str, program: str | None, expected: bool
) -> None:
    assert in_front(target, program) is expected


@pytest.mark.parametrize(
    ("kind", "body", "call"),
    [
        ("pc.key.v1", {"key": "W", "modifiers": ["CTRL"]}, ("key", "W", ("CTRL",))),
        ("pc.key.v2", {"key": "COMMA", "modifiers": ["SHIFT"]}, ("key", "COMMA", ("SHIFT",))),
        ("pc.text.v1", {"text": "+"}, ("text", "+")),
        ("pc.text.v2", {"text": "a", "key": "ENTER"}, ("edit", 0, "a", "ENTER")),
    ],
)
async def test_with_the_program_in_front_the_key_and_the_text_go_out(
    kind: str, body: dict[str, object], call: tuple[object, ...]
) -> None:
    handlers, pc, _ = build("chrome.exe")
    result = await send(handlers, kind, {**body, "target": "browser"})
    assert result.status is ResultStatus.OK
    assert pc.calls == [call]


@pytest.mark.parametrize(
    ("kind", "body"),
    [
        ("pc.key.v1", {"key": "W", "modifiers": ["CTRL"]}),
        ("pc.key.v2", {"key": "K"}),
        ("pc.text.v1", {"text": "+"}),
        ("pc.text.v2", {"text": "uniover.app", "key": "ENTER"}),
    ],
)
async def test_with_another_program_in_front_nothing_is_pressed_and_the_app_is_told(
    kind: str, body: dict[str, object]
) -> None:
    handlers, pc, _ = build("winword.exe")
    result = await send(handlers, kind, {**body, "target": "browser"})
    assert result.status is ResultStatus.REJECTED
    assert result.code == APP_NOT_IN_FRONT
    assert result.detail == "Abra o navegador no PC e deixe-o na frente."
    assert pc.calls == []


async def test_without_a_target_nothing_changes_and_the_window_is_not_even_read() -> None:
    handlers, pc, foreground = build("winword.exe")
    cases: list[tuple[str, dict[str, object]]] = [
        ("pc.key.v1", {"key": "W", "modifiers": ["CTRL"]}),
        ("pc.key.v2", {"key": "BACKSPACE", "repeat": 3}),
        ("pc.text.v1", {"text": "olá"}),
        ("pc.text.v2", {"erase": 2}),
        ("pc.media.v1", {"action": "PLAY_PAUSE"}),
        ("pc.click.v1", {"button": "LEFT"}),
        ("pc.pointer.v1", {"dx": 3, "dy": 1}),
    ]
    for kind, body in cases:
        assert (await send(handlers, kind, body)).status is ResultStatus.OK, kind
    assert len(pc.calls) == 7
    assert foreground.asked == 0


async def test_an_unknown_window_or_one_that_cannot_be_read_is_never_the_program() -> None:
    handlers, pc, foreground = build(None)
    result = await send(handlers, "pc.key.v1", {"key": "K", "target": "browser"})
    assert result.code == APP_NOT_IN_FRONT
    foreground.current, foreground.error = "chrome.exe", OSError("negado")
    result = await send(handlers, "pc.key.v1", {"key": "K", "target": "browser"})
    assert result.code == APP_NOT_IN_FRONT
    assert pc.calls == []


async def test_releasing_a_held_modifier_is_never_blocked() -> None:
    handlers, pc, foreground = build("winword.exe")
    result = await send(handlers, "pc.key.v2", {"key": "ALT", "action": "UP", "target": "browser"})
    assert result.status is ResultStatus.OK
    assert pc.calls == [("key", "ALT", (), 1, "UP")]
    assert foreground.asked == 0


async def test_the_refusal_names_the_program_and_never_the_executable(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO")
    for target, name in [("spotify", "o Spotify"), ("vlc", "o VLC")]:
        handlers, _, _ = build("segredo.exe")
        result = await send(handlers, "pc.key.v1", {"key": "S", "target": target})
        assert result.detail == f"Abra {name} no PC e deixe-o na frente."
    assert "segredo" not in caplog.text


async def test_the_guard_reads_the_window_at_the_moment_of_each_command() -> None:
    pc, foreground = FakeInput(), FakeForeground("chrome.exe")

    async def handle(command: Command) -> CommandResult:
        pc.key(str(command.body["key"]), ())
        return CommandResult(command.id, ResultStatus.OK)

    guarded = focus_guarded(handle, foreground)
    assert (await guarded(Command("1", "pc.key.v1", {"key": "K", "target": "browser"}))).status is (
        ResultStatus.OK
    )
    foreground.current = "explorer.exe"
    assert (
        await guarded(Command("2", "pc.key.v1", {"key": "K", "target": "browser"}))
    ).code == APP_NOT_IN_FRONT
    assert pc.calls == [("key", "K", ())]


def test_the_windows_reader_keeps_only_the_lowercase_file_name() -> None:
    assert (
        WindowsPcForeground(
            lambda: r"C:\Program Files\Google\Chrome\Application\Chrome.EXE"
        ).program()
        == "chrome.exe"
    )
    assert WindowsPcForeground(lambda: None).program() is None
    assert WindowsPcForeground(lambda: "").program() is None

    def denied() -> str | None:
        raise OSError("acesso negado")

    assert WindowsPcForeground(denied).program() is None


def test_the_capability_waits_for_the_api_to_list_it() -> None:
    assert PC_TARGET_CAPABILITY == "pc.target.v1"
    assert PC_TARGET_CAPABILITY in API_LISTED_CAPABILITIES


@pytest.mark.parametrize(
    ("kind", "body", "accepted"),
    [
        ("pc.key.v1", {"key": "W", "modifiers": ["CTRL"], "target": "browser"}, True),
        ("pc.key.v2", {"key": "COMMA", "modifiers": ["SHIFT"], "target": "browser"}, True),
        ("pc.text.v1", {"text": "+", "target": "vlc"}, True),
        ("pc.text.v2", {"text": "a", "key": "ENTER", "target": "spotify"}, True),
        ("pc.key.v1", {"key": "K", "target": "youtube"}, False),
        ("pc.media.v1", {"action": "PLAY_PAUSE", "target": "spotify"}, False),
    ],
)
def test_the_contract_carries_the_program_only_on_key_and_text(
    kind: str, body: dict[str, object], accepted: bool
) -> None:
    envelope = {
        "v": 1,
        "id": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e9f",
        "type": kind,
        "source": "api",
        "target": "agent:pc-casa",
        "ts": "2026-11-13T14:00:00Z",
        "correlationId": None,
        "body": body,
    }
    outcome = EnvelopeGate("pc-casa").check_inbound(json.dumps(envelope))
    assert isinstance(outcome, Accepted) is accepted
