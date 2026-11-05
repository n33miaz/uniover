"""Falha de partida: gravações independentes, sem texto de exceção, reserva por processo e envio."""

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters.diagnostics_file import FileDiagnosticStore
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.startup_trace import (
    CLAIM_MAX_SECONDS,
    KIND,
    LOG_FILE,
    describe_exception,
    process_alive,
    record_startup_failure,
)
from uniover_agent.composition.diagnostics_delivery import DiagnosticsDelivery
from uniover_agent.core import (
    ConnectionSupervisor,
    EnvelopeFactory,
    EnvelopeGate,
)
from uniover_agent.core.api_features import ApiFeatures
from uniover_agent.core.diagnostics import (
    DIAGNOSTICS_CAPABILITY,
    DiagnosticsRecorder,
    DiagnosticsShipper,
)

from .support import AGENT_ID
from .test_diagnostics import make_event
from .test_startup_trace import queue


def sleeper() -> subprocess.Popen[bytes]:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])


# --- log e fila são independentes -----------------------------------------------------------


def test_a_log_that_cannot_be_written_does_not_stop_the_queue(tmp_path: Path) -> None:
    (tmp_path / "logs").write_text("é um arquivo, não uma pasta", encoding="utf-8")

    assert record_startup_failure("cofre", "x", base=tmp_path, clock=lambda: 1000.0) is True

    assert [e["kind"] for e in queue(tmp_path)] == [KIND]
    assert (tmp_path / "runtime" / "startup-failure.cofre.txt").exists()


def test_a_queue_that_cannot_be_written_still_leaves_the_log(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "diagnostics.jsonl").mkdir()

    assert record_startup_failure("cofre", "x", base=tmp_path, clock=lambda: 1000.0) is False

    assert "cofre: x" in (tmp_path / "logs" / LOG_FILE).read_text(encoding="utf-8")


# --- texto de exceção inesperada nunca entra ------------------------------------------------


def test_describe_exception_keeps_only_the_type_and_the_place() -> None:
    try:
        raise RuntimeError("password hunter2")
    except RuntimeError as exc:
        text = describe_exception(exc)

    assert text.startswith("RuntimeError em test_startup_delivery.py:")
    assert "hunter2" not in text
    assert "password" not in text


