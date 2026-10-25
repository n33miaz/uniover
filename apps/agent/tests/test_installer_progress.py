"""O instalador roda sem console: o andamento vai à página local e o código da TV, a uma janela."""

import asyncio
import subprocess
import sys
from pathlib import Path

import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters import tv_pairing
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore
from uniover_agent.adapters.pairing_page import progress_page_html, write_progress_page
from uniover_agent.adapters.process import NO_WINDOW
from uniover_agent.config import connection_page_path
from uniover_agent.main import main

from .test_config_main import FakePairingApi


def test_the_progress_page_reloads_itself_and_says_what_is_happening() -> None:
    page = progress_page_html("PC conectado. Terminando a instalação…")
    assert '<meta http-equiv="refresh" content="3">' in page
    assert "Terminando a instalação" in page
    assert "<script" not in page


def test_the_progress_page_is_written_whole(tmp_path: Path) -> None:
    page = tmp_path / "web" / "conectar.html"
    write_progress_page(page, "Procurando a TV…")
    assert page.read_text(encoding="utf-8") == progress_page_html("Procurando a TV…")
    assert [item.name for item in page.parent.iterdir()] == ["conectar.html"]


def test_pair_installing_keeps_the_page_in_progress_for_the_installer_to_finish(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    with FakePairingApi() as api:
        monkeypatch.setenv("UNIOVER_API_URL", api.url)
        monkeypatch.setenv("UNIOVER_ALLOW_INSECURE", "1")
        monkeypatch.setattr(main_module, "SystemClock", FakeClock)
        code = main(["pair", "--no-browser", "--installing"], secrets=FakeSecretStore())
    assert code == 0
    page = connection_page_path().read_text(encoding="utf-8")
    assert "Terminando a instalação" in page
    assert 'http-equiv="refresh"' in page
    assert "Pode fechar esta janela" not in page


def test_the_tv_code_is_asked_in_a_window_without_a_console(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        seen["command"] = command
        seen["flags"] = kwargs["creationflags"]
        return subprocess.CompletedProcess(command, 0, stdout="A1B2C3\r\n", stderr="")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "run", fake_run)

    assert asyncio.run(tv_pairing.ask_code_in_window()) == "A1B2C3"
    assert seen["flags"] == NO_WINDOW
    command = seen["command"]
    assert isinstance(command, list)
    assert "InputBox" in command[-1]
    assert "-WindowStyle" not in command  # sem console nao ha o que esconder
