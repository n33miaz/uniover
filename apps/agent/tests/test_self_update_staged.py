r"""Atualização preparada: a versão nova se monta em `app.staging\<sha>` com o ambiente guardado,
com o agente antigo servindo; a troca é gravar o ponteiro (reserva) ou a passagem sem queda."""

import os
import time
import zipfile
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters import current_pointer as pointer
from uniover_agent.adapters import self_update as module
from uniover_agent.adapters.self_update import (
    SelfUpdateError,
    UpdateResult,
    apply_prepared,
    candidate_env,
    self_update,
)

OLD = "a" * 40
NEW = "b" * 40
NEXT = "c" * 40


def make_zip(path: Path, sha: str, *, runner: bool = True) -> None:
    with zipfile.ZipFile(path, "w") as bundle:
        bundle.comment = sha.encode("ascii")
        bundle.writestr(f"uniover-{sha}/README.md", "raiz")
        bundle.writestr(f"uniover-{sha}/apps/agent/pyproject.toml", "[project]\n")
        if runner:
            bundle.writestr(f"uniover-{sha}/apps/agent/tools/run-agent.ps1", "# supervisor\n")


class Pc:
    """Uma instalação com `app` na versão antiga (o layout de sempre) e `runtime` vazio."""

    def __init__(self, base: Path) -> None:
        self.base = base
        self.source = base / "app"
        (self.source / "tools").mkdir(parents=True)
        (self.source / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (self.source / "tools" / "run-agent.ps1").write_text("# antigo\n", encoding="ascii")
        (self.source / ".version").write_text(OLD + "\n", encoding="ascii")
        (base / "runtime" / "venv" / "Scripts").mkdir(parents=True)
        (base / "runtime" / "venv" / "Scripts" / "python.exe").write_bytes(b"")
        self.downloads: list[str] = []
        self.synced: list[Path] = []
        self.checked: list[Path] = []

    def download(self, sha: str, destination: Path) -> None:
        self.downloads.append(sha)
        make_zip(destination, sha)

    def run_sync(self, source: Path) -> None:
        self.synced.append(source)
        environment = candidate_env(source)
        (environment / "Scripts").mkdir(parents=True)
        (environment / "Scripts" / "python.exe").write_bytes(b"")

    def run_check(self, source: Path) -> None:
        self.checked.append(source)

    def prepare(self, latest: str, **kwargs: Any) -> UpdateResult:
        options: dict[str, Any] = {
            "staged": True,
            "fetch_latest": lambda: latest,
            "download": self.download,
            "run_sync": self.run_sync,
            "run_check": self.run_check,
            "free_bytes": lambda folder: 10**12,
        } | kwargs
        return self_update(self.source, **options)

    def installed(self) -> str | None:
        return module.read_version(pointer.current_app(self.base))

    def trial(self) -> str | None:
        path = self.base / "runtime" / "update-trial.txt"
        return path.read_text(encoding="ascii") if path.exists() else None


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path / "UniOver")


# ---- preparar ----


def test_preparing_builds_the_new_version_beside_the_old_one_and_stops_there(pc: Pc) -> None:
    result = pc.prepare(NEW)
    assert result.outcome == "prepared"
    assert result.updated is False
    assert result.latest == NEW
    # O que roda não mudou nada: a versão em uso é a mesma e o ponteiro nem existe.
    assert pc.installed() == OLD
    assert pointer.read(pc.base) is None
    staged = pointer.staged_app(pc.base, NEW)
    assert module.read_version(staged) == NEW
    assert (staged / "tools" / "run-agent.ps1").is_file()
    # O ambiente é o guardado da versão, e o sync e o auto-diagnóstico rodaram NELA.
    assert pc.synced == [staged]
    assert pc.checked == [staged]
    assert (pointer.staged_venv(pc.base, NEW) / "Scripts" / "python.exe").is_file()
    prepared = pointer.read_prepared(pc.base)
    assert prepared is not None
    assert prepared.sha == NEW


def test_preparing_the_same_version_again_does_not_download_it_again(pc: Pc) -> None:
    pc.prepare(NEW)
    again = pc.prepare(NEW)
    assert again.outcome == "prepared"
    assert pc.downloads == [NEW]


