"""Um só agente por instalação; falha de conexão antes do primeiro hello deixa rastro."""

import asyncio
import os
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters import single_instance
from uniover_agent.adapters.fakes import FakeTransport
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.single_instance import (
    ALREADY_RUNNING_MESSAGE,
    EXIT_ALREADY_RUNNING,
    acquire,
)
from uniover_agent.adapters.startup_trace import KIND, LOG_FILE, record_startup_failure
from uniover_agent.composition.diagnostics_delivery import CONNECTION_FAILURES_BEFORE_TRACE
from uniover_agent.core.diagnostics import DIAGNOSTICS_CAPABILITY
from uniover_agent.ports import TransportError

from .support import kill_tree
from .test_startup_delivery import Delivery, types
from .test_startup_trace import queue

HOLDER = (
    "import sys, time, pathlib\n"
    "from uniover_agent.adapters.single_instance import acquire\n"
    "base = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None\n"
    "print(acquire(base), flush=True)\n"
    "time.sleep(120)\n"
)


def start_holder(base: Path | None = None) -> subprocess.Popen[str]:
    args = [sys.executable, "-c", HOLDER] + ([str(base)] if base else [])
    child = subprocess.Popen(args, stdout=subprocess.PIPE, text=True)  # noqa: S603
    assert child.stdout is not None
    assert child.stdout.readline().strip() == "True"
    return child


def stop(child: subprocess.Popen[str]) -> None:
    kill_tree(child)


# --- instância única --------------------------------------------------------------------------


