"""Handlers do controle do PC com mouse, teclado, energia e abertura de programas falsos."""

import asyncio
from collections.abc import Sequence

import pytest

from uniover_agent.core import Command, Handler, ResultStatus
from uniover_agent.core.pc import (
    UNKNOWN_APP,
    UNSUPPORTED,
    PcApp,
    parse_favorites,
    pc_app_launch_handler,
    pc_handlers,
    pc_power_handler,
    slugify,
)
from uniover_agent.ports.pc import PcUnsupported


class FakeInput:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []
        self.error: Exception | None = None

    def _record(self, *call: object) -> None:
        if self.error is not None:
            raise self.error
        self.calls.append(call)

    def move(self, dx: int, dy: int) -> None:
        self._record("move", dx, dy)

    def scroll(self, horizontal: int, vertical: int) -> None:
        self._record("scroll", horizontal, vertical)

    def click(self, button: str, action: str) -> None:
        self._record("click", button, action)

    def key(self, key: str, modifiers: Sequence[str]) -> None:
        self._record("key", key, tuple(modifiers))

    def type_text(self, text: str) -> None:
        self._record("text", text)

    def media(self, action: str, steps: int) -> None:
        self._record("media", action, steps)


class FakePower:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []
        self.slept = asyncio.Event()

    def lock(self) -> None:
        self.calls.append(("lock",))

    def sleep(self) -> None:
        self.calls.append(("sleep",))
        self.slept.set()

    def shutdown(self, delay_seconds: int) -> None:
        self.calls.append(("shutdown", delay_seconds))

    def cancel_shutdown(self) -> None:
        self.calls.append(("cancel",))


class FakeLauncher:
    def __init__(self) -> None:
        self.opened: list[str] = []

    def launch(self, target: str) -> None:
        self.opened.append(target)


APPS = [PcApp("navegador", "Navegador", "https://exemplo.test"), PcApp("notas", "Notas", "notepad")]


def build() -> tuple[dict[str, Handler], FakeInput, FakePower, FakeLauncher]:
    pc, power, launcher = FakeInput(), FakePower(), FakeLauncher()
    handlers = pc_handlers(pc, power, launcher, APPS, shutdown_delay_seconds=45)
    return dict(handlers), pc, power, launcher


async def run(handler: Handler, body: dict[str, object]) -> ResultStatus:
    result = await handler(Command("1", "pc.x.v1", body))
    return result.status


async def test_pointer_moves_and_scrolls_in_one_command() -> None:
    handlers, pc, _, _ = build()
    status = await run(handlers["pc.pointer.v1"], {"dx": 3, "dy": -2, "scrollY": 120})
    assert status is ResultStatus.OK
    assert pc.calls == [("move", 3, -2), ("scroll", 0, 120)]


async def test_pointer_with_nothing_to_do_touches_nothing() -> None:
    handlers, pc, _, _ = build()
    await run(handlers["pc.pointer.v1"], {"dx": 0, "dy": 0})
    assert pc.calls == []


async def test_click_defaults_to_a_single_click() -> None:
    handlers, pc, _, _ = build()
    await run(handlers["pc.click.v1"], {"button": "RIGHT"})
    await run(handlers["pc.click.v1"], {"button": "LEFT", "action": "DOWN"})
    assert pc.calls == [("click", "RIGHT", "CLICK"), ("click", "LEFT", "DOWN")]


async def test_key_text_and_media() -> None:
    handlers, pc, _, _ = build()
    await run(handlers["pc.key.v1"], {"key": "C", "modifiers": ["CTRL"]})
    await run(handlers["pc.key.v1"], {"key": "ENTER"})
    await run(handlers["pc.text.v1"], {"text": "olá"})
    await run(handlers["pc.media.v1"], {"action": "VOLUME_UP", "steps": 3})
    await run(handlers["pc.media.v1"], {"action": "MUTE"})
    assert pc.calls == [
        ("key", "C", ("CTRL",)),
        ("key", "ENTER", ()),
        ("text", "olá"),
        ("media", "VOLUME_UP", 3),
        ("media", "MUTE", 1),
    ]


async def test_typed_text_never_reaches_the_log(caplog: pytest.LogCaptureFixture) -> None:
    handlers, _, _, _ = build()
    with caplog.at_level("DEBUG"):
        await run(handlers["pc.text.v1"], {"text": "senha-secreta-123"})
    assert "senha-secreta-123" not in caplog.text


