"""Adaptador do Windows com `SendInput` trocado por um registro: nada mexe no mouse real."""

import subprocess
import sys
from collections.abc import Callable, Sequence

import pytest

from uniover_agent.adapters import pc_windows
from uniover_agent.adapters.pc_inputs import (
    KEY_UNICODE,
    KEY_UP,
    MOUSE_LEFTDOWN,
    MOUSE_LEFTUP,
    MOUSE_MOVE,
    MOUSE_RIGHTDOWN,
    MOUSE_RIGHTUP,
    RawInput,
    UnknownKey,
)
from uniover_agent.adapters.pc_windows import (
    PartialSendError,
    WindowsPcInput,
    WindowsPcLauncher,
    WindowsPcPower,
)
from uniover_agent.ports.pc import PcUnsupported


class Recorder:
    def __init__(self) -> None:
        self.batches: list[list[RawInput]] = []

    def __call__(self, inputs: Sequence[RawInput]) -> None:
        self.batches.append(list(inputs))


def test_each_command_is_a_single_batch_to_the_system() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent)
    pc.move(5, 6)
    pc.scroll(0, 120)
    pc.click("LEFT", "DOUBLE")
    pc.key("C", ["CTRL"])
    pc.type_text("oi")
    pc.media("VOLUME_UP", 2)
    assert [len(batch) for batch in sent.batches] == [1, 1, 4, 4, 4, 4]
    assert sent.batches[0] == [RawInput("mouse", MOUSE_MOVE, 5, 6)]


def exits_with(code: int, calls: list[list[str]] | None = None) -> Callable[[list[str]], int]:
    def run(arguments: list[str]) -> int:
        if calls is not None:
            calls.append(arguments)
        return code

    return run


def test_power_runs_shutdown_with_a_countdown_and_a_notice() -> None:
    calls: list[list[str]] = []
    power = WindowsPcPower(run=exits_with(0, calls))
    power.shutdown(30)
    power.cancel_shutdown()
    assert calls[0][:3] == ["/s", "/t", "30"]
    assert "/c" in calls[0]
    assert calls[1] == ["/a"]


def test_shutdown_countdown_never_goes_below_ten_seconds() -> None:
    calls: list[list[str]] = []
    WindowsPcPower(run=exits_with(0, calls)).shutdown(0)
    assert calls[0][2] == "10"


def test_a_shutdown_the_system_refused_is_a_failure_not_a_success() -> None:
    # Política, UAC ou erro do Windows: saída diferente de zero é falha (sem auditoria de sucesso).
    with pytest.raises(OSError, match=r"agendar o desligamento.*5"):
        WindowsPcPower(run=exits_with(5)).shutdown(30)


def test_cancelling_with_no_countdown_running_is_fine_but_any_other_error_is_not() -> None:
    WindowsPcPower(run=exits_with(1116)).cancel_shutdown()
    with pytest.raises(OSError, match=r"cancelar o desligamento.*5"):
        WindowsPcPower(run=exits_with(5)).cancel_shutdown()
    with pytest.raises(OSError, match=r"cancelar o desligamento.*1"):
        WindowsPcPower(run=exits_with(1)).cancel_shutdown()


