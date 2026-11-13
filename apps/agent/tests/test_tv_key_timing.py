import asyncio
import contextlib
import logging
import re
import time

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvRemote
from uniover_agent.config import Settings
from uniover_agent.core import (
    Command,
    CommandResult,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ProcessMessage,
    ResultStatus,
    TvSessionManager,
    tv_key_handler,
)
from uniover_agent.core.tv.handlers import KEY_MAX_AGE_SECONDS
from uniover_agent.core.tv.key_timing import (
    AGE_LIMIT_SECONDS,
    NAMED_KEYS,
    KeyTimings,
    key_label,
    percentile,
)
from uniover_agent.ports import TvUnreachable

from .support import AGENT_ID, dump, tv_key
from .test_tv_composition import TV_HOST, make_tv, pair_fake_tv

_LOGGER = "uniover_agent.core.tv.key_timing"
MS = 1_000_000


class NsClock:
    """Relógio de nanossegundos que só anda quando o teste manda."""

    def __init__(self) -> None:
        self.now = 1_000 * MS

    def __call__(self) -> int:
        return self.now

    def advance_ms(self, ms: float) -> None:
        self.now += round(ms * MS)


def lines(caplog: pytest.LogCaptureFixture, start: str) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith(start)]


def timings(**kw: object) -> KeyTimings:
    return KeyTimings(version="9.9.9", driver="android-remote", **kw)  # type: ignore[arg-type]


def record(t: KeyTimings, total_ms: float, *, path: str = "nuvem", **kw: object) -> None:
    """Uma tecla em que todo o tempo foi de envio (a idade e a fila zeradas)."""
    values: dict[str, object] = {
        "key": "OK",
        "path": path,
        "outcome": "ok",
        "age": None,
        "queue_ns": 0,
        "session_ns": 0,
        "send_ns": round(total_ms * MS),
    }
    values.update(kw)
    t.record(**values)  # type: ignore[arg-type]


# --- o acumulador --------------------------------------------------------------------------------


def test_nearest_rank_percentiles() -> None:
    values = [float(n) for n in range(1, 101)]
    assert percentile(values, 0.5) == 50
    assert percentile(values, 0.95) == 95
    assert percentile([7.0], 0.95) == 7


def test_nothing_is_logged_without_keys(caplog: pytest.LogCaptureFixture) -> None:
    t = timings()
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        t.report()
        t.report()
    assert caplog.records == []


def test_the_summary_has_counts_percentiles_paths_and_version(
    caplog: pytest.LogCaptureFixture,
) -> None:
    t = timings()
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        for ms in range(1, 21):  # 1..20 ms
            record(t, ms, path="nuvem" if ms % 2 else "canal direto", age=0.010)
        t.report()
    (line,) = lines(caplog, "teclas da TV no último minuto")
    assert "20 (canal direto 10, nuvem 10; ok 20)" in line
    # ponta a ponta = idade 10 + envio (1..20)
    assert "ms ponta a ponta p50 20/p95 29/máx 30" in line
    assert "idade p50 10/p95 10/máx 10" in line
    assert "envio p50 10/p95 19/máx 20" in line
    assert "lentas (>300 ms) 0" in line
    assert "driver android-remote | agente 9.9.9" in line


def test_the_window_resets_after_each_summary(caplog: pytest.LogCaptureFixture) -> None:
    t = timings()
    record(t, 900)
    t.report()
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        record(t, 5)
        t.report()
        t.report()  # janela vazia: nada
    (line,) = lines(caplog, "teclas da TV no último minuto")
    assert "1 (nuvem 1; ok 1)" in line
    assert "máx 5" in line
    assert "lentas (>300 ms) 0" in line


def test_a_slow_key_gets_its_own_line_without_naming_typed_characters(
    caplog: pytest.LogCaptureFixture,
) -> None:
    t = timings(slow_ms=300)
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        record(t, 299)
        record(t, 301, key="TYPE_a", age=0.050, queue_ns=20 * MS, session_ns=200 * MS)
    (line,) = lines(caplog, "tecla lenta da TV")
    assert line.startswith("tecla lenta da TV: 571 ms ponta a ponta | idade 50 | fila 20 |")
    assert "sessão 200 | envio 301 | caminho nuvem | resultado ok | tecla outra |" in line
    assert "TYPE" not in line


@pytest.mark.parametrize("key", ["NUM_0", "NUM_5", "NUM_9", "TYPE_a", "DEL", "QUALQUER"])
def test_only_allowed_keys_are_named_and_digits_never_are(
    key: str, caplog: pytest.LogCaptureFixture
) -> None:
    t = timings()
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        record(t, 1_000, key=key)
    (line,) = lines(caplog, "tecla lenta da TV")
    assert "| tecla outra |" in line
    assert key not in line


@pytest.mark.parametrize("key", ["UP", "OK", "BACK", "HOME", "VOLUME_UP", "CHANNEL_DOWN", "MENU"])
def test_semantic_keys_keep_their_name(key: str, caplog: pytest.LogCaptureFixture) -> None:
    t = timings()
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        record(t, 1_000, key=key)
    (line,) = lines(caplog, "tecla lenta da TV")
    assert f"| tecla {key} |" in line


