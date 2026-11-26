"""Origem do APK do TV Livre: só entrega ao ADB o que bate com o hash publicado."""

import asyncio
import hashlib
from pathlib import Path

import httpx
import pytest

from uniover_agent.adapters import tv_livre_apk
from uniover_agent.adapters.tv_livre_apk import MAX_APK_BYTES, ReleaseApkSource
from uniover_agent.ports.tv_livre import LauncherApkError

BASE = "https://exemplo.test/releases/latest/download"
APK = b"PK\x03\x04" + b"conteudo do apk" * 20


def source(tmp_path: Path, files: dict[str, httpx.Response]) -> ReleaseApkSource:
    def handler(request: httpx.Request) -> httpx.Response:
        return files.get(request.url.path.rsplit("/", 1)[-1], httpx.Response(404))

    return ReleaseApkSource(
        BASE,
        tmp_path / "apk",
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def published(apk: bytes = APK, digest: str | None = None) -> dict[str, httpx.Response]:
    digest = digest or hashlib.sha256(apk).hexdigest()
    return {
        "uniover-launcher.apk": httpx.Response(200, content=apk),
        "uniover-launcher.apk.sha256": httpx.Response(
            200, text=f"{digest}  uniover-launcher.apk\n"
        ),
    }


async def test_a_matching_download_is_returned(tmp_path: Path) -> None:
    result = await source(tmp_path, published()).fetch()

    assert result.path.read_bytes() == APK
    assert result.sha256 == hashlib.sha256(APK).hexdigest()


async def test_a_hash_that_does_not_match_removes_the_file(tmp_path: Path) -> None:
    with pytest.raises(LauncherApkError) as raised:
        await source(tmp_path, published(digest="0" * 64)).fetch()

    assert raised.value.code == "apk_hash_mismatch"
    assert not (tmp_path / "apk" / "uniover-launcher.apk").exists()


@pytest.mark.parametrize("missing", ["uniover-launcher.apk", "uniover-launcher.apk.sha256"])
async def test_a_missing_publication_is_unavailable(tmp_path: Path, missing: str) -> None:
    files = published()
    del files[missing]

    with pytest.raises(LauncherApkError) as raised:
        await source(tmp_path, files).fetch()

    assert raised.value.code == "apk_unavailable"


async def test_an_unreadable_hash_is_unavailable(tmp_path: Path) -> None:
    files = published()
    files["uniover-launcher.apk.sha256"] = httpx.Response(200, text="não é um hash")

    with pytest.raises(LauncherApkError) as raised:
        await source(tmp_path, files).fetch()

    assert raised.value.code == "apk_unavailable"


async def test_something_that_is_not_a_zip_is_invalid(tmp_path: Path) -> None:
    with pytest.raises(LauncherApkError) as raised:
        await source(tmp_path, published(b"<html>erro</html>")).fetch()

    assert raised.value.code == "apk_invalid"


async def test_an_oversized_download_is_refused(tmp_path: Path) -> None:
    big = b"PK\x03\x04" + b"x" * MAX_APK_BYTES

    with pytest.raises(LauncherApkError) as raised:
        await source(tmp_path, published(big)).fetch()

    assert raised.value.code == "apk_invalid"


def test_only_https_is_accepted(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        ReleaseApkSource("http://exemplo.test/x", tmp_path)


# --- versão publicada --------------------------------------------------------------------------

TAGGED = "https://exemplo.test/releases/download"


def redirect(location: str, status: int = 302) -> dict[str, httpx.Response]:
    return {"uniover-launcher.apk": httpx.Response(status, headers={"location": location})}


async def test_the_published_version_comes_from_the_first_redirect_without_downloading(
    tmp_path: Path,
) -> None:
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url)))
        return redirect(f"{TAGGED}/v1.12.3/uniover-launcher.apk")["uniover-launcher.apk"]

    apk = ReleaseApkSource(
        BASE,
        tmp_path / "apk",
        # Como o cliente de verdade, que segue redirecionamentos: a consulta não pode segui-lo.
        client_factory=lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), follow_redirects=True
        ),
    )

    assert await apk.published_version() == "1.12.3"
    assert seen == [("HEAD", f"{BASE}/uniover-launcher.apk")]
    assert not (tmp_path / "apk").exists()


@pytest.mark.parametrize(
    "files",
    [
        pytest.param({}, id="sem publicação"),
        pytest.param(published(), id="sem redirecionamento"),
        pytest.param(redirect(""), id="redirecionamento vazio"),
        pytest.param(redirect("https://cdn.exemplo.test/blob/abc123"), id="sem tag"),
        pytest.param(redirect(f"{TAGGED}/nightly/uniover-launcher.apk"), id="tag sem número"),
        pytest.param(redirect(f"{TAGGED}/v1.2/uniover-launcher.apk"), id="duas partes"),
        pytest.param(redirect(f"{TAGGED}/v1.2.3-rc.1/uniover-launcher.apk"), id="pré-versão"),
        pytest.param(redirect(f"{TAGGED}/v1.2.3/outro.apk"), id="outro arquivo"),
    ],
)
async def test_an_unreadable_publication_tells_no_version(
    tmp_path: Path, files: dict[str, httpx.Response]
) -> None:
    assert await source(tmp_path, files).published_version() is None


async def test_a_network_failure_tells_no_version_instead_of_raising(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sem rede", request=request)

    apk = ReleaseApkSource(
        BASE,
        tmp_path,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    assert await apk.published_version() is None


async def test_a_slow_publication_is_abandoned_at_the_time_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.Event().wait()
        raise AssertionError("não chega aqui")

    monkeypatch.setattr(tv_livre_apk, "VERSION_TIMEOUT_SECONDS", 0.01)
    apk = ReleaseApkSource(
        BASE,
        tmp_path,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    assert await apk.published_version() is None
