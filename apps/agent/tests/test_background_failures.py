"""Tarefas de fundo da TV que falhavam em silêncio: agora seguem vivas e dizem a causa."""

import asyncio
import logging

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.adapters.tv_samsung import SamsungTvDriver
from uniover_agent.core.tv.light_settings import TvLightSettings
from uniover_agent.core.tv.session import SessionState, TvSessionManager
from uniover_agent.ports import TvUnreachable


async def test_the_watch_loop_survives_a_failure_and_still_hibernates_the_session(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    clock = FakeClock()
    manager = TvSessionManager(clock, FakeTvRemote(), hibernate_seconds=60)
    await manager.wake()
    real = manager.hibernate_if_idle
    failures = {"left": 1}

    async def flaky() -> bool:
        if failures["left"]:
            failures["left"] -= 1
            raise RuntimeError("falha inesperada")
        return await real()

    monkeypatch.setattr(manager, "hibernate_if_idle", flaky)

    with caplog.at_level(logging.ERROR):
        watcher = asyncio.create_task(manager.watch())
        for _ in range(300):
            await asyncio.sleep(0)
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)

    # A primeira rodada falhou e foi registrada com a pilha; a seguinte hibernou a sessão.
    assert any("hibernação" in record.getMessage() for record in caplog.records)
    assert manager.snapshot().connection == "hibernating"
    assert manager._state is SessionState.HIBERNATING


async def test_an_unexpected_failure_reading_the_foreground_app_ends_the_truce_and_is_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Broken:
        async def playing_media_packages(self) -> frozenset[str]:
            raise ValueError("resposta que ninguém previu")

    holds: list[bool] = []
    settings = TvLightSettings(Broken(), FakeClock(), holds.append, lambda: "com.netflix.ninja")  # type: ignore[arg-type]
    settings._focus_enabled = True
    settings._set_focus(True)

    with caplog.at_level(logging.ERROR):
        await settings._check_focus()

    assert holds == [True, False]
    assert any("app em foco" in record.getMessage() for record in caplog.records)


async def test_a_samsung_tv_that_refuses_the_token_leaves_the_reason_in_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Refusing:
        token = "antigo"

        def open(self) -> object:
            raise ConnectionError("unauthorized: token recusado")

        def close(self) -> None:
            return None

    driver = SamsungTvDriver(
        "192.168.0.11",
        "antigo",
        "UniOver",
        factory=lambda host, token, name: Refusing(),  # type: ignore[arg-type,return-value]
    )

    with caplog.at_level(logging.WARNING), pytest.raises(TvUnreachable):
        await driver.connect()

    text = " ".join(record.getMessage() for record in caplog.records)
    assert "ConnectionError" in text
    assert "recusou o token" in text
    # O endereço da TV não entra no registro nem na ocorrência.
    assert "192.168.0.11" not in text
