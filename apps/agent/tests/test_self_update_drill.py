"""Ponto de injeção do ensaio de atualização: desligado por padrão e recusando origem de fora."""

import io
import zipfile
from pathlib import Path

import httpx
import pytest

from tests.test_self_update import NEW, OLD, Installation, make_zip, patch_http, repo_files
from uniover_agent.adapters import self_update as module
from uniover_agent.adapters.self_update import (
    SelfUpdateError,
    archive_url,
    commit_url,
    download_archive,
    drill_origin,
    latest_commit,
    read_version,
    self_update,
)

ORIGIN = "http://127.0.0.1:50123"


@pytest.fixture
def drill(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv(module.DRILL_ENV, "1")
    monkeypatch.setenv(module.DRILL_SOURCE_ENV, ORIGIN)
    return ORIGIN


def test_the_drill_is_off_by_default_and_the_urls_stay_on_github() -> None:
    assert drill_origin() is None
    assert commit_url() == module.COMMIT_URL
    assert archive_url(NEW) == f"https://github.com/n33miaz/uniover/archive/{NEW}.zip"


def test_the_origin_is_ignored_without_the_mode_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(module.DRILL_SOURCE_ENV, ORIGIN)
    assert drill_origin() is None
    assert commit_url() == module.COMMIT_URL


@pytest.mark.parametrize("mode", ["", "0", "true", "yes"])
def test_only_the_exact_mode_value_turns_the_drill_on(
    monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    monkeypatch.setenv(module.DRILL_ENV, mode)
    monkeypatch.setenv(module.DRILL_SOURCE_ENV, ORIGIN)
    assert drill_origin() is None


def test_the_drill_points_both_requests_at_the_local_server(drill: str) -> None:
    assert drill_origin() == drill
    assert commit_url() == f"{drill}/commit"
    assert archive_url(NEW) == f"{drill}/archive/{NEW}.zip"


def test_a_trailing_slash_on_the_origin_is_tolerated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(module.DRILL_ENV, "1")
    monkeypatch.setenv(module.DRILL_SOURCE_ENV, f"{ORIGIN}/")
    assert commit_url() == f"{ORIGIN}/commit"


@pytest.mark.parametrize(
    "origin",
    [
        "",
        "https://127.0.0.1:50123",
        "http://127.0.0.1",
        "http://example.com:50123",
        "http://api.github.com:80",
        "http://127.0.0.1:50123/outro/caminho",
        "http://127.0.0.1:99999",
        "127.0.0.1:50123",
    ],
)
def test_a_drill_without_a_valid_local_origin_is_refused_instead_of_falling_back(
    monkeypatch: pytest.MonkeyPatch, origin: str
) -> None:
    monkeypatch.setenv(module.DRILL_ENV, "1")
    monkeypatch.setenv(module.DRILL_SOURCE_ENV, origin)
    with pytest.raises(SelfUpdateError, match="modo ensaio"):
        drill_origin()
    with pytest.raises(SelfUpdateError, match="modo ensaio"):
        latest_commit()
    with pytest.raises(SelfUpdateError, match="modo ensaio"):
        archive_url(NEW)


def test_a_drill_without_any_origin_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(module.DRILL_ENV, "1")
    with pytest.raises(SelfUpdateError, match="modo ensaio"):
        drill_origin()


def test_latest_commit_asks_the_local_server_in_drill_mode(
    monkeypatch: pytest.MonkeyPatch, drill: str
) -> None:
    requests = patch_http(monkeypatch, lambda r: httpx.Response(200, json={"sha": NEW}))
    assert latest_commit() == NEW
    assert [str(r.url) for r in requests] == [f"{drill}/commit"]


def test_download_archive_reads_the_zip_from_the_local_server_in_drill_mode(
    monkeypatch: pytest.MonkeyPatch, drill: str, tmp_path: Path
) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("a.txt", "x")
    requests = patch_http(monkeypatch, lambda r: httpx.Response(200, content=buffer.getvalue()))
    destination = tmp_path / "main.zip"
    download_archive(NEW, destination)
    assert destination.read_bytes() == buffer.getvalue()
    assert [str(r.url) for r in requests] == [f"{drill}/archive/{NEW}.zip"]


def test_outside_the_drill_the_requests_still_go_to_github(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(module.DRILL_SOURCE_ENV, ORIGIN)
    requests = patch_http(monkeypatch, lambda r: httpx.Response(200, json={"sha": NEW}))
    assert latest_commit() == NEW
    assert [str(r.url) for r in requests] == [module.COMMIT_URL]


def test_a_full_update_runs_through_the_local_server_in_drill_mode(
    monkeypatch: pytest.MonkeyPatch, drill: str, tmp_path: Path
) -> None:
    archive = tmp_path / "feed.zip"
    make_zip(archive, repo_files("ensaio"))

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/commit":
            return httpx.Response(200, json={"sha": NEW})
        return httpx.Response(200, content=archive.read_bytes())

    requests = patch_http(monkeypatch, respond)
    installed = Installation(tmp_path / "UniOver")
    result = self_update(
        installed.source, run_sync=installed.run_sync, run_check=installed.run_check
    )
    assert result.updated
    assert read_version(installed.source) == NEW
    assert read_version(installed.source) != OLD
    assert [str(r.url) for r in requests] == [f"{drill}/commit", f"{drill}/archive/{NEW}.zip"]


def test_a_failed_check_in_drill_mode_keeps_the_running_version(
    monkeypatch: pytest.MonkeyPatch, drill: str, tmp_path: Path
) -> None:
    archive = tmp_path / "feed.zip"
    make_zip(archive, repo_files("quebrada"))

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/commit":
            return httpx.Response(200, json={"sha": NEW})
        return httpx.Response(200, content=archive.read_bytes())

    patch_http(monkeypatch, respond)
    installed = Installation(tmp_path / "UniOver")

    def import_fails(_source: Path) -> None:
        raise SelfUpdateError("a verificação rápida da atualização falhou (código 1)")

    result = self_update(installed.source, run_sync=installed.run_sync, run_check=import_fails)
    assert not result.updated
    assert "verificação rápida" in result.message
    assert read_version(installed.source) == OLD
    assert installed.leftovers() == []
