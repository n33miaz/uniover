"""Um só agente por instalação; falha de conexão antes do primeiro hello deixa rastro."""

import asyncio
import ctypes
import os
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters import single_instance, startup_trace
from uniover_agent.adapters.fakes import FakeTransport
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.single_instance import (
    ALREADY_RUNNING_MESSAGE,
    EXIT_ALREADY_RUNNING,
    acquire,
    mutex_name,
)
from uniover_agent.adapters.startup_trace import KIND, LOG_FILE, log_once, record_startup_failure
from uniover_agent.composition import connection, system
from uniover_agent.composition.diagnostics_delivery import (
    CONNECTION_FAILURES_BEFORE_TRACE,
    REFRESH_EVERY_SECONDS,
)
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


def test_the_same_installation_written_differently_has_one_mutex(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    base.mkdir()
    assert mutex_name(base) == mutex_name(Path(str(base) + os.sep))
    assert mutex_name(base) == mutex_name(Path(str(base).replace("\\", "/")))
    assert mutex_name(base) == mutex_name(Path(str(base).upper()))
    assert mutex_name(base) != mutex_name(tmp_path / "Other")


@pytest.mark.skipif(sys.platform != "win32", reason="mutex nomeado do Windows")
def test_access_denied_on_the_mutex_means_someone_else_owns_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mutex de processo elevado: a tarefa sem elevacao recebe acesso negado e nao roda junto."""
    kernel32 = MagicMock()
    kernel32.CreateMutexW.return_value = 0
    monkeypatch.setattr(ctypes, "WinDLL", lambda *args, **kwargs: kernel32, raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5)
    assert single_instance._acquire_windows("UniOver-Agent-teste") is False

    # Qualquer outra falha em criar o mutex nao tira o agente do ar.
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 8)
    assert single_instance._acquire_windows("UniOver-Agent-teste") is True


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


# --- sem auto-verificacao, a falha de partida nao fica presa por uma consulta que falhou ---------


class Flaky:
    """`fetch` das capacidades da API: nao sabe nas primeiras `down` consultas, depois diz."""

    def __init__(self, down: int) -> None:
        self.down = down
        self.calls = 0

    async def __call__(self) -> frozenset[str] | None:
        self.calls += 1
        return None if self.calls <= self.down else frozenset({DIAGNOSTICS_CAPABILITY})


def flaky_delivery(tmp_path: Path, down: int) -> tuple[Delivery, Flaky]:
    flow = Delivery(
        tmp_path / "runtime",
        self_care=False,
        api_features=None,
        base=tmp_path,
    )
    fetch = Flaky(down)
    flow.features._fetch = fetch
    return flow, fetch


async def test_without_self_care_a_failed_features_query_is_retried_when_the_connection_fails(
    tmp_path: Path,
) -> None:
    flow, fetch = flaky_delivery(tmp_path, down=1)
    assert record_startup_failure("cofre", "x", base=tmp_path) is True

    await flow.delivery.prepare()
    assert flow.delivery.capabilities() == ()  # rede fora do ar na partida

    await flow.delivery.connection_failed(TransportError("sem rede"), False, 1)

    assert fetch.calls == 2
    assert flow.delivery.capabilities() == (DIAGNOSTICS_CAPABILITY,)


async def test_without_self_care_a_query_that_failed_before_the_hello_is_retried_after_it(
    tmp_path: Path,
) -> None:
    flow, fetch = flaky_delivery(tmp_path, down=1)
    assert record_startup_failure("cofre", "x", base=tmp_path) is True
    await flow.delivery.prepare()

    await flow.delivery.after_hello()  # o hello saiu sem declarar o diagnostico

    assert flow.transport.sent == []  # nada enviado sem a capacidade declarada
    assert fetch.calls == 2
    assert flow.delivery.capabilities() == (DIAGNOSTICS_CAPABILITY,)  # a proxima conexao declara


async def test_nothing_is_asked_when_there_is_no_startup_failure_and_no_self_care(
    tmp_path: Path,
) -> None:
    flow, fetch = flaky_delivery(tmp_path, down=0)
    await flow.delivery.prepare()
    await flow.delivery.connection_failed(TransportError("sem rede"), False, 1)
    await flow.delivery.after_hello()
    assert fetch.calls == 0


async def test_the_features_query_is_not_repeated_on_every_failed_attempt(tmp_path: Path) -> None:
    flow, fetch = flaky_delivery(tmp_path, down=1000)
    now = [1000.0]
    flow.delivery._monotonic = lambda: now[0]
    assert record_startup_failure("cofre", "x", base=tmp_path) is True
    await flow.delivery.prepare()
    assert fetch.calls == 1

    for attempt in range(1, 6):
        now[0] += 10
        await flow.delivery.connection_failed(TransportError("sem rede"), False, attempt)
    await flow.delivery.after_hello()
    assert fetch.calls == 2  # uma so, dentro do periodo

    now[0] += REFRESH_EVERY_SECONDS
    await flow.delivery.connection_failed(TransportError("sem rede"), False, 7)
    assert fetch.calls == 3


# --- aviso de "outra instancia" so uma vez por janela --------------------------------------


def test_the_other_instance_line_is_written_once_per_window(tmp_path: Path) -> None:
    now = [0.0]
    for minute in range(30):
        now[0] = minute * 60.0
        log_once("ja_rodando", ALREADY_RUNNING_MESSAGE, base=tmp_path, clock=lambda: now[0])
    text = (tmp_path / "logs" / LOG_FILE).read_text(encoding="utf-8")
    assert text.count(ALREADY_RUNNING_MESSAGE) == 1

    log_once("ja_rodando", ALREADY_RUNNING_MESSAGE, base=tmp_path, clock=lambda: 7 * 3600.0)
    assert (tmp_path / "logs" / LOG_FILE).read_text(encoding="utf-8").count(
        ALREADY_RUNNING_MESSAGE
    ) == 2
    assert queue(tmp_path) == []  # so o log, a fila nao e tocada


def test_a_run_started_by_the_legacy_wrapper_does_not_take_the_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    holder = start_holder()
    try:
        monkeypatch.setenv("UNIOVER_LEGACY_TAKEOVER", "1")
        assert main_module.main(["run"]) == 0
    finally:
        stop(holder)
    assert not (installation_base() / "logs" / LOG_FILE).exists()


# --- so a falha antes do primeiro hello e falha de partida ---------------------------------


def test_a_credential_rejected_after_a_hello_is_not_a_startup_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def rejected(*args: object, **kwargs: object) -> int:
        return system.EXIT_CREDENTIAL_REJECTED

    monkeypatch.setattr(connection, "run", rejected)
    monkeypatch.setitem(startup_trace._session, "started", True)

    assert main_module.main(["run"]) == system.EXIT_CREDENTIAL_REJECTED

    assert not (installation_base() / "logs" / LOG_FILE).exists()
    assert not (installation_base() / "runtime" / "diagnostics.jsonl").exists()


def test_an_exception_after_a_hello_is_not_a_startup_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken(*args: object, **kwargs: object) -> int:
        raise PermissionError("depois de horas")

    monkeypatch.setattr(connection, "run", broken)
    monkeypatch.setitem(startup_trace._session, "started", True)

    with pytest.raises(PermissionError):
        main_module.main(["run"])

    assert not (installation_base() / "logs" / LOG_FILE).exists()