def test_an_unexpected_exception_never_leaks_its_message(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> None:
        raise RuntimeError("password hunter2")

    monkeypatch.setattr(main_module, "migrate_layout", broken)

    with pytest.raises(RuntimeError):
        main_module.main(["run"])

    base = installation_base()
    assert "RuntimeError em" in (base / "logs" / LOG_FILE).read_text(encoding="utf-8")
    everything = (base / "logs" / LOG_FILE).read_text(encoding="utf-8") + json.dumps(queue(base))
    assert "hunter2" not in everything


# --- a reserva pertence a um processo --------------------------------------------------------


def test_the_current_process_is_alive_and_a_finished_one_is_not() -> None:
    assert process_alive(os.getpid())
    child = sleeper()
    assert process_alive(child.pid)
    child.kill()
    child.wait(timeout=30)
    assert not process_alive(child.pid)
    assert not process_alive(0)


def test_a_claim_of_a_live_process_is_respected_however_old_and_taken_back_when_it_dies(
    tmp_path: Path,
) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    claim = runtime / "startup-failure.cofre.txt.claim"
    holder = sleeper()
    try:
        claim.write_text(str(holder.pid), encoding="ascii")
        old = time.time() - 600
        os.utime(claim, (old, old))

        # O dono está parado há 10 minutos, mas vivo: ninguém toma a reserva dele.
        assert record_startup_failure("cofre", "x", base=tmp_path) is False
        assert queue(tmp_path) == []
    finally:
        holder.kill()
        holder.wait(timeout=30)

    assert record_startup_failure("cofre", "x", base=tmp_path) is True
    assert len(queue(tmp_path)) == 1
    assert not claim.exists()


def test_a_claim_older_than_any_plausible_run_is_taken_even_if_the_pid_looks_alive(
    tmp_path: Path,
) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    claim = runtime / "startup-failure.cofre.txt.claim"
    claim.write_text(str(os.getpid()), encoding="ascii")
    old = time.time() - CLAIM_MAX_SECONDS - 10
    os.utime(claim, (old, old))

    assert record_startup_failure("cofre", "x", base=tmp_path) is True


def test_real_processes_racing_for_the_same_window_record_it_once(tmp_path: Path) -> None:
    go = tmp_path / "go"
    code = (
        "import sys, time, pathlib\n"
        "from uniover_agent.adapters.startup_trace import record_startup_failure\n"
        "base, go = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])\n"
        "while not go.exists():\n"
        "    time.sleep(0.01)\n"
        "print(record_startup_failure('cofre', 'x', base=base))\n"
    )
    children = [
        subprocess.Popen(  # noqa: S603
            [sys.executable, "-c", code, str(tmp_path), str(go)],
            stdout=subprocess.PIPE,
            text=True,
        )
        for _ in range(4)
    ]
    time.sleep(3)  # todos já importaram e esperam o sinal
    go.write_text("go", encoding="utf-8")
    results = [child.communicate(timeout=120)[0].strip() for child in children]

    assert results.count("True") == 1
    assert len(queue(tmp_path)) == 1


# --- teto da fila com o arquivo de envio trancado -------------------------------------------


def test_a_locked_sending_file_cannot_make_the_queue_grow_without_limit(tmp_path: Path) -> None:
    store = FileDiagnosticStore(tmp_path, max_events=5)
    # Uma pasta no lugar do arquivo de envio: regravá-lo falha, como com o arquivo trancado.
    (tmp_path / "diagnostics.sending.jsonl").mkdir()
    pending = tmp_path / "diagnostics.jsonl"

    results = [store.append_confirmed(make_event(index)) for index in range(6000)]

    assert pending.stat().st_size <= 2 * 160 * 1024 + 1024
    assert results[0] is True
    assert results[-1] is False

    (tmp_path / "diagnostics.sending.jsonl").rmdir()
    collected: list[str] = []
    while batch := store.take(100):
        collected += [e.detail for e in batch]
        store.confirm(batch)
    assert 0 < len(collected) <= 10
    # Destravado, a fila volta a aceitar.
    assert store.append_confirmed(make_event(9999)) is True


def test_a_stale_incoming_file_from_a_crash_is_recovered(tmp_path: Path) -> None:
    store = FileDiagnosticStore(tmp_path)
    (tmp_path / "diagnostics.incoming.jsonl").write_text(
        '{"kind":"update.failed","severity":"error","detail":"sobrou"}' + os.linesep,
        encoding="utf-8",
    )
    store.append_confirmed(make_event(1))
    assert store.has_kind("update.failed") is True
    assert store.has_kind("nao.existe") is False

    details: list[str] = []
    while batch := store.take(10):
        details += [e.detail for e in batch]
        store.confirm(batch)

    assert "sobrou" in details
    assert "falha 1" in details
    assert store.has_kind("update.failed") is False


# --- entrega pelo hello de verdade -----------------------------------------------------------


class Delivery:
    """O fluxo de verdade: `ConnectionSupervisor` + `hello` + consulta de recursos + envio."""

    def __init__(
        self,
        runtime: Path,
        *,
        self_care: bool,
        api_features: frozenset[str] | None,
        fetch_delay: int = 0,
    ) -> None:
        self.clock = FakeClock()
        self.transport = FakeTransport([[]])
        self.store = FileDiagnosticStore(runtime)
        self.fetches = 0
        gate = EnvelopeGate(AGENT_ID)
        envelopes = EnvelopeFactory(AGENT_ID, gate, self.clock)

        async def fetch() -> frozenset[str] | None:
            self.fetches += 1
            for _ in range(fetch_delay):
                await asyncio.sleep(0)
            return api_features

        self.features = ApiFeatures(fetch, self.clock)
        shipper = DiagnosticsShipper(
            self.store,
            DiagnosticsRecorder(self.store, self.clock),
            self.transport,
            envelopes,
            self.clock,
            enabled=lambda: self.features.supports(DIAGNOSTICS_CAPABILITY),
        )
        self.delivery = DiagnosticsDelivery(self.store, self.features, shipper, self_care=self_care)

        async def ignore(raw: str | bytes) -> None:
            return None

        self.supervisor = ConnectionSupervisor(
            self.transport,
            ignore,
            envelopes,
            self.clock,
            lambda: 0.5,
            agent_version="0.1.0",
            capabilities=lambda: ("tv.remote", *self.delivery.capabilities()),
            on_connected=self.delivery.after_hello,
        )

    async def first_connection(self) -> None:
        await self.delivery.prepare()
        task = asyncio.create_task(self.supervisor.run())
        for _ in range(2000):
            if self.transport.connects >= 2 or task.done():
                break
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


def types(transport: FakeTransport) -> list[str]:
    return [message["type"] for message in transport.sent]


@pytest.mark.parametrize("self_care", [True, False])
async def test_a_startup_failure_ships_on_the_first_hello(tmp_path: Path, self_care: bool) -> None:
    record_startup_failure("cofre", "falha ao ler do cofre", base=tmp_path)
    flow = Delivery(
        tmp_path / "runtime",
        self_care=self_care,
        api_features=frozenset({DIAGNOSTICS_CAPABILITY}),
        fetch_delay=5,
    )

    await flow.first_connection()

    assert types(flow.transport)[:2] == ["agent.hello.v1", "agent.diagnostics.v1"]
    assert DIAGNOSTICS_CAPABILITY in flow.transport.sent[0]["body"]["capabilities"]
    [event] = flow.transport.sent[1]["body"]["events"]
    assert event["kind"] == KIND
    assert flow.store.has_kind(KIND) is False


async def test_without_a_startup_failure_the_first_connection_does_not_wait_for_the_api(
    tmp_path: Path,
) -> None:
    flow = Delivery(
        tmp_path / "runtime", self_care=False, api_features=frozenset({DIAGNOSTICS_CAPABILITY})
    )

    await flow.first_connection()

    assert flow.fetches == 0
    assert types(flow.transport)[:1] == ["agent.hello.v1"]
    assert "agent.diagnostics.v1" not in types(flow.transport)
    assert DIAGNOSTICS_CAPABILITY not in flow.transport.sent[0]["body"]["capabilities"]


async def test_an_api_that_does_not_list_diagnostics_keeps_the_failure_queued(
    tmp_path: Path,
) -> None:
    record_startup_failure("cofre", "x", base=tmp_path)
    flow = Delivery(tmp_path / "runtime", self_care=False, api_features=frozenset())

    await flow.first_connection()

    assert "agent.diagnostics.v1" not in types(flow.transport)
    assert DIAGNOSTICS_CAPABILITY not in flow.transport.sent[0]["body"]["capabilities"]
    assert flow.store.has_kind(KIND) is True
