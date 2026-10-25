"""Estado da auto-atualização: limpeza, arquivo, aviso à API, falhas isoladas e salto de versão."""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import zipfile
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.self_update import SelfUpdateError, UpdateResult, self_update
from uniover_agent.adapters.update_status import (
    STATUS_FILE,
    FileUpdateStatus,
    default_status_path,
    record_failure,
    record_result,
    record_status,
    record_updating,
)
from uniover_agent.core import (
    ConnectionSupervisor,
    EnvelopeFactory,
    EnvelopeGate,
    UpdateStatusWatcher,
    update_body,
)
from uniover_agent.core.update_report import (
    REASON_LIMIT,
    STALE_REASON,
    UPDATING_STALE_AFTER,
    build_status,
    format_time,
)
from uniover_agent.main import EXIT_OK, main, update_agent
from uniover_agent.ports import TransportError
from uniover_agent.ports.remote_care import UpdateStatus

from .support import AGENT_ID

OLD = "a" * 40
NEW = "b" * 40
LATEST = "c" * 40
NOW = datetime(2026, 10, 24, 15, 0, tzinfo=UTC)
STAMP = "2026-10-24T14:00:00.000Z"


def factory() -> EnvelopeFactory:
    return EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock())


# --- limpeza ------------------------------------------------------------------------------------


def clean(raw: dict[str, Any], **kwargs: Any) -> UpdateStatus:
    return build_status(
        raw,
        installed_sha=kwargs.pop("installed_sha", OLD),
        installed_at=kwargs.pop("installed_at", STAMP),
        now=NOW,
        **kwargs,
    )


def test_a_full_state_goes_through_and_fits_the_contract() -> None:
    status = clean(
        {
            "outcome": "failed",
            "latestSha": LATEST,
            "checkedAt": "2026-10-24T13:00:00Z",
            "nextCheckAt": "2026-10-24T19:00:00+00:00",
            "reason": "não consegui baixar o pacote (ConnectError)",
            "blockedSha": NEW,
            "rolledBack": True,
        },
        previous_sha=NEW,
    )
    assert status == UpdateStatus(
        outcome="failed",
        installed_sha=OLD,
        installed_at=STAMP,
        latest_sha=LATEST,
        checked_at="2026-10-24T13:00:00.000Z",
        next_check_at="2026-10-24T19:00:00.000Z",
        reason="não consegui baixar o pacote (ConnectError)",
        blocked_sha=NEW,
        previous_sha=NEW,
        rolled_back=True,
    )
    hello = factory().hello("0.1.0", ["transport.keepalive.v1"], update=update_body(status))
    assert hello["body"]["update"]["rolledBack"] is True


def test_garbage_is_dropped_field_by_field_never_sent() -> None:
    status = clean(
        {
            "outcome": "exploded",
            "latestSha": "xyz",
            "checkedAt": "ontem",
            "nextCheckAt": 17,
            "reason": ["lista"],
            "blockedSha": "A" * 39,
            "rolledBack": "sim",
        },
        installed_sha="curto",
        installed_at="sem fuso 2026-10-24T14:00:00",
    )
    assert status == UpdateStatus()
    assert update_body(status) == {"outcome": "not_checked"}


def test_uppercase_hashes_are_normalised() -> None:
    assert clean({"outcome": "updated", "latestSha": LATEST.upper()}).latest_sha == LATEST


def test_the_reason_is_one_short_line_without_secrets() -> None:
    raw = {
        "outcome": "failed",
        "reason": "falhou\n  com Authorization: Bearer abc.def.ghi\ttoken=segredo123 " + "x" * 500,
    }
    reason = clean(raw).reason
    assert reason is not None
    assert len(reason) <= REASON_LIMIT
    assert "\n" not in reason and "\t" not in reason
    assert "segredo123" not in reason and "abc.def.ghi" not in reason