def test_preparing_does_not_wait_for_the_tv_nor_for_the_version_in_trial(pc: Pc) -> None:
    # A TV usada agora e a versão atual ainda em prova adiavam a troca de pasta; preparar não
    # derruba nada, então nenhuma das duas atrapalha.
    runtime = pc.base / "runtime"
    (runtime / "tv-last-use").write_text("", encoding="ascii")
    (runtime / "update-trial.txt").write_text(f"{OLD}|0", encoding="ascii")
    result = pc.prepare(NEW)
    assert result.outcome == "prepared"
    assert pc.trial() == f"{OLD}|0"


def test_a_failed_check_removes_what_was_built_and_prepares_nothing(pc: Pc) -> None:
    def broken(source: Path) -> None:
        raise SelfUpdateError("o auto-diagnóstico da versão nova falhou (código 1)")

    result = pc.prepare(NEW, run_check=broken)
    assert result.outcome == "failed"
    assert not pointer.staged_app(pc.base, NEW).exists()
    assert not pointer.staged_venv(pc.base, NEW).exists()
    assert pointer.read_prepared(pc.base) is None


def test_a_version_that_is_already_installed_clears_the_prepared_mark(pc: Pc) -> None:
    pc.prepare(NEW)
    result = pc.prepare(OLD)
    assert result.outcome == "up_to_date"
    assert pointer.read_prepared(pc.base) is None


def test_a_blocked_version_is_not_prepared(pc: Pc) -> None:
    (pc.base / "runtime" / ".blocked-versions").write_text(NEW + "\n", encoding="ascii")
    result = pc.prepare(NEW)
    assert result.outcome == "blocked"
    assert pc.downloads == []


def test_preparing_a_newer_commit_discards_the_one_that_never_got_in(pc: Pc) -> None:
    pc.prepare(NEW)
    pc.prepare(NEXT)
    assert not pointer.staged_app(pc.base, NEW).exists()
    assert not pointer.staged_venv(pc.base, NEW).exists()
    prepared = pointer.read_prepared(pc.base)
    assert prepared is not None
    assert prepared.sha == NEXT


def test_preparing_never_removes_the_version_in_use_or_the_previous_one(pc: Pc) -> None:
    pc.prepare(NEW)
    apply_prepared(pc.source)
    pc.prepare(NEXT)
    assert pointer.staged_app(pc.base, NEW).is_dir()
    assert pointer.staged_venv(pc.base, NEW).is_dir()
    assert (pc.base / "app").is_dir()
    assert (pc.base / "runtime" / "venv").is_dir()


def test_the_disposable_environment_of_the_classic_layout_is_unchanged(tmp_path: Path) -> None:
    assert candidate_env(tmp_path / "app") == tmp_path / "app.venv"
    base = tmp_path / "UniOver"
    assert candidate_env(pointer.staged_app(base, NEW)) == base / "runtime" / f"venv-{NEW}"


# ---- trocar (caminho de reserva) ----


def test_applying_writes_the_pointer_and_keeps_the_old_one_to_go_back(pc: Pc) -> None:
    pc.prepare(NEW)
    result = apply_prepared(pc.source)
    assert result.updated is True
    assert result.outcome == "updated"
    resolved = pointer.read(pc.base)
    assert resolved is not None
    assert resolved.current.sha == NEW
    assert resolved.current.app == pointer.staged_app(pc.base, NEW)
    # A anterior é o layout de sempre, intacto, com o ambiente dele.
    assert resolved.previous == pointer.legacy_slot(pc.base)
    assert pc.installed() == NEW
    assert module.read_version(pc.source) == OLD
    assert pc.trial() == f"{NEW}|0"
    assert pointer.read_prepared(pc.base) is None


def test_the_proof_is_written_before_the_pointer(pc: Pc) -> None:
    pc.prepare(NEW)
    seen: list[object] = []

    def record(source: Path, sha: str) -> None:
        # Quando a prova é gravada o ponteiro ainda é o de antes: sem prova, não há troca.
        seen.append(pointer.read(pc.base))
        module.write_trial_marker(source, sha)

    assert apply_prepared(pc.source, record_trial=record).updated is True
    assert seen == [None]


def test_a_proof_that_cannot_be_written_means_no_switch(pc: Pc) -> None:
    pc.prepare(NEW)

    def full_disk(source: Path, sha: str) -> None:
        raise OSError("disco cheio")

    result = apply_prepared(pc.source, record_trial=full_disk)
    assert result.outcome == "failed"
    assert result.updated is False
    assert pointer.read(pc.base) is None
    assert pointer.read_prepared(pc.base) is not None


