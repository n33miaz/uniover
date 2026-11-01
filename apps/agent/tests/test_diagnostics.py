"""Diagnóstico do agente: o que sai do PC é limpo, resumido e cabe no contrato."""

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path

import pytest

from uniover_agent.adapters.diagnostics_file import (
    MAX_EVENTS,
    DiagnosticsLogHandler,
    FileDiagnosticStore,
    component_of,
)
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.core import EnvelopeFactory, EnvelopeGate
from uniover_agent.core.diagnostics import (
    BATCH_SIZE,
    DETAIL_LIMIT,
    MAX_BATCHES_PER_FLUSH,
    DiagnosticsRecorder,
    DiagnosticsShipper,
    component_safe,
    describe_exception,
)
from uniover_agent.core.redaction import scrub_personal
from uniover_agent.ports import TransportError
from uniover_agent.ports.diagnostics import DiagnosticEvent

from .support import AGENT_ID


class MemoryStore:
    """Fila em memória: guarda o que o gravador pôs e entrega como o arquivo entregaria."""

    def __init__(self) -> None:
        self.events: list[DiagnosticEvent] = []

    def append(self, event: DiagnosticEvent) -> None:
        self.events.append(event)

    def take(self, limit: int) -> list[DiagnosticEvent]:
        taken, self.events = self.events[:limit], self.events[limit:]
        return taken

    def confirm(self, events: list[DiagnosticEvent]) -> None:
        """Em memória o `take` já tirou o lote; não há o que confirmar."""

    def put_back(self, events: list[DiagnosticEvent]) -> None:
        self.events = events + self.events


def recorder(
    store: MemoryStore | None = None, clock: FakeClock | None = None, **kwargs: object
) -> tuple[DiagnosticsRecorder, MemoryStore, FakeClock]:
    memory = store or MemoryStore()
    time = clock or FakeClock(datetime(2026, 10, 31, 12, 0, tzinfo=UTC))
    return DiagnosticsRecorder(memory, time, **kwargs), memory, time  # type: ignore[arg-type]


def make_event(index: int = 0) -> DiagnosticEvent:
    return DiagnosticEvent(
        id=f"0192f1e4-7b3a-7c2e-9d11-5a4b6c7d{index:04d}",
        at="2026-10-31T12:00:00.000Z",
        kind="background.failed",
        severity="error",
        detail=f"falha {index}",
    )


# --- gravador -----------------------------------------------------------------------------------


def test_the_detail_loses_paths_addresses_emails_names_and_tokens() -> None:
    rec, store, _ = recorder(names=["fulano", "PC-DA-SALA"])
    rec.record(
        "check.failed",
        "error",
        r"falhou em C:\Users\fulano\AppData\x.log para 192.168.0.10 (aa:bb:cc:dd:ee:ff), "
        "fulano@exemplo.com, PC-DA-SALA, token=uo_dev_SEGREDO123 e \\\\servidor\\pasta\\a",
    )
    [event] = store.events
    for leaked in (
        "fulano",
        "Users",
        "192.168",
        "aa:bb:cc",
        "PC-DA-SALA",
        "SEGREDO123",
        "servidor",
    ):
        assert leaked not in event.detail
    assert "<caminho>" in event.detail
    assert "<ip>" in event.detail


def test_the_repeat_inside_the_window_only_counts_and_the_summary_comes_out_on_flush() -> None:
    rec, store, clock = recorder(window=600)
    for _ in range(4):
        rec.record("background.failed", "error", "a tarefa x falhou", component="tv.watch")
    assert len(store.events) == 1  # a primeira vai na hora
    rec.flush_pending()
    assert [(e.count) for e in store.events] == [1, 3]
    rec.flush_pending()
    assert len(store.events) == 2  # o resumo não se repete
    clock.advance(601)
    rec.record("background.failed", "error", "a tarefa x falhou", component="tv.watch")
    assert len(store.events) == 3


