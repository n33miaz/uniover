"""Atualização verificada: o pacote é do commit pedido, íntegro e igual à árvore dele no GitHub."""

import hashlib
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest

from tests.test_self_update import NEW, OLD, Installation, make_zip, patch_http, repo_files
from uniover_agent.adapters import self_update as module
from uniover_agent.adapters.self_update import (
    SelfUpdateError,
    UpdateRejected,
    agent_blob_hashes,
    fetch_git_tree,
    run_uv_sync,
    self_update,
    update_in_trial,
    verify_archive,
    verify_tree,
)
from uniover_agent.adapters.update_basics import read_version

FILES = {
    "pyproject.toml": b"[project]\r\nname = 'x'\r\n",
    "tools/run-agent.ps1": b"# supervisor\r\nWrite-Host 1\r\n",
    "src/uniover_agent/marca.py": b"MARCA = 1\n",
}


def blob(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


def make_package(path: Path, files: dict[str, bytes] = FILES, comment: str = NEW) -> Path:
    with zipfile.ZipFile(path, "w") as bundle:
        bundle.comment = comment.encode("ascii")
        bundle.writestr(f"uniover-{NEW}/README.md", "raiz")
        for name, data in files.items():
            bundle.writestr(f"uniover-{NEW}/apps/agent/{name}", data)
    return path


def tree_of(files: dict[str, bytes]) -> dict[str, str]:
    """A árvore do git: os fins de linha ficam normalizados em LF dentro do repositório."""
    return {name: blob(data.replace(b"\r\n", b"\n")) for name, data in files.items()}


# --- o zip --------------------------------------------------------------------------------------


def test_a_zip_of_the_requested_commit_passes(tmp_path: Path) -> None:
    verify_archive(make_package(tmp_path / "a.zip"), NEW)


def test_a_zip_of_another_commit_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(UpdateRejected, match="não é do commit esperado"):
        verify_archive(make_package(tmp_path / "a.zip", comment=OLD), NEW)
    with pytest.raises(UpdateRejected, match="não é do commit esperado"):
        verify_archive(make_package(tmp_path / "b.zip", comment=""), NEW)


def test_a_damaged_zip_is_rejected(tmp_path: Path) -> None:
    archive = make_package(tmp_path / "a.zip", {"src/uniover_agent/marca.py": b"MARCA = 1\n" * 50})
    data = bytearray(archive.read_bytes())
    marker = data.index(b"MARCA = 1")
    data[marker + 2] ^= 0xFF  # um byte do conteúdo muda: o CRC não fecha
    archive.write_bytes(bytes(data))
    with pytest.raises(UpdateRejected, match="corrompido"):
        verify_archive(archive, NEW)


def test_something_that_is_not_a_zip_is_rejected(tmp_path: Path) -> None:
    broken = tmp_path / "a.zip"
    broken.write_bytes(b"isto nao e um zip")
    with pytest.raises(UpdateRejected, match="não é um zip válido"):
        verify_archive(broken, NEW)


# --- a árvore do commit -------------------------------------------------------------------------


def test_the_hashes_come_with_and_without_the_line_ending_conversion(tmp_path: Path) -> None:
    hashes = agent_blob_hashes(make_package(tmp_path / "a.zip"))
    assert set(hashes) == set(FILES)
    raw, normalized = hashes["tools/run-agent.ps1"]
    assert raw == blob(FILES["tools/run-agent.ps1"])
    assert normalized == blob(b"# supervisor\nWrite-Host 1\n")
    # O que não é de `apps/agent` e os atalhos ficam de fora.
    assert "README.md" not in hashes


def test_a_package_equal_to_the_tree_passes_even_with_crlf_in_the_zip(tmp_path: Path) -> None:
    archive = make_package(tmp_path / "a.zip")
    assert verify_tree(archive, NEW, lambda sha: tree_of(FILES)) is True


def test_an_equal_package_with_raw_bytes_in_the_tree_also_passes(tmp_path: Path) -> None:
    archive = make_package(tmp_path / "a.zip")
    assert verify_tree(archive, NEW, lambda sha: {n: blob(d) for n, d in FILES.items()}) is True


def test_a_file_that_differs_from_the_commit_is_rejected(tmp_path: Path) -> None:
    archive = make_package(tmp_path / "a.zip")
    tampered = tree_of(FILES) | {"src/uniover_agent/marca.py": blob(b"MARCA = 2\n")}
    with pytest.raises(UpdateRejected, match="difere do commit"):
        verify_tree(archive, NEW, lambda sha: tampered)


def test_an_extra_or_a_missing_file_is_rejected(tmp_path: Path) -> None:
    archive = make_package(tmp_path / "a.zip")
    extra = {**tree_of(FILES), "src/uniover_agent/outro.py": blob(b"x")}
    with pytest.raises(UpdateRejected, match="não são os do commit"):
        verify_tree(archive, NEW, lambda sha: extra)
    fewer = {name: h for name, h in tree_of(FILES).items() if name != "pyproject.toml"}
    with pytest.raises(UpdateRejected, match="não são os do commit"):
        verify_tree(archive, NEW, lambda sha: fewer)


def test_an_unavailable_tree_rejects_the_package(tmp_path: Path) -> None:
    with pytest.raises(UpdateRejected, match="não consegui conferir a árvore"):
        verify_tree(make_package(tmp_path / "a.zip"), NEW, lambda sha: None)


def test_the_default_fetch_is_looked_up_at_call_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked: list[str] = []
    monkeypatch.setattr(module, "fetch_git_tree", asked.append)
    with pytest.raises(UpdateRejected, match="não consegui conferir a árvore"):
        verify_tree(make_package(tmp_path / "a.zip"), NEW)
    assert asked == [NEW]


def github_tree(entries: list[dict[str, Any]], **extra: Any) -> httpx.Response:
    return httpx.Response(200, json={"sha": NEW, "tree": entries, **extra})


def test_the_tree_from_github_keeps_only_agent_blobs(monkeypatch: pytest.MonkeyPatch) -> None:
    entries = [
        {"path": "README.md", "type": "blob", "sha": "1" * 40, "mode": "100644"},
        {"path": "apps", "type": "tree", "sha": "2" * 40, "mode": "040000"},
        {"path": "apps/agent", "type": "tree", "sha": "3" * 40, "mode": "040000"},
        {"path": "apps/agent/pyproject.toml", "type": "blob", "sha": "4" * 40, "mode": "100644"},
        {"path": "apps/agent/atalho", "type": "blob", "sha": "5" * 40, "mode": "120000"},
        {"path": "apps/agent/src/a.py", "type": "blob", "sha": "6" * 40, "mode": "100644"},
        {"path": "apps/web/x.ts", "type": "blob", "sha": "7" * 40, "mode": "100644"},
    ]
    requests = patch_http(monkeypatch, lambda r: github_tree(entries))
    assert fetch_git_tree(NEW) == {"pyproject.toml": "4" * 40, "src/a.py": "6" * 40}
    assert str(requests[0].url) == (
        f"https://api.github.com/repos/n33miaz/uniover/git/trees/{NEW}?recursive=1"
    )


class Clock:
    """Relógio e espera de mentira: `sleep` só avança o tempo e anota o pedido."""

    def __init__(self, wall: float = 1_000_000.0) -> None:
        self.now = 0.0
        self.wall_start = wall
        self.pauses: list[float] = []

    def sleep(self, seconds: float) -> None:
        self.pauses.append(seconds)
        self.now += seconds

    def monotonic(self) -> float:
        return self.now

    def wall(self) -> float:
        return self.wall_start + self.now

    def fetch(self, sha: str = NEW) -> dict[str, str] | None:
        return fetch_git_tree(sha, sleep=self.sleep, monotonic=self.monotonic, wall=self.wall)


GOOD_ENTRIES = [{"path": "apps/agent/a.py", "type": "blob", "sha": "6" * 40, "mode": "100644"}]
GOOD_TREE = {"a.py": "6" * 40}


def sequence(
    monkeypatch: pytest.MonkeyPatch, *answers: httpx.Response | Exception
) -> tuple[list[httpx.Request], list[httpx.Response | Exception]]:
    """Responde na ordem dada (um item por consulta); sobrar consulta é falha do teste."""
    queue = list(answers)

    def handler(request: httpx.Request) -> httpx.Response:
        answer = queue.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    return patch_http(monkeypatch, handler), queue


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(403, json={"message": "Forbidden"}),
        httpx.Response(404, json={"message": "Not Found"}),
        httpx.Response(200, content=b"nao e json"),
        httpx.Response(200, json=["lista"]),
        httpx.Response(200, json={"tree": "nada"}),
        httpx.Response(200, json={"tree": [{"path": "apps/agent/a", "type": "blob"}]}),
        httpx.Response(200, json={"tree": [{"path": "README.md", "type": "blob", "sha": "1"}]}),
    ],
)
def test_a_tree_that_cannot_be_trusted_is_none_without_retrying(
    monkeypatch: pytest.MonkeyPatch, response: httpx.Response
) -> None:
    requests = patch_http(monkeypatch, lambda r: response)
    clock = Clock()
    assert clock.fetch() is None
    assert len(requests) == 1
    assert clock.pauses == []


