"""Falhas de partida deixam rastro em disco e na fila do diagnóstico, sem repetir sem fim."""

import json
from pathlib import Path

import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters import startup_trace
from uniover_agent.adapters.startup_trace import (
    KIND,
    LOG_FILE,
    MARKER_FILE,
    REPEAT_SECONDS,
    record_startup_failure,
)
from uniover_agent.config import ConfigError


def queue(base: Path) -> list[dict[str, object]]:
    path = base / "runtime" / "diagnostics.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


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
    assert record_startup_failure(
        "cofre", "d", base=tmp_path, clock=lambda: 1000.0 + REPEAT_SECONDS + 1
    )
    assert len(queue(tmp_path)) == 3


def test_secrets_in_the_detail_are_scrubbed(tmp_path: Path) -> None:
    record_startup_failure("excecao", "falhou com token=segredo123456 no meio", base=tmp_path)

    text = (tmp_path / "logs" / LOG_FILE).read_text(encoding="utf-8")
    assert "segredo123456" not in text
    assert "segredo123456" not in json.dumps(queue(tmp_path))


def test_the_log_is_rotated_when_it_grows_too_much(tmp_path: Path) -> None:
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / LOG_FILE).write_text("x" * (70 * 1024), encoding="utf-8")

    record_startup_failure("cofre", "depois", base=tmp_path)

    assert (logs / (LOG_FILE + ".1")).exists()
    assert (logs / LOG_FILE).stat().st_size < 1024


def test_a_broken_folder_never_raises(tmp_path: Path) -> None:
    blocker = tmp_path / "logs"
    blocker.write_text("é um arquivo, não uma pasta", encoding="utf-8")

    assert record_startup_failure("cofre", "x", base=tmp_path) is False
    assert not (tmp_path / "runtime" / MARKER_FILE).exists()


def test_main_records_a_config_error_and_still_returns_the_failure_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
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
    assert seen == [("excecao", "PermissionError: negado")]


def test_other_commands_do_not_write_startup_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(main_module, "record_startup_failure", lambda *a: seen.append("x"))

    def broken() -> None:
        raise ConfigError("ruim")

    monkeypatch.setattr(main_module, "Settings", broken)

    assert main_module.main(["status"]) == 1
    assert seen == []
    assert startup_trace.KIND == "startup.failed"