async def test_lock_shutdown_and_cancel() -> None:
    handlers, _, power, _ = build()
    await run(handlers["pc.power.v1"], {"action": "LOCK"})
    await run(handlers["pc.power.v1"], {"action": "SHUTDOWN"})
    await run(handlers["pc.power.v1"], {"action": "CANCEL_SHUTDOWN"})
    assert power.calls == [("lock",), ("shutdown", 45), ("cancel",)]


async def test_sleep_answers_first_and_suspends_afterwards() -> None:
    power = FakePower()
    handler = pc_power_handler(power, shutdown_delay_seconds=30, sleep_delay_seconds=0.01)
    result = await handler(Command("1", "pc.power.v1", {"action": "SLEEP"}))
    # O resultado já voltou e o PC ainda não adormeceu: a resposta sai antes de a conexão cair.
    assert result.status is ResultStatus.OK
    assert power.calls == []
    await asyncio.wait_for(power.slept.wait(), 2)
    assert power.calls == [("sleep",)]


async def test_a_failing_suspend_is_logged_and_does_not_crash(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Broken(FakePower):
        def sleep(self) -> None:
            raise OSError("recusou")

    pending: list[asyncio.Future[None]] = []
    handler = pc_power_handler(
        Broken(),
        shutdown_delay_seconds=30,
        sleep_delay_seconds=0,
        spawn=lambda coroutine: pending.append(asyncio.ensure_future(coroutine)),
    )
    await handler(Command("1", "pc.power.v1", {"action": "SLEEP"}))
    with caplog.at_level("WARNING"):
        await asyncio.gather(*pending)
    assert "não foi possível suspender" in caplog.text


async def test_launch_only_opens_what_the_pc_listed() -> None:
    handlers, _, _, launcher = build()
    assert await run(handlers["pc.app.launch.v1"], {"appId": "notas"}) is ResultStatus.OK
    assert launcher.opened == ["notepad"]
    result = await pc_app_launch_handler(launcher, APPS)(
        Command("2", "pc.app.launch.v1", {"appId": "cmd"})
    )
    assert (result.status, result.code) == (ResultStatus.REJECTED, UNKNOWN_APP)
    assert launcher.opened == ["notepad"]


async def test_the_system_refusing_is_reported_not_raised() -> None:
    handlers, pc, _, _ = build()
    pc.error = PcUnsupported("só no Windows")
    result = await handlers["pc.key.v1"](Command("1", "pc.key.v1", {"key": "A"}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, UNSUPPORTED)
    pc.error = OSError("o Windows aceitou 0 de 2 eventos")
    result = await handlers["pc.key.v1"](Command("2", "pc.key.v1", {"key": "A"}))
    assert (result.status, result.code) == (ResultStatus.FAILED, "failed")
    pc.error = ValueError("tecla fora do contrato")
    result = await handlers["pc.key.v1"](Command("3", "pc.key.v1", {"key": "A"}))
    assert result.status is ResultStatus.REJECTED


def test_favorites_are_parsed_with_stable_unique_ids() -> None:
    apps = parse_favorites(
        [
            "Navegador Web=C:\\Programas\\nav.exe",
            "Navegador  Web = https://exemplo.test",
            "Música=spotify:",
            "sem-igual",
            "=vazio",
            "SemDestino=",
        ]
    )
    assert [(app.id, app.label) for app in apps] == [
        ("navegador-web", "Navegador Web"),
        ("navegador-web-2", "Navegador  Web"),
        ("musica", "Música"),
    ]
    assert apps[0].target == "C:\\Programas\\nav.exe"
    assert apps[1].target == "https://exemplo.test"


def test_favorites_stop_at_the_contract_limit() -> None:
    assert len(parse_favorites([f"App {n}=x" for n in range(40)])) == 24


def test_slugify() -> None:
    assert slugify("Ação & Reação!") == "acao-reacao"
    assert slugify("???") == "app"
    assert len(slugify("a" * 100)) == 40


async def test_a_failing_pointer_is_quiet_in_the_log(caplog: pytest.LogCaptureFixture) -> None:
    handlers, pc, _, _ = build()
    pc.error = OSError("o Windows aceitou 0 de 1 eventos de entrada")
    with caplog.at_level("INFO"):
        result = await handlers["pc.pointer.v1"](Command("1", "pc.pointer.v1", {"dx": 1, "dy": 1}))
    assert result.status is ResultStatus.FAILED
    assert caplog.text == ""
