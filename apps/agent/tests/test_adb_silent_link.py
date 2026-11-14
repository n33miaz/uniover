"""A sonda silenciosa com limite de frequência: só `authorized` libera, e nunca durante o dono."""

import asyncio
import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

from uniover_agent.adapters.adb_probe_times_file import PROBE_TIMES_FILE, AdbProbeTimesFile
from uniover_agent.adapters.adb_silent_probe import ProbeResult
from uniover_agent.core.tv.adb_silent_link import (
    MIN_PROBE_INTERVAL_SECONDS,
    AdbSilentLink,
)
from uniover_agent.ports import (
    PROBE_AUTHORIZED,
    PROBE_EVENT_MISMATCH,
    PROBE_SKIPPED,
    PROBE_TLS_REQUIRED,
    PROBE_UNAUTHORIZED,
    PROBE_UNKNOWN,
    PROBE_UNREACHABLE,
    AdbIdle,
    AdbUnauthorized,
    AdbUnreachable,
    ProbeVerdict,
)
from uniover_agent.ports.diagnostics import Severity

ADDRESS = "192.168.1.6:5555"


class MemoryStore:
    """Os horários que sobreviveriam a um reinício, e em que thread foram gravados."""

    def __init__(self) -> None:
        self.times: dict[str, float] = {}
        self.saved_in: list[int] = []

    def load(self) -> dict[str, float]:
        return dict(self.times)

    def save(self, times: dict[str, float]) -> None:
        self.saved_in.append(threading.get_ident())
        self.times = dict(times)


class Rig:
    """O relógio, a sonda (que diz o que o teste mandar) e o que foi anotado."""

    def __init__(self, store: MemoryStore | None = None, interval: float = 300.0) -> None:
        self.now = 1000.0
        self.wall = 1_800_000_000.0
        self.answers: list[str] = [PROBE_AUTHORIZED]
        self.probes = 0
        self.busy = False
        self.sleeps: list[float] = []
        self.recorded: list[tuple[str, Severity, str]] = []
        self.link = AdbSilentLink(
            ADDRESS,
            self.probe,
            lambda: self.now,
            owner_busy=lambda: self.busy,
            sleep=self.sleep,
            wall_clock=lambda: self.wall,
            store=store,
            min_interval_seconds=interval,
        )
        self.link.record_with(
            lambda kind, severity, text: self.recorded.append((kind, severity, text))
        )

    async def probe(self) -> ProbeVerdict:
        self.probes += 1
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        return ProbeVerdict(answer, "digital" if answer == PROBE_AUTHORIZED else None)

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds
        self.wall += seconds

    def advance(self, seconds: float) -> None:
        self.now += seconds
        self.wall += seconds


class Session:
    """A abertura de curta duração do teste: conta aberturas, fechamentos e o que mandar falhar."""

    def __init__(self) -> None:
        self.opens = 0
        self.closes = 0
        self.errors: list[Exception] = []
        self.worked = 0

    @asynccontextmanager
    async def __call__(self) -> AsyncIterator[None]:
        self.opens += 1
        if self.errors:
            raise self.errors.pop(0)
        try:
            yield
        finally:
            self.closes += 1

    async def work(self) -> None:
        self.worked += 1


@pytest.fixture
def rig() -> Rig:
    return Rig()


def test_the_verdicts_are_the_ones_the_probe_speaks() -> None:
    assert PROBE_AUTHORIZED == ProbeResult.AUTHORIZED.value
    assert PROBE_UNAUTHORIZED == ProbeResult.UNAUTHORIZED.value
    assert PROBE_TLS_REQUIRED == ProbeResult.TLS_REQUIRED.value
    assert PROBE_UNREACHABLE == ProbeResult.UNREACHABLE.value
    assert PROBE_UNKNOWN == ProbeResult.UNKNOWN.value
    assert PROBE_SKIPPED not in {result.value for result in ProbeResult}