def test_a_pointer_that_cannot_be_written_takes_the_proof_back(
    pc: Pc, monkeypatch: pytest.MonkeyPatch
) -> None:
    pc.prepare(NEW)

    def refuse(base: Path, target: pointer.Slot) -> pointer.Pointer:
        raise OSError("negado")

    monkeypatch.setattr(pointer, "switch_to", refuse)
    result = apply_prepared(pc.source)
    assert result.outcome == "failed"
    assert pc.trial() is None


def test_applying_waits_for_the_tv_unless_the_owner_insists(pc: Pc) -> None:
    pc.prepare(NEW)
    (pc.base / "runtime" / "tv-last-use").write_text("", encoding="ascii")
    waiting = apply_prepared(pc.source)
    assert waiting.outcome == "deferred_busy"
    assert pc.installed() == OLD
    assert apply_prepared(pc.source, ignore_deferral=True).updated is True


def test_applying_waits_for_the_pc_control_too(pc: Pc) -> None:
    pc.prepare(NEW)
    (pc.base / "runtime" / "pc-last-use").write_text("", encoding="ascii")
    assert apply_prepared(pc.source).outcome == "deferred_busy"


def test_applying_does_not_replace_a_version_that_is_still_in_trial(pc: Pc) -> None:
    pc.prepare(NEW)
    (pc.base / "runtime" / "update-trial.txt").write_text(f"{OLD}|0", encoding="ascii")
    result = apply_prepared(pc.source)
    assert result.updated is False
    assert "em prova" in result.message
    assert pointer.read(pc.base) is None


def test_applying_refuses_a_version_that_got_blocked_meanwhile(pc: Pc) -> None:
    pc.prepare(NEW)
    (pc.base / "runtime" / ".blocked-versions").write_text(NEW + "\n", encoding="ascii")
    assert apply_prepared(pc.source).outcome == "blocked"
    assert pointer.read(pc.base) is None


def test_applying_with_nothing_prepared_does_nothing(pc: Pc) -> None:
    result = apply_prepared(pc.source)
    assert result.updated is False
    assert result.outcome is None
    assert pointer.read(pc.base) is None


def test_a_second_update_keeps_the_first_as_the_one_to_go_back_to(pc: Pc) -> None:
    pc.prepare(NEW)
    apply_prepared(pc.source)
    # A primeira se confirmou (sem prova): a segunda entra e a anterior passa a ser a primeira.
    (pc.base / "runtime" / "update-trial.txt").unlink()
    pc.source = pointer.current_app(pc.base)
    pc.prepare(NEXT)
    assert apply_prepared(pc.source).updated is True
    resolved = pointer.read(pc.base)
    assert resolved is not None
    assert resolved.current.sha == NEXT
    assert resolved.previous is not None
    assert resolved.previous.sha == NEW
    assert os.path.isdir(resolved.previous.app)


def test_the_state_of_a_prepared_check_is_neutral(pc: Pc, tmp_path: Path) -> None:
    from datetime import UTC, datetime  # noqa: PLC0415

    from uniover_agent.adapters.update_status import (  # noqa: PLC0415
        PREPARED_REASON,
        STATUS_FILE,
        record_result,
        record_status,
    )

    path = pc.base / "runtime" / STATUS_FILE
    record_status(path, {"outcome": "updating"})
    record_result(path, pc.prepare(NEW), datetime.now(UTC))
    import json  # noqa: PLC0415

    state = json.loads(path.read_text(encoding="utf-8"))
    # Nada de "atualizando" preso nem de falha: a versão está pronta e o motivo diz isso.
    assert state["outcome"] == "up_to_date"
    assert state["reason"] == PREPARED_REASON
    assert state["latestSha"] == NEW


def test_a_version_that_got_blocked_or_deferred_stops_waiting_for_the_switch(pc: Pc) -> None:
    # O supervisor só age no que está preparado: uma versão que a passagem bloqueou ou adiou
    # (e que o `self-update` agora recusa) não pode ser tentada de novo a cada checagem.
    pc.prepare(NEW)
    runtime = pc.base / "runtime"
    (runtime / ".blocked-versions").write_text(NEW + "\n", encoding="ascii")
    assert pc.prepare(NEW).outcome == "blocked"
    assert pointer.read_prepared(pc.base) is None
    (runtime / ".blocked-versions").unlink()
    pc.prepare(NEW)
    (runtime / ".deferred-versions").write_text(f"{NEW}|{int(time.time())}\n", encoding="ascii")
    assert pc.prepare(NEW).outcome == "deferred"
    assert pointer.read_prepared(pc.base) is None
