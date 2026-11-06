"""Composição do canal ADB: uma linha no marcador, capacidade, lista depois do `hello`, digitação.

O adaptador é o dublê (`FakeTvAdb`); a API é o servidor WebSocket falso de loopback.
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent.adapters import tv_adb as adb_module
from uniover_agent.adapters.fakes import (
    FakeSecretStore,
    FakeTvAdb,
    FakeTvRemote,
)
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.composition import connection as connection_module
from uniover_agent.composition import tv as tv_module
from uniover_agent.composition.connection import run
from uniover_agent.composition.system import EXIT_CREDENTIAL_REJECTED
from uniover_agent.config import Settings, tv_cert_dir
from uniover_agent.core import Command, ResultStatus, tv_text_handler
from uniover_agent.ports import (
    AdbUnauthorized,
    AdbUnreachable,
    LaunchableApp,
    TvCertificateRefused,
    TvNotPaired,
    TvUnreachable,
    is_user_initiated,
)

from .support import AGENT_ID, ANDROID_KEYS, TOKEN, FakeApi, dump, envelope
from .support_adb import LAUNCHER_QUERY, LEANBACK_QUERY, NO_ACTIVITIES, FakeAdbRunner, ok
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

    monkeypatch.setattr(tv_module, "AdbTv", fake_adapter)
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

    monkeypatch.setattr(tv_module, "tv_text_handler", spy)
    setup = make_tv(
        Settings(tv_host=TV_HOST, tv_adb_port=5556, adb_timeout_seconds=7.5, tv_watchdog=False)
    )
    assert setup is not None
    assert built == [(tmp_path / "platform-tools" / "adb.exe", TV_HOST, 5556, 7.5)]
    # Um único handler de texto: o ADB se pluga na digitação, não registra outro por cima.
    assert len(created) == 1
    assert "tv.text.v1" in setup.handlers  # embrulhado só para marcar o uso da TV
    assert setup.text is not None
    assert {"tv.apps.refresh.v1", "tv.app.launch.v1"} <= set(setup.handlers)
    assert len(setup.prepare) == 2  # o ADB e o TV Livre
    assert len(setup.after_hello) == 1
    # Anunciante da lista, temporizador da limpeza e laço do modo foco.
    assert len(setup.background) == 3
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
        "tv.presence.v1",
        "tv.cleanup.automatic.v1",
        "tv.light-settings.v1",
        "tv.focus-closes-background.v1",
        "tv.focus-catalog.v1",
        "tv.livre.v1",
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
        "tv.presence.v1",
        "tv.cleanup.automatic.v1",
        "tv.light-settings.v1",
        "tv.focus-closes-background.v1",
        "tv.focus-catalog.v1",
        "tv.livre.v1",
    ]


async def test_capability_is_declared_even_when_the_tv_has_not_given_the_permission(
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
    # O app só mostra "Atualizar lista" (o toque que pede a permissão) a quem tem `tv.adb`: sem a
    # capacidade o dono nunca teria como dar o primeiro aceite.
    assert "tv.adb" in setup.capabilities
    assert "Nenhum aviso é aberto sozinho" in caplog.text
    assert "tv.apps.refresh.v1" in setup.handlers


async def test_a_tap_reaches_the_real_adb_marked_but_the_startup_never_connects(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Ponta a ponta com o `AdbTv` de verdade: só o toque em "Atualizar lista" abre conexão."""
    user_home = tmp_path / "usuario"
    (user_home / ".android").mkdir(parents=True)
    (user_home / ".android" / "adbkey").write_bytes(
        b"-----BEGIN PRIVATE KEY-----\nchave-de-teste\n-----END PRIVATE KEY-----\n"
    )
    monkeypatch.setattr(Path, "home", lambda: user_home)
    fake_exe = tmp_path / "platform-tools" / "adb.exe"
    fake_exe.parent.mkdir(parents=True)
    fake_exe.write_text("x")
    monkeypatch.setenv("UNIOVER_ADB_PATH", str(fake_exe))
    serial = f"{TV_HOST}:5555"

    def on_tv(command: str) -> tuple[str, ...]:
        return ("-s", serial, "shell", command)

    runner = FakeAdbRunner(
        {
            ("connect", serial): ok(f"connected to {serial}\r\n"),
            ("-s", serial, "get-state"): ok("device\r\n"),
            ("disconnect", serial): ok(""),
            on_tv(LEANBACK_QUERY): ok(NO_ACTIVITIES),
            on_tv(LAUNCHER_QUERY): ok(NO_ACTIVITIES),
            on_tv("settings put global adb_allowed_connection_time 0"): ok(""),
            on_tv("settings get global adb_allowed_connection_time"): ok("0\r\n"),
            on_tv("getprop ro.serialno"): ok("SN123456\r\n"),
        }
    )

    async def mac(host: str, port: int) -> str | None:
        return "AA:BB:CC:00:11:22"

    monkeypatch.setattr(adb_module, "run_process", runner)
    monkeypatch.setattr(tv_module, "resolve_tv_mac", mac)
    pair_fake_tv(monkeypatch, FakeTvRemote())
    setup = make_tv(Settings(tv_host=TV_HOST, tv_watchdog=False))
    assert setup is not None
    for step in setup.prepare:
        await step()
    assert ("connect", serial) not in runner.calls  # a partida só lê: nenhum aviso na TV
    assert setup.activity is not None and not setup.activity.recent()
    wake = setup.handlers["tv.wake.v1"]
    await wake(Command("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1", "tv.wake.v1", {}))
    assert not setup.activity.recent()  # o `wake` também vem do servidor: não prova ninguém na TV
    handler = setup.handlers["tv.apps.refresh.v1"]
    refresh = Command("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1", "tv.apps.refresh.v1", {})
    # Como o `ProcessMessage` executa um comando: numa tarefa própria (`_execute_detached`). A marca
    # de pedido da pessoa tem de chegar ao `AdbTv` por dentro dela.
    await asyncio.ensure_future(handler(refresh))
    # O transporte vivo da partida é desfeito e o toque abre uma conexão nova: essa é a prova.
    assert runner.calls.count(("connect", serial)) == 1
    # O toque conecta por levar a marca de pedido da pessoa; nem ele nem nenhum comando de tipo
    # (tecla, atalho do iPhone) conta como alguém na tela: só o sinal de presença conta.
    assert not setup.activity.recent()
    await setup.handlers["tv.key.v1"](
        Command("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1", "tv.key.v1", {"key": "OK"})
    )
    assert not setup.activity.recent()
    assert "tv.presence.v1" in setup.silent_commands  # sem resposta: chega a cada 20 s
    await setup.handlers["tv.presence.v1"](
        Command("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1", "tv.presence.v1", {})
    )
    assert setup.activity.recent()
    state = json.loads((tv_cert_dir("tv") / "adb-authorization.json").read_text(encoding="utf-8"))
    assert state["state"] == "verified"
    assert state["mac"] == "AA:BB:CC:00:11:22"


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
    presence_id = "0192f1e4-0000-7000-8000-0000000000c7"

    async def script(connection: ServerConnection) -> None:
        await connection.send(dump(envelope("tv.wake.v1", {}, id=ids["wake"])))
        await connection.send(dump(envelope("tv.presence.v1", {}, id=presence_id)))
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
        "agent.diagnostics.v1",
        "tv.remote",
        "tv.kind.android",
        *ANDROID_KEYS,
        "tv.adb",
        "tv.presence.v1",
        "tv.cleanup.automatic.v1",
        "tv.light-settings.v1",
        "tv.focus-closes-background.v1",
        "tv.focus-catalog.v1",
        "tv.livre.v1",
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
    # O sinal de presença é aceito pelo contrato e executado sem resposta (chega a cada 20 s).
    assert presence_id not in results
    assert not [m for m in api.received if m.get("correlationId") == presence_id]
    assert adb.launched == [("com.cnvs.apptv", None)]
    # "ab" pelo ADB; o "ç" não é ASCII e vai pelo controle remoto; "a" apaga os dois (DEL x2).
    assert adb.typed == ["ab"]
    assert remote.texts == ["ç"]
    assert remote.keys.count("DEL") == 2
    # Ao encerrar, a sessão fecha o canal ADB junto.
    assert not adb.connected
    assert adb.disconnects >= 1


