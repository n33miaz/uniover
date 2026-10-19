"""Isolamento: nenhum teste toca na configuração nem no certificado reais do usuário."""

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    for name in (
        "API_URL",
        "AGENT_ID",
        "LOG_LEVEL",
        "ALLOW_INSECURE",
        "TV_HOST",
        "TV_CLIENT_NAME",
        "TV_NAME",
        "TV_HIBERNATE_SECONDS",
    ):
        monkeypatch.delenv(f"UNIOVER_{name}", raising=False)
    # A pasta do certificado da TV vive em `%LOCALAPPDATA%`: nenhum teste toca na real.
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "localappdata"))
    config = tmp_path / "agent.toml"
    monkeypatch.setenv("UNIOVER_CONFIG_FILE", str(config))
    return config
