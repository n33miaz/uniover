"""Assinatura do APK do TV Livre: só instala o que o certificado fixado assinou."""

import hashlib
from pathlib import Path

import httpx
import pytest

from uniover_agent.adapters.tv_adb_parsing import AdbOutput
from uniover_agent.adapters.tv_livre_apk import ReleaseApkSource
from uniover_agent.adapters.tv_livre_signer import ApkSignerVerifier
from uniover_agent.config import Settings
from uniover_agent.ports.tv_livre import LauncherApkError

PIN = "ab" * 32
OTHER = "cd" * 32
APK = Path("launcher.apk")
SIGNER = Path("apksigner-falso")


def output(*digests: str, returncode: int = 0) -> AdbOutput:
    lines = [f"Signer #{i} certificate SHA-256 digest: {d}" for i, d in enumerate(digests, 1)]
    return AdbOutput(returncode, "\n".join(lines))


def verifier(
    result: AdbOutput | BaseException,
    pinned: frozenset[str] = frozenset({PIN}),
    tool: Path | None = SIGNER,
) -> tuple[ApkSignerVerifier, list[list[str]]]:
    calls: list[list[str]] = []

    async def run(argv: object, seconds: float) -> AdbOutput:
        calls.append(list(argv))  # type: ignore[call-overload]
        if isinstance(result, BaseException):
            raise result
        return result

    return ApkSignerVerifier(pinned, tool, runner=run), calls


async def test_the_pinned_certificate_passes_and_the_command_is_fixed() -> None:
    check, calls = verifier(output(PIN))

    await check(APK)

    assert calls == [[str(SIGNER), "verify", "--print-certs", str(APK)]]


async def test_the_digest_case_does_not_matter() -> None:
    check, _ = verifier(output(PIN.upper()))

    await check(APK)


@pytest.mark.parametrize(
    ("result", "code"),
    [
        (output(OTHER), "apk_signer_mismatch"),
        (output(PIN, OTHER), "apk_signer_mismatch"),
        (output(), "apk_signature_invalid"),
        (output(PIN, returncode=1), "apk_signature_invalid"),
        (TimeoutError(), "signer_unverifiable"),
        (OSError(), "signer_unverifiable"),
    ],
)
async def test_anything_but_the_pinned_signer_is_refused(
    result: AdbOutput | BaseException, code: str
) -> None:
    check, _ = verifier(result)

    with pytest.raises(LauncherApkError) as raised:
        await check(APK)

    assert raised.value.code == code


async def test_without_a_pinned_certificate_nothing_is_installed() -> None:
    check, calls = verifier(output(PIN), pinned=frozenset())

    with pytest.raises(LauncherApkError) as raised:
        await check(APK)

    assert raised.value.code == "signer_not_pinned"
    assert calls == []


async def test_without_apksigner_nothing_is_installed() -> None:
    check, _ = verifier(output(PIN), tool=None)

    with pytest.raises(LauncherApkError) as raised:
        await check(APK)

    assert raised.value.code == "signer_unverifiable"


async def test_a_refused_signature_removes_the_downloaded_apk(tmp_path: Path) -> None:
    apk = b"PK\x03\x04" + b"x" * 40

    digest = hashlib.sha256(apk).hexdigest()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".sha256"):
            return httpx.Response(200, text=digest)
        return httpx.Response(200, content=apk)

    check, _ = verifier(output(OTHER))
    source = ReleaseApkSource(
        "https://exemplo.test/x",
        tmp_path,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        verifier=check,
    )

    with pytest.raises(LauncherApkError) as raised:
        await source.fetch()

    assert raised.value.code == "apk_signer_mismatch"
    assert not (tmp_path / "uniover-launcher.apk").exists()


def test_the_pinned_certificates_are_read_from_the_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    colons = ":".join(PIN[i : i + 2] for i in range(0, 64, 2)).upper()
    monkeypatch.setenv("UNIOVER_TV_LIVRE_SIGNER_SHA256", f"{colons}, {OTHER}")

    assert Settings().tv_livre_signer_sha256 == [PIN, OTHER]  # type: ignore[call-arg]


def test_a_malformed_pin_is_a_configuration_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UNIOVER_TV_LIVRE_SIGNER_SHA256", "nao-e-hash")

    with pytest.raises(ValueError, match="SHA-256"):
        Settings()  # type: ignore[call-arg]
