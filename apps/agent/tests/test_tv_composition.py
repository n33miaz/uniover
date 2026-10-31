"""Composição do agente com a TV: capacidades, estado publicado e comandos de ponta a ponta.

O controle da TV é o dublê (`FakeTvRemote`); a API é o servidor WebSocket falso de loopback.
"""

import asyncio
import logging
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent import main as main_module
from uniover_agent.adapters import tv_locate
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTransport, FakeTvRemote
from uniover_agent.config import Settings, tv_cert_dir
from uniover_agent.core import (
    Command,
    CommandResult,
    EnvelopeFactory,
    EnvelopeGate,
    ResultStatus,
    TvState,
)
from uniover_agent.main import (
    EXIT_CREDENTIAL_REJECTED,
    TvSetup,
    build_handler,
    build_tv,
    run,
    silence_noisy_loggers,
)
from uniover_agent.ports import TextFieldStatus

from .support import AGENT_ID, ANDROID_KEYS, TOKEN, FakeApi, dump, envelope
from .support_tv import write_certificate

TV_HOST = "192.168.0.4"


def pair_fake_tv(monkeypatch: pytest.MonkeyPatch, remote: FakeTvRemote) -> list[tuple[Any, ...]]:
    """Grava um par de certificado de teste e troca o adaptador real pelo dublê."""
    write_certificate(tv_cert_dir("tv"), "UniOver")
    built: list[tuple[Any, ...]] = []

    def fake_adapter(*args: Any, **kwargs: Any) -> FakeTvRemote:
        built.append(args)
        return remote

    monkeypatch.setattr(main_module, "AndroidTvRemoteV2", fake_adapter)
    return built


def make_tv(settings: Settings) -> TvSetup | None:
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    return build_tv(settings, clock, FakeTransport(), envelopes)


def test_no_tv_host_means_no_tv() -> None:
    assert make_tv(Settings()) is None