def test_the_real_runner_reports_the_exit_code_of_the_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[list[str]] = []

    def fake(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        seen.append(args)
        return subprocess.CompletedProcess(args, 1116)

    monkeypatch.setattr(pc_windows, "run_hidden", fake)
    monkeypatch.setattr(pc_windows, "IS_WINDOWS", True)
    assert pc_windows._run_shutdown(["/a"]) == 1116
    assert seen == [["shutdown", "/a"]]


def test_lock_and_sleep_report_a_refusal_from_the_system() -> None:
    power = WindowsPcPower(lock=lambda: False, suspend=lambda: False)
    with pytest.raises(OSError, match="bloquear"):
        power.lock()
    with pytest.raises(OSError, match="suspender"):
        power.sleep()


def test_lock_and_sleep_call_the_system_once() -> None:
    calls: list[str] = []

    def lock() -> bool:
        calls.append("lock")
        return True

    def suspend() -> bool:
        calls.append("sleep")
        return True

    power = WindowsPcPower(lock=lock, suspend=suspend)
    power.lock()
    power.sleep()
    assert calls == ["lock", "sleep"]


def test_launcher_hands_the_target_over() -> None:
    opened: list[str] = []
    WindowsPcLauncher(opened.append).launch("C:/Programas/app.exe")
    assert opened == ["C:/Programas/app.exe"]


@pytest.mark.skipif(sys.platform == "win32", reason="fora do Windows o sistema recusa")
def test_outside_windows_everything_is_refused() -> None:
    with pytest.raises(PcUnsupported):
        WindowsPcInput().move(1, 1)
    with pytest.raises(PcUnsupported):
        WindowsPcPower().lock()
    with pytest.raises(PcUnsupported):
        WindowsPcPower().shutdown(30)
    with pytest.raises(PcUnsupported):
        WindowsPcLauncher().launch("x")


@pytest.mark.skipif(sys.platform != "win32", reason="a estrutura nativa só existe no Windows")
def test_native_structures_match_the_windows_layout_without_sending_anything() -> None:
    # Só monta as estruturas, sem enviar evento algum. O `if` (e não só o `skipif`) é o que o mypy
    # entende: fora do Windows estas funções não existem no módulo.
    if sys.platform == "win32":
        assert pc_windows.native_size() == (40 if sys.maxsize > 2**32 else 28)
        mouse = pc_windows.to_native(RawInput("mouse", MOUSE_MOVE, 3, -4))
        assert (mouse.type, mouse.union.mi.dx, mouse.union.mi.dy) == (0, 3, -4)
        wheel = pc_windows.to_native(RawInput("mouse", 0x0800, data=-120))
        assert wheel.union.mi.mouseData == 0xFFFFFF88
        key = pc_windows.to_native(RawInput("keyboard", 0x0004, scan=0x00E7))
        assert (key.type, key.union.ki.wScan, key.union.ki.dwFlags) == (1, 0xE7, 4)


LEFT_DOWN = RawInput("mouse", MOUSE_LEFTDOWN)
LEFT_UP = RawInput("mouse", MOUSE_LEFTUP)
RIGHT_DOWN = RawInput("mouse", MOUSE_RIGHTDOWN)
RIGHT_UP = RawInput("mouse", MOUSE_RIGHTUP)


class Handle:
    def __init__(self) -> None:
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True


class Timers:
    """Temporizador falso: guarda o que foi armado e só dispara quando o teste manda."""

    def __init__(self) -> None:
        self.armed: list[tuple[float, Callable[[], None], Handle]] = []

    def __call__(self, delay: float, callback: Callable[[], None]) -> Handle:
        handle = Handle()
        self.armed.append((delay, callback, handle))
        return handle

    def live(self) -> list[tuple[float, Callable[[], None]]]:
        return [(delay, call) for delay, call, handle in self.armed if not handle.cancelled]

    def fire_last(self) -> None:
        *_, (_, callback, handle) = (a for a in self.armed if not a[2].cancelled)
        handle.cancelled = True  # um temporizador que disparou não fica mais pendente
        callback()


class Flaky:
    """`SendInput` falso que aceita só parte de certos lotes e pode recusar tudo."""

    def __init__(self) -> None:
        self.batches: list[list[RawInput]] = []
        self.accept: list[int | None] = []  # por lote: quantos aceita (None = todos)
        self.refuse_all = False

    def __call__(self, inputs: Sequence[RawInput]) -> None:
        batch = list(inputs)
        if self.refuse_all:
            raise OSError("recusou tudo")
        limit = self.accept.pop(0) if self.accept else None
        if limit is not None and limit < len(batch):
            if limit:
                self.batches.append(batch[:limit])
            raise PartialSendError(limit, len(batch))
        self.batches.append(batch)


def test_release_all_lifts_the_button_that_was_put_down() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent, start_timer=Timers())
    pc.click("LEFT", "DOWN")
    pc.release_all()
    assert sent.batches[-1] == [LEFT_UP]
    # Já solto: chamar de novo não envia mais nada.
    pc.release_all()
    assert len(sent.batches) == 2


