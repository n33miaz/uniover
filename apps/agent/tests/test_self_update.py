"""Auto-atualização: sha igual, sha novo, falhas de rede e a troca atômica das pastas."""

import io
import shutil
import subprocess
import zipfile
from collections.abc import Callable
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any

import httpx
import pytest

from uniover_agent.adapters import self_update as module
from uniover_agent.adapters.self_update import (
    SelfUpdateError,
    UpdateResult,
    candidate_env,
    download_archive,
    extract_agent,
    latest_commit,
    read_version,
    run_uv_check,
    run_uv_sync,
    self_update,
    summarize_failure,
    swap_directories,
)
from uniover_agent.composition import maintenance as maintenance_module
from uniover_agent.composition.system import EXIT_OK
from uniover_agent.main import main

OLD = "a" * 40
NEW = "b" * 40


def make_zip(path: Path, files: dict[str, str], comment: str = NEW) -> None:
    """Zip no formato do GitHub: o commit vem gravado no comentário (a atualização o confere)."""
    with zipfile.ZipFile(path, "w") as bundle:
        bundle.comment = comment.encode("ascii")
        for name, content in files.items():
            bundle.writestr(name, content)


def repo_files(marker: str) -> dict[str, str]:
    return {
        f"uniover-{NEW}/README.md": "raiz do repositório",
        f"uniover-{NEW}/apps/web/package.json": "{}",
        f"uniover-{NEW}/apps/agent/pyproject.toml": f"# versão {marker}",
        f"uniover-{NEW}/apps/agent/src/uniover_agent/marca.py": f"MARCA = {marker!r}",
    }


class Installation:
    """`agent-src` falsa, ao lado de onde a nova é montada."""

    def __init__(self, base: Path, version: str | None = OLD) -> None:
        self.base = base
        self.source = base / "agent-src"
        self.source.mkdir(parents=True)
        (self.source / "pyproject.toml").write_text("# versão antiga", encoding="utf-8")
        if version:
            (self.source / ".version").write_text(version + "\n", encoding="utf-8")
        self.downloads: list[str] = []
        self.synced: list[Path] = []
        self.checked: list[Path] = []

    def download(self, sha: str, destination: Path) -> None:
        self.downloads.append(sha)
        make_zip(destination, repo_files("nova"))

    def run_sync(self, source: Path) -> None:
        self.synced.append(source)

    def run_check(self, source: Path) -> None:
        self.checked.append(source)

    def update(self, latest: str, **kwargs: object) -> UpdateResult:
        return self_update(
            self.source,
            fetch_latest=lambda: latest,
            download=kwargs.pop("download", self.download),  # type: ignore[arg-type]
            run_sync=kwargs.pop("run_sync", self.run_sync),  # type: ignore[arg-type]
            run_check=kwargs.pop("run_check", self.run_check),  # type: ignore[arg-type]
            **kwargs,  # type: ignore[arg-type]
        )

    def leftovers(self) -> list[str]:
        return sorted(p.name for p in self.base.iterdir() if p.name not in {"agent-src", "runtime"})


@pytest.fixture
def installed(tmp_path: Path) -> Installation:
    return Installation(tmp_path / "UniOver")


def test_the_same_sha_changes_nothing(installed: Installation) -> None:
    result = installed.update(OLD)
    assert (result.updated, installed.downloads, installed.synced) == (False, [], [])
    assert "mais recente" in result.message


def test_a_new_sha_downloads_that_exact_commit_and_swaps_the_folder(
    installed: Installation,
) -> None:
    result = installed.update(NEW)
    assert result == UpdateResult(True, "agente atualizado")
    # Baixa o commit exato que a API informou, não a branch.
    assert installed.downloads == [NEW]
    source = installed.source
    assert (source / "pyproject.toml").read_text(encoding="utf-8") == "# versão nova"
    assert (source / "src" / "uniover_agent" / "marca.py").read_text(encoding="utf-8") == (
        "MARCA = 'nova'"
    )
    # Só `apps/agent` vem do zip, sem a pasta do repositório nem o resto dele.
    assert not (source / "README.md").exists()
    assert not (source / "apps").exists()
    assert read_version(source) == NEW
    assert installed.synced == [installed.base / "agent-src.new"]
    assert installed.checked == [installed.base / "agent-src.new"]
    # A anterior fica para o wrapper do Windows poder voltar atrás após quedas curtas.
    assert (installed.base / "agent-src.previous" / "pyproject.toml").is_file()
    assert installed.leftovers() == ["agent-src.previous"]


