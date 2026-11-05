"""Falhas de partida deixam rastro em disco e na fila do diagnóstico, sem repetir sem fim."""

import json
import os
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters.diagnostics_file import FileDiagnosticStore
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.startup_trace import (
    CLAIM_UNREADABLE_SECONDS,
    KIND,
    LOG_FILE,
    REPEAT_SECONDS,
    record_startup_failure,
)
from uniover_agent.composition import connection, system
from uniover_agent.config import ConfigError
from uniover_agent.core import EnvelopeFactory, EnvelopeGate
from uniover_agent.core.diagnostics import DiagnosticsRecorder, DiagnosticsShipper

from .support import AGENT_ID
from .test_diagnostics import make_event


def fixed(value: float) -> Callable[[], float]:
    return lambda: value


def queue(base: Path) -> list[dict[str, object]]:
    path = base / "runtime" / "diagnostics.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def markers(base: Path) -> list[Path]:
    return sorted((base / "runtime").glob("startup-failure.*.txt"))


def test_a_failure_goes_to_the_log_and_to_the_diagnostics_queue(tmp_path: Path) -> None:
    assert record_startup_failure(
        "cofre", "falha ao ler do cofre", base=tmp_path, clock=lambda: 1e9
    )

    log = (tmp_path / "logs" / LOG_FILE).read_text(encoding="utf-8")
    assert "ERROR startup: cofre: falha ao ler do cofre" in log
    [event] = queue(tmp_path)
    assert event["kind"] == KIND
    assert event["severity"] == "error"
    assert event["component"] == "startup"
    assert str(event["detail"]).startswith("cofre:")


def test_the_same_reason_is_not_repeated_inside_the_window(tmp_path: Path) -> None:
    assert record_startup_failure("cofre", "a", base=tmp_path, clock=lambda: 1000.0)
    assert not record_startup_failure("cofre", "b", base=tmp_path, clock=lambda: 1000.0 + 60)
    assert len(queue(tmp_path)) == 1
    # Outro motivo entra na hora; o mesmo, só depois da janela.
    assert record_startup_failure("nao_pareado", "c", base=tmp_path, clock=lambda: 1000.0 + 120)
    after = 1000.0 + REPEAT_SECONDS + 1
    assert record_startup_failure("cofre", "d", base=tmp_path, clock=lambda: after)
    assert len(queue(tmp_path)) == 3


def test_the_log_is_rotated_when_it_grows_too_much(tmp_path: Path) -> None:
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / LOG_FILE).write_text("x" * (70 * 1024), encoding="utf-8")

    record_startup_failure("cofre", "depois", base=tmp_path)

    assert (logs / (LOG_FILE + ".1")).exists()
    assert (logs / LOG_FILE).stat().st_size < 1024


def test_a_broken_folder_never_raises(tmp_path: Path) -> None:
    blocker = tmp_path / "runtime"
    blocker.write_text("é um arquivo, não uma pasta", encoding="utf-8")

    assert record_startup_failure("cofre", "x", base=tmp_path) is False
    assert markers(tmp_path) == []


def test_a_queue_that_cannot_be_written_does_not_start_the_window(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    # Uma pasta no lugar do arquivo: abrir para acrescentar falha, como numa fila trancada.
    (runtime / "diagnostics.jsonl").mkdir()

    assert record_startup_failure("cofre", "a", base=tmp_path, clock=lambda: 1000.0) is False
    assert markers(tmp_path) == []
    assert not list(runtime.glob("*.claim"))

    (runtime / "diagnostics.jsonl").rmdir()
    # A próxima partida tenta de novo, sem esperar as 6 h.
    assert record_startup_failure("cofre", "a", base=tmp_path, clock=lambda: 1001.0) is True
    assert len(queue(tmp_path)) == 1
    assert len(markers(tmp_path)) == 1


def test_each_reason_has_its_own_window(tmp_path: Path) -> None:
    for moment, reason in enumerate(("cofre", "nao_pareado", "cofre", "nao_pareado")):
        record_startup_failure(reason, "x", base=tmp_path, clock=fixed(1000.0 + moment))

    assert [e["detail"] for e in queue(tmp_path)] == ["cofre: x", "nao_pareado: x"]


def test_only_one_of_many_simultaneous_processes_records_the_window(tmp_path: Path) -> None:
    results: list[bool] = []
    gate = threading.Barrier(8)

    def worker() -> None:
        gate.wait()
        results.append(record_startup_failure("cofre", "x", base=tmp_path, clock=lambda: 5000.0))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert results.count(True) == 1
    assert len(queue(tmp_path)) == 1


def test_a_fresh_claim_blocks_and_a_stale_one_is_taken_over(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    claim = runtime / "startup-failure.cofre.txt.claim"
    claim.write_text("", encoding="utf-8")
    os.utime(claim, (2000.0, 2000.0))

    assert record_startup_failure("cofre", "x", base=tmp_path, clock=lambda: 2005.0) is False
    assert queue(tmp_path) == []
    assert claim.exists()

    stale = 2000.0 + CLAIM_UNREADABLE_SECONDS + 1
    assert record_startup_failure("cofre", "x", base=tmp_path, clock=lambda: stale) is True
    assert not claim.exists()


def test_anything_that_looks_like_a_secret_or_a_person_is_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("USERNAME", "raphaelzinho")
    detail = (
        r"PermissionError: C:\Users\raphaelzinho\AppData\x.toml negado para raphaelzinho; "
        "valor QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVuIHNlc2FtZQ e uo_dev_abcdef123456 "
        "Authorization: Basic abc123 senha=hunter2 maria@example.com 192.168.0.14"
    )

    record_startup_failure("excecao", detail, base=tmp_path)

    text = (tmp_path / "logs" / LOG_FILE).read_text(encoding="utf-8")
    sent = json.dumps(queue(tmp_path))
    for leaked in (
        "raphaelzinho",
        "QWxhZGRpbjpvcGVuIHNlc2FtZQ",
        "uo_dev_abcdef123456",
        "abc123",
        "hunter2",
        "maria@example.com",
        "192.168.0.14",
    ):
        assert leaked not in text
        assert leaked not in sent


def test_main_records_a_config_error_and_still_returns_the_failure_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[str, str]] = []
    monkeypatch.setattr(
        main_module, "record_startup_failure", lambda reason, detail: seen.append((reason, detail))
    )

    def broken() -> None:
        raise ConfigError("agent.toml inválido")

    monkeypatch.setattr(main_module, "Settings", broken)

    assert main_module.main(["run"]) == 1
    assert seen == [("configuracao", "agent.toml inválido")]


def test_main_records_an_unexpected_exception_and_lets_it_rise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[str, str]] = []
    monkeypatch.setattr(
        main_module, "record_startup_failure", lambda reason, detail: seen.append((reason, detail))
    )

    def broken() -> None:
        raise PermissionError("negado")

    monkeypatch.setattr(main_module, "migrate_layout", broken)

    with pytest.raises(PermissionError):
        main_module.main(["run"])
    [(reason, detail)] = seen
    assert reason == "excecao"
    assert detail.startswith("PermissionError em test_startup_trace.py:")
    assert "negado" not in detail