def test_release_all_with_nothing_held_sends_nothing() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent, start_timer=Timers())
    pc.release_all()
    pc.click("LEFT", "CLICK")
    pc.move(1, 1)
    batches = len(sent.batches)
    pc.release_all()
    assert len(sent.batches) == batches


def test_a_button_put_down_and_then_up_is_not_held() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent, start_timer=Timers())
    pc.click("LEFT", "DOWN")
    pc.click("LEFT", "UP")
    pc.release_all()
    assert len(sent.batches) == 2


def test_release_all_lifts_every_held_button() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent, start_timer=Timers())
    pc.click("RIGHT", "DOWN")
    pc.click("LEFT", "DOWN")
    pc.release_all()
    assert sent.batches[-1] == [LEFT_UP, RIGHT_UP]


def test_a_partial_batch_releases_what_went_in() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky, start_timer=Timers())
    # Um duplo clique em que só 3 dos 4 eventos entraram: o terceiro é um DOWN sem UP.
    flaky.accept = [3]
    with pytest.raises(PartialSendError):
        pc.click("LEFT", "DOUBLE")
    assert flaky.batches[-1] == [LEFT_UP]
    pc.release_all()
    assert len(flaky.batches) == 2  # nada mais a soltar


def test_a_batch_the_system_took_none_of_leaves_nothing_to_release() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky, start_timer=Timers())
    flaky.refuse_all = True
    with pytest.raises(OSError, match="recusou"):
        pc.click("LEFT", "DOWN")
    flaky.refuse_all = False
    pc.release_all()
    assert flaky.batches == []


def test_a_partial_batch_does_not_drop_a_drag_already_in_progress() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky, start_timer=Timers())
    pc.click("LEFT", "DOWN")
    flaky.accept = [0]
    with pytest.raises(PartialSendError):
        pc.move(5, 5)
    # O arrasto continua: o botão segue apertado até o app soltar ou o agente soltar tudo.
    assert flaky.batches == [[LEFT_DOWN]]
    pc.release_all()
    assert flaky.batches[-1] == [LEFT_UP]


def test_a_refused_release_keeps_the_button_held_for_a_new_attempt() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky, start_timer=Timers())
    pc.click("LEFT", "DOWN")
    flaky.refuse_all = True
    pc.release_all()  # não levanta erro
    flaky.refuse_all = False
    pc.release_all()
    assert flaky.batches[-1] == [LEFT_UP]


