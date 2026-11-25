"""Toque na tela do PC: do ponto relativo ao pixel físico, com DPI misto e vários arranjos.

Nenhum teste aqui move o mouse: o envio, a leitura dos monitores e a janela sob o ponto são dublês.
"""

from collections.abc import Sequence
from dataclasses import dataclass

import pytest

from uniover_agent.adapters.pc_inputs import (
    MOUSE_ABSOLUTE,
    MOUSE_LEFTDOWN,
    MOUSE_LEFTUP,
    MOUSE_MOVE,
    MOUSE_VIRTUALDESK,
    RawInput,
    abs_move_inputs,
)
from uniover_agent.adapters.pc_windows import (
    PER_MONITOR_AWARE_V2,
    PartialSendError,
    WindowsPcInput,
    read_physical_layout,
)
from uniover_agent.core.pc.absolute import (
    NORMALIZED_MAX,
    RELATIVE_MAX,
    STALE_LAYOUT,
    AbsoluteTarget,
    LayoutChanged,
    MonitorArea,
    locate,
    normalized,
    physical_point,
    virtual_desk,
)
from uniover_agent.ports.pc import CAUSE_ELEVATED_WINDOW, PcInputRefused

from .test_pc_windows import Recorder, Timers

# Arranjos em pixels físicos (como `EnumDisplayMonitors` os dá com a thread no modo por monitor).
# Um monitor a 150 % tem os mesmos pixels físicos; o que muda é o que um processo sem DPI veria.
LAYOUTS: dict[str, list[MonitorArea]] = {
    # O principal à esquerda (100 %) e um 1440p à direita (150 %), alinhados pelo topo.
    "lado_a_lado": [MonitorArea(0, 0, 0, 1920, 1080), MonitorArea(1, 1920, 0, 2560, 1440)],
    # O segundo à esquerda do principal: o desktop virtual começa em x negativo, e mais alto.
    "origem_negativa": [MonitorArea(0, 0, 0, 1920, 1080), MonitorArea(1, -2560, -360, 2560, 1440)],
    # Um em cima do outro (125 % no de cima).
    "empilhados": [MonitorArea(0, 0, 0, 1920, 1080), MonitorArea(1, 320, -1200, 1920, 1200)],
    # Três, somando 6400 de largura (o eixo onde o arredondamento mais pesa).
    "tres_largos": [
        MonitorArea(0, 0, 0, 2560, 1440),
        MonitorArea(1, 2560, 0, 1920, 1080),
        MonitorArea(2, -1920, 200, 1920, 1200),
    ],
    # Um 4K a 150 % sozinho.
    "um_4k": [MonitorArea(0, 0, 0, 3840, 2160)],
}

# A posição relativa em vários pontos, inclusive as bordas.
RELATIVE_POINTS = [0, 1, 7, 4096, 16384, 32767, 32768, 49151, 65000, 65534, RELATIVE_MAX]


def _round_half_up(numerator: int, denominator: int) -> int:
    return (2 * numerator + denominator) // (2 * denominator)


def windows_truncating(n: int, origin: int, size: int) -> int:
    """Um modelo da volta do Windows: `origem + n * tamanho / 65536`, truncado."""
    return origin + n * size // 65536


def windows_rounding(n: int, origin: int, size: int) -> int:
    """O outro modelo comum: `origem + round(n * (tamanho - 1) / 65535)`."""
    return origin + _round_half_up(n * (size - 1), NORMALIZED_MAX)


def target_for(monitor: MonitorArea, u: int, v: int) -> AbsoluteTarget:
    return AbsoluteTarget(monitor.id, u, v, monitor.width, monitor.height)