def test_the_first_event_after_the_window_carries_the_unreported_count() -> None:
    rec, store, clock = recorder(window=600)
    for _ in range(3):
        rec.record("process.exited", "warn", "saiu")
    clock.advance(700)
    rec.record("process.exited", "warn", "saiu")
    assert [e.count for e in store.events] == [1, 3]


def test_the_same_kind_with_another_detail_is_another_occurrence() -> None:
    rec, store, _ = recorder()
    rec.record("check.failed", "error", "a")
    rec.record("check.failed", "error", "b")
    assert len(store.events) == 2


def test_an_invalid_kind_or_component_never_raises_and_records_nothing() -> None:
    rec, store, _ = recorder()
    rec.record("Tipo Inválido", "error", "x")
    rec.record("check.failed", "error", "x", component="C:\\caminho")
    assert store.events == []


def test_a_long_detail_is_cut_and_an_empty_one_falls_back_to_the_kind() -> None:
    rec, store, _ = recorder()
    rec.record("check.failed", "warn", "x" * 1000)
    rec.record("agent.started", "info", "   ")
    assert len(store.events[0].detail) <= DETAIL_LIMIT
    assert store.events[1].detail == "agent.started"


def test_describing_an_exception_gives_type_and_place_but_never_the_message() -> None:
    try:
        raise RuntimeError(r"não abriu C:\Users\fulano\segredo.txt")
    except RuntimeError as error:
        text = describe_exception(error)
    assert text.startswith("RuntimeError em ")
    assert "segredo" not in text and "fulano" not in text
    assert (
        "test_diagnostics.py" not in text
    )  # o ponto é do código do agente; de fora, "desconhecido"
    assert "local desconhecido" in text


def test_the_place_is_the_deepest_frame_of_the_agent_code() -> None:
    rec, _, _ = recorder()
    with pytest.raises(ValueError, match="formato do contrato") as caught:
        rec._record("Inválido", "error", "x", None, None)
    text = describe_exception(caught.value)
    assert text.startswith("ValueError em diagnostics.py:_record (linha ")


def test_the_error_summary_goes_into_the_detail() -> None:
    rec, store, _ = recorder()
    try:
        raise OSError("caminho C:\\x\\y")
    except OSError as error:
        rec.record("background.failed", "error", "a tarefa falhou", error=error)
    assert "OSError em" in store.events[0].detail
    assert "C:" not in store.events[0].detail


def test_component_safe_fits_the_contract_format() -> None:
    assert component_safe("TvSessionManager.watch") == "tvsessionmanager.watch"
    assert component_safe("tv.endereço") == "tv.endere_o"
    assert component_safe("###") is None
    assert component_safe("a" * 80) == "a" * 32


# --- fila em arquivo ----------------------------------------------------------------------------


def test_the_file_queue_keeps_order_and_gives_back_what_could_not_be_sent(tmp_path: Path) -> None:
    store = FileDiagnosticStore(tmp_path)
    for index in range(5):
        store.append(make_event(index))
    first = store.take(2)
    assert [e.detail for e in first] == ["falha 0", "falha 1"]
    store.put_back(first)
    assert [e.detail for e in store.take(10)] == [f"falha {i}" for i in range(5)]
    assert store.take(10) == []