def test_an_update_that_never_finished_becomes_a_failure() -> None:
    old = format_time(NOW - UPDATING_STALE_AFTER - timedelta(minutes=1))
    status = clean({"outcome": "updating", "checkedAt": old})
    assert (status.outcome, status.reason) == ("failed", STALE_REASON)
    assert clean({"outcome": "updating"}).outcome == "failed"
    fresh = format_time(NOW - timedelta(minutes=2))
    assert clean({"outcome": "updating", "checkedAt": fresh}).outcome == "updating"


# --- arquivo ------------------------------------------------------------------------------------


def installation(tmp_path: Path, *, version: str | None = OLD) -> tuple[Path, Path]:
    source = tmp_path / "app"
    source.mkdir()
    if version:
        (source / ".version").write_text(version + "\n", encoding="utf-8")
    return source, tmp_path / "runtime" / STATUS_FILE


def reader(source: Path, path: Path) -> FileUpdateStatus:
    return FileUpdateStatus(path, source, lambda: NOW)


def test_without_a_state_file_the_installed_version_is_still_reported(tmp_path: Path) -> None:
    source, path = installation(tmp_path)
    status = reader(source, path).read()
    assert (status.outcome, status.installed_sha) == ("not_checked", OLD)
    assert status.installed_at is not None and status.installed_at.endswith("Z")
    assert status.previous_sha is None


@pytest.mark.parametrize(
    "content",
    [b"", b"{", b"[1, 2]", b'"texto"', b"\xff\xfe\x00", b"null", b'{"outcome": {"a": 1}}'],
)
def test_a_corrupt_state_file_never_breaks_the_reader(tmp_path: Path, content: bytes) -> None:
    source, path = installation(tmp_path)
    path.parent.mkdir()
    path.write_bytes(content)
    status = reader(source, path).read()
    assert (status.outcome, status.installed_sha) == ("not_checked", OLD)


def test_an_oversized_state_file_is_ignored(tmp_path: Path) -> None:
    source, path = installation(tmp_path)
    path.parent.mkdir()
    path.write_text(json.dumps({"outcome": "updated", "reason": "x" * 50_000}), encoding="utf-8")
    assert reader(source, path).read().outcome == "not_checked"


def test_the_previous_version_comes_from_the_folder_next_to_app(tmp_path: Path) -> None:
    source, path = installation(tmp_path)
    previous = tmp_path / "app.previous"
    care = previous / "src" / "uniover_agent" / "adapters"
    care.mkdir(parents=True)
    (care / "maintenance_signals.py").write_text("", encoding="utf-8")
    (previous / ".version").write_text(NEW + "\n", encoding="utf-8")
    assert reader(source, path).read().previous_sha == NEW


def test_a_previous_version_without_remote_care_is_not_offered_to_go_back_to(
    tmp_path: Path,
) -> None:
    source, path = installation(tmp_path)
    previous = tmp_path / "app.previous"
    previous.mkdir()
    (previous / ".version").write_text(NEW + "\n", encoding="utf-8")
    assert reader(source, path).read().previous_sha is None


def test_running_without_a_version_file_is_not_an_error(tmp_path: Path) -> None:
    source, path = installation(tmp_path, version=None)
    status = reader(source, path).read()
    assert (status.installed_sha, status.installed_at) == (None, None)


def test_writes_merge_clear_with_none_and_leave_no_temp_file(tmp_path: Path) -> None:
    _, path = installation(tmp_path)
    record_status(path, {"outcome": "failed", "reason": "um", "latestSha": LATEST})
    record_status(path, {"outcome": "up_to_date", "reason": None})
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "outcome": "up_to_date",
        "latestSha": LATEST,
    }
    assert [p.name for p in path.parent.iterdir()] == [STATUS_FILE]


def test_a_state_that_cannot_be_written_is_only_a_warning(tmp_path: Path) -> None:
    blocker = tmp_path / "runtime"
    blocker.write_text("sou um arquivo", encoding="utf-8")
    record_status(blocker / STATUS_FILE, {"outcome": "updating"})


def test_the_default_path_lives_in_the_runtime_folder_of_the_installation() -> None:
    assert default_status_path().parts[-2:] == ("runtime", STATUS_FILE)
    assert default_status_path().is_relative_to(Path(os.environ["LOCALAPPDATA"]))