@pytest.mark.parametrize("name", sorted(LAYOUTS))
def test_every_point_lands_within_one_physical_pixel_under_both_windows_roundings(
    name: str,
) -> None:
    monitors = LAYOUTS[name]
    left, top, width, height = virtual_desk(monitors)
    for monitor in monitors:
        for u in RELATIVE_POINTS:
            for v in RELATIVE_POINTS:
                target = target_for(monitor, u, v)
                (x, y), (nx, ny) = locate(monitors, target)
                # O pixel pedido: a mesma fração do monitor, nas bordas exatamente o primeiro e o
                # último pixel dele.
                assert monitor.left <= x < monitor.left + monitor.width
                assert monitor.top <= y < monitor.top + monitor.height
                assert abs(x - (monitor.left + u * (monitor.width - 1) / RELATIVE_MAX)) <= 0.5
                assert abs(y - (monitor.top + v * (monitor.height - 1) / RELATIVE_MAX)) <= 0.5
                assert 0 <= nx <= NORMALIZED_MAX and 0 <= ny <= NORMALIZED_MAX
                for back in (windows_truncating, windows_rounding):
                    assert abs(back(nx, left, width) - x) <= 1, (name, back.__name__, u)
                    assert abs(back(ny, top, height) - y) <= 1, (name, back.__name__, v)


def test_the_corners_of_each_monitor_are_its_first_and_last_pixels() -> None:
    monitors = LAYOUTS["origem_negativa"]
    second = monitors[1]
    assert physical_point(monitors, target_for(second, 0, 0)) == (-2560, -360)
    assert physical_point(monitors, target_for(second, RELATIVE_MAX, RELATIVE_MAX)) == (-1, 1079)
    # O canto de cima à esquerda do desktop virtual é o 0 absoluto; o de baixo à direita, o máximo.
    assert normalized(-2560, -360, virtual_desk(monitors)) == (0, 0)
    assert normalized(1919, 1079, virtual_desk(monitors)) == (NORMALIZED_MAX, NORMALIZED_MAX)


def test_a_gone_or_resized_monitor_is_a_stale_layout_and_nothing_is_guessed() -> None:
    monitors = LAYOUTS["lado_a_lado"]
    with pytest.raises(LayoutChanged) as gone:
        physical_point(monitors, AbsoluteTarget(2, 0, 0, 1920, 1080))
    assert gone.value.cause == STALE_LAYOUT
    # A resolução do segundo mudou depois do `s.mon` que o app usou.
    with pytest.raises(LayoutChanged):
        physical_point(monitors, AbsoluteTarget(1, 0, 0, 1920, 1080))
    with pytest.raises(LayoutChanged):
        locate([], AbsoluteTarget(0, 0, 0, 1920, 1080))


@dataclass(frozen=True)
class _Monitor:
    id: int
    left: int
    top: int
    width: int
    height: int


class DpiThread:
    """A thread do agente sem modo de DPI: lida assim, um monitor a 150 % vem em pixels lógicos."""

    PHYSICAL = (_Monitor(0, 0, 0, 1920, 1080), _Monitor(1, 1920, 0, 2560, 1440))
    # O que um processo sem DPI vê do mesmo arranjo (o segundo encolhido por 1,5).
    LOGICAL = (_Monitor(0, 0, 0, 1920, 1080), _Monitor(1, 1920, 0, 1707, 960))

    def __init__(self) -> None:
        self.context = 17  # um modo qualquer que não é o por monitor
        self.history: list[int] = []

    def set_context(self, context: int) -> int:
        previous, self.context = self.context, context
        self.history.append(context)
        return previous

    def enumerate(self) -> Sequence[_Monitor]:
        return self.PHYSICAL if self.context == PER_MONITOR_AWARE_V2 else self.LOGICAL


def test_the_layout_is_read_in_physical_pixels_and_the_thread_mode_is_restored() -> None:
    thread = DpiThread()
    layout = read_physical_layout(thread.set_context, thread.enumerate)
    assert layout == [MonitorArea(0, 0, 0, 1920, 1080), MonitorArea(1, 1920, 0, 2560, 1440)]
    assert thread.history == [PER_MONITOR_AWARE_V2, 17]
    assert thread.context == 17
    # Lido sem o modo por monitor, o tamanho não bate com o `s.mon` (físico): recusa, não erra.
    logical = [MonitorArea(m.id, m.left, m.top, m.width, m.height) for m in DpiThread.LOGICAL]
    with pytest.raises(LayoutChanged):
        physical_point(logical, AbsoluteTarget(1, 32768, 32768, 2560, 1440))


