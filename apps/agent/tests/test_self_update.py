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

from uniover_agent import main as main_module
from uniover_agent.adapters import self_update as module
from uniover_agent.adapters.self_update import (
    SelfUpdateError,
    UpdateResult,
    download_archive,
    extract_agent,
    latest_commit,
    read_version,
    run_uv_check,
    run_uv_sync,
    self_update,
    swap_directories,
)
from uniover_agent.main import EXIT_OK, main

OLD = "a" * 40
NEW = "b" * 40


def make_zip(path: Path, files: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w") as bundle:
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
        return sorted(p.name for p in self.base.iterdir() if p.name != "agent-src")


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
    assert [str(r.url) for r in requests] == [module.COMMIT_URL]


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


def test_uv_sync_runs_the_project_sync_with_the_uv_that_launched_us(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[list[str]] = []
    monkeypatch.setenv("UV", "C:/uv/uv.exe")
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: calls.append(cmd))
    run_uv_sync(tmp_path / "agent-src")
    assert calls == [["C:/uv/uv.exe", "sync", "--project", str(tmp_path / "agent-src"), "--quiet"]]


def test_uv_sync_without_uv_is_a_soft_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(SelfUpdateError, match="uv não encontrado"):
        run_uv_sync(tmp_path)


def test_uv_sync_failure_is_a_soft_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def failing(cmd: list[str], **kwargs: object) -> None:
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setenv("UV", "uv")
    monkeypatch.setattr(subprocess, "run", failing)
    with pytest.raises(SelfUpdateError, match="sincronizar"):
        run_uv_sync(tmp_path)


def test_uv_check_imports_the_agent_and_the_minimum_hello_contract(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[list[str]] = []
    monkeypatch.setenv("UV", "C:/uv/uv.exe")
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: calls.append(cmd))
    run_uv_check(tmp_path / "agent-src")
    assert calls == [
        [
            "C:/uv/uv.exe",
            "run",
            "--project",
            str(tmp_path / "agent-src"),
            "python",
            "-c",
            "import uniover_agent.main; import uniover_agent.contracts.agent_hello_v1",
        ]
    ]


# --- comando de linha -----------------------------------------------------------------------


def test_the_self_update_command_always_exits_zero_and_says_what_happened(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    seen: dict[str, object] = {}

    def fake(source: Path, *, sync: bool) -> UpdateResult:
        seen.update(source=source, sync=sync)
        return UpdateResult(False, "não atualizei agora: sem rede")

    monkeypatch.setattr(main_module, "self_update", fake)
    assert main(["self-update", "--no-sync"]) == EXIT_OK
    assert "sem rede" in capsys.readouterr().out
    assert seen == {"source": tmp_path / "localappdata" / "UniOver" / "app", "sync": False}
    assert main(["self-update"]) == EXIT_OK
    assert seen["sync"] is True