def test_no_digit_or_typing_key_is_in_the_allowed_list() -> None:
    assert not any(k.startswith(("NUM_", "TYPE_")) for k in NAMED_KEYS)
    assert key_label("NUM_1") == "outra"


def test_the_age_limit_is_the_stale_key_limit() -> None:
    assert AGE_LIMIT_SECONDS == KEY_MAX_AGE_SECONDS


@pytest.mark.parametrize("age", [3_600_000.0, -5.0])
def test_an_impossible_age_saturates_and_is_counted_apart(
    age: float, caplog: pytest.LogCaptureFixture
) -> None:
    t = timings(slow_ms=1e12)
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        record(t, 10, age=0.020)
        record(t, 10, age=age)
        t.report()
    (line,) = lines(caplog, "teclas da TV no último minuto")
    # a idade válida (20) sozinha nos percentis; a inválida contada à parte
    assert "idade p50 20/p95 20/máx 20 (inválida 1)" in line
    # no ponta a ponta a idade satura: no limite (1500) ou em 0
    expected = "p50 30/p95 1510/máx 1510" if age > 0 else "p50 10/p95 30/máx 30"
    assert f"ms ponta a ponta {expected}" in line


def test_an_impossible_age_on_a_slow_key_line_is_marked(
    caplog: pytest.LogCaptureFixture,
) -> None:
    t = timings()
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        record(t, 10, age=1e9)
    (line,) = lines(caplog, "tecla lenta da TV")
    assert line.startswith("tecla lenta da TV: 1510 ms ponta a ponta | idade inválida |")


def test_slow_lines_are_capped_per_window_and_the_rest_is_counted(
    caplog: pytest.LogCaptureFixture,
) -> None:
    t = timings(slow_lines=2)
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        for _ in range(5):
            record(t, 1_000, outcome="tv_unreachable", send_ns=None, session_ns=1_000 * MS)
        t.report()
        record(t, 1_000)
    assert len(lines(caplog, "tecla lenta da TV")) == 3  # 2 na primeira janela, 1 na segunda
    (summary,) = lines(caplog, "teclas da TV no último minuto")
    assert "tv_unreachable 5" in summary
    assert "envio n/d" in summary
    assert "lentas (>300 ms) 5 (2 detalhadas)" in summary


def test_samples_are_bounded_but_count_and_maximum_are_not(
    caplog: pytest.LogCaptureFixture,
) -> None:
    t = timings(max_samples=3, slow_ms=10_000)
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        for ms in (1, 2, 3, 4, 500):
            record(t, ms)
        t.report()
    (line,) = lines(caplog, "teclas da TV no último minuto")
    assert line.startswith("teclas da TV no último minuto: 5 (nuvem 5; ok 5)")
    assert "ms ponta a ponta p50 2/p95 3/máx 500" in line


def test_every_segment_keeps_its_maximum_beyond_the_samples(
    caplog: pytest.LogCaptureFixture,
) -> None:
    t = timings(max_samples=2, slow_ms=1e12)
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        record(t, 1, age=0.001, queue_ns=1 * MS, session_ns=1 * MS)
        record(t, 1, age=0.001, queue_ns=1 * MS, session_ns=1 * MS)
        # fora das amostras: cada trecho tem um pico próprio
        record(t, 70, age=0.900, queue_ns=80 * MS, session_ns=60 * MS)
        t.report()
    (line,) = lines(caplog, "teclas da TV no último minuto")
    assert "idade p50 1/p95 1/máx 900" in line
    assert "fila p50 1/p95 1/máx 80" in line
    assert "sessão p50 1/p95 1/máx 60" in line
    assert "envio p50 1/p95 1/máx 70" in line
    assert "máx 1110 | idade" in line  # ponta a ponta: 900 + 80 + 60 + 70


async def test_closing_writes_the_current_window(caplog: pytest.LogCaptureFixture) -> None:
    t = timings()
    record(t, 5)
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        await t.aclose()
        await t.aclose()  # janela já vazia: nada de novo
    (line,) = lines(caplog, "teclas da TV no último minuto")
    assert "1 (nuvem 1; ok 1)" in line


def test_the_tv_setup_closes_the_timings_after_the_drain(monkeypatch: pytest.MonkeyPatch) -> None:
    """O resumo final é um `closer` da TV: o encerramento os chama depois do dreno das teclas."""
    pair_fake_tv(monkeypatch, FakeTvRemote())
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    owners = [getattr(close, "__self__", None) for close in setup.closers]
    (key_timings,) = [owner for owner in owners if isinstance(owner, KeyTimings)]
    assert key_timings.aclose in setup.closers
    assert key_timings.run in setup.background


async def test_run_reports_once_per_window() -> None:
    clock = FakeClock()
    reports: list[int] = []
    t = KeyTimings(version="x", driver="d", report_every=60.0, sleep=clock.sleep)
    t.report = lambda: reports.append(1)  # type: ignore[method-assign]
    task = asyncio.create_task(t.run())
    for _ in range(10):
        await asyncio.sleep(0)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert set(clock.sleeps) == {60.0}
    assert len(reports) >= 2


