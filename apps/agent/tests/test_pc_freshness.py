"""Validade dos comandos do PC: o velho é recusado, mas soltar um botão nunca expira.

A idade é medida com o relógio monotônico do agente contra o `ts` da API, descontada a menor espera
recente: o relógio de parede do PC (adiantado, atrasado, acertado no meio da sessão) não entra.
"""

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import pytest

from uniover_agent.core import Command, ResultStatus
from uniover_agent.core.pc import ClockOffset, PcApp, PcUseTracker, pc_handlers
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

    def key(
        self, key: str, modifiers: Sequence[str], *, repeat: int = 1, action: str = "PRESS"
    ) -> None:
        if repeat == 1 and action == "PRESS":
            self.calls.append(("key", key, tuple(modifiers)))
        else:
            self.calls.append(("key", key, tuple(modifiers), repeat, action))

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

    `elapsed` é o tempo real decorrido. O relógio da API é `NOW + elapsed - drift - api_step` e o
    monotônico do agente é `mono_origin + elapsed` (a origem é arbitrária, como a de
    `time.monotonic`). O relógio de parede do PC acompanha a API (`drift`) e fica `pc_ahead`
    segundos à frente dela. `api_step` é um salto só do relógio da API.
    """

    def __init__(
        self, *, pc_ahead: float = 0.0, mono_origin: float = 5000.0, seeded: bool = True
    ) -> None:
        self.elapsed = 0.0
        self.drift = 0.0
        self.api_step = 0.0
        self.pc_ahead = pc_ahead
        self.skews: list[float] = []
        self.refusals: list[float] = []
        self.unstable: list[int] = []
        self.clock = ClockOffset(
            now=lambda: NOW + timedelta(seconds=self.elapsed - self.drift + self.pc_ahead),
            monotonic=lambda: mono_origin + self.elapsed,
            on_skew=self.skews.append,
            on_refused=self.refusals.append,
            on_unstable=self.unstable.append,
        )
        self.pc = FakeInput()
        self.power = FakePower()
        self.launcher = FakeLauncher()
        self.use = PcUseTracker(lambda: mono_origin + self.elapsed)
        self.handlers = dict(
            pc_handlers(
                self.pc,
                self.power,
                self.launcher,
                [PcApp("notas", "Notas", "notepad")],
                shutdown_delay_seconds=30,
                clock=self.clock,
                use=self.use,
            )
        )
        if seeded:
            # A estimativa só existe depois de dois batimentos que concordam.
            self.heartbeat(0.2)
            self.heartbeat(0.2)

    def stamp(self, in_flight: float) -> str:
        """O `ts` de uma mensagem que a API montou `in_flight` s antes de chegar."""
        seconds = self.elapsed - self.drift - self.api_step - in_flight
        return (NOW + timedelta(seconds=seconds)).isoformat()

    def heartbeat(self, in_flight: float = 0.2) -> None:
        """Um batimento da API: o único que `ProcessMessage` conta como amostra."""
        self.clock.observe(self.stamp(in_flight))

    def beats(self, count: int, in_flight: float = 0.2, every: float = 25.0) -> None:
        for _ in range(count):
            self.elapsed += every
            self.heartbeat(in_flight)

    def suspend(self, seconds: float, *, monotonic_counts: bool) -> None:
        """O PC dorme `seconds`; a API e o relógio de parede seguem. O monotônico pode parar."""
        if monotonic_counts:
            self.elapsed += seconds
        else:
            self.drift -= seconds

    async def run(
        self, handler: str, body: dict[str, object], in_flight: float | None
    ) -> tuple[str, str]:
        sent_at = None if in_flight is None else self.stamp(in_flight)
        result = await self.handlers[handler](Command("1", handler, body, sent_at=sent_at))
        return result.status.value, result.code


async def test_only_a_command_that_runs_counts_as_use_of_the_pc() -> None:
    lab = Lab()
    assert lab.use.seconds_since_use() is None  # nada foi controlado desde que o agente subiu
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)
    assert lab.use.seconds_since_use() is None, "recusado por idade: não chegou ao adaptador"

    assert (await lab.run("pc.pointer.v1", {"dx": 1, "dy": 1}, 0.5))[0] == "ok"
    lab.elapsed += 40
    assert lab.use.seconds_since_use() == pytest.approx(40)
    assert (await lab.run("pc.key.v1", {"key": "A"}, 0.5))[0] == "ok"
    assert lab.use.seconds_since_use() == pytest.approx(0)


async def test_a_fresh_command_runs() -> None:
    lab = Lab()
    lab.heartbeat()
    assert await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5) == ("ok", "")
    assert lab.pc.calls == [("click", "LEFT", "CLICK")]


async def test_with_an_empty_window_the_age_is_unknown_and_the_command_is_accepted() -> None:
    lab = Lab(seeded=False)
    assert lab.clock.offset is None
    assert (await lab.run("pc.key.v1", {"key": "A"}, 0.5))[0] == "ok"
    # Sem referência não se recusa por idade: a API já não segura comando durante a reconexão.
    assert (await lab.run("pc.key.v1", {"key": "B"}, 25.0))[0] == "ok"
    assert (await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 25.0))[0] == "ok"
    assert [call[0] for call in lab.pc.calls] == ["key", "key", "move"]


@pytest.mark.parametrize("pc_ahead", [3.0, 60.0, -30.0])
async def test_with_a_confirmed_estimate_the_pc_wall_clock_does_not_matter(pc_ahead: float) -> None:
    lab = Lab(pc_ahead=pc_ahead)  # semeado: a estimativa existe
    assert lab.clock.offset is not None
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    assert (await lab.run("pc.pointer.v1", {"dx": 1, "dy": 1}, 0.5))[0] == "ok"
    # Pelo relógio de parede um comando de 10 s e outro de 0,5 s seriam indistinguíveis aqui.
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)


async def test_a_single_beat_is_not_enough_to_make_an_estimate() -> None:
    lab = Lab(seeded=False)
    lab.heartbeat(0.2)
    assert lab.clock.offset is None
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 30.0))[0] == "ok"


async def test_a_bad_first_beat_does_not_become_the_reference() -> None:
    lab = Lab(seeded=False)
    lab.heartbeat(-30.0)  # o primeiro batimento tem um carimbo 30 s no futuro
    lab.heartbeat(0.2)  # o segundo não concorda com o primeiro: nenhum dos dois vale ainda
    assert lab.clock.offset is None
    lab.heartbeat(0.2)  # este concorda com o segundo
    assert lab.clock.offset is not None
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)


async def test_two_beats_that_agree_within_the_margin_confirm_the_estimate() -> None:
    lab = Lab(seeded=False)
    lab.heartbeat(0.2)
    lab.heartbeat(0.5)
    assert lab.clock.offset is not None
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)


async def test_a_command_never_seeds_the_estimate() -> None:
    lab = Lab(seeded=False)
    await lab.run("pc.key.v1", {"key": "A"}, 0.5)
    await lab.run("pc.key.v1", {"key": "B"}, 25.0)
    assert lab.clock.offset is None  # só o batimento da API a inaugura


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


async def test_a_stale_key_up_is_still_executed_so_a_held_modifier_is_never_stuck() -> None:
    lab = Lab()
    lab.heartbeat()
    status = await lab.run("pc.key.v2", {"key": "ALT", "action": "UP"}, 60)
    assert status == ("ok", "")
    assert lab.pc.calls == [("key", "ALT", (), 1, "UP")]


async def test_a_stale_key_v2_that_presses_or_holds_is_rejected_as_expired() -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    assert await lab.run("pc.key.v2", {"key": "BACKSPACE", "repeat": 9}, 6.5) == (
        "rejected",
        EXPIRED,
    )
    assert await lab.run("pc.key.v2", {"key": "ALT", "action": "DOWN"}, 6.5) == (
        "rejected",
        EXPIRED,
    )
    assert lab.pc.calls == []


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


async def test_after_a_long_suspend_with_the_monotonic_counting_the_window_is_empty() -> None:
    lab = Lab()
    lab.suspend(3600, monotonic_counts=True)
    assert lab.clock.offset is None  # as amostras saíram da janela
    # O primeiro comando depois de acordar vale como chegou, ainda que o `ts` seja de 25 s atrás.
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 25.0))[0] == "ok"
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    lab.beats(2)
    assert (await lab.run("pc.click.v1", {"button": "RIGHT"}, 0.5))[0] == "ok"
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 12.0) == ("rejected", EXPIRED)


async def test_after_a_suspend_where_the_monotonic_stops_three_heartbeats_rebase_the_estimate() -> (
    None
):
    lab = Lab()
    lab.heartbeat(0.2)
    lab.suspend(3600, monotonic_counts=False)
    # A API andou uma hora que o monotônico não viu: os batimentos saem MUITO abaixo do mínimo.
    lab.beats(2)
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    lab.beats(1)  # o terceiro seguido refaz a estimativa
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 12.0) == ("rejected", EXPIRED)


async def test_the_estimate_follows_the_api_clock_once_old_samples_leave_the_window() -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    first = lab.clock.offset
    assert first is not None
    lab.elapsed = 400  # fora da janela de 5 minutos
    lab.drift = 7.0  # o relógio da API ficou 7 s para trás do monotônico do agente
    lab.heartbeat(0.2)
    lab.heartbeat(0.2)  # dois batimentos que concordam inauguram a estimativa
    assert lab.clock.offset == pytest.approx(first + 7.0)
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"


async def test_when_the_api_clock_steps_back_commands_are_accepted_again_after_three_beats() -> (
    None
):
    lab = Lab()
    lab.beats(2)
    assert (await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 0.3))[0] == "ok"
    lab.api_step = 4.0  # o relógio da API recuou 4 s
    lab.beats(1)
    # O mínimo antigo ainda vale: tudo parece 4 s mais velho.
    assert await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 0.3) == ("rejected", EXPIRED)
    assert await lab.run("pc.click.v1", {"button": "LEFT"}, 1.5) == ("rejected", EXPIRED)
    lab.beats(1)
    assert await lab.run("pc.click.v1", {"button": "LEFT"}, 1.5) == ("rejected", EXPIRED)
    lab.beats(1)  # o terceiro seguido
    assert (await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 0.3))[0] == "ok"
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 1.5))[0] == "ok"
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)


async def test_a_slow_beat_now_and_then_does_not_move_the_estimate() -> None:
    lab = Lab()
    lab.beats(1)
    base = lab.clock.offset
    for in_flight in (3.0, 3.0, 0.2, 3.0, 3.0, 0.2):  # nunca três seguidos
        lab.beats(1, in_flight)
    assert lab.clock.offset == pytest.approx(base)


async def test_a_single_future_stamped_beat_does_not_make_later_commands_look_old() -> None:
    lab = Lab()
    lab.beats(2)
    base = lab.clock.offset
    lab.heartbeat(-30.0)  # um carimbo 30 s no futuro
    assert lab.clock.offset == pytest.approx(base)
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    # Nem cinco minutos depois: sem o envenenamento, a idade segue certa.
    lab.beats(10)
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)


async def test_a_real_forward_step_of_the_api_clock_is_followed_after_three_beats() -> None:
    lab = Lab()
    lab.beats(2)
    lab.api_step = -30.0  # a API avançou 30 s: os carimbos passam a vir 30 s à frente
    lab.beats(3)
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)


async def test_dropping_pointer_moves_for_age_over_and_over_is_reported_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    lab = Lab()
    lab.heartbeat(0.2)
    with caplog.at_level("WARNING"):
        for _ in range(20):
            await lab.run("pc.pointer.v1", {"dx": 1, "dy": 1}, 8.0)
        assert caplog.text == ""  # vinte seguidos ainda não é "sem parar"
        for _ in range(30):
            await lab.run("pc.pointer.v1", {"dx": 1, "dy": 1}, 8.0)
        assert caplog.text.count("descartado por idade") == 1
        assert len(lab.refusals) == 1
        # Um movimento aceito encerra a sequência; a próxima, se vier, avisa de novo.
        assert (await lab.run("pc.pointer.v1", {"dx": 1, "dy": 1}, 0.3))[0] == "ok"
        for _ in range(21):
            await lab.run("pc.pointer.v1", {"dx": 1, "dy": 1}, 8.0)
    assert caplog.text.count("descartado por idade") == 2
    assert len(lab.refusals) == 2


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


async def test_a_small_api_clock_step_back_is_rebased_after_three_beats() -> None:
    lab = Lab()
    assert (await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 1.2))[0] == "ok"
    lab.api_step = 1.2  # o relógio da API recuou 1,2 s
    lab.beats(1)
    assert await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 1.2) == ("rejected", EXPIRED)
    lab.beats(1)
    assert await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 1.2) == ("rejected", EXPIRED)
    lab.beats(1)  # o terceiro seguido refaz a estimativa
    assert (await lab.run("pc.pointer.v1", {"dx": 5, "dy": 5}, 1.2))[0] == "ok"
    assert await lab.run("pc.click.v1", {"button": "RIGHT"}, 10.0) == ("rejected", EXPIRED)


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


async def test_an_old_outlier_streak_does_not_survive_an_empty_window() -> None:
    lab = Lab()
    lab.api_step = 4.0
    lab.beats(2)  # duas fora do esperado: falta uma para refazer a estimativa
    lab.suspend(3600, monotonic_counts=True)  # a janela esvazia
    assert lab.clock.offset is None
    lab.beats(2)  # dois batimentos que concordam (com a API 4 s atrás) confirmam de novo
    confirmed = lab.clock.offset
    assert confirmed is not None
    lab.api_step = 8.0
    lab.beats(1)  # UM batimento fora do esperado: com a sequência velha, seriam três
    assert lab.clock.offset == pytest.approx(confirmed)
    assert (await lab.run("pc.click.v1", {"button": "LEFT"}, 0.5))[0] == "ok"


async def test_a_link_whose_beats_never_agree_is_reported_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    lab = Lab(seeded=False)
    with caplog.at_level("DEBUG"):
        for beat in range(30):
            lab.elapsed += 25.0
            lab.heartbeat(0.2 if beat % 2 else 3.0)  # cada par discorda do anterior
    assert lab.clock.offset is None
    assert lab.unstable == [10]
    assert caplog.text.count("enlace instável") == 1
    # Dois que concordam, enfim, formam a estimativa e zeram a contagem.
    lab.beats(2)
    assert lab.clock.offset is not None