def test_the_dead_man_timer_releases_a_button_left_down_without_traffic() -> None:
    now = [100.0]
    timers = Timers()
    sent = Recorder()
    pc = WindowsPcInput(sent, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    pc.click("LEFT", "DOWN")
    ((delay, _),) = timers.live()
    assert delay == 30
    now[0] += 30
    timers.fire_last()
    assert sent.batches[-1] == [LEFT_UP]
    assert timers.live() == []  # nada mais apertado: o temporizador não fica armado


def test_traffic_postpones_the_dead_man_timer() -> None:
    now = [0.0]
    timers = Timers()
    sent = Recorder()
    pc = WindowsPcInput(sent, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    pc.click("LEFT", "DOWN")
    now[0] = 20
    pc.move(2, 2)  # o arrasto segue vivo
    now[0] = 30
    timers.fire_last()
    # Passaram só 10 s desde o último comando: não solta, rearma para os 20 s que faltam.
    assert len(sent.batches) == 2
    ((delay, _),) = timers.live()
    assert delay == 20
    now[0] = 50
    timers.fire_last()
    assert sent.batches[-1] == [LEFT_UP]


def test_the_dead_man_timer_is_cancelled_when_the_button_is_let_go() -> None:
    timers = Timers()
    pc = WindowsPcInput(Recorder(), start_timer=timers)
    pc.click("LEFT", "DOWN")
    pc.click("LEFT", "UP")
    assert timers.live() == []


def test_a_late_firing_of_a_replaced_timer_does_nothing() -> None:
    now = [0.0]
    timers = Timers()
    sent = Recorder()
    pc = WindowsPcInput(sent, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    pc.click("LEFT", "DOWN")
    stale = timers.armed[0][1]
    pc.click("LEFT", "UP")
    pc.click("RIGHT", "DOWN")
    now[0] = 100
    stale()  # o disparo do primeiro temporizador, que já tinha sido cancelado
    assert sent.batches[-1] == [RIGHT_DOWN]
    assert len(timers.live()) == 1


def test_the_dead_man_timer_tries_again_when_the_release_was_refused() -> None:
    now = [0.0]
    timers = Timers()
    flaky = Flaky()
    pc = WindowsPcInput(flaky, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    pc.click("LEFT", "DOWN")
    flaky.refuse_all = True
    now[0] = 30
    timers.fire_last()
    ((delay, _),) = timers.live()
    assert delay == 30
    flaky.refuse_all = False
    now[0] = 60
    timers.fire_last()
    assert flaky.batches[-1] == [LEFT_UP]


ALT_DOWN = RawInput("keyboard", vk=0x12)
ALT_UP = RawInput("keyboard", flags=KEY_UP, vk=0x12)
SHIFT_DOWN = RawInput("keyboard", vk=0x10)
SHIFT_UP = RawInput("keyboard", flags=KEY_UP, vk=0x10)


def test_a_repeated_key_goes_out_as_one_batch() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent)
    pc.key("BACKSPACE", [], repeat=12)
    assert len(sent.batches) == 1
    assert len(sent.batches[0]) == 24
    pc.release_all()
    assert len(sent.batches) == 1, "uma batida completa não deixa nada apertado"


def test_a_held_modifier_stays_down_across_other_keys_and_is_let_go_by_up() -> None:
    sent = Recorder()
    timers = Timers()
    pc = WindowsPcInput(sent, start_timer=timers)
    pc.key("ALT", [], action="DOWN")
    pc.key("TAB", [])  # Alt+Tab de verdade: o Alt segue apertado entre os toques
    pc.key("TAB", ["SHIFT"])
    assert sent.batches[0] == [ALT_DOWN]
    assert ALT_UP not in [event for batch in sent.batches for event in batch]
    assert len(timers.live()) == 1, (
        "enquanto o Alt está apertado o temporizador de segurança está armado"
    )
    pc.key("ALT", [], action="UP")
    assert sent.batches[-1] == [ALT_UP]
    assert timers.live() == []
    pc.release_all()
    assert len(sent.batches) == 4, "nada ficou para soltar"


def test_release_all_lets_go_of_a_held_modifier() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent)
    pc.key("ALT", [], action="DOWN")
    pc.release_all()
    assert sent.batches == [[ALT_DOWN], [ALT_UP]]
    pc.release_all()
    assert len(sent.batches) == 2


def test_release_all_lets_go_of_the_held_keys_in_the_reverse_order_and_the_mouse_too() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent)
    pc.key("ALT", [], action="DOWN")
    pc.key("SHIFT", [], action="DOWN")
    pc.click("LEFT", "DOWN")
    pc.release_all()
    assert sent.batches[-1] == [LEFT_UP, SHIFT_UP, ALT_UP]


def test_the_dead_man_timer_lets_go_of_a_modifier_held_without_traffic() -> None:
    now = [10.0]
    timers = Timers()
    sent = Recorder()
    pc = WindowsPcInput(sent, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    pc.key("ALT", [], action="DOWN")
    ((delay, _),) = timers.live()
    assert delay == 30
    now[0] += 30
    timers.fire_last()
    assert sent.batches[-1] == [ALT_UP]
    assert timers.live() == []


def test_traffic_keeps_a_held_modifier_alive_past_the_dead_man_time() -> None:
    now = [0.0]
    timers = Timers()
    sent = Recorder()
    pc = WindowsPcInput(sent, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    pc.key("ALT", [], action="DOWN")
    now[0] = 20
    pc.move(0, 0)  # o sinal de vida do app
    now[0] = 30
    timers.fire_last()
    assert len(sent.batches) == 1, "passaram só 10 s sem tráfego: não solta"
    now[0] = 50
    timers.fire_last()
    assert sent.batches[-1] == [ALT_UP]


def test_a_refused_release_of_a_held_modifier_is_retried_by_the_dead_man_timer() -> None:
    now = [0.0]
    timers = Timers()
    flaky = Flaky()
    pc = WindowsPcInput(flaky, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    pc.key("ALT", [], action="DOWN")
    flaky.refuse_all = True
    pc.release_all()  # não levanta erro
    ((delay, _),) = timers.live()
    assert delay == 30
    flaky.refuse_all = False
    now[0] = 60
    timers.fire_last()
    assert flaky.batches[-1] == [ALT_UP]
    pc.release_all()
    assert flaky.batches[-1] == [ALT_UP] and len(flaky.batches) == 2


def test_a_partial_batch_keeps_a_modifier_already_held_and_lets_go_of_what_it_pressed() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky)
    pc.key("ALT", [], action="DOWN")
    flaky.accept = [1]  # só o SHIFT apertado entra
    with pytest.raises(PartialSendError):
        pc.key("TAB", ["SHIFT"])
    assert flaky.batches[-2:] == [[SHIFT_DOWN], [SHIFT_UP]], "o que o lote parcial apertou é solto"
    pc.release_all()
    assert flaky.batches[-1] == [ALT_UP], "o Alt segurado de antes segue até a soltura"


def test_a_batch_refused_whole_leaves_the_held_modifier_untouched() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky)
    pc.key("ALT", [], action="DOWN")
    flaky.refuse_all = True
    with pytest.raises(OSError):
        pc.key("TAB", [])
    flaky.refuse_all = False
    pc.release_all()
    assert flaky.batches[-1] == [ALT_UP]


def test_pressing_the_held_modifier_again_does_not_double_track_it() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent)
    pc.key("ALT", [], action="DOWN")
    pc.key("ALT", [], action="DOWN")
    pc.release_all()
    assert sent.batches[-1] == [ALT_UP]
    pc.release_all()
    assert len(sent.batches) == 3


def test_a_refused_hold_is_not_remembered_as_held() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky)
    flaky.refuse_all = True
    with pytest.raises(OSError):
        pc.key("ALT", [], action="DOWN")
    flaky.refuse_all = False
    pc.release_all()
    assert flaky.batches == []


