"""Handlers do controle do PC com mouse, teclado, energia e abertura de programas falsos."""

import asyncio
from collections.abc import Sequence

import pytest

from uniover_agent.core import Command, Handler, ResultStatus
from uniover_agent.core.pc import (
    UNKNOWN_APP,
    UNSUPPORTED,
    ClickPacer,
    PcApp,
    parse_favorites,
    pc_app_launch_handler,
    pc_handlers,
    pc_power_handler,
    slugify,
)
from uniover_agent.core.pc.handlers import merge_pointer_commands
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

    def click(self, button: str, action: str, modifiers: Sequence[str] = ()) -> None:
        if modifiers:
            self._record("click", button, action, tuple(modifiers))
        else:
            self._record("click", button, action)

    def key(
        self, key: str, modifiers: Sequence[str], *, repeat: int = 1, action: str = "PRESS"
    ) -> None:
        if repeat == 1 and action == "PRESS":
            self._record("key", key, tuple(modifiers))
        else:
            self._record("key", key, tuple(modifiers), repeat, action)

    def type_text(self, text: str) -> None:
        self._record("text", text)

    def edit_text(self, erase: int, text: str, key: str | None = None) -> None:
        self._record("edit", erase, text, key)

    def media(self, action: str, steps: int) -> None:
        self._record("media", action, steps)

    def release_all(self) -> None:
        self.calls.append(("release_all",))


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


async def test_an_empty_pointer_message_still_reaches_the_input_as_traffic() -> None:
    # O app a manda para manter um arrasto vivo: o adaptador a conta sem enviar evento nenhum.
    handlers, pc, _, _ = build()
    await run(handlers["pc.pointer.v1"], {"dx": 0, "dy": 0})
    assert pc.calls == [("move", 0, 0)]


async def test_click_defaults_to_a_single_click() -> None:
    handlers, pc, _, _ = build()
    await run(handlers["pc.click.v1"], {"button": "RIGHT"})
    await run(handlers["pc.click.v1"], {"button": "LEFT", "action": "DOWN"})
    assert pc.calls == [("click", "RIGHT", "CLICK"), ("click", "LEFT", "DOWN")]


async def test_key_v2_passes_the_repeat_and_the_action_to_the_input() -> None:
    handlers, pc, _, _ = build()
    await run(handlers["pc.key.v2"], {"key": "BACKSPACE", "repeat": 12})
    await run(handlers["pc.key.v2"], {"key": "ALT", "action": "DOWN"})
    await run(handlers["pc.key.v2"], {"key": "TAB", "modifiers": ["SHIFT"]})
    await run(handlers["pc.key.v2"], {"key": "ALT", "action": "UP"})
    await run(handlers["pc.key.v2"], {"key": "D0", "modifiers": ["CTRL"]})
    assert pc.calls == [
        ("key", "BACKSPACE", (), 12, "PRESS"),
        ("key", "ALT", (), 1, "DOWN"),
        ("key", "TAB", ("SHIFT",)),
        ("key", "ALT", (), 1, "UP"),
        ("key", "D0", ("CTRL",)),
    ]


async def test_key_v1_is_untouched_by_the_v2_and_ignores_nothing_it_never_had() -> None:
    # Compatibilidade: o handler antigo segue servido, com o mesmo corpo de antes.
    handlers, pc, _, _ = build()
    assert "pc.key.v1" in handlers
    await run(handlers["pc.key.v1"], {"key": "C", "modifiers": ["CTRL"]})
    assert pc.calls == [("key", "C", ("CTRL",))]