def test_a_second_process_cannot_take_the_lock_until_the_first_one_is_gone(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    holder = start_holder(base)
    try:
        assert acquire(base) is False
    finally:
        stop(holder)

    assert acquire(base) is True
    # Quem já a tem não é barrado por ela mesma (o `run` recomeça quando a TV muda de endereço).
    assert acquire(base) is True


def test_different_installations_do_not_share_the_lock(tmp_path: Path) -> None:
    holder = start_holder(tmp_path / "one")
    try:
        assert acquire(tmp_path / "two") is True
    finally:
        stop(holder)


def test_the_lockfile_fallback_respects_a_live_owner_and_replaces_a_dead_one(
    tmp_path: Path,
) -> None:
    lock = tmp_path / "runtime" / single_instance.LOCK_FILE
    lock.parent.mkdir()
    owner = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        lock.write_text(str(owner.pid), encoding="ascii")
        assert single_instance._acquire_lockfile(lock) is False
    finally:
        kill_tree(owner)

    assert single_instance._acquire_lockfile(lock) is True
    assert lock.read_text(encoding="ascii") == str(os.getpid())


def test_a_second_run_exits_with_its_own_code_without_touching_the_queue() -> None:
    holder = start_holder()
    try:
        assert main_module.main(["run"]) == EXIT_ALREADY_RUNNING
    finally:
        stop(holder)

    base = installation_base()
    assert ALREADY_RUNNING_MESSAGE in (base / "logs" / LOG_FILE).read_text(encoding="utf-8")
    assert not (base / "runtime" / "diagnostics.jsonl").exists()
    assert not (base / "runtime" / "diagnostics.sending.jsonl").exists()
    # O segundo agente nem chega à estrutura de pastas do primeiro.
    assert not (base / "config").exists()


def test_other_commands_do_not_take_the_lock() -> None:
    holder = start_holder()
    try:
        assert main_module.main(["status"]) != EXIT_ALREADY_RUNNING
    finally:
        stop(holder)


# --- falha de conexão antes do primeiro hello ----------------------------------------------


class Failing(FakeTransport):
    """Transporte que falha em `connect` com `error` nas primeiras `times` tentativas."""

    def __init__(self, error: Exception, times: int, after: int = 0) -> None:
        super().__init__([[]])
        self.error = error
        self.times = times
        self.after = after

    async def connect(self) -> None:
        if self.connects >= self.after and self.connects < self.after + self.times:
            self.connects += 1
            raise self.error
        await super().connect()


async def run_until(flow: Delivery, done: Callable[[], bool]) -> None:
    await flow.delivery.prepare()
    task = asyncio.create_task(flow.supervisor.run())
    # Prazo em tempo real: o rastro e o envio passam por threads, e numa máquina ocupada demoram.
    deadline = time.monotonic() + 60
    while not (task.done() or done()) and time.monotonic() < deadline:  # noqa: ASYNC110 - espera por condição de fora
        await asyncio.sleep(0.005)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.parametrize("self_care", [True, False])
async def test_an_unexpected_error_before_the_first_hello_ships_on_the_first_hello(
    tmp_path: Path, self_care: bool
) -> None:
    transport = Failing(ValueError("senha hunter2"), times=1)
    flow = Delivery(
        tmp_path / "runtime",
        self_care=self_care,
        api_features=frozenset({DIAGNOSTICS_CAPABILITY}),
        transport=transport,
        base=tmp_path,
    )

    await run_until(flow, lambda: "agent.diagnostics.v1" in types(transport))

    assert types(transport)[:2] == ["agent.hello.v1", "agent.diagnostics.v1"]
    assert DIAGNOSTICS_CAPABILITY in transport.sent[0]["body"]["capabilities"]
    [event] = transport.sent[1]["body"]["events"]
    assert event["kind"] == KIND
    assert event["detail"].startswith("conexao: ValueError em ")
    assert "hunter2" not in str(transport.sent)


async def test_many_consecutive_connect_failures_leave_a_trace_but_a_few_do_not(
    tmp_path: Path,
) -> None:
    few = Failing(TransportError("sem rede"), times=CONNECTION_FAILURES_BEFORE_TRACE - 1)
    flow = Delivery(
        tmp_path / "a" / "runtime",
        self_care=True,
        api_features=frozenset({DIAGNOSTICS_CAPABILITY}),
        transport=few,
        base=tmp_path / "a",
    )
    await run_until(flow, lambda: types(few)[:1] == ["agent.hello.v1"])
    assert queue(tmp_path / "a") == []

    many = Failing(TransportError("sem rede"), times=CONNECTION_FAILURES_BEFORE_TRACE)
    flow = Delivery(
        tmp_path / "b" / "runtime",
        self_care=False,
        api_features=frozenset({DIAGNOSTICS_CAPABILITY}),
        transport=many,
        base=tmp_path / "b",
    )
    await run_until(flow, lambda: "agent.diagnostics.v1" in types(many))

    [event] = many.sent[1]["body"]["events"]
    assert event["detail"].startswith("conexao: TransportError em ")
    assert f"{CONNECTION_FAILURES_BEFORE_TRACE} tentativas" in event["detail"]


async def test_failures_after_the_first_hello_leave_no_trace(tmp_path: Path) -> None:
    transport = Failing(ValueError("depois"), times=3, after=1)
    flow = Delivery(
        tmp_path / "runtime",
        self_care=True,
        api_features=frozenset({DIAGNOSTICS_CAPABILITY}),
        transport=transport,
        base=tmp_path,
    )

    await run_until(flow, lambda: transport.connects >= 6)

    assert queue(tmp_path) == []


# --- sem marcador, a fila segura a repetição ------------------------------------------------


def test_without_a_writable_marker_the_queue_still_stops_the_repetition(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "startup-failure.cofre.txt").mkdir()  # o marcador não pode ser gravado

    assert record_startup_failure("cofre", "a", base=tmp_path, clock=lambda: 1000.0) is True
    assert record_startup_failure("cofre", "b", base=tmp_path, clock=lambda: 1060.0) is False

    assert len(queue(tmp_path)) == 1
    assert (runtime / "startup-failure.cofre.txt").is_dir()
    # Outro motivo não é calado pelo primeiro.
    assert record_startup_failure("nao_pareado", "c", base=tmp_path, clock=lambda: 1100.0) is True
