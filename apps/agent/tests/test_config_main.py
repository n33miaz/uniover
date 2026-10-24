import asyncio
import json
import logging
import threading
import tomllib
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent import main as main_module
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore
from uniover_agent.adapters.local_config import save_agent_config
from uniover_agent.config import ConfigError, Settings, require_api_url
from uniover_agent.main import (
    EXIT_CREDENTIAL_REJECTED,
    EXIT_NOT_PAIRED,
    configure_logging,
    main,
    pairing_info,
    run,
    silence_noisy_loggers,
)

from .support import AGENT_ID, TOKEN, FakeApi, dump, tv_key


def test_config_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UNIOVER_API_URL", "https://api.exemplo.test")
    monkeypatch.setenv("UNIOVER_AGENT_ID", "pc-sala")
    monkeypatch.setenv("UNIOVER_LOG_LEVEL", "DEBUG")
    settings = Settings()
    assert settings.api_url == "https://api.exemplo.test"
    assert settings.agent_id == "pc-sala"
    assert settings.log_level == "DEBUG"
    assert settings.allow_insecure is False


def test_typing_by_keys_is_off_by_default_and_read_from_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings()
    assert (settings.tv_text_by_keys, settings.tv_text_key_pause_ms) == (False, 0)
    monkeypatch.setenv("UNIOVER_TV_TEXT_BY_KEYS", "1")
    monkeypatch.setenv("UNIOVER_TV_TEXT_KEY_PAUSE_MS", "15")
    settings = Settings()
    assert (settings.tv_text_by_keys, settings.tv_text_key_pause_ms) == (True, 15)
    monkeypatch.setenv("UNIOVER_TV_TEXT_KEY_PAUSE_MS", "-1")
    with pytest.raises(ValueError, match="tv_text_key_pause_ms"):
        Settings()


def test_adb_settings_have_defaults_and_read_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("UNIOVER_ADB_PATH")
    settings = Settings()
    assert (settings.adb_path, settings.tv_adb_port, settings.adb_timeout_seconds) == (
        None,
        5555,
        5.0,
    )
    monkeypatch.setenv("UNIOVER_ADB_PATH", "C:/ferramentas/adb.exe")
    monkeypatch.setenv("UNIOVER_TV_ADB_PORT", "5556")
    monkeypatch.setenv("UNIOVER_ADB_TIMEOUT_SECONDS", "8")
    settings = Settings()
    assert settings.adb_path == "C:/ferramentas/adb.exe"
    assert (settings.tv_adb_port, settings.adb_timeout_seconds) == (5556, 8.0)
    monkeypatch.setenv("UNIOVER_TV_ADB_PORT", "70000")
    with pytest.raises(ValueError, match="tv_adb_port"):
        Settings()