def test_logical_rectangles_would_miss_the_target_by_far_more_than_two_pixels() -> None:
    """O cuidado com o DPI importa: com os retângulos lógicos e o tamanho tirado deles, o mesmo
    toque cairia longe (o que este conjunto de testes pegaria pelo limite de 1 pixel acima)."""
    physical = [MonitorArea(m.id, m.left, m.top, m.width, m.height) for m in DpiThread.PHYSICAL]
    logical = [MonitorArea(m.id, m.left, m.top, m.width, m.height) for m in DpiThread.LOGICAL]
    u = v = 49151
    (x, y), _ = locate(physical, AbsoluteTarget(1, u, v, 2560, 1440))
    (lx, ly), (nx, ny) = locate(logical, AbsoluteTarget(1, u, v, 1707, 960))
    # A posição absoluta calculada no desktop lógico, aplicada pelo Windows ao desktop físico.
    left, top, width, height = virtual_desk(physical)
    landed = (windows_rounding(nx, left, width), windows_rounding(ny, top, height))
    assert abs(landed[0] - x) > 2 or abs(landed[1] - y) > 2
    assert (lx, ly) != (x, y)


def test_a_thread_that_cannot_change_mode_is_left_as_it_was() -> None:
    calls: list[int] = []

    def refuse(context: int) -> int:
        calls.append(context)
        return 0  # o Windows antigo não tem o modo: nada a restaurar

    read_physical_layout(refuse, lambda: DpiThread.PHYSICAL)
    assert calls == [PER_MONITOR_AWARE_V2]


@pytest.mark.parametrize(
    "body",
    [
        {"m": True, "u": 0, "v": 0, "w": 10, "h": 10},
        {"m": 0, "u": -1, "v": 0, "w": 10, "h": 10},
        {"m": 0, "u": 0, "v": 65536, "w": 10, "h": 10},
        {"m": 0, "u": 0.5, "v": 0, "w": 10, "h": 10},
        {"m": 0, "u": 0, "v": 0, "w": 0, "h": 10},
        {"m": 64, "u": 0, "v": 0, "w": 10, "h": 10},
        {"m": 0, "u": 0, "v": 0, "w": 10},
    ],
)
def test_the_adapter_rejects_positions_outside_the_contract(body: dict[str, object]) -> None:
    with pytest.raises(ValueError, match="contrato"):
        AbsoluteTarget.from_body(body)


def test_the_absolute_move_carries_both_flags_and_never_leaves_the_scale() -> None:
    (event,) = abs_move_inputs(70000, -5)
    assert event.flags == MOUSE_MOVE | MOUSE_ABSOLUTE | MOUSE_VIRTUALDESK
    assert (event.dx, event.dy) == (0xFFFF, 0)


SIDE = LAYOUTS["lado_a_lado"]
LEFT_DOWN = RawInput("mouse", MOUSE_LEFTDOWN)
LEFT_UP = RawInput("mouse", MOUSE_LEFTUP)
MIDDLE_OF_SECOND = AbsoluteTarget(1, 32768, 32768, 2560, 1440)


def _abs_event(target: AbsoluteTarget, monitors: Sequence[MonitorArea] = SIDE) -> RawInput:
    _, (nx, ny) = locate(monitors, target)
    (event,) = abs_move_inputs(nx, ny)
    return event


def make(
    send: object | None = None,
    *,
    layout: list[MonitorArea] | None = None,
    elevated: bool = False,
    timers: Timers | None = None,
    now: list[float] | None = None,
) -> tuple[WindowsPcInput, Recorder]:
    recorder = Recorder()
    clock = now if now is not None else [0.0]
    pc = WindowsPcInput(
        send or recorder,  # type: ignore[arg-type]
        monotonic=lambda: clock[0],
        dead_man_seconds=30,
        start_timer=timers or Timers(),
        layout=lambda: SIDE if layout is None else layout,
        elevated_at=lambda _x, _y: elevated,
    )
    return pc, recorder


def test_a_tap_moves_and_clicks_in_a_single_batch() -> None:
    pc, sent = make()
    pc.tap(MIDDLE_OF_SECOND, "LEFT", "CLICK")
    assert sent.batches == [[_abs_event(MIDDLE_OF_SECOND), LEFT_DOWN, LEFT_UP]]