def test_without_network_it_retries_with_backoff_then_gives_up(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sem rede em 10.1.2.3")

    requests = patch_http(monkeypatch, offline)
    clock = Clock()
    with caplog.at_level("INFO", logger=module.__name__):
        assert clock.fetch() is None
    assert len(requests) == 3
    assert clock.pauses == [2.0, 8.0]
    lines = [r.getMessage() for r in caplog.records]
    assert len(lines) == 3
    assert all("github.com" not in line and "10.1.2.3" not in line for line in lines)
    assert "tentativa 1/3" in lines[0]
    assert "tentativa 3/3" in lines[2]


def test_a_transient_failure_then_success_returns_the_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests, queue = sequence(
        monkeypatch, httpx.ConnectTimeout("lento"), httpx.Response(502), github_tree(GOOD_ENTRIES)
    )
    clock = Clock()
    assert clock.fetch() == GOOD_TREE
    assert len(requests) == 3
    assert queue == []
    assert clock.pauses == [2.0, 8.0]


@pytest.mark.parametrize(
    "limited",
    [
        httpx.Response(403, json={"message": "API rate limit exceeded"}),
        httpx.Response(403, headers={"X-RateLimit-Remaining": "0"}, json={"message": "x"}),
        httpx.Response(429),
    ],
)
def test_a_rate_limit_is_retried(monkeypatch: pytest.MonkeyPatch, limited: httpx.Response) -> None:
    requests, _ = sequence(monkeypatch, limited, github_tree(GOOD_ENTRIES))
    clock = Clock()
    assert clock.fetch() == GOOD_TREE
    assert len(requests) == 2
    assert clock.pauses == [2.0]


def test_retry_after_is_respected(monkeypatch: pytest.MonkeyPatch) -> None:
    sequence(
        monkeypatch, httpx.Response(429, headers={"Retry-After": "20"}), github_tree(GOOD_ENTRIES)
    )
    clock = Clock()
    assert clock.fetch() == GOOD_TREE
    assert clock.pauses == [20.0]


def test_the_rate_limit_reset_time_is_respected(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = Clock()
    reset = str(int(clock.wall_start) + 30)
    sequence(
        monkeypatch,
        httpx.Response(403, headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset}),
        github_tree(GOOD_ENTRIES),
    )
    assert clock.fetch() == GOOD_TREE
    assert clock.pauses == [30.0]


def test_a_wait_beyond_the_budget_gives_up_without_sleeping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests = patch_http(
        monkeypatch, lambda r: httpx.Response(429, headers={"Retry-After": "3600"})
    )
    clock = Clock()
    assert clock.fetch() is None
    assert len(requests) == 1
    assert clock.pauses == []


def test_the_total_wait_never_passes_the_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    requests = patch_http(monkeypatch, lambda r: httpx.Response(429, headers={"Retry-After": "40"}))
    clock = Clock()
    assert clock.fetch() is None
    # 40 s cabem no prazo de 60; os 40 s seguintes (80 no total) não.
    assert clock.pauses == [40.0]
    assert len(requests) == 2
    assert clock.now <= module.TREE_RETRY_BUDGET_SECONDS


def test_a_server_error_that_never_recovers_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    requests = patch_http(monkeypatch, lambda r: httpx.Response(503))
    clock = Clock()
    assert clock.fetch() is None
    assert len(requests) == 3


# --- árvore truncada ----------------------------------------------------------------------------

APPS, AGENT, SRC = "7" * 40, "c" * 40, "d" * 40


def tree_item(path: str, sha: str, kind: str = "tree") -> dict[str, str]:
    mode = "040000" if kind == "tree" else "100644"
    return {"path": path, "type": kind, "sha": sha, "mode": mode}


def truncated_repo(
    monkeypatch: pytest.MonkeyPatch, **overrides: httpx.Response
) -> list[httpx.Request]:
    """O GitHub devolve a árvore recursiva truncada; ela se lê um diretório por vez."""

    def handler(request: httpx.Request) -> httpx.Response:
        sha = request.url.path.rsplit("/", 1)[1]
        recursive = request.url.query == b"recursive=1"
        if sha in overrides:
            return overrides[sha]
        if recursive and sha == NEW:
            return github_tree([], truncated=True)
        if recursive and sha == AGENT:
            return github_tree(
                [
                    tree_item("pyproject.toml", "4" * 40, "blob"),
                    tree_item("src", SRC),
                    tree_item("src/a.py", "6" * 40, "blob"),
                ]
            )
        if sha == APPS:
            return github_tree([tree_item("agent", AGENT), tree_item("web", "f" * 40)])
        if sha == NEW:
            return github_tree(
                [
                    tree_item("README.md", "1" * 40, "blob"),
                    tree_item("apps", APPS),
                    tree_item("docs", "e" * 40),
                ]
            )
        return httpx.Response(404)

    return patch_http(monkeypatch, handler)


def test_a_truncated_tree_is_read_directory_by_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    requests = truncated_repo(monkeypatch)
    assert Clock().fetch() == {"pyproject.toml": "4" * 40, "src/a.py": "6" * 40}
    base = "https://api.github.com/repos/n33miaz/uniover/git/trees/"
    asked = [str(r.url).removeprefix(base) for r in requests]
    assert asked == [f"{NEW}?recursive=1", NEW, APPS, f"{AGENT}?recursive=1"]


def test_a_truncated_agent_directory_is_walked_by_its_own_subdirectories(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        sha = request.url.path.rsplit("/", 1)[1]
        recursive = request.url.query == b"recursive=1"
        if sha == NEW:
            return (
                github_tree([], truncated=True)
                if recursive
                else github_tree([tree_item("apps", APPS)])
            )
        if sha == APPS:
            return github_tree([tree_item("agent", AGENT)])
        if sha == AGENT and recursive:
            return github_tree([], truncated=True)
        if sha == AGENT:
            return github_tree(
                [tree_item("pyproject.toml", "4" * 40, "blob"), tree_item("src", SRC)]
            )
        if sha == SRC:
            return github_tree([tree_item("a.py", "6" * 40, "blob")])
        return httpx.Response(404)

    patch_http(monkeypatch, handler)
    assert Clock().fetch() == {"pyproject.toml": "4" * 40, "src/a.py": "6" * 40}


def test_a_truncated_tree_without_the_agent_directory_is_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.query == b"recursive=1":
            return github_tree([], truncated=True)
        return github_tree([tree_item("README.md", "1" * 40, "blob")])

    patch_http(monkeypatch, handler)
    assert Clock().fetch() is None


def test_a_truncated_tree_fails_closed_when_a_subtree_cannot_be_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    truncated_repo(monkeypatch, **{AGENT: httpx.Response(404)})
    assert Clock().fetch() is None


def test_a_truncated_tree_retries_transient_errors_in_a_subtree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    truncated_repo(monkeypatch, **{APPS: httpx.Response(503)})
    clock = Clock()
    assert clock.fetch() is None
    # O prazo é um só para a conferência toda: três tentativas em `apps` (2 s + 8 s) e acabou.
    assert clock.pauses == [2.0, 8.0]


def test_no_new_query_leaves_once_the_budget_is_spent(monkeypatch: pytest.MonkeyPatch) -> None:
    flat_answers = [
        httpx.Response(429, headers={"Retry-After": "60"}),
        github_tree([tree_item("apps", APPS)]),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.query == b"recursive=1":
            return github_tree([], truncated=True)
        return flat_answers.pop(0)

    requests = patch_http(monkeypatch, handler)
    clock = Clock()
    assert clock.fetch() is None
    # O recuo de 60 s consumiu o prazo: a descida para `apps` nem começa.
    assert clock.pauses == [60.0]
    assert len(requests) == 3


def test_a_truncated_tree_for_a_non_sha_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_http(monkeypatch, lambda r: github_tree([], truncated=True))
    assert Clock().fetch("main") is None


def test_verify_tree_stays_fail_closed_when_the_fetch_gives_up(tmp_path: Path) -> None:
    with pytest.raises(UpdateRejected, match="não consegui conferir a árvore"):
        verify_tree(make_package(tmp_path / "a.zip"), NEW, lambda sha: None)


# --- a atualização ------------------------------------------------------------------------------


def mark_trial(base: Path, sha: str | None) -> None:
    runtime = base / "runtime"
    runtime.mkdir(exist_ok=True)
    (runtime / "update-trial.txt").write_text(f"{sha}|0", encoding="ascii")


def test_an_installed_version_still_in_proof_is_not_replaced_and_nothing_is_downloaded(
    tmp_path: Path,
) -> None:
    installed = Installation(tmp_path / "UniOver")
    mark_trial(installed.base, OLD)
    assert update_in_trial(installed.source)
    result = self_update(
        installed.source,
        fetch_latest=lambda: pytest.fail("não devia nem consultar o GitHub"),
        download=installed.download,
    )
    assert not result.updated and result.outcome is None
    assert "em prova" in result.message
    assert installed.downloads == [] and read_version(installed.source) == OLD


def test_a_proof_of_another_version_does_not_block_the_update(tmp_path: Path) -> None:
    installed = Installation(tmp_path / "UniOver")
    mark_trial(installed.base, "c" * 40)
    assert not update_in_trial(installed.source)
    assert installed.update(NEW).updated


def test_a_package_that_fails_the_check_is_rejected_and_leaves_the_install_intact(
    tmp_path: Path,
) -> None:
    installed = Installation(tmp_path / "UniOver")

    def other_commit(sha: str, destination: Path) -> None:
        make_zip(destination, repo_files("nova"), comment=OLD)

    result = installed.update(NEW, download=other_commit)
    assert (result.updated, result.outcome, result.rejected) == (False, "failed", True)
    assert "pacote recusado" in result.message and result.latest == NEW
    assert read_version(installed.source) == OLD
    assert installed.leftovers() == []
    assert not (installed.base / "agent-src.new").exists()


def test_a_tree_mismatch_also_rejects_the_package(tmp_path: Path) -> None:
    installed = Installation(tmp_path / "UniOver")

    def mismatch(archive: Path, sha: str) -> bool:
        raise UpdateRejected("um arquivo do pacote difere do commit")

    result = installed.update(NEW, verify_files=mismatch)
    assert result.rejected and "difere do commit" in result.message
    assert installed.synced == [] and read_version(installed.source) == OLD


def test_the_channel_chooses_which_branch_is_asked_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installed = Installation(tmp_path / "UniOver")
    asked: list[str] = []

    def latest(channel: str = "develop") -> str:
        asked.append(channel)
        return OLD

    monkeypatch.setattr(module, "latest_commit", latest)
    self_update(installed.source, channel="main", download=installed.download)
    self_update(installed.source, download=installed.download)
    assert asked == ["main", "develop"]


def test_a_failed_update_for_network_reasons_is_not_a_rejection(tmp_path: Path) -> None:
    installed = Installation(tmp_path / "UniOver")

    def offline() -> str:
        raise SelfUpdateError("não consegui consultar o GitHub (ConnectError)")

    result = self_update(installed.source, fetch_latest=offline)
    assert result.outcome == "failed" and not result.rejected


def test_the_sync_of_the_candidate_is_locked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess  # noqa: PLC0415

    seen: list[list[str]] = []

    def fake(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setenv("UV", "uv")
    monkeypatch.setattr(subprocess, "run", fake)
    run_uv_sync(tmp_path / "app.new")
    assert "--frozen" in seen[0]
