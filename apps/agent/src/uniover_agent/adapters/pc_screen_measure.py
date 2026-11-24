"""Medição local do custo da tela ao vivo (captura e JPEG), sem rede e sem gravar imagem.

Uso no Windows: `python -m uniover_agent.adapters.pc_screen_measure [segundos]`.
Sai com código 1 se algum limite não for cumprido."""

import sys
from collections.abc import Callable
from dataclasses import dataclass
from time import monotonic, process_time, sleep

MIN_FPS = 5.0
MAX_CPU_PERCENT = 25.0
MAX_PRIVATE_MB = 80.0
WIDTH = 1280
TARGET_FPS = 8


@dataclass(frozen=True)
class Measurement:
    fps: float
    cpu_percent: float
    private_mb: float

    def failures(self) -> list[str]:
        problems = []
        if self.fps < MIN_FPS:
            problems.append(f"quadros por segundo {self.fps:.1f} < {MIN_FPS}")
        if self.cpu_percent > MAX_CPU_PERCENT:
            problems.append(f"CPU {self.cpu_percent:.1f}% > {MAX_CPU_PERCENT}%")
        if self.private_mb > MAX_PRIVATE_MB:
            problems.append(f"memória {self.private_mb:.1f} MB > {MAX_PRIVATE_MB} MB")
        return problems


@dataclass(frozen=True)
class Clocks:
    """Relógios injetáveis, para medir sem esperar de verdade nos testes."""

    wall: Callable[[], float] = monotonic
    cpu: Callable[[], float] = process_time
    pause: Callable[[float], None] = sleep


def measure(
    capture: Callable[[], object],
    private_bytes: Callable[[], int],
    seconds: float,
    clocks: Clocks | None = None,
) -> Measurement:
    """Captura durante `seconds`, no máximo a `TARGET_FPS`, como se o telefone sempre pedisse."""
    clocks = clocks or Clocks()
    clock, cpu_clock, pause = clocks.wall, clocks.cpu, clocks.pause
    start, cpu_start = clock(), cpu_clock()
    frames, peak = 0, 0
    while clock() - start < seconds:
        begin = clock()
        capture()
        frames += 1
        peak = max(peak, private_bytes())
        pause(max(0.0, 1 / TARGET_FPS - (clock() - begin)))
    elapsed = clock() - start
    return Measurement(
        fps=frames / elapsed if elapsed > 0 else 0.0,
        cpu_percent=100 * (cpu_clock() - cpu_start) / elapsed if elapsed > 0 else 0.0,
        private_mb=peak / 1_000_000,
    )


def main(argv: list[str]) -> int:
    from uniover_agent.adapters.pc_screen_worker import (  # noqa: PLC0415
        FrameRequest,
        capture_frame,
        private_bytes,
    )

    seconds = float(argv[0]) if argv else 10.0
    request = FrameRequest(WIDTH, 8, 0, True)
    result = measure(lambda: capture_frame(request), private_bytes, seconds)
    print(f"{result.fps:.1f} qps, CPU {result.cpu_percent:.1f}%, {result.private_mb:.1f} MB")
    problems = result.failures()
    for problem in problems:
        print(f"FALHOU: {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
