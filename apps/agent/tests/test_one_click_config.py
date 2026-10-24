"""Configuração gravada pelo agente, arquivo de registro e `--if-needed` do instalador."""

import logging
import tomllib
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters.fakes import FakeSecretStore
from uniover_agent.adapters.local_config import update_config
from uniover_agent.config import Settings, agent_source_dir, tv_cert_dir
from uniover_agent.main import configure_logging, tv_pair

from .support_tv import write_certificate


def test_update_config_keeps_lists_numbers_and_booleans(isolated_env: Path) -> None:
    isolated_env.write_text(
        'api_url = "https://a.test"\n'
        'tv_cleanup_keep = ["com.x.y", "com.z"]\n'
        "tv_hibernate_seconds = 120\n"
        "allow_insecure = true\n"
        'tv_id_hint = "velho"\n',
        encoding="utf-8",
    )
    update_config(isolated_env, {"tv_host": "192.168.0.7", "tv_id_hint": None})
    assert tomllib.loads(isolated_env.read_text(encoding="utf-8")) == {
        "api_url": "https://a.test",
        "tv_cleanup_keep": ["com.x.y", "com.z"],
        "tv_hibernate_seconds": 120,
        "allow_insecure": True,
        "tv_host": "192.168.0.7",
    }
    # O arquivo temporário da troca atômica não sobra e o resultado é lido pelo Settings.
    assert not isolated_env.with_name(isolated_env.name + ".tmp").exists()
    settings = Settings()
    assert (settings.tv_host, settings.tv_cleanup_keep) == ("192.168.0.7", ["com.x.y", "com.z"])


def test_tv_id_hint_and_log_file_are_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UNIOVER_TV_ID_HINT", "abc")
    monkeypatch.setenv("UNIOVER_LOG_FILE", "C:/x/agent.log")
    settings = Settings()
    assert (settings.tv_id_hint, settings.log_file) == ("abc", "C:/x/agent.log")


def test_agent_source_dir_is_under_localappdata(tmp_path: Path) -> None:
    assert agent_source_dir() == tmp_path / "localappdata" / "UniOver" / "agent-src"


def test_log_file_gets_the_records_with_rotation(tmp_path: Path) -> None:
    target = tmp_path / "pasta" / "agent.log"
    configure_logging("INFO", str(target))
    try:
        logging.getLogger("uniover_agent").info("registro de teste")
        handlers = [h for h in logging.getLogger().handlers if isinstance(h, RotatingFileHandler)]
        assert len(handlers) == 1
        assert (handlers[0].maxBytes, handlers[0].backupCount) == (1_000_000, 2)
        for handler in handlers:
            handler.flush()
        assert "registro de teste" in target.read_text(encoding="utf-8")
    finally:
        configure_logging("WARNING")


def test_an_unwritable_log_file_only_warns(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    blocker = tmp_path / "arquivo"
    blocker.write_text("x", encoding="utf-8")
    try:
        configure_logging("INFO", str(blocker / "agent.log"))
        assert "não consegui abrir o arquivo de registro" in capsys.readouterr().err
    finally:
        configure_logging("WARNING")


async def test_tv_pair_if_needed_skips_a_paired_samsung(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def never(host: str, name: str) -> str:
        raise AssertionError("não deveria parear de novo")

    monkeypatch.setattr(main_module, "pair_samsung_tv", never)
    store = FakeSecretStore()
    store.set("samsung:tv", "token")
    code = await tv_pair(
        Settings(tv_kind="samsung", tv_host="192.168.0.11"),
        None,
        None,
        secrets=store,
        if_needed=True,
    )
    assert code == 0
    assert "já está pareada" in capsys.readouterr().out


async def test_tv_pair_if_needed_skips_a_paired_android(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def never(*args: object) -> None:
        raise AssertionError("não deveria parear de novo")

    monkeypatch.setattr(main_module, "pair_tv", never)
    write_certificate(tv_cert_dir("tv"), "UniOver")
    assert await tv_pair(Settings(tv_host="192.168.0.4"), None, None, if_needed=True) == 0
    assert "já está pareada" in capsys.readouterr().out


async def test_tv_pair_does_not_ask_to_configure_what_tv_find_already_saved(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def pair(host: str, name: str) -> str:
        return "token"

    monkeypatch.setattr(main_module, "pair_samsung_tv", pair)
    store = FakeSecretStore()
    settings = Settings(tv_kind="samsung", tv_host="192.168.0.11")
    assert await tv_pair(settings, None, None, secrets=store) == 0
    assert "Agora defina" not in capsys.readouterr().out
    assert store.get("samsung:tv") == "token"