def test_a_key_that_cannot_be_held_is_refused_before_anything_is_sent() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent)
    with pytest.raises(UnknownKey):
        pc.key("A", [], action="DOWN")
    assert sent.batches == []


def test_typed_text_with_an_emoji_goes_out_as_a_single_batch() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent, start_timer=Timers())
    pc.type_text("oi \U0001f600")
    (batch,) = sent.batches
    assert [event.scan for event in batch[::2]] == [ord("o"), ord("i"), ord(" "), 0xD83D, 0xDE00]


def test_a_lone_surrogate_is_refused_and_nothing_is_sent() -> None:
    sent = Recorder()
    pc = WindowsPcInput(sent, start_timer=Timers())
    with pytest.raises(ValueError, match="par substituto"):
        pc.type_text("senha\ud800")
    assert sent.batches == []


def test_a_partial_key_batch_releases_every_key_that_went_down() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky, start_timer=Timers())
    # CTRL+SHIFT+T: só os três apertos entraram, as três soluturas ficaram de fora.
    flaky.accept = [3]
    with pytest.raises(PartialSendError):
        pc.key("T", ["CTRL", "SHIFT"])
    assert [(e.vk, e.flags) for e in flaky.batches[-1]] == [
        (ord("T"), KEY_UP),
        (0x10, KEY_UP),
        (0x11, KEY_UP),
    ]
    pc.release_all()
    assert len(flaky.batches) == 2  # nada mais preso


def test_a_partial_batch_of_typed_text_releases_the_unicode_key_that_went_down() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky, start_timer=Timers())
    flaky.accept = [3]  # "a" inteiro e o aperto de "b"
    with pytest.raises(PartialSendError):
        pc.type_text("ab")
    (up,) = flaky.batches[-1]
    assert (up.scan, up.flags) == (ord("b"), KEY_UNICODE | KEY_UP)


