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
    read_version,
    run_uv_sync,
    self_update,
    update_in_trial,
    verify_archive,
    verify_tree,
)

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


def test_an_unavailable_tree_means_not_verified_not_rejected(tmp_path: Path) -> None:
    assert verify_tree(make_package(tmp_path / "a.zip"), NEW, lambda sha: None) is False


def test_the_default_fetch_is_looked_up_at_call_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked: list[str] = []
    monkeypatch.setattr(module, "fetch_git_tree", asked.append)
    assert verify_tree(make_package(tmp_path / "a.zip"), NEW) is False
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


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(403, json={"message": "rate limit"}),
        httpx.Response(200, content=b"nao e json"),
        httpx.Response(200, json=["lista"]),
        httpx.Response(200, json={"truncated": True, "tree": []}),
        httpx.Response(200, json={"tree": "nada"}),
        httpx.Response(200, json={"tree": [{"path": "apps/agent/a", "type": "blob"}]}),
        httpx.Response(200, json={"tree": [{"path": "README.md", "type": "blob", "sha": "1"}]}),
    ],
)
def test_a_tree_that_cannot_be_trusted_or_obtained_is_none(
    monkeypatch: pytest.MonkeyPatch, response: httpx.Response
) -> None:
    patch_http(monkeypatch, lambda r: response)
    assert fetch_git_tree(NEW) is None


def test_without_network_the_tree_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sem rede")

    patch_http(monkeypatch, offline)
    assert fetch_git_tree(NEW) is None


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