async def test_the_probe_result_is_returned_and_recorded_in_short_portuguese(rig: Rig) -> None:
    for answer, severity in (
        (PROBE_AUTHORIZED, "info"),
        (PROBE_UNAUTHORIZED, "warn"),
        (PROBE_TLS_REQUIRED, "info"),
        (PROBE_UNREACHABLE, "info"),
        (PROBE_UNKNOWN, "warn"),
    ):
        rig.answers = [answer]
        rig.advance(MIN_PROBE_INTERVAL_SECONDS)
        verdict = await rig.link.clearance()
        assert verdict.result == answer
        assert rig.link.last_result == answer
        kind, recorded_severity, text = rig.recorded[-1]
        assert kind == f"adb.probe.{answer}"
        assert recorded_severity == severity
        assert text.startswith("sonda do ADB:")
        # Nunca endereço nem MAC no que vai ao diagnóstico.
        assert "192.168" not in text and ":5555" not in text


async def test_the_authorized_verdict_carries_the_fingerprint_of_the_key_that_signed(
    rig: Rig,
) -> None:
    assert await rig.link.clearance() == ProbeVerdict(PROBE_AUTHORIZED, "digital")


async def test_at_most_one_probe_per_address_every_five_minutes(rig: Rig) -> None:
    assert (await rig.link.clearance()).result == PROBE_AUTHORIZED
    rig.advance(MIN_PROBE_INTERVAL_SECONDS - 1)
    # Um `authorized` de segundos atrás não vale como prova do momento: nem sonda, nem liberação.
    assert (await rig.link.clearance()).result == PROBE_SKIPPED
    assert rig.probes == 1
    rig.advance(1)
    assert (await rig.link.clearance()).result == PROBE_AUTHORIZED
    assert rig.probes == 2


async def test_a_configured_interval_below_five_minutes_is_raised_to_five_minutes() -> None:
    rig = Rig(interval=1.0)
    await rig.link.clearance()
    rig.advance(60)
    assert (await rig.link.clearance()).result == PROBE_SKIPPED
    assert rig.probes == 1
    rig.advance(MIN_PROBE_INTERVAL_SECONDS)
    assert (await rig.link.clearance()).result == PROBE_AUTHORIZED


async def test_a_larger_configured_interval_is_kept() -> None:
    rig = Rig(interval=900.0)
    await rig.link.clearance()
    rig.advance(600)
    assert (await rig.link.clearance()).result == PROBE_SKIPPED
    rig.advance(300)
    assert (await rig.link.clearance()).result == PROBE_AUTHORIZED


async def test_a_skipped_call_records_nothing_and_keeps_the_last_result(rig: Rig) -> None:
    rig.answers = [PROBE_UNAUTHORIZED]
    await rig.link.clearance()
    recorded = len(rig.recorded)
    assert (await rig.link.clearance()).result == PROBE_SKIPPED
    assert len(rig.recorded) == recorded
    assert rig.link.last_result == PROBE_UNAUTHORIZED


async def test_the_probe_never_runs_during_an_owner_command_and_the_window_is_not_spent(
    rig: Rig,
) -> None:
    rig.busy = True
    assert (await rig.link.clearance()).result == PROBE_SKIPPED
    assert rig.probes == 0
    rig.busy = False
    assert (await rig.link.clearance()).result == PROBE_AUTHORIZED  # nada foi gasto na espera
    assert rig.probes == 1


