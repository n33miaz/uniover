"""O lote de diagnóstico só sai da fila em disco depois de o envio terminar.

Falha de atualização é o que o dono mais precisa saber; reiniciar ou atualizar o agente no meio do
envio é o caso normal, então um lote retirado e perdido ali apagaria justamente esse aviso.
"""

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters.diagnostics_file import LEASE_SECONDS, FileDiagnosticStore
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.core import EnvelopeFactory, EnvelopeGate
from uniover_agent.core.diagnostics import DiagnosticsRecorder, DiagnosticsShipper
from uniover_agent.ports import TransportError

from .support import AGENT_ID
from .test_diagnostics import make_event


class Clock:
    """Relógio monotônico à mão, para vencer um empréstimo sem esperar."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def details(store: FileDiagnosticStore, limit: int = 100) -> list[str]:
    """O que um processo novo leria: abre a fila de novo, como depois de uma queda."""
    return [event.detail for event in store.take(limit)]


def make_shipper(store: FileDiagnosticStore, transport: Any) -> DiagnosticsShipper:
    clock = FakeClock(datetime(2026, 10, 31, 12, 0, tzinfo=UTC))
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    return DiagnosticsShipper(store, DiagnosticsRecorder(store, clock), transport, envelopes, clock)


def filled(tmp_path: Path, count: int = 3) -> FileDiagnosticStore:
    store = FileDiagnosticStore(tmp_path)
    for index in range(count):
        store.append(make_event(index))
    return store


def test_a_lent_batch_stays_on_disk_until_it_is_confirmed(tmp_path: Path) -> None:
    store = filled(tmp_path)

    batch = store.take(2)

    assert [e.detail for e in batch] == ["falha 0", "falha 1"]
    # A queda do processo logo depois do `take`: a fila nova ainda tem tudo.
    assert details(FileDiagnosticStore(tmp_path)) == ["falha 0", "falha 1", "falha 2"]


def test_confirming_removes_only_that_batch(tmp_path: Path) -> None:
    store = filled(tmp_path, 5)
    batch = store.take(2)

    store.confirm(batch)

    assert details(FileDiagnosticStore(tmp_path)) == ["falha 2", "falha 3", "falha 4"]


def test_the_same_process_never_lends_the_same_event_twice(tmp_path: Path) -> None:
    store = filled(tmp_path, 3)

    first = store.take(2)
    second = store.take(2)
    third = store.take(2)

    assert [e.detail for e in first] == ["falha 0", "falha 1"]
    assert [e.detail for e in second] == ["falha 2"]
    assert third == []


def test_giving_a_batch_back_makes_it_available_again_in_order(tmp_path: Path) -> None:
    store = filled(tmp_path, 4)
    first = store.take(2)

    store.put_back(first)

    assert [e.detail for e in store.take(10)] == [f"falha {i}" for i in range(4)]


def test_a_batch_that_was_lent_and_forgotten_comes_back_after_the_lease(tmp_path: Path) -> None:
    """Cancelado no meio do `take` (o resultado nunca chegou a quem pediu): não fica preso."""
    clock = Clock()
    store = FileDiagnosticStore(tmp_path, monotonic=clock)
    store.append(make_event(1))
    store.take(10)
    assert store.take(10) == []

    clock.now += LEASE_SECONDS + 1

    assert [e.detail for e in store.take(10)] == ["falha 1"]


def test_ids_the_supervisor_did_not_write_are_stable_across_reads(tmp_path: Path) -> None:
    (tmp_path / "diagnostics.jsonl").write_text(
        '{"kind":"update.failed","severity":"error","component":"supervisor","detail":"sem id"}\n',
        encoding="utf-8",
    )
    store = FileDiagnosticStore(tmp_path)
    batch = store.take(10)
    store.put_back(batch)

    again = FileDiagnosticStore(tmp_path).take(10)

    assert [e.id for e in again] == [e.id for e in batch]


def test_what_arrives_while_a_batch_is_in_flight_is_kept_and_sent_next(tmp_path: Path) -> None:
    store = filled(tmp_path, 1)
    in_flight = store.take(10)
    (tmp_path / "diagnostics.jsonl").write_text(
        '{"kind":"update.failed","severity":"error","detail":"chegou durante"}\n',
        encoding="utf-8",
    )

    assert [e.detail for e in store.take(10)] == ["chegou durante"]
    store.confirm(in_flight)
    assert not (tmp_path / "diagnostics.incoming.jsonl").exists()
    # A de falha de atualização ainda não foi confirmada: um processo novo a reenvia.
    assert details(FileDiagnosticStore(tmp_path)) == ["chegou durante"]


async def test_a_send_cancelled_midway_keeps_the_batch(tmp_path: Path) -> None:
    store = filled(tmp_path)
    started = asyncio.Event()

    class Hanging(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            started.set()
            await asyncio.sleep(3600)

    task = asyncio.create_task(make_shipper(store, Hanging()).flush())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # Na mesma execução o lote volta a estar disponível...
    assert [e.detail for e in store.take(10)] == ["falha 0", "falha 1", "falha 2"]
    # ...e num processo novo também (nada saiu do disco).
    assert details(FileDiagnosticStore(tmp_path)) == ["falha 0", "falha 1", "falha 2"]


async def test_a_flush_cancelled_right_after_take_keeps_the_batch(tmp_path: Path) -> None:
    """Interrompe exatamente depois do `take(n)`, antes de o envio começar."""
    store = filled(tmp_path)
    transport = FakeTransport()
    original = store.take

    def take_then_get_cancelled(limit: int) -> Any:
        original(limit)
        raise asyncio.CancelledError  # o processo é derrubado com o lote já emprestado

    store.take = take_then_get_cancelled  # type: ignore[method-assign]

    with pytest.raises(asyncio.CancelledError):
        await make_shipper(store, transport).flush()

    assert transport.sent == []
    assert details(FileDiagnosticStore(tmp_path)) == ["falha 0", "falha 1", "falha 2"]


async def test_a_transport_error_gives_the_batch_back(tmp_path: Path) -> None:
    store = filled(tmp_path)

    class Failing(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            raise TransportError("sem canal")

    assert await make_shipper(store, Failing()).flush() == 0

    assert [e.detail for e in store.take(10)] == ["falha 0", "falha 1", "falha 2"]


async def test_a_delivered_batch_is_confirmed_and_leaves_the_disk(tmp_path: Path) -> None:
    store = filled(tmp_path, 45)
    transport = FakeTransport()

    assert await make_shipper(store, transport).flush() == 45

    assert len(transport.sent) == 3
    assert details(FileDiagnosticStore(tmp_path)) == []
    assert not (tmp_path / "diagnostics.sending.jsonl").exists()


async def test_an_interruption_between_sends_resends_only_what_was_not_confirmed(
    tmp_path: Path,
) -> None:
    store = filled(tmp_path, 45)
    sent: list[int] = []

    class DiesOnSecond(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            if sent:
                raise asyncio.CancelledError
            sent.append(len(message["body"]["events"]))

    with pytest.raises(asyncio.CancelledError):
        await make_shipper(store, DiesOnSecond()).flush()

    assert sent == [20]
    assert details(FileDiagnosticStore(tmp_path)) == [f"falha {i}" for i in range(20, 45)]


async def test_a_batch_that_is_not_a_valid_message_is_dropped_for_good(tmp_path: Path) -> None:
    store = FileDiagnosticStore(tmp_path)
    (tmp_path / "diagnostics.jsonl").write_text(
        '{"kind":"check.failed","severity":"error","detail":"ok"}\n', encoding="utf-8"
    )

    class Invalid(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            raise ValueError("fora do contrato")

    assert await make_shipper(store, Invalid()).flush() == 0

    assert details(FileDiagnosticStore(tmp_path)) == []