def test_a_missing_version_file_counts_as_outdated(tmp_path: Path) -> None:
    installation = Installation(tmp_path / "UniOver", version=None)
    assert installation.update(NEW).updated
    assert read_version(installation.source) == NEW


def test_no_sync_flag_skips_uv_sync(installed: Installation) -> None:
    assert installed.update(NEW, sync=False).updated
    assert installed.synced == []
    assert installed.checked == [installed.base / "agent-src.new"]


def test_a_failed_sync_refuses_the_update_and_keeps_the_previous_version(
    installed: Installation,
) -> None:
    def failing(_source: Path) -> None:
        raise SelfUpdateError("uv não encontrado")

    result = installed.update(NEW, run_sync=failing)
    assert not result.updated
    assert "uv não encontrado" in result.message
    assert read_version(installed.source) == OLD
    assert installed.leftovers() == []


def test_a_failed_quick_check_refuses_the_update_and_keeps_the_previous_version(
    installed: Installation,
) -> None:
    def failing(_source: Path) -> None:
        raise SelfUpdateError("import não passou")

    result = installed.update(NEW, run_check=failing)
    assert not result.updated
    assert "import não passou" in result.message
    assert read_version(installed.source) == OLD
    assert installed.leftovers() == []


def test_a_version_blocked_by_the_wrapper_is_not_downloaded(installed: Installation) -> None:
    runtime = installed.base / "runtime"
    runtime.mkdir()
    (runtime / module.BLOCKED_VERSIONS_FILE).write_text(NEW + "\n", encoding="utf-8")
    result = installed.update(NEW)
    assert not result.updated
    assert installed.downloads == []
    assert "caiu repetidamente" in result.message


def test_a_network_failure_on_the_commit_check_keeps_everything(
    installed: Installation, caplog: pytest.LogCaptureFixture
) -> None:
    def offline() -> str:
        raise SelfUpdateError("não consegui consultar o GitHub (ConnectError)")

    result = self_update(installed.source, fetch_latest=offline, download=installed.download)
    assert (result.updated, installed.downloads) == (False, [])
    assert "não atualizei agora" in result.message
    assert read_version(installed.source) == OLD
    assert "adiada" in caplog.text


def test_a_failed_download_leaves_the_current_folder_and_no_residue(
    installed: Installation,
) -> None:
    def broken(sha: str, destination: Path) -> None:
        destination.write_bytes(b"metade")
        raise SelfUpdateError("não consegui baixar o pacote (ReadTimeout)")

    result = installed.update(NEW, download=broken)
    assert not result.updated
    assert read_version(installed.source) == OLD
    assert (installed.source / "pyproject.toml").read_text(encoding="utf-8") == "# versão antiga"
    assert installed.leftovers() == []


def test_a_bad_zip_is_refused_without_touching_the_installation(installed: Installation) -> None:
    def not_a_zip(sha: str, destination: Path) -> None:
        destination.write_bytes(b"isto nao e um zip")

    assert not installed.update(NEW, download=not_a_zip).updated
    assert read_version(installed.source) == OLD
    assert installed.leftovers() == []


def test_a_zip_without_the_agent_is_refused(installed: Installation) -> None:
    def without_agent(sha: str, destination: Path) -> None:
        make_zip(destination, {f"uniover-{NEW}/apps/web/package.json": "{}"})

    result = installed.update(NEW, download=without_agent)
    assert not result.updated
    assert "não contém apps/agent" in result.message
    assert installed.leftovers() == []


