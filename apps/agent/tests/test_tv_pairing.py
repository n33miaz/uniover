import logging
import subprocess
import sys
from pathlib import Path

import pytest
from androidtvremote2 import AndroidTVRemote, CannotConnect, ConnectionClosed, InvalidAuth

from uniover_agent import main as main_module
from uniover_agent.adapters.tv_pairing import (
    TvPairingError,
    is_paired,
    pair_tv,
    prepare_private_dir,
    restrict_to_current_user,
)
from uniover_agent.config import ConfigError, Settings, require_tv_host, tv_cert_dir
from uniover_agent.main import main, tv_pair

from .support_tv import write_certificate

SECRET_CODE = "A1B2C3"


class FakePairing:
    def __init__(
        self, *, start_error: Exception | None = None, finish_error: Exception | None = None
    ) -> None:
        self.start_error = start_error
        self.finish_error = finish_error
        self.codes: list[str] = []
        self.started = 0
        self.disconnects = 0

    async def async_generate_cert_if_missing(self) -> bool:
        return True

    async def async_start_pairing(self) -> None:
        self.started += 1
        if self.start_error is not None:
            raise self.start_error

    async def async_finish_pairing(self, pairing_code: str) -> None:
        self.codes.append(pairing_code)
        if self.finish_error is not None:
            raise self.finish_error

    def disconnect(self) -> None:
        self.disconnects += 1


async def answer(code: str) -> str:
    return code


async def test_pairing_sends_the_code_and_always_disconnects(tmp_path: Path) -> None:
    library = FakePairing()
    await pair_tv(
        "10.0.0.4",
        "UniOver",
        tmp_path / "tv",
        lambda: answer(f" {SECRET_CODE}\n"),
        factory=lambda *_: library,
    )
    assert library.codes == [SECRET_CODE]
    assert library.disconnects == 1
    assert (tmp_path / "tv").is_dir()


@pytest.mark.parametrize("code", ["", "12345", "1234567", "12 345", "ZZZZZZ", "12-456"])
async def test_a_malformed_code_is_refused_before_reaching_the_tv(
    tmp_path: Path, code: str
) -> None:
    library = FakePairing()
    with pytest.raises(TvPairingError, match="6 caracteres"):
        await pair_tv(
            "10.0.0.4", "UniOver", tmp_path / "tv", lambda: answer(code), factory=lambda *_: library
        )
    assert library.codes == []
    assert library.disconnects == 1


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"start_error": CannotConnect("x")}, "não consegui falar com a TV"),
        ({"start_error": ConnectionClosed("x")}, "não consegui falar com a TV"),
        ({"finish_error": InvalidAuth(f"código {SECRET_CODE}")}, "não aceitou o código"),
        ({"finish_error": ConnectionClosed("x")}, "fechou a conexão"),
    ],
)
async def test_failures_become_clear_messages_without_the_code(
    tmp_path: Path, kwargs: dict[str, Exception], message: str
) -> None:
    library = FakePairing(**kwargs)
    with pytest.raises(TvPairingError, match=message) as caught:
        await pair_tv(
            "10.0.0.4",
            "UniOver",
            tmp_path / "tv",
            lambda: answer(SECRET_CODE),
            factory=lambda *_: library,
        )
    assert SECRET_CODE not in str(caught.value)
    assert library.disconnects == 1


class OfflineLibrary(AndroidTVRemote):
    """Biblioteca real (gera o certificado de verdade), sem falar com TV nenhuma."""

    async def async_start_pairing(self) -> None:
        return None

    async def async_finish_pairing(self, pairing_code: str) -> None:
        return None


