"""Validade dos comandos do PC: o velho é recusado, mas soltar um botão nunca expira."""

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import pytest

from uniover_agent.core import Command, Handler, ResultStatus
from uniover_agent.core.pc import PcApp, pc_handlers
from uniover_agent.core.pc.freshness import EXPIRED

NOW = datetime(2026, 11, 7, 12, 0, 0, tzinfo=UTC)


class FakeInput:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []

    def move(self, dx: int, dy: int) -> None:
        self.calls.append(("move", dx, dy))

    def scroll(self, horizontal: int, vertical: int) -> None:
        self.calls.append(("scroll", horizontal, vertical))

    def click(self, button: str, action: str) -> None:
        self.calls.append(("click", button, action))

    def key(self, key: str, modifiers: Sequence[str]) -> None:
        self.calls.append(("key", key, tuple(modifiers)))

    def type_text(self, text: str) -> None:
        self.calls.append(("text", text))

    def media(self, action: str, steps: int) -> None:
        self.calls.append(("media", action, steps))

    def release_all(self) -> None:
        self.calls.append(("release_all",))


class FakePower:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def lock(self) -> None:
        self.calls.append("lock")

    def sleep(self) -> None:
        self.calls.append("sleep")

    def shutdown(self, delay_seconds: int) -> None:
        self.calls.append("shutdown")

    def cancel_shutdown(self) -> None:
        self.calls.append("cancel")


class FakeLauncher:
    def __init__(self) -> None:
        self.opened: list[str] = []

    def launch(self, target: str) -> None:
        self.opened.append(target)


def build() -> tuple[dict[str, Handler], FakeInput, FakePower, FakeLauncher]:
    pc, power, launcher = FakeInput(), FakePower(), FakeLauncher()
    handlers = pc_handlers(
        pc,
        power,
        launcher,
        [PcApp("notas", "Notas", "notepad")],
        shutdown_delay_seconds=30,
        now=lambda: NOW,
    )
    return dict(handlers), pc, power, launcher


def aged(seconds: float) -> str:
    """O `ts` de um comando que a API montou `seconds` antes de `NOW`."""
    return (NOW - timedelta(seconds=seconds)).isoformat()


async def run(handler: Handler, body: dict[str, object], age: float | None) -> tuple[str, str]:
    sent_at = None if age is None else aged(age)
    result = await handler(Command("1", "pc.x.v1", body, sent_at=sent_at))
    return result.status.value, result.code


async def test_a_fresh_command_runs() -> None:
    handlers, pc, _, _ = build()
    assert await run(handlers["pc.click.v1"], {"button": "LEFT"}, 0.5) == ("ok", "")
    assert pc.calls == [("click", "LEFT", "CLICK")]


async def test_a_command_without_a_usable_timestamp_runs_as_it_arrived() -> None:
    handlers, pc, _, _ = build()
    assert (await run(handlers["pc.key.v1"], {"key": "A"}, None))[0] == "ok"
    bad = Command("2", "pc.key.v1", {"key": "B"}, sent_at="ontem")
    naive = Command("3", "pc.key.v1", {"key": "C"}, sent_at="2020-01-01T00:00:00")
    assert (await handlers["pc.key.v1"](bad)).status is ResultStatus.OK
    assert (await handlers["pc.key.v1"](naive)).status is ResultStatus.OK
    assert [call[1] for call in pc.calls] == ["A", "B", "C"]


@pytest.mark.parametrize(
    ("handler", "body"),
    [
        ("pc.click.v1", {"button": "LEFT"}),
        ("pc.click.v1", {"button": "LEFT", "action": "DOWN"}),
        ("pc.key.v1", {"key": "ENTER"}),
        ("pc.text.v1", {"text": "oi"}),
        ("pc.media.v1", {"action": "MUTE"}),
        ("pc.app.launch.v1", {"appId": "notas"}),
    ],
)
async def test_a_stale_command_is_rejected_as_expired_and_never_executed(
    handler: str, body: dict[str, object]
) -> None:
    handlers, pc, _, launcher = build()
    assert await run(handlers[handler], body, 6) == ("rejected", EXPIRED)
    assert pc.calls == []
    assert launcher.opened == []


async def test_a_stale_up_is_still_executed_because_letting_go_is_always_safe() -> None:
    handlers, pc, _, _ = build()
    status = await run(handlers["pc.click.v1"], {"button": "LEFT", "action": "UP"}, 60)
    assert status == ("ok", "")
    assert pc.calls == [("click", "LEFT", "UP")]


async def test_a_stale_pointer_is_dropped_without_a_word(
    caplog: pytest.LogCaptureFixture,
) -> None:
    handlers, pc, _, _ = build()
    with caplog.at_level("DEBUG"):
        assert await run(handlers["pc.pointer.v1"], {"dx": 900, "dy": 0}, 3) == (
            "rejected",
            EXPIRED,
        )
        assert (await run(handlers["pc.pointer.v1"], {"dx": 1, "dy": 1}, 0.2))[0] == "ok"
    assert pc.calls == [("move", 1, 1)]
    assert caplog.text == ""


async def test_power_has_its_own_longer_validity() -> None:
    handlers, _, power, _ = build()
    assert await run(handlers["pc.power.v1"], {"action": "LOCK"}, 10) == ("ok", "")
    assert await run(handlers["pc.power.v1"], {"action": "SHUTDOWN"}, 16) == (
        "rejected",
        EXPIRED,
    )
    assert power.calls == ["lock"]
    # Dez segundos de idade já vencem uma tecla, mas não a energia.
    assert (await run(handlers["pc.key.v1"], {"key": "A"}, 10))[1] == EXPIRED


async def test_a_clock_a_little_behind_the_api_is_tolerated_but_a_lot_is_not(
    caplog: pytest.LogCaptureFixture,
) -> None:
    handlers, pc, _, _ = build()
    assert (await run(handlers["pc.key.v1"], {"key": "A"}, -3))[0] == "ok"
    with caplog.at_level("WARNING"):
        assert await run(handlers["pc.key.v1"], {"key": "B"}, -30) == ("rejected", EXPIRED)
        assert await run(handlers["pc.key.v1"], {"key": "C"}, -30) == ("rejected", EXPIRED)
    assert [call[1] for call in pc.calls] == ["A"]
    # Avisa uma vez só, sem repetir a cada comando.
    assert caplog.text.count("comando do PC recusado") == 1


async def test_refusing_a_stale_text_never_logs_what_was_typed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    handlers, _, _, _ = build()
    with caplog.at_level("DEBUG"):
        await run(handlers["pc.text.v1"], {"text": "senha-secreta-123"}, 30)
    assert "senha-secreta-123" not in caplog.text