def test_a_key_release_the_system_refused_is_retried_by_the_dead_man_timer() -> None:
    now = [0.0]
    timers = Timers()
    flaky = Flaky()
    pc = WindowsPcInput(flaky, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    flaky.accept = [2, 0]  # o lote entra em parte e a soltura que segue também é recusada
    with pytest.raises(PartialSendError):
        pc.key("T", ["CTRL"])
    ((delay, _),) = timers.live()
    assert delay == 30
    now[0] = 30
    timers.fire_last()
    assert [e.vk for e in flaky.batches[-1]] == [ord("T"), 0x11]
    assert timers.live() == []


def test_an_empty_move_sends_nothing_but_keeps_a_drag_alive() -> None:
    now = [0.0]
    timers = Timers()
    sent = Recorder()
    pc = WindowsPcInput(sent, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    pc.click("LEFT", "DOWN")
    now[0] = 20
    pc.move(0, 0)  # o app manda uma mensagem vazia para dizer que segue vivo
    assert len(sent.batches) == 1  # nenhum evento a mais no sistema
    now[0] = 30
    timers.fire_last()
    # Só 10 s desde a última mensagem: não solta, rearma para os 20 s que faltam.
    assert len(sent.batches) == 1
    ((delay, _),) = timers.live()
    assert delay == 20
    now[0] = 50
    timers.fire_last()
    assert sent.batches[-1] == [LEFT_UP]


def test_a_drag_held_still_for_the_whole_dead_man_time_is_released() -> None:
    now = [0.0]
    timers = Timers()
    sent = Recorder()
    pc = WindowsPcInput(sent, monotonic=lambda: now[0], dead_man_seconds=30, start_timer=timers)
    pc.click("LEFT", "DOWN")
    now[0] = 30  # nenhuma mensagem do PC em 30 s
    timers.fire_last()
    assert sent.batches[-1] == [LEFT_UP]


def test_a_stuck_key_is_released_at_the_start_of_the_next_dispatch_not_after_the_idle_wait() -> (
    None
):
    flaky = Flaky()
    timers = Timers()
    pc = WindowsPcInput(flaky, start_timer=timers)
    flaky.accept = [2, 0]  # CTRL e T entram apertados e a soltura que segue é recusada
    with pytest.raises(PartialSendError):
        pc.key("T", ["CTRL"])
    assert [(e.vk, e.flags) for e in flaky.batches[-1]] == [(0x11, 0), (ord("T"), 0)]
    pc.move(3, 3)  # o próximo comando, bem antes dos 30 s
    release, move = flaky.batches[-2:]
    assert [(e.vk, e.flags) for e in release] == [(ord("T"), KEY_UP), (0x11, KEY_UP)]
    assert [(e.dx, e.dy) for e in move] == [(3, 3)]
    # Soltou: nada fica pendente nem armado.
    assert timers.live() == []
    pc.release_all()
    assert len(flaky.batches) == 3


def test_a_stuck_key_that_is_still_refused_does_not_stop_the_next_dispatch() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky, start_timer=Timers())
    flaky.accept = [2, 0]
    with pytest.raises(PartialSendError):
        pc.key("T", ["CTRL"])
    flaky.accept = [0]  # a soltura de novo recusada...
    pc.move(1, 1)  # ...mas o comando novo segue o seu caminho
    assert [(e.dx, e.dy) for e in flaky.batches[-1]] == [(1, 1)]


def test_an_empty_move_also_retries_a_stuck_key() -> None:
    flaky = Flaky()
    pc = WindowsPcInput(flaky, start_timer=Timers())
    flaky.accept = [2, 0]  # CTRL e T entram apertados e a soltura que segue é recusada
    with pytest.raises(PartialSendError):
        pc.key("T", ["CTRL"])
    pc.move(0, 0)  # o movimento vazio do app, bem antes dos 30 s
    assert [(e.vk, e.flags) for e in flaky.batches[-1]] == [(ord("T"), KEY_UP), (0x11, KEY_UP)]
    pc.release_all()
    assert len(flaky.batches) == 2  # nada mais preso