def test_other_commands_do_not_write_startup_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(main_module, "record_startup_failure", lambda *a: seen.append("x"))

    def broken() -> None:
        raise ConfigError("ruim")

    monkeypatch.setattr(main_module, "Settings", broken)

    assert main_module.main(["status"]) == 1
    assert seen == []


def test_invalid_settings_are_a_configuration_failure_without_the_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("UNIOVER_TV_ADB_PORT", "segredo-que-nao-e-numero")

    assert main_module.main(["run"]) == 1

    base = installation_base()
    log = (base / "logs" / LOG_FILE).read_text(encoding="utf-8")
    assert "configuracao: configuração inválida" in log
    assert "segredo-que-nao-e-numero" not in log
    assert "segredo-que-nao-e-numero" not in json.dumps(queue(base))


def test_the_real_not_paired_exit_is_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("UNIOVER_AGENT_ID", raising=False)

    assert main_module.main(["run"]) == system.EXIT_NOT_PAIRED

    base = installation_base()
    assert "nao_pareado:" in (base / "logs" / LOG_FILE).read_text(encoding="utf-8")
    assert [e["kind"] for e in queue(base)] == [KIND]


def test_the_credential_rejected_exit_is_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    async def rejected(*args: object, **kwargs: object) -> int:
        return system.EXIT_CREDENTIAL_REJECTED

    monkeypatch.setattr(connection, "run", rejected)

    assert main_module.main(["run"]) == system.EXIT_CREDENTIAL_REJECTED

    log = (installation_base() / "logs" / LOG_FILE).read_text(encoding="utf-8")
    assert "credencial_recusada:" in log


async def test_the_recorded_failure_goes_out_on_the_next_hello(tmp_path: Path) -> None:
    record_startup_failure("cofre", "falha ao ler do cofre", base=tmp_path)
    clock = FakeClock(datetime(2026, 11, 5, 12, 0, tzinfo=UTC))
    store = FileDiagnosticStore(tmp_path / "runtime")
    transport = FakeTransport()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    shipper = DiagnosticsShipper(
        store, DiagnosticsRecorder(store, clock), transport, envelopes, clock
    )

    assert await shipper.flush() == 1

    [message] = transport.sent
    [event] = message["body"]["events"]
    assert event["kind"] == KIND
    assert event["detail"].startswith("cofre:")


def test_compaction_keeps_the_newest_events_and_leaves_the_live_file_alone(
    tmp_path: Path,
) -> None:
    """Compactar não regrava `diagnostics.jsonl` (o supervisor acrescenta a ele sem lock)."""
    store = FileDiagnosticStore(tmp_path, max_events=5)
    total = 1200
    for index in range(total):
        assert store.append_confirmed(make_event(index))

    # Depois da compactação o arquivo vivo é novo: o que cai nele não depende de leitura antiga.
    pending = tmp_path / "diagnostics.jsonl"
    before = pending.stat().st_size if pending.exists() else 0
    assert before < 160 * 1024
    line = '{"kind":"update.failed","severity":"error","detail":"do supervisor"}'
    with pending.open("a", encoding="utf-8") as handle:
        handle.write(line + os.linesep)

    collected: list[str] = []
    while batch := store.take(100):
        collected += [e.detail for e in batch]
        store.confirm(batch)

    assert "do supervisor" in collected
    assert f"falha {total - 1}" in collected
    assert len(collected) <= 20
