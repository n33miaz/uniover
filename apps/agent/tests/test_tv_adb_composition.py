"""Composição do canal ADB: uma linha no marcador, capacidade, lista depois do `hello`, digitação.

O adaptador é o dublê (`FakeTvAdb`); a API é o servidor WebSocket falso de loopback.
"""

import asyncio
import logging
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent import main as main_module
from uniover_agent.adapters.fakes import FakeSecretStore, FakeTvAdb, FakeTvRemote
from uniover_agent.config import Settings
from uniover_agent.core import tv_text_handler
from uniover_agent.main import EXIT_CREDENTIAL_REJECTED, run
from uniover_agent.ports import AdbUnauthorized, AdbUnreachable, LaunchableApp

from .support import AGENT_ID, ANDROID_KEYS, TOKEN, FakeApi, dump, envelope
from .test_tv_composition import TV_HOST, make_tv, pair_fake_tv


def enable_adb(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, adb: FakeTvAdb
) -> list[tuple[Any, ...]]:
    """Aponta para um `adb` que existe (um arquivo qualquer) e troca o adaptador pelo dublê."""
    fake_exe = tmp_path / "platform-tools" / "adb.exe"
    fake_exe.parent.mkdir(parents=True)
    fake_exe.write_text("x")
    monkeypatch.setenv("UNIOVER_ADB_PATH", str(fake_exe))
    built: list[tuple[Any, ...]] = []

    def fake_adapter(*args: Any, **kwargs: Any) -> FakeTvAdb:
        built.append((*args, kwargs["timeout"]))
        return adb

    monkeypatch.setattr(main_module, "AdbTv", fake_adapter)
    return built


def adb_apps() -> list[LaunchableApp]:
    return [
        LaunchableApp("com.cnvs.apptv", ".ui.LoginActivity", user_installed=True),
        LaunchableApp("com.android.vending", "com.google.android.finsky.TvMainActivity"),
        LaunchableApp("com.tcl.suspension", ".ui.main.MainActivity"),
    ]


