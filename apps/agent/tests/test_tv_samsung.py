"""Samsung Tizen: tradução do protocolo, composição e os limites declarados ao app."""

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from uniover_agent import main as main_module
from uniover_agent.adapters import tv_samsung_pairing as samsung_pairing
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTransport
from uniover_agent.adapters.tv_samsung import SAMSUNG_KEYS, SamsungClient, SamsungTvDriver
from uniover_agent.adapters.tv_samsung_pairing import pair_samsung_tv
from uniover_agent.config import Settings
from uniover_agent.core import (
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    ResultStatus,
    TvSessionManager,
)
from uniover_agent.core.tv.handlers import unsupported_handler
from uniover_agent.core.tv.samsung_apps import SamsungTvApps
from uniover_agent.core.tv.session import POWER_REPEAT_SECONDS
from uniover_agent.main import build_tv, samsung_token_name, tv_pair
from uniover_agent.ports import TvUnreachable

from .support import AGENT_ID


class FakeSamsungClient:
    """Cliente síncrono da biblioteca, sem rede e com o token que a TV devolve no aceite."""

    def __init__(self, token: str | None = None) -> None:
        self.token: str | None = token or "token-novo"
        self.opens = 0
        self.closes = 0
        self.keys: list[tuple[str, str]] = []
        self.apps: list[dict[str, Any]] | None = [
            {"appId": "111299001912", "name": "Vídeo"},
            {"appId": "org.tizen.browser", "name": "Internet"},
        ]
        self.runs: list[tuple[str, str, str]] = []

    def open(self) -> object:
        self.opens += 1
        return object()

    def close(self) -> None:
        self.closes += 1

    def send_key(
        self,
        key: str,
        times: int = 1,
        key_press_delay: float | None = None,
        cmd: str = "Click",
    ) -> None:
        del times, key_press_delay
        self.keys.append((key, cmd))

    def app_list(self) -> list[dict[str, Any]] | None:
        return self.apps

    def run_app(self, app_id: str, app_type: str = "DEEP_LINK", meta_tag: str = "") -> None:
        self.runs.append((app_id, app_type, meta_tag))


def factory(client: FakeSamsungClient) -> Callable[[str, str | None, str], SamsungClient]:
    def build(host: str, token: str | None, name: str) -> SamsungClient:
        del host, token, name
        return client

    return build


async def power_on(host: str) -> bool | None:
    del host
    return True


async def power_off(host: str) -> bool | None:
    del host
    return False


def manager_for(client: FakeSamsungClient) -> tuple[FakeClock, SamsungTvDriver, TvSessionManager]:
    clock = FakeClock()
    driver = SamsungTvDriver(
        "192.168.0.11", "token-anterior", "UniOver", factory=factory(client), fetch_power=power_on
    )
    return clock, driver, TvSessionManager(clock, driver, hibernate_seconds=10)


async def test_key_map_keeps_the_contract_names_out_of_the_samsung_socket() -> None:
    client = FakeSamsungClient()
    _, _, manager = manager_for(client)
    keys = ("UP", "OK", "BACK", "HOME", "VOLUME_UP", "NUM_7", "INPUT", "POWER")
    for key in keys:
        await manager.send_key(key)
    assert client.keys == [(SAMSUNG_KEYS[key], "Click") for key in keys]
    assert {"PLAY_PAUSE", "MEDIA_NEXT", "MEDIA_PREVIOUS"} <= SAMSUNG_KEYS.keys()


async def test_samsung_session_hibernates_and_opens_again_on_the_next_command() -> None:
    client = FakeSamsungClient()
    clock, _, manager = manager_for(client)
    await manager.send_key("HOME")
    clock.advance(10)
    assert await manager.hibernate_if_idle() is True
    await manager.send_key("BACK")
    assert (client.opens, client.closes, client.keys) == (
        2,
        1,
        [("KEY_HOME", "Click"), ("KEY_RETURN", "Click")],
    )


async def test_rest_power_state_is_published_and_power_is_not_sent_twice() -> None:
    client = FakeSamsungClient()
    clock, driver, manager = manager_for(client)
    saved: list[str] = []
    driver._save_token = saved.append
    await manager.send_key("POWER")
    await manager.send_key("POWER")
    assert manager.snapshot().power == "on"
    assert client.keys == [("KEY_POWER", "Click")]
    assert saved == ["token-novo"]
    clock.advance(POWER_REPEAT_SECONDS)
    await manager.send_key("POWER")
    assert client.keys == [("KEY_POWER", "Click"), ("KEY_POWER", "Click")]