def test_lines_from_the_supervisor_script_are_accepted_and_foreign_ones_are_dropped(
    tmp_path: Path,
) -> None:
    pending = tmp_path / "diagnostics.jsonl"
    pending.write_text(
        "\n".join(
            [
                # O que o `run-agent.ps1` escreve: sem `count`, `at` com milissegundos.
                '{"id":"3f2a9c1d-4e5b-4a79-8877-665544332211","at":"2026-10-31T12:00:00.123Z",'
                '"kind":"process.unresponsive","severity":"error","component":"supervisor",'
                '"detail":"o agente parou"}',
                "isto não é json",
                '{"kind":"Maiuscula","severity":"error","detail":"x"}',
                '{"kind":"check.failed","severity":"fatal","detail":"x"}',
                '{"kind":"check.failed","severity":"warn","detail":"   "}',
                '["lista"]',
                # Sem id/at: o agente completa; o detalhe é higienizado de novo.
                '{"kind":"check.failed","severity":"warn","detail":"em C:\\\\Users\\\\x\\\\a.log"}',
            ]
        ),
        encoding="utf-8",
    )
    events = FileDiagnosticStore(tmp_path).take(20)
    assert [e.kind for e in events] == ["process.unresponsive", "check.failed"]
    assert events[0].component == "supervisor" and events[0].at == "2026-10-31T12:00:00.123Z"
    assert "Users" not in events[1].detail
    assert events[1].id and events[1].at.endswith("Z")


def test_the_queue_never_holds_more_than_the_cap(tmp_path: Path) -> None:
    store = FileDiagnosticStore(tmp_path, max_events=5)
    for index in range(40):
        store.append(make_event(index))
    taken = store.take(100)
    assert len(taken) == 5
    assert taken[-1].detail == "falha 39"
    assert MAX_EVENTS == 200


def test_what_arrives_while_the_queue_is_being_read_is_not_lost(tmp_path: Path) -> None:
    store = FileDiagnosticStore(tmp_path)
    store.append(make_event(1))
    taken = store.take(10)
    # Depois da renomeação, quem escreve (o supervisor) cai num arquivo novo.
    (tmp_path / "diagnostics.jsonl").write_text(
        '{"kind":"process.exited","severity":"warn","detail":"nova"}\n', encoding="utf-8"
    )
    assert [e.detail for e in taken] == ["falha 1"]
    assert [e.detail for e in store.take(10)] == ["nova"]


def test_a_leftover_from_an_interrupted_send_is_read_first(tmp_path: Path) -> None:
    store = FileDiagnosticStore(tmp_path)
    store.append(make_event(1))
    store.take(0)  # renomeia para `.sending` e não tira nada: simula a queda do processo
    store.append(make_event(2))
    assert [e.detail for e in store.take(10)] == ["falha 1"]
    assert [e.detail for e in store.take(10)] == ["falha 2"]


@pytest.mark.parametrize(
    ("logger", "expected"),
    [
        ("uniover_agent.core.tv.session", "tv.session"),
        ("uniover_agent.adapters.tv_samsung", "tv_samsung"),
        ("uniover_agent", "uniover_agent"),
        ("###", None),
        ("uniover_agent.Core.Algo-Estranho", "algo_estranho"),
    ],
)
def test_the_logger_name_becomes_a_component(logger: str, expected: str | None) -> None:
    assert component_of(logger) == expected


def test_every_logged_error_becomes_an_event_unless_it_was_already_recorded() -> None:
    rec, store, _ = recorder()
    handler = DiagnosticsLogHandler(rec)
    log = logging.getLogger("uniover_agent.core.tv.session")
    log.addHandler(handler)
    other = logging.getLogger("outra.biblioteca")
    other.addHandler(handler)
    try:
        log.warning("só aviso")
        log.error("falha comum em C:\\Users\\x\\a")
        log.error("já gravada", extra={"recorded": True})
        other.error("de fora")
        try:
            raise ValueError("segredo")
        except ValueError:
            log.exception("deu ruim")
    finally:
        log.removeHandler(handler)
        other.removeHandler(handler)
    assert [e.kind for e in store.events] == ["error.logged", "error.logged"]
    assert store.events[0].component == "tv.session"
    assert "Users" not in store.events[0].detail
    assert "ValueError em" in store.events[1].detail
    assert "segredo" not in store.events[1].detail


# --- envio --------------------------------------------------------------------------------------


def shipper(
    store: MemoryStore, transport: FakeTransport, rec: DiagnosticsRecorder, clock: FakeClock
) -> DiagnosticsShipper:
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    return DiagnosticsShipper(store, rec, transport, envelopes, clock)


