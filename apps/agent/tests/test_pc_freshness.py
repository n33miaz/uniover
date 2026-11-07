"""Validade dos comandos do PC: o velho é recusado, mas soltar um botão nunca expira.

A idade é medida com o relógio monotônico do agente contra o `ts` da API, descontada a menor espera
recente: o relógio de parede do PC (adiantado, atrasado, acertado no meio da sessão) não entra.
"""

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import pytest

from uniover_agent.core import Command, ResultStatus
from uniover_agent.core.pc import ClockOffset, PcApp, pc_handlers
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


class Lab:
    """Handlers do PC com relógios falsos, que só andam quando se manda.

    `elapsed` é o tempo real decorrido: o relógio da API é `NOW + elapsed - drift` e o monotônico
    do agente é `mono_origin + elapsed` (a origem é arbitrária, como a de `time.monotonic`). O
    relógio de parede do PC fica `pc_ahead` segundos à frente do da API.
    """

    def __init__(self, *, pc_ahead: float = 0.0, mono_origin: float = 5000.0) -> None:
        self.elapsed = 0.0
        self.drift = 0.0
        self.pc_ahead = pc_ahead
        self.skews: list[float] = []
        self.refusals: list[float] = []
        self.clock = ClockOffset(
            now=lambda: NOW + timedelta(seconds=self.elapsed + self.pc_ahead),
            monotonic=lambda: mono_origin + self.elapsed,
            on_skew=self.skews.append,
            on_refused=self.refusals.append,
        )
        self.pc = FakeInput()
        self.power = FakePower()
        self.launcher = FakeLauncher()
        self.handlers = dict(
            pc_handlers(
                self.pc,
                self.power,
                self.launcher,
                [PcApp("notas", "Notas", "notepad")],
                shutdown_delay_seconds=30,
                clock=self.clock,
            )
        )

    def stamp(self, in_flight: float) -> str:
        """O `ts` de uma mensagem que a API montou `in_flight` s antes de chegar."""
        return (NOW + timedelta(seconds=self.elapsed - self.drift - in_flight)).isoformat()

    def heartbeat(self, in_flight: float = 0.2) -> None:
        """Um batimento da API, que `ProcessMessage` conta como amostra."""
        self.clock.observe(self.stamp(in_flight))

    def suspend(self, seconds: float, *, monotonic_counts: bool) -> None:
        """O PC dorme `seconds`; a API segue. O monotônico pode ou não contar o tempo dormido."""
        self.elapsed += seconds
        if not monotonic_counts:
            # O relógio da API andou `seconds` a mais que o monotônico do agente.
            self.elapsed -= seconds
            self.drift -= seconds

    async def run(
        self, handler: str, body: dict[str, object], in_flight: float | None
    ) -> tuple[str, str]:
        sent_at = None if in_flight is None else self.stamp(in_flight)
        self.clock.observe(sent_at)  # como `ProcessMessage`, ao receber
        result = await self.handlers[handler](Command("1", handler, body, sent_at=sent_at))
        return result.status.value, result.code


async def test_a_fresh_command_runs() -> None:
    lab = Lab()
    lab.heartbeat()
    assert await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5) == ("ok", "")
    assert lab.pc.calls == [("click", "LEFT", "CLICK")]


async def test_with_no_estimate_yet_even_an_old_command_runs_as_it_arrived() -> None:
    lab = Lab()
    command = Command("1", "pc.key.v1", {"key": "A"}, sent_at=lab.stamp(60))
    assert (await lab.handlers["pc.key.v1"](command)).status is ResultStatus.OK
    assert lab.clock.offset is None


async def test_a_command_without_a_usable_timestamp_runs_as_it_arrived() -> None:
    lab = Lab()
    lab.heartbeat()
    assert (await lab.run("pc.key.v1", {"key": "A"}, None))[0] == "ok"
    bad = Command("2", "pc.key.v1", {"key": "B"}, sent_at="ontem")
    naive = Command("3", "pc.key.v1", {"key": "C"}, sent_at="2020-01-01T00:00:00")
    assert (await lab.handlers["pc.key.v1"](bad)).status is ResultStatus.OK
    assert (await lab.handlers["pc.key.v1"](naive)).status is ResultStatus.OK
    assert [call[1] for call in lab.pc.calls] == ["A", "B", "C"]


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
    lab = Lab()
    lab.heartbeat(0.2)
    assert await lab.run(handler, body, 6.5) == ("rejected", EXPIRED)
    assert lab.pc.calls == []
    assert lab.launcher.opened == []


async def test_a_stale_up_is_still_executed_because_letting_go_is_always_safe() -> None:
    lab = Lab()
    lab.heartbeat()
    status = await lab.run("pc.click.v1", {"button": "LEFT", "action": "UP"}, 60)
    assert status == ("ok", "")
    assert lab.pc.calls == [("click", "LEFT", "UP")]


async def test_a_stale_pointer_is_dropped_without_a_word(
    caplog: pytest.LogCaptureFixture,
) -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    with caplog.at_level("DEBUG"):
        assert await lab.run("pc.pointer.v1", {"dx": 900, "dy": 0}, 3) == ("rejected", EXPIRED)
        assert (await lab.run("pc.pointer.v1", {"dx": 1, "dy": 1}, 0.3))[0] == "ok"
    assert lab.pc.calls == [("move", 1, 1)]
    assert caplog.text == ""
    assert lab.refusals == []  # o movimento não vai ao diagnóstico


