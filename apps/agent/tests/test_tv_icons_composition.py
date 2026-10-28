"""Composição dos ícones: ligados só quando o `aapt2` existe; sem ele o agente segue como antes."""

import asyncio
import logging
from collections.abc import Sequence
from pathlib import Path

import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters.fakes import FakeTvAdb, FakeTvRemote
from uniover_agent.config import Settings
from uniover_agent.core import AppEntry, AppIconPublisher, Command, ResultStatus
from uniover_agent.core.domain import TvState
from uniover_agent.ports import LaunchableApp

from .test_tv_adb_composition import enable_adb
from .test_tv_composition import TV_HOST, make_tv, pair_fake_tv

REQUEST_ID = "0192f1e4-0000-7000-8000-000000000001"


def enable_aapt(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    tool = tmp_path / "sdk" / "aapt2.exe"
    tool.parent.mkdir(parents=True)
    tool.write_text("x")
    monkeypatch.setenv("UNIOVER_AAPT_PATH", str(tool))
    return tool


def test_without_aapt_there_is_no_icon_task_and_the_reason_is_logged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, FakeTvAdb())
    with caplog.at_level(logging.INFO):
        setup = make_tv(Settings(tv_host=TV_HOST, tv_watchdog=False))
    assert setup is not None
    # o anunciante da lista, o temporizador da limpeza e o laço do modo foco
    assert len(setup.background) == 3
    assert "aapt2 não encontrado" in caplog.text


def test_with_aapt_the_icon_task_is_registered_and_listens_to_the_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, FakeTvAdb())
    enable_aapt(monkeypatch, tmp_path)
    created: list[AppIconPublisher] = []
    original = AppIconPublisher

    def spy(*args: object, **kwargs: object) -> AppIconPublisher:
        publisher = original(*args, **kwargs)  # type: ignore[arg-type]
        created.append(publisher)
        return publisher

    monkeypatch.setattr(main_module, "AppIconPublisher", spy)
    setup = make_tv(
        Settings(tv_host=TV_HOST, icons_dir=str(tmp_path / "meus-icones"), tv_watchdog=False)
    )
    assert setup is not None
    (publisher,) = created
    assert len(setup.background) == 4
    assert publisher.run in setup.background
    # Sessão que volta a ficar quente retoma o que ficou pela metade (e só isso).
    publisher.request([AppEntry("com.cnvs.apptv", "CineVS")])
    publisher.on_state(TvState("on", None, None, "hot"))


async def test_the_apps_list_hands_its_list_to_the_icon_task_after_publishing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    adb = FakeTvAdb([LaunchableApp("com.cnvs.apptv", ".ui.LoginActivity", user_installed=True)])
    enable_adb(monkeypatch, tmp_path, adb)
    enable_aapt(monkeypatch, tmp_path)
    requested: list[list[str]] = []
    original = AppIconPublisher.request

    def record(
        self: AppIconPublisher, apps: Sequence[AppEntry], *, refresh_versions: bool = True
    ) -> None:
        requested.append([entry.package for entry in apps])
        original(self, apps, refresh_versions=refresh_versions)

    monkeypatch.setattr(AppIconPublisher, "request", record)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    handler = setup.handlers["tv.apps.refresh.v1"]
    result = await asyncio.wait_for(handler(Command(REQUEST_ID, "tv.apps.refresh.v1", {})), 5)
    assert result.status is ResultStatus.OK
    assert requested == [["com.cnvs.apptv"]]