async def test_real_library_generates_the_pair_inside_the_protected_folder(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    folder = tmp_path / "UniOver" / "tv" / "sala"
    with caplog.at_level(logging.DEBUG):
        await pair_tv(
            "10.0.0.4", "UniOver", folder, lambda: answer(SECRET_CODE), factory=OfflineLibrary
        )
    assert is_paired(folder)
    assert (folder / "cert.pem").read_text().startswith("-----BEGIN CERTIFICATE-----")
    assert "PRIVATE KEY" in (folder / "key.pem").read_text()
    # A chave nunca vai para o registro.
    assert "PRIVATE KEY" not in caplog.text
    assert SECRET_CODE not in caplog.text


@pytest.mark.skipif(sys.platform != "win32", reason="icacls só existe no Windows")
def test_folder_is_restricted_to_the_current_user_on_windows(tmp_path: Path) -> None:
    folder = tmp_path / "protegida"
    prepare_private_dir(folder)
    # Um arquivo criado depois herda a restrição da pasta (a chave nasce já protegida).
    secret = folder / "key.pem"
    secret.write_text("segredo", encoding="utf-8")
    listing = subprocess.run(  # noqa: S603
        ["icacls", str(secret)],  # noqa: S607
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    entries = [line for line in listing.splitlines() if ":(" in line]
    assert entries, listing
    for forbidden in ("Everyone", "BUILTIN\\Users", "Authenticated Users"):
        assert forbidden not in listing
    # Só o próprio usuário aparece (nenhuma herança de outros grupos).
    assert len(entries) == 1, listing
    assert secret.read_text(encoding="utf-8") == "segredo"


@pytest.mark.skipif(sys.platform == "win32", reason="modo 0700 é do POSIX")
def test_folder_is_mode_0700_outside_windows(tmp_path: Path) -> None:
    folder = tmp_path / "protegida"
    folder.mkdir()
    restrict_to_current_user(folder)
    assert folder.stat().st_mode & 0o777 == 0o700


def test_is_paired_needs_both_files(tmp_path: Path) -> None:
    assert not is_paired(tmp_path)
    write_certificate(tmp_path, "UniOver")
    assert is_paired(tmp_path)
    (tmp_path / "key.pem").unlink()
    assert not is_paired(tmp_path)


# --- configuração e linha de comando ---------------------------------------------------------


def test_cert_dir_lives_under_localappdata_and_the_name_is_sanitized(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert tv_cert_dir("sala") == tmp_path / "UniOver" / "tv" / "sala"
    assert tv_cert_dir("../../fora") == tmp_path / "UniOver" / "tv" / "fora"
    assert tv_cert_dir("???") == tmp_path / "UniOver" / "tv" / "tv"
    assert tmp_path in tv_cert_dir("a/b\\c").parents


def test_tv_host_must_be_just_an_address() -> None:
    assert require_tv_host("192.168.0.4") == "192.168.0.4"
    assert require_tv_host("tv-sala.local") == "tv-sala.local"
    for bad in (None, "", "http://192.168.0.4", "192.168.0.4:6466", "a b", "x/y"):
        with pytest.raises(ConfigError):
            require_tv_host(bad)


def test_tv_settings_have_the_agreed_defaults() -> None:
    settings = Settings()
    assert settings.tv_host is None
    assert settings.tv_client_name == "UniOver"
    assert settings.tv_hibernate_seconds == 300


def test_tv_settings_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UNIOVER_TV_HOST", "192.168.0.4")
    monkeypatch.setenv("UNIOVER_TV_CLIENT_NAME", "Casa")
    monkeypatch.setenv("UNIOVER_TV_HIBERNATE_SECONDS", "120")
    settings = Settings()
    assert (settings.tv_host, settings.tv_client_name, settings.tv_hibernate_seconds) == (
        "192.168.0.4",
        "Casa",
        120,
    )


async def test_tv_pair_command_reports_success_without_printing_the_code(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    seen: dict[str, object] = {}

    async def fake_pair(host: str, client: str, folder: Path, ask: object) -> None:
        seen.update(host=host, client=client, folder=folder)

    monkeypatch.setattr(main_module, "pair_tv", fake_pair)
    assert await tv_pair(Settings(), "192.168.0.4", None) == 0
    out = capsys.readouterr().out
    assert seen["host"] == "192.168.0.4"
    assert seen["client"] == "UniOver"
    assert seen["folder"] == tmp_path / "UniOver" / "tv" / "tv"
    assert "TV pareada" in out
    assert "UNIOVER_TV_HOST=192.168.0.4" in out


async def test_tv_pair_command_reports_failure_on_stderr(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def failing(host: str, client: str, folder: Path, ask: object) -> None:
        raise TvPairingError("a TV não aceitou o código")

    monkeypatch.setattr(main_module, "pair_tv", failing)
    assert await tv_pair(Settings(), "192.168.0.4", "sala") == 1
    assert "não aceitou" in capsys.readouterr().err


def test_tv_pair_needs_a_host(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["tv-pair"]) == 1
    assert "UNIOVER_TV_HOST" in capsys.readouterr().err


async def test_a_failed_pairing_discards_the_pair_it_just_generated(tmp_path: Path) -> None:
    folder = tmp_path / "tv"

    class Rejecting(OfflineLibrary):
        async def async_finish_pairing(self, pairing_code: str) -> None:
            raise InvalidAuth("recusado")

    with pytest.raises(TvPairingError):
        await pair_tv("10.0.0.4", "UniOver", folder, lambda: answer(SECRET_CODE), factory=Rejecting)
    # Sem par sobrando, `is_paired` não faz o agente declarar `tv.remote` para uma TV não pareada.
    assert not is_paired(folder)
    assert not (folder / "key.pem").exists()


async def test_a_failed_repairing_keeps_the_pair_that_already_worked(tmp_path: Path) -> None:
    folder = tmp_path / "tv"
    write_certificate(folder, "UniOver")
    before = (folder / "cert.pem").read_bytes()

    class ExistingPair(FakePairing):
        async def async_generate_cert_if_missing(self) -> bool:
            return False  # já existia: nada foi gerado nesta execução

    library = ExistingPair(finish_error=InvalidAuth("recusado"))
    with pytest.raises(TvPairingError):
        await pair_tv(
            "10.0.0.4", "UniOver", folder, lambda: answer(SECRET_CODE), factory=lambda *_: library
        )
    assert is_paired(folder)
    assert (folder / "cert.pem").read_bytes() == before