def test_a_zip_with_a_path_that_escapes_is_refused(tmp_path: Path) -> None:
    archive = tmp_path / "evil.zip"
    make_zip(
        archive,
        {
            f"uniover-{NEW}/apps/agent/pyproject.toml": "ok",
            f"uniover-{NEW}/apps/agent/../../../fora.txt": "x",
        },
    )
    destination = tmp_path / "novo"
    destination.mkdir()
    with pytest.raises(SelfUpdateError, match="caminho inválido"):
        extract_agent(archive, destination)
    assert not (tmp_path / "fora.txt").exists()


def test_symlinks_in_the_zip_are_ignored(tmp_path: Path) -> None:
    archive = tmp_path / "links.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(f"uniover-{NEW}/apps/agent/pyproject.toml", "ok")
        link = zipfile.ZipInfo(f"uniover-{NEW}/apps/agent/atalho")
        link.external_attr = 0o120777 << 16
        bundle.writestr(link, "/etc/passwd")
    destination = tmp_path / "novo"
    destination.mkdir()
    extract_agent(archive, destination)
    assert sorted(p.name for p in destination.iterdir()) == ["pyproject.toml"]


def test_a_missing_installation_is_not_created(tmp_path: Path) -> None:
    result = self_update(tmp_path / "nao-existe", fetch_latest=lambda: pytest.fail("sem rede"))
    assert not result.updated
    assert "não instalado" in result.message
    assert not (tmp_path / "nao-existe").exists()


def test_the_swap_is_a_pair_of_renames_and_rolls_back_if_the_second_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current, new = tmp_path / "agent-src", tmp_path / "agent-src.new"
    current.mkdir()
    (current / "v").write_text("velha", encoding="utf-8")
    new.mkdir()
    (new / "v").write_text("nova", encoding="utf-8")
    original = Path.rename

    def flaky(self: Path, target: Path) -> Path:
        if self == new:
            raise PermissionError("em uso")
        return original(self, target)

    monkeypatch.setattr(Path, "rename", flaky)
    with pytest.raises(SelfUpdateError, match="versão nova"):
        swap_directories(current, new)
    # Voltou atrás: a velha segue no lugar, inteira.
    assert (current / "v").read_text(encoding="utf-8") == "velha"
    assert not (tmp_path / "agent-src.old").exists()


def test_a_locked_current_folder_is_a_soft_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current, new = tmp_path / "agent-src", tmp_path / "agent-src.new"
    current.mkdir()
    new.mkdir()

    def locked(self: Path, target: Path) -> Path:
        raise PermissionError("em uso")

    monkeypatch.setattr(Path, "rename", locked)
    with pytest.raises(SelfUpdateError, match="em uso"):
        swap_directories(current, new)


# --- GitHub e uv, com a rede e o processo trocados ----------------------------------------------


Handler = Callable[[httpx.Request], httpx.Response]


def patch_http(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> list[httpx.Request]:
    """Troca a rede do `httpx` por um servidor de mentira e devolve os pedidos recebidos."""
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    transport = httpx.MockTransport(respond)

    def get(url: str, **kwargs: Any) -> httpx.Response:
        with httpx.Client(transport=transport) as client:
            return client.get(url, headers=kwargs.get("headers"))

    def stream(method: str, url: str, **kwargs: Any) -> AbstractContextManager[httpx.Response]:
        client = httpx.Client(transport=transport, follow_redirects=kwargs["follow_redirects"])
        return client.stream(method, url, headers=kwargs.get("headers"))

    monkeypatch.setattr(httpx, "get", get)
    monkeypatch.setattr(httpx, "stream", stream)
    return requests


def test_latest_commit_reads_the_sha_from_the_github_api(monkeypatch: pytest.MonkeyPatch) -> None:
    requests = patch_http(monkeypatch, lambda r: httpx.Response(200, json={"sha": NEW}))
    assert latest_commit() == NEW
    assert [str(r.url) for r in requests] == [
        module.PRODUCTION_REF_URL,
        module.COMMIT_URL.format(channel="develop"),
    ]


def test_latest_commit_asks_for_the_branch_of_the_channel(monkeypatch: pytest.MonkeyPatch) -> None:
    requests = patch_http(monkeypatch, lambda r: httpx.Response(200, json={"sha": NEW}))
    assert latest_commit("main") == NEW
    assert str(requests[0].url) == module.PRODUCTION_REF_URL
    assert str(requests[1].url).endswith("/commits/develop")
    assert module.DEFAULT_CHANNEL == "develop"


def test_homolog_stays_an_explicit_test_channel(monkeypatch: pytest.MonkeyPatch) -> None:
    requests = patch_http(monkeypatch, lambda r: httpx.Response(200, json={"sha": NEW}))
    assert latest_commit("homolog") == NEW
    assert len(requests) == 1
    assert str(requests[0].url).endswith("/commits/homolog")


def test_legacy_production_channel_follows_the_configured_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "PRODUCTION_REF", "homolog")
    requests = patch_http(monkeypatch, lambda r: httpx.Response(200, json={"sha": NEW}))
    assert latest_commit("develop") == NEW
    assert str(requests[1].url).endswith("/commits/homolog")