async def test_a_probe_that_raises_or_speaks_nonsense_proves_nothing(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    async def boom() -> ProbeVerdict:
        raise RuntimeError("falha")

    broken = AdbSilentLink(ADDRESS, boom, lambda: rig.now)
    with caplog.at_level(logging.ERROR):
        assert (await broken.clearance()).result == PROBE_UNKNOWN
    rig.answers = ["authorised"]
    rig.advance(MIN_PROBE_INTERVAL_SECONDS)
    assert (await rig.link.clearance()).result == PROBE_UNKNOWN


async def test_a_failing_recorder_never_breaks_the_probe(rig: Rig) -> None:
    def broken(kind: str, severity: Severity, text: str) -> None:
        raise RuntimeError("diagnóstico fora")

    rig.link.record_with(broken)
    assert (await rig.link.clearance()).result == PROBE_AUTHORIZED


def test_an_event_of_an_aborted_opening_is_recorded_with_a_fixed_text(rig: Rig) -> None:
    rig.link.note_event(PROBE_EVENT_MISMATCH)
    kind, severity, text = rig.recorded[-1]
    assert kind == "adb.probe.mismatch"
    assert severity == "warn"
    assert text == "sonda do ADB: a TV aceita o adb mas recusou a chave da sonda; chaves diferentes"
    rig.link.note_event("inventado")
    assert len(rig.recorded) == 1


# --- a abertura de curta duração -------------------------------------------------------------


async def test_the_session_opens_works_and_closes(rig: Rig) -> None:
    session = Session()
    assert await rig.link.run(session, session.work, "tv_back") is True
    assert (session.opens, session.worked, session.closes) == (1, 1, 1)


async def test_the_session_closes_even_when_the_work_fails(rig: Rig) -> None:
    session = Session()

    async def broken() -> None:
        raise RuntimeError("leitura quebrou")

    with pytest.raises(RuntimeError):
        await rig.link.run(session, broken, "tv_back")
    assert session.closes == 1


@pytest.mark.parametrize("error", [AdbIdle("x"), AdbUnauthorized("x")])
async def test_a_session_the_gate_refuses_reports_false_without_work_or_retry(
    rig: Rig, error: Exception
) -> None:
    session = Session()
    session.errors = [error]
    assert await rig.link.run(session, session.work, "start") is False
    assert (session.opens, session.worked, session.closes) == (1, 0, 0)
    assert rig.sleeps == []


async def test_the_session_waits_for_the_adb_port_of_a_tv_that_just_came_back(rig: Rig) -> None:
    session = Session()
    session.errors = [AdbUnreachable("x"), AdbUnreachable("x")]
    assert await rig.link.run(session, session.work, "tv_back") is True
    assert session.opens == 3
    assert rig.sleeps == [10.0, 30.0]


async def test_the_session_gives_up_after_the_last_retry(rig: Rig) -> None:
    session = Session()
    session.errors = [AdbUnreachable("x")] * 4
    assert await rig.link.run(session, session.work, "tv_back") is False
    assert session.opens == 4
    assert rig.sleeps == [10.0, 30.0, 60.0]


async def test_the_session_without_retry_tries_once(rig: Rig) -> None:
    session = Session()
    session.errors = [AdbUnreachable("x")]
    assert await rig.link.run(session, session.work, "daily_check", retry=False) is False
    assert session.opens == 1


async def test_the_session_stops_retrying_when_an_owner_command_starts(rig: Rig) -> None:
    session = Session()
    session.errors = [AdbUnreachable("x")]

    async def sleep_and_get_busy(seconds: float) -> None:
        rig.busy = True

    rig.link._sleep = sleep_and_get_busy
    assert await rig.link.run(session, session.work, "tv_back") is False
    assert session.opens == 1


async def test_the_session_does_not_start_during_an_owner_command(rig: Rig) -> None:
    rig.busy = True
    session = Session()
    assert await rig.link.run(session, session.work, "tv_back") is False
    assert session.opens == 0


async def test_a_second_session_during_another_gives_up_instead_of_waiting(rig: Rig) -> None:
    gate = asyncio.Event()
    first = Session()

    async def slow() -> None:
        await gate.wait()

    running = asyncio.create_task(rig.link.run(first, slow, "a"))
    await asyncio.sleep(0)
    second = Session()
    assert await rig.link.run(second, second.work, "b") is False
    assert second.opens == 0
    gate.set()
    assert await running is True


async def test_aclose_cancels_the_open_session_and_it_closes_before_aclose_returns(
    rig: Rig,
) -> None:
    session = Session()
    started = asyncio.Event()

    async def slow() -> None:
        started.set()
        await asyncio.Event().wait()

    running = asyncio.create_task(rig.link.run(session, slow, "tv_back"))
    await started.wait()
    await rig.link.aclose()
    assert session.closes == 1  # o `adb disconnect` do fim da sessão já aconteceu
    with pytest.raises(asyncio.CancelledError):
        await running
    # Depois de fechado, nada abre.
    assert await rig.link.run(session, session.work, "tv_back") is False
    assert session.opens == 1


async def test_aclose_without_a_session_is_harmless(rig: Rig) -> None:
    await rig.link.aclose()
    await rig.link.aclose()


# --- a janela de 5 minutos sobrevive a reiniciar o agente --------------------------------------


async def test_the_last_probe_time_is_kept_by_endpoint_and_survives_a_restart() -> None:
    store = MemoryStore()
    first = Rig(store)
    await first.link.clearance()
    assert store.times == {ADDRESS: first.wall}
    # O agente reinicia: processo novo (monotônico recomeça), mesmo disco e mesma hora de parede.
    second = Rig(store)
    second.wall = first.wall + 60
    assert (await second.link.clearance()).result == PROBE_SKIPPED
    assert second.probes == 0
    second.wall = first.wall + 300
    assert (await second.link.clearance()).result == PROBE_AUTHORIZED
    assert store.times == {ADDRESS: first.wall + 300}


async def test_the_window_is_per_endpoint() -> None:
    store = MemoryStore()
    store.times = {"192.168.1.9:5555": 1_800_000_000.0}
    rig = Rig(store)
    assert (await rig.link.clearance()).result == PROBE_AUTHORIZED
    assert set(store.times) == {"192.168.1.9:5555", ADDRESS}


async def test_a_future_time_in_the_file_does_not_block_the_probe_for_days() -> None:
    store = MemoryStore()
    rig = Rig(store)
    store.times = {ADDRESS: rig.wall + 86400}  # arquivo ruim ou relógio muito mexido
    assert (await rig.link.clearance()).result == PROBE_AUTHORIZED


async def test_the_time_is_saved_off_the_event_loop_thread() -> None:
    store = MemoryStore()
    rig = Rig(store)
    await rig.link.clearance()
    assert store.saved_in
    assert threading.get_ident() not in store.saved_in


async def test_a_store_that_fails_never_breaks_the_probe(caplog: pytest.LogCaptureFixture) -> None:
    class Broken(MemoryStore):
        def load(self) -> dict[str, float]:
            raise OSError("disco")

        def save(self, times: dict[str, float]) -> None:
            raise OSError("disco")

    rig = Rig(Broken())
    with caplog.at_level(logging.ERROR):
        assert (await rig.link.clearance()).result == PROBE_AUTHORIZED


async def test_the_window_is_spent_even_if_the_agent_dies_during_the_probe() -> None:
    store = MemoryStore()
    rig = Rig(store)

    async def never() -> ProbeVerdict:
        await asyncio.Event().wait()
        return ProbeVerdict(PROBE_AUTHORIZED)

    rig.link._probe = never
    task = asyncio.create_task(rig.link.clearance())
    await asyncio.sleep(0.05)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert store.times == {ADDRESS: rig.wall}  # gravado antes de sondar


# --- o arquivo dos horários ---------------------------------------------------------------------


def test_the_times_file_round_trips(tmp_path: Path) -> None:
    file = AdbProbeTimesFile(tmp_path / "runtime")
    assert file.load() == {}
    file.save({ADDRESS: 1_800_000_000.5})
    assert file.load() == {ADDRESS: 1_800_000_000.5}


@pytest.mark.parametrize(
    "content",
    [
        b"",
        b"\xff\xfe",
        b"nao e json",
        b"[]",
        b'{"probes": 3}',
        b'{"probes": {"a": "texto", "b": true, "c": NaN, "d": 5}}',
        b"x" * 20000,
    ],
)
def test_a_bad_times_file_is_never_an_error(tmp_path: Path, content: bytes) -> None:
    (tmp_path / PROBE_TIMES_FILE).write_bytes(content)
    loaded = AdbProbeTimesFile(tmp_path).load()
    assert loaded in ({}, {"d": 5.0})


def test_a_times_file_that_cannot_be_written_is_only_logged(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    blocker = tmp_path / "runtime"
    blocker.write_text("é um arquivo, não uma pasta")
    with caplog.at_level(logging.WARNING):
        AdbProbeTimesFile(blocker).save({ADDRESS: 1.0})
    assert "não consegui gravar" in caplog.text