def test_results_of_each_kind_are_recorded(tmp_path: Path) -> None:
    _, path = installation(tmp_path)
    record_status(path, {"rolledBack": True, "blockedSha": NEW, "nextCheckAt": STAMP})

    def state() -> dict[str, Any]:
        loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        return loaded

    record_updating(path, NOW)
    assert state()["outcome"] == "updating"
    record_result(path, UpdateResult(False, "m", "up_to_date", latest=LATEST), NOW)
    assert state()["outcome"] == "up_to_date" and state()["rolledBack"] is True
    record_result(path, UpdateResult(False, "m", "blocked", latest=NEW, blocked=NEW), NOW)
    assert state()["outcome"] == "blocked" and state()["blockedSha"] == NEW
    record_result(path, UpdateResult(False, "não atualizei agora: sem rede", "failed"), NOW)
    assert state()["reason"] == "não atualizei agora: sem rede".encode().decode()
    assert state()["latestSha"] == NEW  # a checagem que falhou não apaga o que se sabia
    record_result(path, UpdateResult(True, "ok", "updated", latest=LATEST), NOW)
    assert (state()["outcome"], "rolledBack" in state(), "blockedSha" in state()) == (
        "updated",
        False,
        False,
    )
    assert state()["nextCheckAt"] == STAMP  # o que é do supervisor fica
    record_result(path, UpdateResult(False, "sem instalação"), NOW)  # sem `outcome`: nada
    assert state()["outcome"] == "updated"
    record_failure(path, "erro inesperado", NOW)
    assert state()["outcome"] == "failed"


# --- `hello`, reenvio e aviso -------------------------------------------------------------------


class Harness:
    def __init__(self, update_status: Any, *, rehello: float = 300.0) -> None:
        self.clock = FakeClock()
        self.transport = FakeTransport([[]] * 3)
        self.supervisor = ConnectionSupervisor(
            self.transport,
            self._process,
            EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), self.clock),
            self.clock,
            lambda: 0.5,
            agent_version="0.1.0",
            capabilities=["transport.keepalive.v1"],
            update_status=update_status,
            rehello_interval=rehello,
        )

    async def _process(self, raw: str | bytes) -> None:
        return None

    async def first_hello(self) -> dict[str, Any]:
        task = asyncio.create_task(self.supervisor.run())
        for _ in range(200):
            if self.transport.sent:
                break
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return self.transport.sent[0]


async def test_the_hello_carries_the_update_state() -> None:
    body = {"outcome": "up_to_date", "installedSha": OLD, "latestSha": OLD}
    hello = await Harness(lambda: body).first_hello()
    assert hello["body"]["update"] == body


async def test_an_old_agent_style_hello_has_no_update_at_all() -> None:
    hello = await Harness(None).first_hello()
    assert "update" not in hello["body"]


@pytest.mark.parametrize("bad", [{"outcome": "bogus"}, {"outcome": "failed", "reason": "x" * 999}])
async def test_a_state_the_contract_refuses_never_keeps_the_agent_from_saying_hello(
    bad: dict[str, Any],
) -> None:
    hello = await Harness(lambda: bad).first_hello()
    assert hello["body"]["agentVersion"] == "0.1.0"
    assert "update" not in hello["body"]


async def test_a_reader_that_blows_up_never_keeps_the_agent_from_saying_hello() -> None:
    def explode() -> dict[str, Any]:
        raise RuntimeError("disco sumiu")

    hello = await Harness(explode).first_hello()
    assert "update" not in hello["body"]


async def test_the_hello_is_sent_again_while_connected() -> None:
    harness = Harness(lambda: {"outcome": "updated"}, rehello=0.0)
    harness.supervisor._keepalive_interval = 0.0
    task = asyncio.create_task(harness.supervisor.run())
    hellos = 0
    for _ in range(500):
        hellos = sum(1 for m in harness.transport.sent if m["type"] == "agent.hello.v1")
        await asyncio.sleep(0)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert hellos >= 1