async def test_standby_reported_by_rest_becomes_power_off() -> None:
    client = FakeSamsungClient()
    clock = FakeClock()
    driver = SamsungTvDriver(
        "192.168.0.11", "token-anterior", "UniOver", factory=factory(client), fetch_power=power_off
    )
    manager = TvSessionManager(clock, driver)
    await manager.wake()
    assert manager.snapshot().power == "off"


async def test_samsung_apps_use_a_valid_alias_but_launch_the_original_app_id() -> None:
    client = FakeSamsungClient()

    def respond(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path.endswith("/111299001912"):
            return httpx.Response(200, json={"id": "111299001912", "name": "Vídeo"})
        return httpx.Response(404)

    transport = httpx.MockTransport(respond)
    driver = SamsungTvDriver(
        "192.168.0.11",
        "token-anterior",
        "UniOver",
        factory=factory(client),
        fetch_power=power_on,
        rest_transport=transport,
    )
    manager = TvSessionManager(FakeClock(), driver, hibernate_seconds=10)
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    apps = SamsungTvApps(manager, driver, FakeTransport(), envelopes)
    entries = await apps.refresh()
    assert [entry.package for entry in entries] == ["samsung.app.id111299001912"]
    await apps.launch_package(entries[0].package)
    assert client.runs == [("111299001912", "NATIVE_LAUNCH", "")]


async def test_samsung_catalog_probes_only_installed_apps_and_extra_ids() -> None:
    async def respond(request: httpx.Request) -> httpx.Response:
        app_id = request.url.path.rsplit("/", maxsplit=1)[-1]
        if app_id == "111299001912":
            return httpx.Response(200, json={"id": app_id, "name": "YouTube"})
        if app_id == "meu.app":
            return httpx.Response(200, json={"id": app_id, "name": "Meu app"})
        if app_id == "lento.app":
            await asyncio.sleep(0.1)
        return httpx.Response(404)

    driver = SamsungTvDriver(
        "192.168.0.11",
        None,
        "UniOver",
        app_ids=("meu.app", "lento.app"),
        rest_transport=httpx.MockTransport(respond),
        app_timeout_seconds=0.01,
        app_list_timeout_seconds=0.2,
    )
    assert await driver.app_list() == [
        {"appId": "111299001912", "name": "YouTube"},
        {"appId": "meu.app", "name": "Meu app"},
    ]


async def test_samsung_app_launch_uses_rest_before_the_websocket_and_falls_back() -> None:
    client = FakeSamsungClient()

    def respond(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/111299001912"):
            return httpx.Response(200)
        return httpx.Response(500)

    driver = SamsungTvDriver(
        "192.168.0.11",
        "token-anterior",
        "UniOver",
        factory=factory(client),
        fetch_power=power_on,
        rest_transport=httpx.MockTransport(respond),
    )
    await driver.run_app("111299001912")
    assert client.runs == []
    await driver.connect()
    await driver.run_app("sem-rest")
    assert client.runs == [("sem-rest", "NATIVE_LAUNCH", "")]


async def test_samsung_websocket_timeout_does_not_block_the_event_loop() -> None:
    class SlowSamsungClient(FakeSamsungClient):
        def send_key(
            self,
            key: str,
            times: int = 1,
            key_press_delay: float | None = None,
            cmd: str = "Click",
        ) -> None:
            del key, times, key_press_delay, cmd
            time.sleep(0.1)

    client = SlowSamsungClient()
    driver = SamsungTvDriver(
        "192.168.0.11",
        "token-anterior",
        "UniOver",
        factory=factory(client),
        fetch_power=power_on,
        ws_timeout_seconds=0.01,
    )
    await driver.connect()
    started = time.monotonic()
    with pytest.raises(TvUnreachable, match="canal da TV Samsung"):
        await driver.send_key("HOME")
    assert time.monotonic() - started < 0.08
    await asyncio.sleep(0.11)


async def test_text_and_cleanup_are_explicitly_unsupported() -> None:
    text = unsupported_handler("a TV Samsung não suporta digitação por este canal")
    cleanup = unsupported_handler("a TV Samsung não suporta limpeza por ADB")
    text_result = await text(Command("t", "tv.text.v1", {"text": "oi"}))
    cleanup_result = await cleanup(Command("c", "tv.cleanup.v1", {"requestId": "x"}))
    assert (text_result.status, text_result.code) == (ResultStatus.REJECTED, "unsupported")
    assert (cleanup_result.status, cleanup_result.code) == (ResultStatus.REJECTED, "unsupported")


def test_samsung_configuration_selects_its_capabilities_without_adb(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    client = FakeSamsungClient()
    remote = SamsungTvDriver(
        "192.168.0.11", "token-secreto", "UniOver", factory=factory(client), fetch_power=power_on
    )
    monkeypatch.setattr(main_module, "SamsungTvDriver", lambda *_args, **_kwargs: remote)
    secrets = FakeSecretStore()
    secrets.set(samsung_token_name("sala"), "token-secreto")
    settings = Settings(tv_kind="samsung", tv_host="192.168.0.11", tv_name="sala")
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    setup = build_tv(
        settings,
        clock,
        FakeTransport(),
        envelopes,
        secrets,
    )
    assert setup is not None
    assert setup.capabilities == ["tv.remote", "tv.kind.samsung"]
    assert envelopes.hello("0.1.0", tuple(setup.capabilities))["body"]["capabilities"] == [
        "tv.remote",
        "tv.kind.samsung",
    ]
    assert "tv.cleanup.v1" in setup.handlers
    assert setup.text is None
    assert "token-secreto" not in caplog.text


def test_tv_kind_reads_the_environment_and_defaults_to_android(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert Settings().tv_kind == "android"
    monkeypatch.setenv("UNIOVER_TV_KIND", "samsung")
    assert Settings().tv_kind == "samsung"
    monkeypatch.setenv("UNIOVER_TV_SAMSUNG_APPS", "meu.app, 123456")
    assert Settings().tv_samsung_apps == ["meu.app", "123456"]


async def test_samsung_link_launch_is_explicitly_unsupported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = FakeSamsungClient()
    remote = SamsungTvDriver(
        "192.168.0.11", "token-secreto", "UniOver", factory=factory(client), fetch_power=power_on
    )
    monkeypatch.setattr(main_module, "SamsungTvDriver", lambda *_args, **_kwargs: remote)
    secrets = FakeSecretStore()
    secrets.set(samsung_token_name("sala"), "token-secreto")
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    setup = build_tv(
        Settings(tv_kind="samsung", tv_host="192.168.0.11", tv_name="sala"),
        clock,
        FakeTransport(),
        envelopes,
        secrets,
    )
    assert setup is not None
    result = await setup.handlers["tv.app.launch.v1"](
        Command("link", "tv.app.launch.v1", {"target": {"kind": "link", "value": "https://a.test"}})
    )
    assert (result.status, result.code) == (ResultStatus.REJECTED, "unsupported")


async def test_samsung_pair_saves_only_the_token_in_the_credential_store(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def pair(host: str, name: str) -> str:
        assert (host, name) == ("192.168.0.11", "UniOver")
        return "token-secreto"

    monkeypatch.setattr(main_module, "pair_samsung_tv", pair)
    store = FakeSecretStore()
    with caplog.at_level(logging.DEBUG):
        assert await tv_pair(Settings(), "192.168.0.11", "sala", "samsung", store) == 0
    captured = capsys.readouterr()
    assert store.get("samsung:sala") == "token-secreto"
    assert "token-secreto" not in captured.out
    assert "token-secreto" not in captured.err
    assert "token-secreto" not in caplog.text


async def test_samsung_pair_does_not_wait_for_a_slow_close(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    class SlowCloseClient(FakeSamsungClient):
        def close(self) -> None:
            time.sleep(0.1)
            super().close()

    client = SlowCloseClient()
    monkeypatch.setattr(samsung_pairing, "SAMSUNG_CLOSE_TIMEOUT_SECONDS", 0.01)
    started = time.monotonic()
    with caplog.at_level(logging.WARNING):
        result = await pair_samsung_tv("192.168.0.11", "UniOver", factory=factory(client))
    assert result == "token-novo"
    assert time.monotonic() - started < 0.08
    assert "falha ao fechar o canal Samsung depois do pareamento" in caplog.text
    assert "token-novo" not in caplog.text
    await asyncio.sleep(0.11)
    assert client.closes == 1