def test_an_adb_tv_cannot_be_built_without_the_permission_gate() -> None:
    with pytest.raises(TypeError):
        AdbTv(Path("adb"), TV_HOST, 5555)  # type: ignore[call-arg]


async def test_the_volume_diagnostic_runs_with_the_gate_and_as_a_users_request(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_exe = tmp_path / "platform-tools" / "adb.exe"
    fake_exe.parent.mkdir(parents=True)
    fake_exe.write_text("x")
    monkeypatch.setenv("UNIOVER_ADB_PATH", str(fake_exe))
    seen: list[Any] = []

    async def fake_check(kind: str, **kwargs: Any) -> int:
        seen.append((kind, kwargs["adb"], is_user_initiated()))
        return 0

    monkeypatch.setattr(tv_module, "check_volume", fake_check)
    assert await tv_module.tv_volume(Settings(tv_host=TV_HOST)) == 0
    kind, adb, marked = seen[0]
    assert kind == "android"
    assert isinstance(adb, AdbTv)  # com a trava: nunca um `AdbTv` solto
    assert marked  # o comando é um pedido de quem o roda


@pytest.mark.parametrize(
    "error",
    [TvNotPaired("sem par"), TvCertificateRefused("recusado"), TvUnreachable("fora")],
)
async def test_a_scheduled_power_off_without_valid_credentials_only_fails_and_reports(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, error: Exception
) -> None:
    """O desligamento agendado pelo servidor nunca pareia nem conecta o ADB: falha e avisa."""
    remote = FakeTvRemote()
    remote.connect_errors = [error] * 40
    adb = FakeTvAdb()
    pair_fake_tv(monkeypatch, remote)
    enable_adb(monkeypatch, tmp_path, adb)

    async def forbidden(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("o desligamento agendado tentou parear a TV")

    monkeypatch.setattr(tv_module, "pair_tv", forbidden)
    setup = make_tv(Settings(tv_host=TV_HOST, tv_watchdog=False))
    assert setup is not None
    result = await setup.handlers["tv.power.off.v1"](
        Command("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1", "tv.power.off.v1", {})
    )
    assert result.status is ResultStatus.FAILED  # falha e responde, sem tecla nenhuma
    assert result.code in {"failed", "offline"}
    assert adb.connects == 0  # nenhum `adb connect` (e, logo, nenhum aviso de depuração)
    assert remote.events == []  # nenhuma tecla de energia


@pytest.mark.parametrize(
    ("features", "declared"),
    [
        (frozenset({"agent.diagnostics.v1", "tv.presence.v1"}), True),
        (frozenset({"agent.diagnostics.v1"}), False),  # API anterior ao sinal de presença
        (frozenset(), False),
        (None, False),  # API dormindo ou ainda subindo
    ],
)
async def test_the_hello_declares_presence_only_after_the_api_lists_it(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    features: frozenset[str] | None,
    declared: bool,
) -> None:
    """Uma API anterior recusa o `hello` inteiro que traz uma capacidade que não conhece."""

    async def api_features(base_url: str, wait_seconds: float = 10.0) -> frozenset[str] | None:
        return features

    monkeypatch.setattr(connection_module, "fetch_api_features", api_features)
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, FakeTvAdb())

    async def script(connection: ServerConnection) -> None:
        await asyncio.sleep(0.4)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True, tv_host=TV_HOST
        )
        assert await run(settings, lambda: store) == EXIT_CREDENTIAL_REJECTED
    hello = next(m for m in api.received if m["type"] == "agent.hello.v1")
    capabilities = hello["body"]["capabilities"]
    assert ("tv.presence.v1" in capabilities) is declared
    assert "tv.adb" in capabilities  # o resto da TV segue declarado como sempre