# --- integração: ProcessMessage + handler + sessão com TV falsa ----------------------------------


class SlowRemote(FakeTvRemote):
    """TV falsa cujo envio leva `send_ms` no relógio de nanossegundos."""

    def __init__(self, ns: NsClock) -> None:
        super().__init__()
        self._ns = ns
        self.send_ms = 2.0

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        self._ns.advance_ms(self.send_ms)
        await super().send_key(key, direction)


def build(ns: NsClock, remote: FakeTvRemote, t: KeyTimings) -> ProcessMessage:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    keys = tv_key_handler(TvSessionManager(clock, remote), timings=t, clock_ns=ns)
    return ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({"tv.key.v1": keys}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        FakeTransport(),
        timestamp_age=lambda _ts: 0.040,
        clock_ns=ns,
    )


async def test_keys_through_the_queue_become_one_summary_line(
    caplog: pytest.LogCaptureFixture,
) -> None:
    ns = NsClock()
    remote = SlowRemote(ns)
    t = timings()
    process = build(ns, remote, t)
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        for key in ("UP", "DOWN", "OK", "BACK"):
            await process(dump(tv_key(key)))
        await process.drain(1.0)
        t.report()
    assert remote.keys == ["UP", "DOWN", "OK", "BACK"]
    assert lines(caplog, "tecla lenta da TV") == []
    (line,) = lines(caplog, "teclas da TV no último minuto")
    assert line.startswith("teclas da TV no último minuto: 4 (nuvem 4; ok 4)")
    # Chegaram juntas: cada uma espera na fila o envio das anteriores (0, 2, 4 e 6 ms); ponta a
    # ponta = idade 40 (do `ts`) + fila + envio 2 na TV falsa.
    assert "ms ponta a ponta p50 44/p95 48/máx 48" in line
    assert "idade p50 40/p95 40/máx 40" in line
    assert "fila p50 2/p95 6/máx 6" in line
    assert "sessão p50 0/p95 0/máx 0" in line
    assert "envio p50 2/p95 2/máx 2" in line


async def test_a_slow_key_through_the_queue_gets_a_detailed_line(
    caplog: pytest.LogCaptureFixture,
) -> None:
    ns = NsClock()
    remote = SlowRemote(ns)
    remote.send_ms = 400.0
    t = timings()
    process = build(ns, remote, t)
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        await process(dump(tv_key("HOME")))
        await process.drain(1.0)
    (line,) = lines(caplog, "tecla lenta da TV")
    assert line.startswith("tecla lenta da TV: 440 ms ponta a ponta | idade 40 | fila 0 |")
    assert "envio 400 | caminho nuvem | resultado ok | tecla HOME | driver android-remote" in line


async def test_a_direct_key_counts_the_wait_before_the_main_loop_took_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    ns = NsClock()
    t = timings()
    process = build(ns, SlowRemote(ns), t)
    results: list[CommandResult] = []
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        # O canal recebeu a tecla 200 ms antes de o laço principal a pegar (uma pausa do laço).
        process.submit_direct_tv(
            Command("d1", "tv.key.v1", {"key": "OK"}), time.monotonic() - 0.2, results.append
        )
        await process.drain(1.0)
        t.report()
    assert [r.status for r in results] == [ResultStatus.OK]
    (line,) = lines(caplog, "teclas da TV no último minuto")
    assert line.startswith("teclas da TV no último minuto: 1 (canal direto 1; ok 1)")
    assert "idade n/d" in line
    match = re.search(r"fila p50 (\d+)/", line)
    assert match is not None
    assert 200 <= int(match.group(1)) < 260


async def test_a_failed_key_is_counted_by_its_code(caplog: pytest.LogCaptureFixture) -> None:
    ns = NsClock()
    remote = FakeTvRemote()
    remote.connect_errors = [TvUnreachable("x") for _ in range(4)]
    t = timings()
    process = build(ns, remote, t)
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        await process(dump(tv_key("HOME")))
        await process.drain(1.0)
        t.report()
    (line,) = lines(caplog, "teclas da TV no último minuto")
    assert "(nuvem 1; tv_unreachable 1)" in line
    assert "envio n/d" in line


def test_the_hot_path_cost_is_small() -> None:
    """Custo de medir uma tecla (três leituras do relógio e o acúmulo), longe de 1 ms."""
    t = timings(slow_ms=1e12)
    n = 20_000
    start = time.perf_counter_ns()
    for _ in range(n):
        a = time.perf_counter_ns()
        b = time.perf_counter_ns()
        c = time.perf_counter_ns()
        t.record(
            key="OK",
            path="nuvem",
            outcome="ok",
            age=0.01,
            queue_ns=b - a,
            session_ns=c - b,
            send_ns=c - a,
        )
        if len(t._total.values) >= 1000:  # janela nova sem escrever no registro
            t._reset()
    per_key_us = (time.perf_counter_ns() - start) / n / 1000
    assert per_key_us < 500  # folga larga: a CI no Windows com cobertura é lenta