def test_adb_is_wired_with_one_line_and_the_text_handler_is_not_replaced(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    built = enable_adb(monkeypatch, tmp_path, FakeTvAdb())
    created: list[Any] = []
    original = tv_text_handler

    def spy(*args: Any, **kwargs: Any) -> Any:
        created.append(original(*args, **kwargs))
        return created[-1]

    monkeypatch.setattr(main_module, "tv_text_handler", spy)
    setup = make_tv(
        Settings(tv_host=TV_HOST, tv_adb_port=5556, adb_timeout_seconds=7.5, tv_watchdog=False)
    )
    assert setup is not None
    assert built == [(tmp_path / "platform-tools" / "adb.exe", TV_HOST, 5556, 7.5)]
    # Um único handler de texto: o ADB se pluga na digitação, não registra outro por cima.
    assert len(created) == 1
    assert setup.handlers["tv.text.v1"] is created[0]
    assert setup.text is not None
    assert {"tv.apps.refresh.v1", "tv.app.launch.v1"} <= set(setup.handlers)
    assert len(setup.prepare) == 1
    assert len(setup.after_hello) == 1
    # O anunciante da lista e o temporizador da limpeza automática.
    assert len(setup.background) == 2
    # A capacidade só vem depois do teste de conexão (passo de preparação).
    assert setup.capabilities == ["tv.remote", "tv.kind.android", *ANDROID_KEYS]


def test_without_the_adb_nothing_of_it_is_registered(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    with caplog.at_level(logging.WARNING):
        setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    assert "tv.apps.refresh.v1" not in setup.handlers
    assert setup.prepare == []
    assert "adb não encontrado" in caplog.text


async def test_capability_is_declared_when_the_adb_answers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    adb = FakeTvAdb()
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, adb)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    for step in setup.prepare:
        await step()
    assert setup.capabilities == [
        "tv.remote",
        "tv.kind.android",
        *ANDROID_KEYS,
        "tv.adb",
        "tv.cleanup.automatic.v1",
    ]
    assert adb.connects == 1


async def test_capability_is_still_declared_when_the_tv_is_off_right_now(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    adb = FakeTvAdb()
    adb.errors = [AdbUnreachable("a TV não respondeu pelo ADB")]
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, adb)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    for step in setup.prepare:
        await step()
    assert setup.capabilities == [
        "tv.remote",
        "tv.kind.android",
        *ANDROID_KEYS,
        "tv.adb",
        "tv.cleanup.automatic.v1",
    ]


async def test_capability_is_not_declared_when_the_tv_did_not_authorize_this_pc(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    adb = FakeTvAdb()
    adb.errors = [AdbUnauthorized("a TV ainda não autorizou este PC no ADB")]
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, adb)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    with caplog.at_level(logging.WARNING):
        for step in setup.prepare:
            await step()
    assert setup.capabilities == ["tv.remote", "tv.kind.android", *ANDROID_KEYS]
    assert "não autorizou" in caplog.text
    # Os comandos continuam registrados: respondem `adb_unauthorized` em vez de "desconhecido".
    assert "tv.apps.refresh.v1" in setup.handlers


async def test_run_serves_apps_launch_and_typing_through_the_adb(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    remote = FakeTvRemote()
    adb = FakeTvAdb(adb_apps())
    pair_fake_tv(monkeypatch, remote)
    enable_adb(monkeypatch, tmp_path, adb)
    ids = {
        "wake": "0192f1e4-0000-7000-8000-0000000000c1",
        "refresh": "0192f1e4-0000-7000-8000-0000000000c2",
        "launch": "0192f1e4-0000-7000-8000-0000000000c3",
        "text": "0192f1e4-0000-7000-8000-0000000000c4",
        "text2": "0192f1e4-0000-7000-8000-0000000000c5",
        "text3": "0192f1e4-0000-7000-8000-0000000000c6",
    }

    async def script(connection: ServerConnection) -> None:
        await connection.send(dump(envelope("tv.wake.v1", {}, id=ids["wake"])))
        await asyncio.sleep(0.3)
        await connection.send(dump(envelope("tv.apps.refresh.v1", {}, id=ids["refresh"])))
        target = {"target": {"kind": "package", "value": "com.cnvs.apptv"}}
        await connection.send(dump(envelope("tv.app.launch.v1", target, id=ids["launch"])))
        await connection.send(dump(envelope("tv.text.v1", {"text": "ab"}, id=ids["text"])))
        await connection.send(dump(envelope("tv.text.v1", {"text": "abç"}, id=ids["text2"])))
        await connection.send(dump(envelope("tv.text.v1", {"text": "a"}, id=ids["text3"])))
        await asyncio.sleep(0.4)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True, tv_host=TV_HOST
        )
        assert await run(settings, lambda: store) == EXIT_CREDENTIAL_REJECTED

    assert api.received[0]["body"]["capabilities"] == [
        "transport.keepalive.v1",
        "agent.logs.v1",
        "agent.maintenance.v1",
        "tv.remote",
        "tv.kind.android",
        *ANDROID_KEYS,
        "tv.adb",
        "tv.cleanup.automatic.v1",
    ]
    lists = [m for m in api.received if m["type"] == "tv.apps.v1"]
    # Uma lista por iniciativa do agente (sessão quente depois do `hello`) e a do pedido.
    assert [m["correlationId"] for m in lists] == [None, ids["refresh"]]
    expected = [
        {"package": "com.cnvs.apptv", "label": "CineVS"},
        {"package": "com.android.vending", "label": "Play Store"},
    ]
    assert all(m["body"]["apps"] == expected for m in lists)
    results = {
        m["correlationId"]: m["body"] for m in api.received if m["type"] == "command.result.v1"
    }
    assert all(results[ids[name]] == {"ok": True} for name in ids)
    assert adb.launched == [("com.cnvs.apptv", None)]
    # "ab" pelo ADB; o "ç" não é ASCII e vai pelo controle remoto; "a" apaga os dois (DEL x2).
    assert adb.typed == ["ab"]
    assert remote.texts == ["ç"]
    assert remote.keys.count("DEL") == 2
    # Ao encerrar, a sessão fecha o canal ADB junto.
    assert not adb.connected
    assert adb.disconnects >= 1