async def test_key_v2_refused_by_the_input_is_reported_not_raised() -> None:
    handlers, pc, _, _ = build()
    pc.error = ValueError("só um modificador pode ser segurado ou solto: A")
    result = await handlers["pc.key.v2"](Command("1", "pc.key.v2", {"key": "A", "action": "DOWN"}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, "invalid_message")


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


def _move(dx: int, dy: int = 0, **extra: int) -> Command:
    return Command("n", "pc.pointer.v1", {"dx": dx, "dy": dy, **extra}, sent_at="ts-novo")


def test_two_moves_are_summed_and_keep_the_id_and_timestamp_of_the_newer() -> None:
    merged = merge_pointer_commands(
        Command("a", "pc.pointer.v1", {"dx": 3, "dy": -1}, sent_at="ts-velho"), _move(4, 5)
    )
    assert merged is not None
    assert (merged.id, merged.sent_at) == ("n", "ts-novo")
    assert merged.body == {"dx": 7, "dy": 4, "scrollX": 0, "scrollY": 0}


def test_two_scrolls_are_summed() -> None:
    merged = merge_pointer_commands(_move(0, scrollY=120), _move(0, scrollY=-240))
    assert merged is not None
    assert merged.body["scrollY"] == -120


def test_an_empty_move_merges_into_a_move() -> None:
    merged = merge_pointer_commands(_move(0, 0), _move(9, 9))
    assert merged is not None
    assert (merged.body["dx"], merged.body["dy"]) == (9, 9)


def test_a_move_and_a_scroll_are_not_merged_in_either_direction() -> None:
    assert merge_pointer_commands(_move(5), _move(0, scrollY=120)) is None
    assert merge_pointer_commands(_move(0, scrollY=120), _move(5)) is None


def test_a_command_with_both_move_and_scroll_is_not_merged_with_anything() -> None:
    mixed = _move(5, scrollY=120)
    assert merge_pointer_commands(mixed, _move(1)) is None
    assert merge_pointer_commands(_move(1), mixed) is None
    assert merge_pointer_commands(mixed, mixed) is None


@pytest.mark.parametrize(
    ("older", "newer"),
    [
        (_move(1500), _move(600)),
        (_move(-1500), _move(-600)),
        (_move(0, 1500), _move(0, 600)),
        (_move(0, scrollY=700), _move(0, scrollY=600)),
        (_move(0, scrollX=-700), _move(0, scrollX=-600)),
    ],
)
def test_a_sum_past_the_adapter_limits_is_not_merged(older: Command, newer: Command) -> None:
    assert merge_pointer_commands(older, newer) is None


def test_a_sum_exactly_at_the_limit_is_merged() -> None:
    merged = merge_pointer_commands(_move(1000), _move(1000))
    assert merged is not None
    assert merged.body["dx"] == 2000


async def test_text_v2_erases_types_and_presses_the_key_in_one_call_to_the_input() -> None:
    handlers, pc, _, _ = build()
    await run(handlers["pc.text.v2"], {"erase": 3, "text": "olá", "key": "ENTER"})
    await run(handlers["pc.text.v2"], {"erase": 12})
    await run(handlers["pc.text.v2"], {"text": "abc"})
    await run(handlers["pc.text.v2"], {"key": "TAB"})
    assert pc.calls == [
        ("edit", 3, "olá", "ENTER"),
        ("edit", 12, "", None),
        ("edit", 0, "abc", None),
        ("edit", 0, "", "TAB"),
    ]


async def test_text_v1_is_untouched_by_the_v2() -> None:
    handlers, pc, _, _ = build()
    assert "pc.text.v1" in handlers
    await run(handlers["pc.text.v1"], {"text": "olá"})
    assert pc.calls == [("text", "olá")]


async def test_text_v2_never_reaches_the_log(caplog: pytest.LogCaptureFixture) -> None:
    handlers, pc, _, _ = build()
    pc.error = OSError("o Windows recusou")
    with caplog.at_level("DEBUG"):
        result = await handlers["pc.text.v2"](
            Command("1", "pc.text.v2", {"erase": 2, "text": "senha-secreta", "key": "ENTER"})
        )
    assert result.status is ResultStatus.FAILED
    assert "senha-secreta" not in caplog.text
    assert "senha-secreta" not in str(result)


async def test_text_v2_refused_by_the_input_is_reported_not_raised() -> None:
    handlers, pc, _, _ = build()
    pc.error = ValueError("texto com metade de um caractere (par substituto incompleto)")
    result = await handlers["pc.text.v2"](Command("1", "pc.text.v2", {"text": "x"}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, "invalid_message")


async def test_click_v2_passes_the_modifiers_to_the_input() -> None:
    handlers, pc, _, _ = build()
    await run(handlers["pc.click.v2"], {"button": "LEFT", "modifiers": ["CTRL", "SHIFT"]})
    await run(handlers["pc.click.v2"], {"button": "LEFT", "action": "DOUBLE"})
    await run(handlers["pc.click.v2"], {"button": "RIGHT", "modifiers": ["ALT"], "gapMs": 0})
    assert pc.calls == [
        ("click", "LEFT", "CLICK", ("CTRL", "SHIFT")),
        ("click", "LEFT", "DOUBLE"),
        ("click", "RIGHT", "CLICK", ("ALT",)),
    ]


async def test_click_v2_refused_by_the_input_is_reported_not_raised() -> None:
    handlers, pc, _, _ = build()
    pc.error = ValueError("só CTRL, ALT e SHIFT")
    result = await handlers["pc.click.v2"](Command("1", "pc.click.v2", {"button": "LEFT"}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, "invalid_message")


class FakeTime:
    """Relógio e espera de mentira: dormir só adianta o relógio, sem esperar de verdade."""

    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(round(seconds, 4))
        self.now += seconds


def paced() -> tuple[dict[str, Handler], FakeInput, FakeTime]:
    pc, clock = FakeInput(), FakeTime()
    pacer = ClickPacer(clock.monotonic, clock.sleep)
    handlers = pc_handlers(
        pc, FakePower(), FakeLauncher(), APPS, shutdown_delay_seconds=45, pacer=pacer
    )
    return dict(handlers), pc, clock


async def test_the_second_tap_waits_for_what_is_missing_of_the_measured_gap() -> None:
    handlers, pc, clock = paced()
    await run(handlers["pc.click.v1"], {"button": "LEFT"})
    clock.now += 0.04  # o pedido do segundo toque chegou 40 ms depois do primeiro
    await run(handlers["pc.click.v2"], {"button": "LEFT", "gapMs": 150})
    assert clock.sleeps == [0.11], "espera os 110 ms que faltam para os 150 medidos"
    assert pc.calls == [("click", "LEFT", "CLICK"), ("click", "LEFT", "CLICK")]


async def test_a_second_tap_that_arrived_late_goes_out_at_once() -> None:
    handlers, _, clock = paced()
    await run(handlers["pc.click.v1"], {"button": "LEFT"})
    clock.now += 0.3
    await run(handlers["pc.click.v2"], {"button": "LEFT", "gapMs": 150})
    assert clock.sleeps == []


async def test_the_wait_never_goes_past_the_gap_the_app_asked_for() -> None:
    handlers, _, clock = paced()
    await run(handlers["pc.click.v1"], {"button": "LEFT"})
    await run(handlers["pc.click.v2"], {"button": "LEFT", "gapMs": 400})
    assert clock.sleeps == [0.4]
    # Mesmo com o relógio andando para trás (não deveria), nunca passa de \`gapMs\`.
    clock.now -= 5
    await run(handlers["pc.click.v2"], {"button": "LEFT", "gapMs": 100})
    assert clock.sleeps[-1] <= 0.1


async def test_without_a_previous_click_or_a_gap_or_with_another_button_nothing_waits() -> None:
    handlers, _, clock = paced()
    await run(handlers["pc.click.v2"], {"button": "LEFT", "gapMs": 200})  # nenhum antes
    assert clock.sleeps == []
    await run(handlers["pc.click.v2"], {"button": "RIGHT", "gapMs": 200})  # outro botão
    assert clock.sleeps == []
    await run(handlers["pc.click.v2"], {"button": "RIGHT", "modifiers": ["CTRL"]})  # sem intervalo
    await run(handlers["pc.click.v2"], {"button": "RIGHT", "modifiers": ["CTRL"], "gapMs": 0})
    assert clock.sleeps == []


async def test_holding_and_releasing_the_button_do_not_count_as_the_previous_tap() -> None:
    handlers, _, clock = paced()
    await run(handlers["pc.click.v1"], {"button": "LEFT", "action": "DOWN"})
    await run(handlers["pc.click.v1"], {"button": "LEFT", "action": "UP"})
    await run(handlers["pc.click.v2"], {"button": "LEFT", "gapMs": 200})
    assert clock.sleeps == []


async def test_the_v2_click_also_counts_as_the_previous_tap_of_the_next() -> None:
    handlers, _, clock = paced()
    await run(handlers["pc.click.v2"], {"button": "LEFT", "modifiers": ["CTRL"]})
    await run(handlers["pc.click.v2"], {"button": "LEFT", "gapMs": 120})
    assert clock.sleeps == [0.12]