def test_host_without_certificate_means_no_tv_and_tells_how_to_pair(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        assert make_tv(Settings(tv_host=TV_HOST)) is None
    assert "tv-pair" in caplog.text


def test_host_with_certificate_builds_the_session(monkeypatch: pytest.MonkeyPatch) -> None:
    remote = FakeTvRemote()
    built = pair_fake_tv(monkeypatch, remote)
    setup = make_tv(Settings(tv_host=TV_HOST, tv_client_name="Casa"))
    assert setup is not None
    assert built == [(TV_HOST, "Casa", tv_cert_dir("tv"))]
    assert setup.manager.snapshot().connection == "hibernating"
    assert setup.capabilities == ["tv.remote", "tv.kind.android", *ANDROID_KEYS]
    assert set(setup.handlers) == {
        "tv.key.v1",
        "tv.key.v2",
        "tv.key.v3",
        "tv.power.off.v1",
        "tv.text.v1",
        "tv.wake.v1",
        "tv.app.launch.v1",
    }
    assert setup.background == []
    assert setup.after_hello == []


@pytest.mark.parametrize("mac_on_first_connect", [True, False])
async def test_android_learns_mac_on_the_first_authenticated_session_or_after_hibernation(
    monkeypatch: pytest.MonkeyPatch,
    isolated_env: Path,
    mac_on_first_connect: bool,
) -> None:
    write_certificate(tv_cert_dir("tv"), "UniOver")
    checks = 0

    async def arp_mac(host: str) -> str | None:
        nonlocal checks
        assert host == TV_HOST
        checks += 1
        return "AA:BB:CC:00:00:09" if mac_on_first_connect or checks == 2 else None

    async def open_port(host: str, port: int, wait: float) -> bool:
        assert (host, port) == (TV_HOST, 6466)
        return True

    class CallbackRemote(FakeTvRemote):
        def __init__(self, on_connected: Any) -> None:
            super().__init__()
            self._callback = on_connected

        async def connect(self) -> None:
            await super().connect()
            await self._callback()

    remotes: list[CallbackRemote] = []

    def fake_adapter(*args: Any, **kwargs: Any) -> CallbackRemote:
        remote = CallbackRemote(kwargs["on_connected"])
        remotes.append(remote)
        return remote

    monkeypatch.setattr(main_module, "AndroidTvRemoteV2", fake_adapter)
    monkeypatch.setattr(main_module, "arp_mac", arp_mac)
    monkeypatch.setattr(tv_locate, "tcp_open", open_port)
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    setup = build_tv(
        Settings(tv_host=TV_HOST, tv_hibernate_seconds=1),
        clock,
        FakeTransport(),
        envelopes,
    )
    assert setup is not None
    await setup.manager.wake()
    if not mac_on_first_connect:
        assert setup.known.mac is None
        clock.advance(1)
        assert await setup.manager.hibernate_if_idle()
        await setup.manager.wake()
    assert setup.known.mac == "AA:BB:CC:00:00:09"
    assert checks == (1 if mac_on_first_connect else 2)
    assert remotes[0].sent == []
    saved = await asyncio.to_thread(isolated_env.read_text, encoding="utf-8")
    assert saved.count("tv_mac") == 1
    await setup.manager.aclose()


@pytest.mark.parametrize("message_type", ["tv.key.v1", "tv.key.v2"])
async def test_the_composed_key_handler_accepts_power_and_blocks_nothing(
    monkeypatch: pytest.MonkeyPatch, message_type: str
) -> None:
    remote = FakeTvRemote()
    pair_fake_tv(monkeypatch, remote)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    handler = build_handler(FakeClock(), setup)
    result = await handler(Command("1", message_type, {"key": "POWER"}))
    assert result.status is ResultStatus.OK
    assert remote.sent == [("POWER", "SHORT")]
    # Nenhuma tecla vem recusada de fábrica: o mecanismo de bloqueio existe, mas a lista é vazia.
    for key in ("HOME", "MUTE", "VOLUME_DOWN"):
        result = await handler(Command("2", message_type, {"key": key}))
        assert result.status is ResultStatus.OK
    assert [key for key, _ in remote.sent] == ["POWER", "HOME", "MUTE", "VOLUME_DOWN"]


async def test_typing_by_keys_is_off_unless_the_settings_turn_it_on(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    remote = FakeTvRemote()
    pair_fake_tv(monkeypatch, remote)
    with caplog.at_level(logging.INFO):
        default = make_tv(Settings(tv_host=TV_HOST))
    assert default is not None
    assert default.text is not None
    assert default.text.keys_enabled is False
    assert "desligadas" in caplog.text
    await default.handlers["tv.text.v1"](Command("1", "tv.text.v1", {"text": "mat"}))
    assert (remote.keys, remote.texts) == ([], ["mat"])

    remote.keys.clear()
    remote.texts.clear()
    with caplog.at_level(logging.INFO):
        wired = make_tv(Settings(tv_host=TV_HOST, tv_text_by_keys=True, tv_text_key_pause_ms=20))
    assert wired is not None
    assert wired.text is not None
    assert wired.text.keys_enabled is True
    assert "teclas do controle remoto ligadas" in caplog.text
    await wired.handlers["tv.text.v1"](Command("2", "tv.text.v1", {"text": "mat"}))
    assert (remote.keys, remote.texts) == (["TYPE_M", "TYPE_A", "TYPE_T"], [])


async def test_the_text_field_the_tv_reports_reaches_the_composed_typing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote = FakeTvRemote()
    pair_fake_tv(monkeypatch, remote)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    remote.push_text_field(TextFieldStatus("abc", 3, 3, "Buscar", 1))
    await setup.handlers["tv.text.v1"](Command("1", "tv.text.v1", {"text": "abcd"}))
    assert (remote.keys, remote.texts) == ([], ["d"])


async def test_the_composed_typing_forgets_the_field_when_the_session_goes_to_sleep(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote = FakeTvRemote()
    pair_fake_tv(monkeypatch, remote)
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    setup = build_tv(
        Settings(tv_host=TV_HOST, tv_hibernate_seconds=1), clock, FakeTransport(), envelopes
    )
    assert setup is not None
    await setup.manager.wake()
    remote.push_text_field(TextFieldStatus("abc", 3, 3, "Buscar", 1))
    clock.advance(60)
    assert await setup.manager.hibernate_if_idle()
    # Estado de antes de a sessão dormir não vale: volta a pausa de antes, que nunca apaga às cegas.
    await setup.handlers["tv.text.v1"](Command("1", "tv.text.v1", {"text": "xyz"}))
    assert (remote.keys, remote.texts) == ([], ["xyz"])
    await setup.manager.aclose()


async def test_the_composed_typing_forgets_the_field_when_another_app_takes_focus(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote = FakeTvRemote()
    pair_fake_tv(monkeypatch, remote)
    clock = FakeClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    setup = build_tv(Settings(tv_host=TV_HOST), clock, FakeTransport(), envelopes)
    assert setup is not None
    await setup.manager.wake()
    remote.push_app("com.exemplo.video")
    remote.push_text_field(TextFieldStatus("abc", 3, 3, "Buscar", 1))
    remote.push_app("com.exemplo.video")  # o eco da mesma edição repete o app: nada muda
    clock.advance(60)
    await setup.handlers["tv.text.v1"](Command("1", "tv.text.v1", {"text": "abcd"}))
    assert remote.texts == ["d"]
    remote.push_app("com.exemplo.musica")
    clock.advance(60)
    await setup.handlers["tv.text.v1"](Command("2", "tv.text.v1", {"text": "xyz"}))
    assert remote.keys == []
    assert remote.texts == ["d", "xyz"]
    await setup.manager.aclose()


async def test_without_a_tv_the_tv_commands_are_refused() -> None:
    handler = build_handler(FakeClock())
    result = await handler(Command("1", "tv.wake.v1", {}))
    assert result.status.value == "rejected"


async def test_run_declares_the_capability_and_serves_tv_commands(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    remote = FakeTvRemote()
    pair_fake_tv(monkeypatch, remote)
    ids = {
        "wake": "0192f1e4-0000-7000-8000-0000000000a1",
        "key": "0192f1e4-0000-7000-8000-0000000000a2",
        "power": "0192f1e4-0000-7000-8000-0000000000a3",
        "package": "0192f1e4-0000-7000-8000-0000000000a4",
        "text": "0192f1e4-0000-7000-8000-0000000000a5",
        "text_final": "0192f1e4-0000-7000-8000-0000000000a6",
        "text_invalid": "0192f1e4-0000-7000-8000-0000000000a7",
    }

    async def script(connection: ServerConnection) -> None:
        await connection.send(dump(envelope("tv.wake.v1", {}, id=ids["wake"])))
        await asyncio.sleep(0.3)
        remote.push_power(True)
        await connection.send(
            dump(envelope("tv.key.v2", {"key": "HOME", "direction": "SHORT"}, id=ids["key"]))
        )
        await connection.send(dump(envelope("tv.key.v1", {"key": "POWER"}, id=ids["power"])))
        package = {"target": {"kind": "package", "value": "com.netflix.ninja"}}
        await connection.send(dump(envelope("tv.app.launch.v1", package, id=ids["package"])))
        await connection.send(dump(envelope("tv.text.v1", {"text": "mat"}, id=ids["text"])))
        await connection.send(
            dump(envelope("tv.text.v1", {"text": "matrix"}, id=ids["text_final"]))
        )
        # Texto longo demais fica fora do contrato: o envelope recusa antes de chegar ao handler.
        too_long = {"text": "x" * 201}
        await connection.send(dump(envelope("tv.text.v1", too_long, id=ids["text_invalid"])))
        await asyncio.sleep(0.4)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    silence_noisy_loggers()
    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True, tv_host=TV_HOST
        )
        with caplog.at_level(logging.DEBUG):
            assert await run(settings, lambda: store) == EXIT_CREDENTIAL_REJECTED

    hello = api.received[0]
    assert hello["type"] == "agent.hello.v1"
    assert hello["body"]["capabilities"] == [
        "transport.keepalive.v1",
        "agent.logs.v1",
        "agent.maintenance.v1",
        "agent.diagnostics.v1",
        "tv.remote",
        "tv.kind.android",
        *ANDROID_KEYS,
    ]
    # A tela do dono mostra o tipo e o endereço da TV que este PC controla.
    assert hello["body"]["tv"] == {"kind": "android", "host": TV_HOST}

    # Logo depois do `hello`, a API recebe o estado atual: controle dormindo, poder desconhecido.
    first_state = api.received[1]
    assert first_state["type"] == "tv.state.v1"
    assert first_state["body"] == {
        "power": "unknown",
        "volume": None,
        "app": None,
        "connection": "hibernating",
    }
    states = [m["body"] for m in api.received if m["type"] == "tv.state.v1"]
    assert {"power": "on", "volume": None, "app": None, "connection": "hot"} in states

    results = {
        m["correlationId"]: m["body"] for m in api.received if m["type"] == "command.result.v1"
    }
    assert results[ids["wake"]] == {"ok": True}
    assert results[ids["key"]] == {"ok": True}
    assert results[ids["power"]] == {"ok": True}
    assert results[ids["package"]]["error"]["code"] == "unsupported"
    assert results[ids["text"]] == {"ok": True}
    assert results[ids["text_final"]] == {"ok": True}
    assert results[ids["text_invalid"]]["ok"] is False

    # As duas teclas chegaram ao controle, na ordem: POWER não é mais recusado pelo agente.
    assert remote.sent == [("HOME", "SHORT"), ("POWER", "SHORT")]
    # Só o acréscimo vai à TV (nada de reenviar o campo inteiro): "mat" e depois "matrix" = "rix".
    # O vazio nem chega ao handler.
    assert remote.texts == ["mat", "rix"]
    # Ao encerrar, a sessão com a TV é fechada.
    assert not remote.connected
    assert remote.disconnects >= 1
    assert TOKEN not in caplog.text


async def test_run_without_certificate_declares_no_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def script(connection: ServerConnection) -> None:
        await asyncio.sleep(0.2)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True, tv_host=TV_HOST
        )
        await run(settings, lambda: store)
    assert [m["body"]["capabilities"] for m in api.received if m["type"] == "agent.hello.v1"] == [
        [
            "transport.keepalive.v1",
            "agent.logs.v1",
            "agent.maintenance.v1",
            "agent.diagnostics.v1",
        ]
    ]
    assert not [m for m in api.received if m["type"] == "tv.state.v1"]


async def test_later_deliveries_extend_the_composition_with_one_line_each(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """O que os marcadores precisam: handlers, capacidades, tarefa de fundo e envio de eventos."""
    remote = FakeTvRemote()
    pair_fake_tv(monkeypatch, remote)
    original = main_module.build_tv
    ran: list[str] = []
    refresh_id = "0192f1e4-0000-7000-8000-0000000000b1"

    def extended(*args: Any) -> TvSetup | None:
        setup = original(*args)
        assert setup is not None

        async def refresh_apps(command: Command) -> CommandResult:
            ran.append("apps")
            return CommandResult(command.id, ResultStatus.OK)

        async def loop_forever() -> None:
            ran.append("fundo")
            await asyncio.Event().wait()

        async def event_after_hello() -> None:
            # Com o transporte e as mensagens da composição, uma entrega envia seus eventos.
            state = TvState("unknown", None, None, "hibernating")
            await setup.transport.send(setup.envelopes.tv_state(state))

        setup.handlers["tv.apps.refresh.v1"] = refresh_apps
        setup.capabilities.append("tv.adb")
        setup.background.append(loop_forever)
        setup.after_hello.append(event_after_hello)
        return setup

    monkeypatch.setattr(main_module, "build_tv", extended)

    async def script(connection: ServerConnection) -> None:
        await connection.send(dump(envelope("tv.apps.refresh.v1", {}, id=refresh_id)))
        await asyncio.sleep(0.3)
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
    ]
    assert sorted(ran) == ["apps", "fundo"]
    # O estado inicial (anunciado pela composição) e o evento da extensão saem depois do `hello`.
    states = [m for m in api.received if m["type"] == "tv.state.v1"]
    assert len(states) >= 2
    results = {
        m["correlationId"]: m["body"] for m in api.received if m["type"] == "command.result.v1"
    }
    assert results[refresh_id] == {"ok": True}
