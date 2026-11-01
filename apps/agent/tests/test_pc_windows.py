"""Adaptador do Windows com `SendInput` trocado por um registro: nada mexe no mouse real."""

import subprocess
import sys
from collections.abc import Callable, Sequence

import pytest

from uniover_agent.adapters import pc_windows
from uniover_agent.adapters.pc_inputs import MOUSE_MOVE, RawInput
from uniover_agent.adapters.pc_windows import WindowsPcInput, WindowsPcLauncher, WindowsPcPower
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