def test_production_channel_uses_the_published_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        if str(request.url) == module.PRODUCTION_REF_URL:
            return httpx.Response(200, json={"production_ref": "main"})
        return httpx.Response(200, json={"sha": NEW})

    requests = patch_http(monkeypatch, answer)
    assert latest_commit("develop") == NEW
    assert str(requests[1].url).endswith("/commits/main")


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(403, json={"message": "rate limit"}),
        httpx.Response(200, json={"sha": "curto"}),
        httpx.Response(200, json=["lista"]),
        httpx.Response(200, content=b"nao e json"),
    ],
)
def test_latest_commit_turns_bad_answers_into_a_soft_error(
    monkeypatch: pytest.MonkeyPatch, response: httpx.Response
) -> None:
    patch_http(monkeypatch, lambda r: response)
    with pytest.raises(SelfUpdateError):
        latest_commit()


def test_latest_commit_without_network_is_a_soft_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sem rede")

    patch_http(monkeypatch, offline)
    with pytest.raises(SelfUpdateError, match="ConnectError"):
        latest_commit()


def test_download_follows_redirects_and_saves_the_zip(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("a", "b")

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.host == "github.com":
            # O GitHub responde ao endereço do arquivo com um redirecionamento para o codeload.
            return httpx.Response(302, headers={"Location": "https://codeload.github.com/x.zip"})
        return httpx.Response(200, content=buffer.getvalue())

    requests = patch_http(monkeypatch, answer)
    destination = tmp_path / "main.zip"
    download_archive(NEW, destination)
    assert zipfile.is_zipfile(destination)
    assert [r.url.host for r in requests] == ["github.com", "codeload.github.com"]
    assert str(requests[0].url) == f"https://github.com/n33miaz/uniover/archive/{NEW}.zip"


def test_download_failure_is_a_soft_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    patch_http(monkeypatch, lambda r: httpx.Response(404))
    with pytest.raises(SelfUpdateError, match="baixar"):
        download_archive(NEW, tmp_path / "main.zip")


class FakeRun:
    """`subprocess.run` roteirizado: uma resposta por chamada (ou uma exceção)."""

    def __init__(self, *outcomes: subprocess.CompletedProcess[str] | Exception) -> None:
        self.outcomes = list(outcomes) or [done(0)]
        self.calls: list[tuple[list[str], dict[str, Any]]] = []

    def __call__(self, cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append((cmd, kwargs))
        outcome = self.outcomes.pop(0) if len(self.outcomes) > 1 else self.outcomes[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def done(code: int, stderr: str = "", stdout: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["uv"], code, stdout, stderr)


def test_uv_sync_runs_in_a_throwaway_environment_and_never_in_the_running_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = FakeRun()
    monkeypatch.setenv("UV", "C:/uv/uv.exe")
    monkeypatch.setenv("UV_PROJECT_ENVIRONMENT", str(tmp_path / "runtime" / "venv"))
    monkeypatch.setattr(subprocess, "run", fake)
    candidate = tmp_path / "app.new"
    run_uv_sync(candidate)
    [(command, kwargs)] = fake.calls
    # `--frozen`: o uv.lock manda, uma dependência diferente da ensaiada nunca entra sozinha.
    assert command == [
        "C:/uv/uv.exe",
        "sync",
        "--frozen",
        "--project",
        str(candidate),
        "--quiet",
    ]
    # O ambiente do agente em uso (arquivos presos no Windows) fica intocado.
    assert kwargs["env"]["UV_PROJECT_ENVIRONMENT"] == str(tmp_path / "app.new.venv")
    assert kwargs["capture_output"] is True
    assert kwargs["cwd"] == tmp_path


def test_uv_check_uses_the_same_environment_without_syncing_again(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = FakeRun()
    monkeypatch.setenv("UV", "C:/uv/uv.exe")
    monkeypatch.setattr(subprocess, "run", fake)
    run_uv_check(tmp_path / "app.new")
    [(command, kwargs)] = fake.calls
    assert command == [
        "C:/uv/uv.exe",
        "run",
        "--no-sync",
        "--project",
        str(tmp_path / "app.new"),
        "python",
        "-m",
        "uniover_agent.selfcheck",
    ]
    assert kwargs["env"]["UV_PROJECT_ENVIRONMENT"] == str(tmp_path / "app.new.venv")


def test_uv_sync_without_uv_is_a_soft_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(SelfUpdateError, match="uv não encontrado"):
        run_uv_sync(tmp_path)


def test_uv_sync_failure_says_why_and_is_tried_twice(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = FakeRun(done(2, stderr="error: failed to remove file `uniover-agent.exe`\n"))
    monkeypatch.setenv("UV", "uv")
    monkeypatch.setattr(subprocess, "run", fake)
    with pytest.raises(SelfUpdateError) as caught:
        run_uv_sync(tmp_path / "app.new", pause=0)
    assert len(fake.calls) == 2
    message = str(caught.value)
    assert "sincronização das dependências" in message
    assert "código 2" in message
    assert "failed to remove file" in message  # o motivo, não só "CalledProcessError"
    assert "CalledProcessError" not in message


def test_uv_sync_recovers_when_the_second_try_works(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = FakeRun(done(1, stderr="arquivo em uso"), done(0))
    monkeypatch.setenv("UV", "uv")
    monkeypatch.setattr(subprocess, "run", fake)
    run_uv_sync(tmp_path / "app.new", pause=0)
    assert len(fake.calls) == 2


def test_uv_timeout_and_missing_executable_have_their_own_reasons(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("UV", "uv")
    monkeypatch.setattr(subprocess, "run", FakeRun(subprocess.TimeoutExpired("uv", 600)))
    with pytest.raises(SelfUpdateError, match="passou de 600 s"):
        run_uv_sync(tmp_path / "app.new", pause=0)
    monkeypatch.setattr(subprocess, "run", FakeRun(FileNotFoundError()))
    with pytest.raises(SelfUpdateError, match="FileNotFoundError"):
        run_uv_check(tmp_path / "app.new")


def test_failure_reasons_drop_secrets_and_stay_short() -> None:
    text = (
        "error: download https://user:senha-secreta@pypi.example/simple/x failed\n"
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n"
        "token=abc123 e uma chave 0123456789abcdef0123456789abcdef0123\n" + "x" * 900
    )
    reason = summarize_failure(text)
    assert len(reason) <= 400
    for secret in ("senha-secreta", "abcdefghijklmnopqrstuvwxyz", "abc123", "0123456789abcdef"):
        assert secret not in reason


def test_the_candidate_environment_is_removed_after_the_update(installed: Installation) -> None:
    def sync(source: Path) -> None:
        (candidate_env(source) / "Lib").mkdir(parents=True)

    result = installed.update(NEW, run_sync=sync)
    assert result.updated
    assert "agent-src.new.venv" not in installed.leftovers()


def test_the_candidate_environment_is_removed_when_the_update_fails(
    installed: Installation,
) -> None:
    def sync(source: Path) -> None:
        (candidate_env(source) / "Lib").mkdir(parents=True)
        raise SelfUpdateError("a sincronização das dependências falhou (código 2)")

    result = installed.update(NEW, run_sync=sync)
    assert not result.updated
    assert "código 2" in result.message  # o motivo chega ao aviso
    assert installed.leftovers() == []


# --- comando de linha -----------------------------------------------------------------------


def test_the_self_update_command_always_exits_zero_and_says_what_happened(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    seen: dict[str, object] = {}

    def fake(
        source: Path, *, sync: bool, channel: str, ignore_deferral: bool = False
    ) -> UpdateResult:
        seen.update(source=source, sync=sync, channel=channel)
        return UpdateResult(False, "não atualizei agora: sem rede")

    monkeypatch.setattr(maintenance_module, "self_update", fake)
    assert main(["self-update", "--no-sync"]) == EXIT_OK
    assert "sem rede" in capsys.readouterr().out
    assert seen == {
        "source": tmp_path / "localappdata" / "UniOver" / "app",
        "sync": False,
        "channel": "develop",
    }
    assert main(["self-update"]) == EXIT_OK
    assert seen["sync"] is True


def test_the_trial_marker_is_written_before_the_folders_are_swapped(
    installed: Installation,
) -> None:
    order: list[str] = []

    def record(source: Path, sha: str) -> None:
        # Neste instante a versão nova ainda NÃO está no lugar.
        order.append(f"prova {sha[:1]} com versão {read_version(source)[:1]}")  # type: ignore[index]

    assert installed.update(NEW, record_trial=record).updated
    assert order == [f"prova {NEW[:1]} com versão {OLD[:1]}"]
    assert read_version(installed.source) == NEW


def test_the_real_marker_has_the_format_the_supervisor_reads(installed: Installation) -> None:
    assert installed.update(NEW).updated
    marker = installed.base / "runtime" / "update-trial.txt"
    assert marker.read_text(encoding="ascii") == f"{NEW}|0"


def test_a_marker_that_cannot_be_written_aborts_the_swap_and_leaves_the_install_alone(
    installed: Installation,
) -> None:
    def full_disk(_source: Path, _sha: str) -> None:
        raise OSError(28, "No space left on device")

    result = installed.update(NEW, record_trial=full_disk)
    # A versão nova nunca fica no ar sem a prova: nada foi trocado.
    assert not result.updated and result.outcome == "failed"
    assert "prova" in result.message
    assert read_version(installed.source) == OLD
    assert installed.leftovers() == []


def test_a_swap_that_fails_removes_the_marker_of_the_version_that_did_not_come_in(
    installed: Installation, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuses(*_args: object, **_kwargs: object) -> None:
        raise SelfUpdateError("a pasta do agente está em uso; fica para a próxima vez")

    monkeypatch.setattr("uniover_agent.adapters.self_update.swap_directories", refuses)
    result = installed.update(NEW)
    assert not result.updated
    assert not (installed.base / "runtime" / "update-trial.txt").exists()
    assert read_version(installed.source) == OLD


def test_an_update_that_used_up_its_whole_budget_gives_up_before_swapping(
    installed: Installation,
) -> None:
    # A extração/consulta lentas (antivírus, disco no limite) comem o orçamento: a atualização
    # desiste antes de trocar as pastas, em vez de o supervisor matá-la no meio.
    clock = {"now": 0.0}

    def slow_download(sha: str, destination: Path) -> None:
        installed.download(sha, destination)
        clock["now"] += module.WORST_CASE_SECONDS + 1

    result = installed.update(NEW, download=slow_download, monotonic=lambda: clock["now"])
    assert not result.updated and result.outcome == "failed"
    assert "tempo máximo" in result.message
    assert read_version(installed.source) == OLD
    assert installed.leftovers() == []
    assert not (installed.base / "runtime" / "update-trial.txt").exists()


def test_an_update_inside_its_budget_is_not_affected(installed: Installation) -> None:
    clock = {"now": 0.0}
    assert installed.update(NEW, monotonic=lambda: clock["now"]).updated


def test_a_version_returned_for_the_pcs_sake_is_deferred_for_24_hours(
    installed: Installation,
) -> None:
    # O supervisor devolveu a versão por demora/disco do PC (sem bloqueá-la): sem este adiamento o
    # self-update a reinstalaria a cada checagem, num laço de atualizar e voltar.
    runtime = installed.base / "runtime"
    runtime.mkdir()
    now = 1_800_000_000.0
    (runtime / ".deferred-versions").write_text(f"{NEW}|{int(now) - 3600}\n", encoding="ascii")
    result = installed.update(NEW, wall=lambda: now)
    # Resultado neutro (`deferred`, interno): não é falha e não aparece como tal ao dono.
    assert not result.updated and result.outcome == "deferred" and result.latest == NEW
    assert installed.downloads == []
    # Passadas 24 h ela volta a ser tentada.
    assert installed.update(NEW, wall=lambda: now + 24 * 3600 + 1).updated


def test_the_deferral_grows_with_each_return_24h_72h_a_week(installed: Installation) -> None:
    runtime = installed.base / "runtime"
    runtime.mkdir()
    base = 1_800_000_000.0
    day = 24 * 3600
    marks = runtime / ".deferred-versions"
    marks.write_text(f"{NEW}|{int(base)}\n", encoding="ascii")
    assert module.deferred_versions(installed.source, base + day - 1) == {NEW}
    assert module.deferred_versions(installed.source, base + day + 1) == set()
    # Segunda devolução: 72 h a partir dela.
    marks.write_text(f"{NEW}|{int(base)}\n{NEW}|{int(base)}\n", encoding="ascii")
    assert module.deferred_versions(installed.source, base + 3 * day - 1) == {NEW}
    assert module.deferred_versions(installed.source, base + 3 * day + 1) == set()
    # Terceira em diante: uma semana.
    marks.write_text(f"{NEW}|{int(base)}\n" * 3, encoding="ascii")
    assert module.deferred_versions(installed.source, base + 7 * day - 1) == {NEW}
    assert module.deferred_versions(installed.source, base + 7 * day + 1) == set()
    marks.write_text(f"{NEW}|{int(base)}\n" * 9, encoding="ascii")
    assert module.deferred_versions(installed.source, base + 7 * day + 1) == set()


def test_the_owners_explicit_request_bypasses_the_deferral(installed: Installation) -> None:
    runtime = installed.base / "runtime"
    runtime.mkdir()
    now = 1_800_000_000.0
    (runtime / ".deferred-versions").write_text(f"{NEW}|{int(now) - 60}\n", encoding="ascii")
    assert installed.update(NEW, wall=lambda: now, ignore_deferral=True).updated


def test_a_newer_commit_is_not_held_back_by_a_deferred_one(installed: Installation) -> None:
    runtime = installed.base / "runtime"
    runtime.mkdir()
    other = "c" * 40
    now = 1_800_000_000.0
    (runtime / ".deferred-versions").write_text(f"{other}|{int(now) - 60}\n", encoding="ascii")
    assert installed.update(NEW, wall=lambda: now).updated


def test_the_deferral_counts_from_the_last_return_not_the_first(installed: Installation) -> None:
    runtime = installed.base / "runtime"
    runtime.mkdir()
    base = 1_800_000_000.0
    day = 24 * 3600
    # Duas devoluções, a segunda 5 dias depois da primeira: 72 h contadas da SEGUNDA.
    (runtime / ".deferred-versions").write_text(
        f"{NEW}|{int(base)}\n{NEW}|{int(base + 5 * day)}\n", encoding="ascii"
    )
    assert module.deferred_versions(installed.source, base + 8 * day - 1) == {NEW}
    assert module.deferred_versions(installed.source, base + 8 * day + 1) == set()


def test_a_return_stamped_in_the_future_after_the_clock_went_back_is_still_deferred(
    installed: Installation,
) -> None:
    runtime = installed.base / "runtime"
    runtime.mkdir()
    now = 1_800_000_000.0
    day = 24 * 3600
    (runtime / ".deferred-versions").write_text(f"{NEW}|{int(now + 3600)}\n", encoding="ascii")
    assert module.deferred_versions(installed.source, now) == {NEW}
    # Um carimbo absurdo (anos à frente) é falso: não adia para sempre.
    (runtime / ".deferred-versions").write_text(f"{NEW}|{int(now + 400 * day)}\n", encoding="ascii")
    assert module.deferred_versions(installed.source, now) == set()
