"""Auto-diagnóstico da versão (`selfcheck`), canal de atualização e o comando `diagnose`."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from uniover_agent import main as main_module
from uniover_agent import selfcheck
from uniover_agent.adapters.self_update import UpdateResult
from uniover_agent.config import Settings
from uniover_agent.core.self_care import Check, CheckResult
from uniover_agent.main import EXIT_FAILURE, EXIT_OK, main, update_agent

# --- canal -------------------------------------------------------------------------------------


def test_the_channel_defaults_to_develop_and_accepts_main() -> None:
    assert Settings().update_channel == "develop"
    assert Settings(update_channel="main").update_channel == "main"
    assert Settings(update_channel=" Main ").update_channel == "main"


def test_any_other_channel_is_refused() -> None:
    with pytest.raises(ValidationError):
        Settings(update_channel="xyz")


def test_the_channel_comes_from_the_variable_and_from_the_file(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    isolated_env.write_text('update_channel = "main"\n', encoding="utf-8")
    assert Settings().update_channel == "main"
    monkeypatch.setenv("UNIOVER_UPDATE_CHANNEL", "develop")
    assert Settings().update_channel == "develop"  # a variável vence o arquivo


def test_the_update_receives_the_channel_of_the_settings(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    isolated_env.write_text('update_channel = "main"\n', encoding="utf-8")
    seen: list[str] = []

    def fake(source: Path, *, sync: bool, channel: str) -> UpdateResult:
        seen.append(channel)
        return UpdateResult(False, "ok", "up_to_date")

    monkeypatch.setattr(main_module, "self_update", fake)
    assert main(["self-update"]) == EXIT_OK
    assert seen == ["main"]


# --- selfcheck ----------------------------------------------------------------------------------


def test_a_good_installation_passes_the_selfcheck(capsys: pytest.CaptureFixture[str]) -> None:
    assert selfcheck.run() == []
    assert selfcheck.main() == selfcheck.EXIT_OK
    assert "tudo certo" in capsys.readouterr().out


def test_a_configuration_the_new_version_does_not_accept_is_a_problem_without_library_text(
    isolated_env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    isolated_env.write_text('update_channel = "xyz"\ntv_cleanup_keep = 3\n', encoding="utf-8")
    problems = selfcheck.run()
    assert len(problems) == 1 and "a configuração deste PC é aceita" in problems[0]
    # O texto da biblioteca (pydantic) pode trazer valores e caminhos: só o tipo vai adiante.
    assert "xyz" not in problems[0] and "ValidationError" in problems[0]
    assert selfcheck.main() == selfcheck.EXIT_PROBLEM
    assert "falhou em" in capsys.readouterr().err


def test_our_own_configuration_error_keeps_its_clear_message(isolated_env: Path) -> None:
    isolated_env.write_text('api_url = "ftp://x"\n', encoding="utf-8")
    [problem] = selfcheck.run()
    assert "ConfigError" in problem and "http(s) completo" in problem


def test_a_broken_step_does_not_hide_the_next_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom() -> None:
        raise ImportError("nome secreto")

    monkeypatch.setattr(selfcheck, "STEPS", (("o código novo carrega", boom), *selfcheck.STEPS[1:]))
    [problem] = selfcheck.run()
    assert "ImportError" in problem and "secreto" not in problem


def test_the_module_runs_as_a_program_and_exits_zero(tmp_path: Path) -> None:
    done = subprocess.run(
        [sys.executable, "-I", "-m", "uniover_agent.selfcheck"],
        check=False,
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env={
            "SystemRoot": os.environ.get("SystemRoot", ""),
            "LOCALAPPDATA": str(tmp_path / "local"),
            "UNIOVER_CONFIG_FILE": str(tmp_path / "agent.toml"),
        },
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    assert "tudo certo" in done.stdout


# --- diagnose -----------------------------------------------------------------------------------


def fake_checks(*results: CheckResult, repair_ok: bool = True) -> list[Check]:
    checks = []
    for index, result in enumerate(results):
        state = {"fixed": False}

        async def run(result: CheckResult = result, state: dict[str, bool] = state) -> CheckResult:
            return CheckResult(True, "agora sim") if state["fixed"] else result

        async def repair(state: dict[str, bool] = state) -> str | None:
            state["fixed"] = repair_ok
            return None

        checks.append(Check(f"verificacao{index}", run, repair, "refeita"))
    return checks


def test_diagnose_prints_one_plain_line_per_check_and_fails_only_on_a_real_problem(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        main_module,
        "build_checks",
        lambda *args, **kwargs: fake_checks(
            CheckResult(True, "em ordem"), CheckResult(False, "TV fora", severity="warn")
        ),
    )
    assert main(["diagnose"]) == EXIT_OK
    out = capsys.readouterr().out
    assert "OK        verificacao0: em ordem" in out
    assert "PROBLEMA  verificacao1: TV fora" in out
    assert "Detalhes no registro:" in out


def test_diagnose_exits_with_failure_when_an_error_is_left(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        main_module,
        "build_checks",
        lambda *args, **kwargs: fake_checks(CheckResult(False, "pasta incompleta", fixable=True)),
    )
    assert main(["diagnose"]) == EXIT_FAILURE
    assert "PROBLEMA  verificacao0: pasta incompleta" in capsys.readouterr().out


def test_diagnose_only_repairs_when_asked(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        main_module,
        "build_checks",
        lambda *args, **kwargs: fake_checks(CheckResult(False, "quebrada", fixable=True)),
    )
    assert main(["diagnose", "--repair"]) == EXIT_OK
    out = capsys.readouterr().out
    assert "Reparado: verificacao0." in out and "agora sim" in out


# --- update_agent registra o resultado como ocorrência ----------------------------------------


def run_update(monkeypatch: pytest.MonkeyPatch, result: UpdateResult) -> list[tuple[str, str]]:
    from uniover_agent.adapters.fakes import FakeClock  # noqa: PLC0415
    from uniover_agent.care_setup import build_diagnostics  # noqa: PLC0415

    monkeypatch.setattr(main_module, "self_update", lambda source, *, sync, channel: result)
    kit = build_diagnostics(FakeClock())
    assert update_agent(sync=False, kit=kit) == EXIT_OK
    kit.recorder.flush_pending()
    return [(event.kind, event.severity) for event in kit.store.take(20)]


def test_a_rejected_package_is_recorded_as_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    result = UpdateResult(False, "pacote recusado: x", "failed", rejected=True)
    assert run_update(monkeypatch, result) == [("update.rejected", "error")]


def test_a_plain_failure_is_a_warning_and_an_install_is_noted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failed = UpdateResult(False, "não atualizei agora: sem rede", "failed")
    assert run_update(monkeypatch, failed) == [("update.failed", "warn")]
    installed = UpdateResult(True, "agente atualizado", "updated")
    assert run_update(monkeypatch, installed) == [("update.installed", "info")]
    assert run_update(monkeypatch, UpdateResult(False, "já está", "up_to_date")) == []