def test_a_drag_across_monitors_puts_down_moves_and_lets_go() -> None:
    timers = Timers()
    pc, sent = make(timers=timers)
    start = AbsoluteTarget(0, 1000, 1000, 1920, 1080)
    pc.tap(start, "LEFT", "DOWN")
    assert timers.live(), "botão apertado: a soltura automática fica armada"
    pc.move_to(MIDDLE_OF_SECOND)
    pc.tap(MIDDLE_OF_SECOND, "LEFT", "UP")
    assert sent.batches == [
        [_abs_event(start), LEFT_DOWN],
        [_abs_event(MIDDLE_OF_SECOND)],
        [_abs_event(MIDDLE_OF_SECOND), LEFT_UP],
    ]
    assert timers.live() == []


def test_a_drag_left_still_is_released_by_the_dead_man_timer() -> None:
    now = [0.0]
    timers = Timers()
    pc, sent = make(timers=timers, now=now)
    pc.tap(MIDDLE_OF_SECOND, "LEFT", "DOWN")
    now[0] = 30
    timers.fire_last()
    assert sent.batches[-1] == [LEFT_UP]


def test_the_up_of_a_stale_layout_lets_go_without_moving() -> None:
    layout = list(SIDE)
    pc, sent = make(layout=layout)
    pc.tap(MIDDLE_OF_SECOND, "LEFT", "DOWN")
    layout[1] = MonitorArea(1, 1920, 0, 1920, 1080)  # o segundo mudou de resolução no meio
    with pytest.raises(LayoutChanged):
        pc.move_to(MIDDLE_OF_SECOND)
    pc.tap(MIDDLE_OF_SECOND, "LEFT", "UP")
    assert sent.batches[-1] == [LEFT_UP]


def test_the_up_lets_go_even_when_the_monitors_cannot_be_read() -> None:
    reads = [0]

    def flaky_layout() -> list[MonitorArea]:
        reads[0] += 1
        if reads[0] > 1:
            raise OSError("Falha ao enumerar os monitores.")
        return SIDE

    sent = Recorder()
    pc = WindowsPcInput(
        sent, start_timer=Timers(), layout=flaky_layout, elevated_at=lambda *_: False
    )
    pc.tap(MIDDLE_OF_SECOND, "LEFT", "DOWN")
    pc.tap(MIDDLE_OF_SECOND, "LEFT", "UP")
    assert sent.batches[-1] == [LEFT_UP]


def test_a_tap_on_a_stale_layout_sends_nothing() -> None:
    pc, sent = make()
    with pytest.raises(LayoutChanged):
        pc.tap(AbsoluteTarget(1, 0, 0, 1920, 1080), "LEFT", "CLICK")
    assert sent.batches == []


def test_a_tap_on_an_elevated_window_reports_the_cause_and_sends_nothing() -> None:
    pc, sent = make(elevated=True)
    with pytest.raises(PcInputRefused) as refused:
        pc.tap(MIDDLE_OF_SECOND, "LEFT", "DOUBLE")
    assert refused.value.cause == CAUSE_ELEVATED_WINDOW
    assert sent.batches == []
    # Soltar nunca é barrado pela janela de administrador.
    pc.tap(MIDDLE_OF_SECOND, "LEFT", "UP")
    assert sent.batches == [[_abs_event(MIDDLE_OF_SECOND), LEFT_UP]]


def test_a_tap_whose_elevation_cannot_be_measured_still_goes() -> None:
    def broken(_x: int, _y: int) -> bool:
        raise OSError("sem acesso")

    sent = Recorder()
    pc = WindowsPcInput(sent, start_timer=Timers(), layout=lambda: SIDE, elevated_at=broken)
    pc.tap(MIDDLE_OF_SECOND, "LEFT", "CLICK")
    assert len(sent.batches) == 1


def test_a_partially_accepted_tap_releases_the_button_it_pressed() -> None:
    batches: list[list[RawInput]] = []
    accept = [2]

    def partial(inputs: Sequence[RawInput]) -> None:
        batch = list(inputs)
        limit = accept.pop(0) if accept else None
        if limit is not None and limit < len(batch):
            batches.append(batch[:limit])
            raise PartialSendError(limit, len(batch))
        batches.append(batch)

    pc, _ = make(partial)
    with pytest.raises(PartialSendError):
        pc.tap(MIDDLE_OF_SECOND, "LEFT", "CLICK")
    # O movimento e o apertar entraram, o soltar não: o adaptador solta na hora.
    assert batches == [[_abs_event(MIDDLE_OF_SECOND), LEFT_DOWN], [LEFT_UP]]