def test_config_file_is_read_and_env_wins(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    save_agent_config(isolated_env, api_url="https://do-arquivo.test", agent_id="pc-arquivo")
    settings = Settings()
    assert (settings.api_url, settings.agent_id) == ("https://do-arquivo.test", "pc-arquivo")
    monkeypatch.setenv("UNIOVER_AGENT_ID", "pc-env")
    assert Settings().agent_id == "pc-env"


def test_save_agent_config_keeps_other_keys(isolated_env: Path) -> None:
    isolated_env.write_text('log_level = "DEBUG"\n', encoding="utf-8")
    save_agent_config(isolated_env, api_url="https://a.test", agent_id="pc-1")
    data = tomllib.loads(isolated_env.read_text(encoding="utf-8"))
    assert data == {"log_level": "DEBUG", "api_url": "https://a.test", "agent_id": "pc-1"}


def test_api_url_must_be_https_unless_insecure_is_allowed() -> None:
    assert require_api_url(Settings(api_url="https://api.test/")) == "https://api.test"
    with pytest.raises(ConfigError, match="https"):
        require_api_url(Settings(api_url="http://api.test"))
    with pytest.raises(ConfigError, match="UNIOVER_API_URL"):
        require_api_url(Settings())
    with pytest.raises(ConfigError):
        require_api_url(Settings(api_url="ftp://x"))
    assert require_api_url(Settings(api_url="http://127.0.0.1:5000", allow_insecure=True))


def test_status_without_pairing_says_not_paired_and_exits_zero(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["status"], secrets=FakeSecretStore()) == 0
    assert "não pareado" in capsys.readouterr().out


def test_status_with_agent_but_no_token_says_not_paired(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("UNIOVER_AGENT_ID", AGENT_ID)
    assert main(["status"], secrets=FakeSecretStore()) == 0
    assert "não pareado" in capsys.readouterr().out


def test_status_with_token_never_prints_it(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("UNIOVER_AGENT_ID", AGENT_ID)
    monkeypatch.setenv("UNIOVER_API_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("UNIOVER_ALLOW_INSECURE", "1")
    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    assert main(["status"], secrets=store) == 0
    out = capsys.readouterr().out
    assert "Pareado como 'pc-casa'" in out
    assert "sem resposta" in out
    assert TOKEN not in out


def test_run_without_pairing_exits_with_not_paired(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["run"], secrets=FakeSecretStore()) == EXIT_NOT_PAIRED
    assert "uniover-agent pair" in capsys.readouterr().err


def test_default_command_is_run(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([], secrets=FakeSecretStore()) == EXIT_NOT_PAIRED
    assert "não pareado" in capsys.readouterr().err


def test_missing_api_url_is_a_clear_error(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["pair"], secrets=FakeSecretStore()) == 1
    assert "UNIOVER_API_URL" in capsys.readouterr().err


def test_pairing_info_fits_what_the_api_accepts() -> None:
    info = pairing_info("Meu PC: sala/TV *1*")
    assert info.agent_name == "Meu PC- sala-TV -1"
    assert len(info.platform) <= 30
    assert pairing_info("???").agent_name == "agente"


class FakePairingApi:
    """API de pareamento falsa em HTTP local; roteiro: pending, slow_down e approved."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append((self.path, body))
                polls = [r for r in outer.requests if r[0].endswith("/poll")]
                if self.path.endswith("/start"):
                    payload: dict[str, Any] = {
                        "pairingId": "0192f1e4-0000-7000-8000-0000000000aa",
                        "deviceCode": "CODIGO-DO-APARELHO-SECRETO",
                        "userCode": "ABCD-2345",
                        "expiresIn": 600,
                        "interval": 1,
                    }
                elif len(polls) == 1:
                    payload = {"status": "pending"}
                elif len(polls) == 2:
                    payload = {"status": "slow_down", "interval": 2}
                else:
                    payload = {"status": "approved", "agentId": "pc-da-sala", "deviceToken": TOKEN}
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> FakePairingApi:
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def pairing_api() -> Iterator[FakePairingApi]:
    with FakePairingApi() as api:
        yield api


def test_pair_stores_token_in_vault_and_agent_id_in_config(
    monkeypatch: pytest.MonkeyPatch,
    pairing_api: FakePairingApi,
    isolated_env: Path,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("UNIOVER_API_URL", pairing_api.url)
    monkeypatch.setenv("UNIOVER_ALLOW_INSECURE", "1")
    monkeypatch.setattr(main_module, "SystemClock", FakeClock)  # sem esperar o intervalo real
    store = FakeSecretStore()
    with caplog.at_level(logging.DEBUG):
        assert main(["pair", "--name", "PC da sala"], secrets=store) == 0
    captured = capsys.readouterr()

    assert "ABCD-2345" in captured.out
    assert store.get("pc-da-sala") == TOKEN
    config = tomllib.loads(isolated_env.read_text(encoding="utf-8"))
    assert config["agent_id"] == "pc-da-sala"
    assert TOKEN not in isolated_env.read_text(encoding="utf-8")
    # Nada de segredo na saída, no registro nem no arquivo.
    for secret in (TOKEN, "CODIGO-DO-APARELHO-SECRETO"):
        assert secret not in captured.out
        assert secret not in captured.err
        assert secret not in caplog.text
    start = pairing_api.requests[0]
    assert start[0].endswith("/pairing/start")
    assert start[1]["agentName"] == "PC da sala"
    assert pairing_api.requests[1][1]["deviceCode"] == "CODIGO-DO-APARELHO-SECRETO"


async def test_run_connects_with_vault_token_and_stops_on_revocation(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    async def script(connection: ServerConnection) -> None:
        await connection.send(dump(tv_key("HOME", id="0192f1e4-0000-7000-8000-0000000000bb")))
        await connection.send("{quebrado")
        await asyncio.sleep(0.2)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    silence_noisy_loggers()
    async with FakeApi(script) as api:
        settings = Settings(api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True)
        with caplog.at_level(logging.DEBUG):
            exit_code = await run(settings, lambda: store)

    assert exit_code == EXIT_CREDENTIAL_REJECTED
    assert api.authorizations == [f"Bearer {TOKEN}"]
    assert api.paths == [f"/api/v1/devices/agents/{AGENT_ID}/ws"]
    hello, result = api.received
    assert hello["type"] == "agent.hello.v1"
    assert hello["body"]["capabilities"] == ["transport.keepalive.v1"]
    # Sem aparelhos habilitados, o comando válido é recusado pelo núcleo e informado à API.
    assert result["type"] == "command.result.v1"
    assert result["correlationId"] == "0192f1e4-0000-7000-8000-0000000000bb"
    assert result["body"]["error"]["code"] == "rejected"
    # O token continua no cofre (não se apaga sozinho) e não aparece em lugar nenhum.
    assert store.get(AGENT_ID) == TOKEN
    assert TOKEN not in caplog.text
    assert TOKEN not in capsys.readouterr().out
    assert "token revogado ou inválido" in caplog.text


def test_configure_logging_caps_libraries_that_log_headers() -> None:
    configure_logging("DEBUG")
    for name in ("websockets", "httpx", "httpcore", "androidtvremote2", "samsungtvws"):
        assert logging.getLogger(name).getEffectiveLevel() == logging.WARNING