class RecordingTransport(FakeTransport):
    def __init__(self) -> None:
        super().__init__()
        self.fail = False

    async def send(self, message: dict[str, Any]) -> None:
        if self.fail:
            raise TransportError("sem conexão")
        await super().send(message)


class MutableSource:
    def __init__(self, status: UpdateStatus) -> None:
        self.status = status

    def read(self) -> UpdateStatus:
        return self.status


async def test_the_watcher_tells_the_api_only_when_the_state_changes() -> None:
    transport = RecordingTransport()
    source = MutableSource(UpdateStatus(outcome="up_to_date", installed_sha=OLD))
    watcher = UpdateStatusWatcher(source, transport, factory(), FakeClock())
    await watcher.poll()
    assert [m["type"] for m in transport.sent] == ["agent.update.status.v1"]
    await watcher.poll()
    assert len(transport.sent) == 1
    source.status = UpdateStatus(outcome="updating", installed_sha=OLD)
    await watcher.poll()
    assert transport.sent[-1]["body"]["outcome"] == "updating"
    assert len(transport.sent) == 2


async def test_a_change_missed_while_offline_goes_out_when_the_link_is_back() -> None:
    transport = RecordingTransport()
    source = MutableSource(UpdateStatus(outcome="failed", reason="sem rede"))
    watcher = UpdateStatusWatcher(source, transport, factory(), FakeClock())
    transport.fail = True
    await watcher.poll()
    assert transport.sent == []
    transport.fail = False
    await watcher.poll()
    assert transport.sent[0]["body"] == {"outcome": "failed", "reason": "sem rede"}


async def test_the_watcher_loop_survives_a_broken_poll_and_starts_from_the_current_state() -> None:
    clock = FakeClock()
    transport = RecordingTransport()
    calls = {"n": 0}

    class Flaky:
        def read(self) -> UpdateStatus:
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("quebrou")
            return UpdateStatus(outcome="updated" if calls["n"] > 2 else "not_checked")

    watcher = UpdateStatusWatcher(Flaky(), transport, factory(), clock, interval=1.0)
    task = asyncio.create_task(watcher.run())
    for _ in range(100):
        if transport.sent:
            break
        await asyncio.sleep(0)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    # A primeira leitura é o ponto de partida (o `hello` já a levou): só a mudança sai.
    assert transport.sent[0]["body"]["outcome"] == "updated"


# --- comando `self-update` ----------------------------------------------------------------------