async def test_power_has_its_own_longer_validity() -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    assert await lab.run("pc.power.v1", {"action": "LOCK"}, 10.2) == ("ok", "")
    assert await lab.run("pc.power.v1", {"action": "SHUTDOWN"}, 16.2) == ("rejected", EXPIRED)
    assert lab.power.calls == ["lock"]
    # Dez segundos de idade já vencem uma tecla, mas não a energia.
    assert (await lab.run("pc.key.v1", {"key": "A"}, 10.2))[1] == EXPIRED


async def test_cancelling_a_shutdown_never_expires() -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    assert await lab.run("pc.power.v1", {"action": "CANCEL_SHUTDOWN"}, 300) == ("ok", "")
    assert lab.power.calls == ["cancel"]


@pytest.mark.parametrize("pc_ahead", [3.0, 60.0, -30.0])
async def test_a_pc_clock_that_is_off_does_not_kill_the_pointer_or_the_clicks(
    pc_ahead: float,
) -> None:
    lab = Lab(pc_ahead=pc_ahead)
    lab.heartbeat(0.2)
    assert (await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 0.4))[0] == "ok"
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.6))[0] == "ok"
    assert (await lab.run("pc.key.v1", {"key": "A"}, 1.0))[0] == "ok"
    assert [call[0] for call in lab.pc.calls] == ["move", "click", "key"]


@pytest.mark.parametrize("pc_ahead", [3.0, 60.0, -30.0])
async def test_a_command_really_delivered_late_is_rejected_whatever_the_pc_clock(
    pc_ahead: float,
) -> None:
    lab = Lab(pc_ahead=pc_ahead)
    lab.heartbeat(0.2)
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    # Chegou 10 s mais tarde que os demais, com a mesma diferença de relógio.
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.5) == ("rejected", EXPIRED)
    assert lab.pc.calls == [("click", "LEFT", "CLICK")]


@pytest.mark.parametrize("mono_origin", [0.0, 123456.0, -50.0])
async def test_the_origin_of_the_monotonic_clock_does_not_matter(mono_origin: float) -> None:
    lab = Lab(mono_origin=mono_origin)
    lab.heartbeat(0.2)
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 9.0) == ("rejected", EXPIRED)


async def test_the_pc_wall_clock_jumping_forward_mid_session_changes_nothing() -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    before = lab.clock.offset
    lab.elapsed = 10
    lab.pc_ahead = 60.0  # alguém acertou o relógio do PC 60 s para a frente
    assert (await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 0.3))[0] == "ok"
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    assert lab.clock.offset == before
    # A idade continua certa: um comando entregue tarde de verdade segue sendo recusado.
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)
    assert [call[0] for call in lab.pc.calls] == ["move", "click"]


async def test_the_pc_wall_clock_jumping_backward_changes_nothing_either() -> None:
    lab = Lab(pc_ahead=40.0)
    lab.heartbeat(0.2)
    lab.elapsed = 10
    lab.pc_ahead = -40.0
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)


@pytest.mark.parametrize("monotonic_counts", [True, False])
async def test_suspending_the_pc_does_not_make_commands_look_old(monotonic_counts: bool) -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    # Uma hora suspenso, com ou sem o monotônico contar esse tempo; depois chega o batimento.
    lab.suspend(3600, monotonic_counts=monotonic_counts)
    lab.heartbeat(0.2)
    assert (await lab.run("pc.pointer.v1", {"dx": 1, "dy": 1}, 0.3))[0] == "ok"
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    # E a recusa do que foi segurado tempo demais continua valendo depois de acordar.
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 12.0) == ("rejected", EXPIRED)


@pytest.mark.parametrize("monotonic_counts", [True, False])
async def test_the_first_command_after_a_suspend_is_accepted_even_before_a_new_heartbeat(
    monotonic_counts: bool,
) -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    lab.suspend(3600, monotonic_counts=monotonic_counts)
    # O comando é a própria amostra nova (`ProcessMessage` a conta ao receber).
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"


async def test_the_estimate_follows_the_api_clock_once_old_samples_leave_the_window() -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    first = lab.clock.offset
    assert first is not None
    lab.elapsed = 400  # fora da janela de 5 minutos
    lab.drift = 7.0  # o relógio da API ficou 7 s para trás do monotônico do agente
    lab.heartbeat(0.2)
    assert lab.clock.offset == pytest.approx(first + 7.0)
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"


async def test_a_large_difference_is_reported_once_not_per_command(
    caplog: pytest.LogCaptureFixture,
) -> None:
    lab = Lab(pc_ahead=60.0)
    with caplog.at_level("WARNING"):
        lab.heartbeat(0.2)
        for _ in range(3):
            await lab.run("pc.key.v1", {"key": "A"}, 0.3)
    assert lab.skews == [pytest.approx(60.2)]
    assert caplog.text.count("relógio deste PC difere") == 1


async def test_a_small_difference_is_not_reported() -> None:
    lab = Lab(pc_ahead=2.0)
    lab.heartbeat(0.2)
    assert lab.skews == []


async def test_each_refused_command_reaches_the_diagnostics_callback_with_its_age() -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    await lab.run("pc.key.v1", {"key": "A"}, 8.2)
    await lab.run("pc.text.v1", {"text": "x"}, 9.2)
    assert lab.refusals == [pytest.approx(8.0), pytest.approx(9.0)]


async def test_refusing_a_stale_text_never_logs_what_was_typed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    with caplog.at_level("DEBUG"):
        await lab.run("pc.text.v1", {"text": "senha-secreta-123"}, 30)
    assert "senha-secreta-123" not in caplog.text