async def test_the_queue_goes_out_in_batches_that_pass_the_contract_gate() -> None:
    rec, store, clock = recorder()
    transport = FakeTransport()
    for index in range(45):
        store.append(make_event(index))
    sent = await shipper(store, transport, rec, clock).flush()
    assert sent == 45
    sizes = [len(message["body"]["events"]) for message in transport.sent]
    assert sizes == [BATCH_SIZE, BATCH_SIZE, 5]
    assert {message["type"] for message in transport.sent} == {"agent.diagnostics.v1"}
    first = transport.sent[0]["body"]["events"][0]
    assert first["kind"] == "background.failed" and "count" not in first


async def test_one_round_never_sends_more_than_the_batch_cap() -> None:
    rec, store, clock = recorder()
    transport = FakeTransport()
    for index in range(BATCH_SIZE * MAX_BATCHES_PER_FLUSH + 7):
        store.append(make_event(index))
    sent = await shipper(store, transport, rec, clock).flush()
    assert sent == BATCH_SIZE * MAX_BATCHES_PER_FLUSH
    assert len(store.events) == 7


async def test_a_transport_failure_puts_the_batch_back_at_the_front() -> None:
    rec, store, clock = recorder()

    class Failing(FakeTransport):
        async def send(self, message: dict[str, object]) -> None:
            raise TransportError("sem canal")

    for index in range(3):
        store.append(make_event(index))
    assert await shipper(store, Failing(), rec, clock).flush() == 0
    assert [e.detail for e in store.events] == ["falha 0", "falha 1", "falha 2"]


async def test_a_batch_that_cannot_become_a_valid_message_is_dropped_not_retried_forever() -> None:
    rec, store, clock = recorder()
    transport = FakeTransport()
    store.append(
        DiagnosticEvent("não-é-uuid", "2026-10-31T12:00:00.000Z", "check.failed", "error", "x")
    )
    store.append(make_event(1))
    flushed = await shipper(store, transport, rec, clock).flush()
    # O lote inválido sai da fila; o seguinte (outro lote) não existe porque tudo coube em um só.
    assert flushed == 0
    assert store.events == []
    assert transport.sent == []


async def test_a_repeat_count_is_sent_and_pending_summaries_go_out_with_the_flush() -> None:
    rec, store, clock = recorder()
    transport = FakeTransport()
    for _ in range(5):
        rec.record("process.exited", "warn", "saiu", component="main")
    await shipper(store, transport, rec, clock).flush()
    events = [e for message in transport.sent for e in message["body"]["events"]]
    assert [e.get("count", 1) for e in events] == [1, 4]


async def test_the_periodic_task_sends_every_interval_and_survives_a_failing_round() -> None:
    rec, store, clock = recorder()
    transport = FakeTransport()
    ship = shipper(store, transport, rec, clock)
    calls = 0
    original = ship.flush

    async def flaky() -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("boom")
        return await original()

    ship.flush = flaky  # type: ignore[method-assign]
    task = asyncio.create_task(ship.run())
    store.append(make_event(1))
    for _ in range(20):
        await asyncio.sleep(0)
        if transport.sent:
            break
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls >= 2
    assert len(transport.sent) == 1


def test_scrub_personal_keeps_ordinary_text_and_removes_known_names_case_insensitively() -> None:
    assert scrub_personal("a TV respondeu em 3 s") == "a TV respondeu em 3 s"
    assert scrub_personal("usuário Fulano abriu", ["fulano"]) == "usuário <nome> abriu"
    # Nome curto demais não vira regra (apagaria pedaços de palavras comuns).
    assert scrub_personal("ele abriu", ["el"]) == "ele abriu"
    assert scrub_personal("rede fe80::1ff:fe23:4567:890a") == "rede <ip>"
    assert scrub_personal("/home/fulano/x e /Users/ciclano/y") == "<caminho> e <caminho>"