def test_the_command_records_updating_and_then_the_result(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen: list[str] = []

    def fake(source: Path, *, sync: bool) -> UpdateResult:
        seen.append(json.loads(default_status_path().read_text(encoding="utf-8"))["outcome"])
        return UpdateResult(False, "ok", "up_to_date", latest=LATEST)

    monkeypatch.setattr(main_module, "self_update", fake)
    assert update_agent(sync=True) == EXIT_OK
    assert seen == ["updating"]
    state = json.loads(default_status_path().read_text(encoding="utf-8"))
    assert (state["outcome"], state["latestSha"]) == ("up_to_date", LATEST)


def test_an_unexpected_crash_in_the_update_is_recorded_and_still_exits_zero(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(source: Path, *, sync: bool) -> UpdateResult:
        raise RuntimeError("segredo uo_dev_XYZ")

    monkeypatch.setattr(main_module, "self_update", boom)
    assert main(["self-update"]) == EXIT_OK
    state = json.loads(default_status_path().read_text(encoding="utf-8"))
    assert state["outcome"] == "failed"
    assert "uo_dev_XYZ" not in state["reason"] and "RuntimeError" in state["reason"]
    assert "continua valendo" in capsys.readouterr().out


def test_a_broken_state_folder_never_stops_the_update_itself(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    def explode(*args: object) -> None:
        raise OSError("disco cheio")

    monkeypatch.setattr(main_module, "record_updating", explode)
    monkeypatch.setattr(main_module, "record_result", explode)
    monkeypatch.setattr(
        main_module, "self_update", lambda source, *, sync: UpdateResult(True, "agente atualizado")
    )
    assert update_agent(sync=True) == EXIT_OK
    assert "agente atualizado" in capsys.readouterr().out


# --- o caminho "versão atual instalada" para "esta versão" -------------------------------------

AGENT_ROOT = Path(__file__).parents[1]
CANDIDATE_CHECK = "import uniover_agent.main; import uniover_agent.contracts.agent_hello_v1"
SKIPPED_DIRS = {".venv", "__pycache__", ".mypy_cache", ".ruff_cache", ".pytest_cache", "tests"}


def zip_of_this_agent(destination: Path, sha: str, override: dict[str, str] | None = None) -> None:
    """O zip que o GitHub serviria para o commit: `<repo>-<sha>/apps/agent/...` com esta árvore."""
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as bundle:
        for root, dirs, files in os.walk(AGENT_ROOT):
            dirs[:] = [d for d in dirs if d not in SKIPPED_DIRS]
            for name in files:
                file = Path(root) / name
                if file.suffix in {".pyc", ".coverage"} or name == ".coverage":
                    continue
                relative = file.relative_to(AGENT_ROOT).as_posix()
                target = f"uniover-{sha}/apps/agent/{relative}"
                if override and relative in override:
                    bundle.writestr(target, override[relative])
                else:
                    bundle.write(file, target)


def candidate_imports(candidate: Path) -> None:
    """A verificação do `uv run ... python -c`: interpretador novo, só com a candidata."""
    environment = {**os.environ, "PYTHONPATH": str(candidate / "src")}
    try:
        subprocess.run(  # noqa: S603 - o próprio interpretador e uma importação fixa
            [sys.executable, "-c", CANDIDATE_CHECK],
            check=True,
            env=environment,
            cwd=candidate.parent,
            capture_output=True,
        )
    except subprocess.CalledProcessError:
        raise SelfUpdateError("a verificação rápida da atualização falhou") from None


def copier(archive: Path) -> Callable[[str, Path], None]:
    def download(sha: str, destination: Path) -> None:
        shutil.copyfile(archive, destination)

    return download


def fake_install(base: Path) -> Path:
    """Instalação "atual": `app` com o commit antigo e o estado como o supervisor o deixa."""
    source = base / "app"
    care = source / "src" / "uniover_agent" / "adapters"
    care.mkdir(parents=True)
    (care / "maintenance_signals.py").write_text("", encoding="utf-8")
    (source / ".version").write_text(OLD + "\n", encoding="utf-8")
    (base / "runtime").mkdir()
    return source


def test_this_version_installs_over_the_current_one_and_reports_both(tmp_path: Path) -> None:
    source = fake_install(tmp_path)
    archive = tmp_path / "published.zip"
    zip_of_this_agent(archive, NEW)

    result = self_update(
        source,
        sync=False,
        fetch_latest=lambda: NEW,
        download=copier(archive),
        run_check=candidate_imports,
    )

    assert result.updated and result.outcome == "updated"
    assert (source / ".version").read_text(encoding="utf-8").strip() == NEW
    assert (tmp_path / "app.previous" / ".version").read_text(encoding="utf-8").strip() == OLD
    record_result(tmp_path / "runtime" / STATUS_FILE, result, NOW)
    status = FileUpdateStatus(tmp_path / "runtime" / STATUS_FILE, source, lambda: NOW).read()
    assert (status.outcome, status.installed_sha, status.previous_sha) == ("updated", NEW, OLD)
    assert status.latest_sha == NEW
    # O que o agente novo manda no `hello` passa pelo portão de saída com o contrato do repositório.
    hello = factory().hello(
        "0.1.0+" + NEW[:12], ["agent.maintenance.v1"], update=update_body(status)
    )
    assert hello["body"]["update"]["previousSha"] == OLD


def test_a_candidate_that_does_not_import_is_never_installed_and_the_failure_is_reported(
    tmp_path: Path,
) -> None:
    source = fake_install(tmp_path)
    archive = tmp_path / "broken.zip"
    zip_of_this_agent(archive, NEW, {"src/uniover_agent/main.py": "def (:\n"})

    result = self_update(
        source,
        sync=False,
        fetch_latest=lambda: NEW,
        download=copier(archive),
        run_check=candidate_imports,
    )

    assert not result.updated and result.outcome == "failed"
    assert (source / ".version").read_text(encoding="utf-8").strip() == OLD
    assert not (tmp_path / "app.previous").exists()
    record_result(tmp_path / "runtime" / STATUS_FILE, result, NOW)
    status = FileUpdateStatus(tmp_path / "runtime" / STATUS_FILE, source, lambda: NOW).read()
    assert status.outcome == "failed" and status.latest_sha == NEW and status.reason


def _git_archive_of_develop(destination: Path) -> Path | None:
    git = shutil.which("git")
    if git is None:
        return None
    archive = destination / "develop.zip"
    done = subprocess.run(  # noqa: S603 - git do PATH, argumentos fixos
        [git, "archive", "--format=zip", "-o", str(archive), "origin/develop", "."],
        check=False,
        cwd=AGENT_ROOT,
        capture_output=True,
    )
    return archive if done.returncode == 0 else None


OLD_SUPERVISED_UPDATE = """
import os, shutil, subprocess, sys
from pathlib import Path
from uniover_agent.adapters.self_update import self_update

source, archive, sha = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]

def check(candidate):
    subprocess.run([sys.executable, "-c", sys.argv[4]], check=True, cwd=source.parent,
                   env={**os.environ, "PYTHONPATH": str(candidate / "src")})

result = self_update(source, sync=False, fetch_latest=lambda: sha,
                     download=lambda s, d: shutil.copyfile(archive, d), run_check=check)
print(result.updated, result.message)
"""


def test_the_code_published_in_develop_updates_itself_into_this_version(tmp_path: Path) -> None:
    """Primeiro salto: a `self_update` que está nos PCs hoje (a da `develop`) instala esta."""
    develop_zip = _git_archive_of_develop(tmp_path)
    if develop_zip is None:
        pytest.skip("sem a referência origin/develop neste clone")
    published = tmp_path / "published"
    with zipfile.ZipFile(develop_zip) as bundle:
        bundle.extractall(published)
    old_src = published / "src"
    source = fake_install(tmp_path / "pc")
    archive = tmp_path / "this-version.zip"
    zip_of_this_agent(archive, NEW)
    script = tmp_path / "old_update.py"
    script.write_text(OLD_SUPERVISED_UPDATE, encoding="utf-8")

    done = subprocess.run(  # noqa: S603 - o próprio interpretador, script do teste
        [sys.executable, str(script), str(source), str(archive), NEW, CANDIDATE_CHECK],
        check=False,
        env={**os.environ, "PYTHONPATH": str(old_src)},
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )

    assert done.returncode == 0, done.stderr
    assert done.stdout.strip().startswith("True"), done.stdout + done.stderr
    assert (source / ".version").read_text(encoding="utf-8").strip() == NEW
    assert (tmp_path / "pc" / "app.previous" / ".version").read_text(
        encoding="utf-8"
    ).strip() == OLD
    # A versão nova, rodando de onde caiu, lê o que a antiga deixou (nada) e fala o seu `hello`.
    probe = (
        "import json; from pathlib import Path;"
        "from uniover_agent.adapters.update_status import FileUpdateStatus;"
        "from uniover_agent.core import update_body;"
        "p = Path(r'%s'); status = FileUpdateStatus(p / 'runtime/update-status.json', p / 'app');"
        "print(json.dumps(update_body(status.read())))" % (tmp_path / "pc")
    )
    seen = subprocess.run(  # noqa: S603 - o próprio interpretador, script fixo do teste
        [sys.executable, "-c", probe],
        check=True,
        env={**os.environ, "PYTHONPATH": str(source / "src")},
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )
    body = json.loads(seen.stdout)
    assert (body["outcome"], body["installedSha"], body["previousSha"]) == (
        "not_checked",
        NEW,
        OLD,
    )
