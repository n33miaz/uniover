import logging

import pytest

from uniover_agent.config import Settings
from uniover_agent.main import main


def test_config_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UNIOVER_API_URL", "https://api.exemplo.test")
    monkeypatch.setenv("UNIOVER_AGENT_ID", "pc-sala")
    monkeypatch.setenv("UNIOVER_LOG_LEVEL", "DEBUG")
    settings = Settings()
    assert settings.api_url == "https://api.exemplo.test"
    assert settings.agent_id == "pc-sala"
    assert settings.log_level == "DEBUG"


def test_main_runs_without_network(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="uniover_agent"):
        main()
    assert "pronto" in caplog.text
