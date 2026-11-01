"""Composição do controle do PC: só existe quando ligado, e de ponta a ponta pelo agente."""

import asyncio
import tomllib
from collections.abc import Sequence
from functools import partial
from pathlib import Path

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent import main as main_module
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTransport
from uniover_agent.config import Settings
from uniover_agent.core import Command, EnvelopeFactory, EnvelopeGate
from uniover_agent.main import (
    EXIT_CREDENTIAL_REJECTED,
    EXIT_OK,
    build_handler,
    build_pc,
    main,
    run,
    silence_noisy_loggers,
)

from .support import AGENT_ID, TOKEN, FakeApi, dump, envelope


class FakeInput:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []

    def move(self, dx: int, dy: int) -> None:
        self.calls.append(("move", dx, dy))

    def scroll(self, horizontal: int, vertical: int) -> None:
        self.calls.append(("scroll", horizontal, vertical))

    def click(self, button: str, action: str) -> None:
        self.calls.append(("click", button, action))

    def key(self, key: str, modifiers: Sequence[str]) -> None:
        self.calls.append(("key", key, tuple(modifiers)))

    def type_text(self, text: str) -> None:
        self.calls.append(("text", text))

    def media(self, action: str, steps: int) -> None:
        self.calls.append(("media", action, steps))


class FakePower:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []

    def lock(self) -> None:
        self.calls.append(("lock",))

    def sleep(self) -> None:
        self.calls.append(("sleep",))

    def shutdown(self, delay_seconds: int) -> None:
        self.calls.append(("shutdown", delay_seconds))

    def cancel_shutdown(self) -> None:
        self.calls.append(("cancel",))


class FakeLauncher:
    def __init__(self) -> None:
        self.opened: list[str] = []

    def launch(self, target: str) -> None:
        self.opened.append(target)


def parts(settings: Settings) -> tuple[Settings, FakeTransport, EnvelopeFactory]:
    clock = FakeClock()
    return settings, FakeTransport(), EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)


def test_it_is_off_by_default() -> None:
    settings, transport, envelopes = parts(Settings())
    assert build_pc(settings, transport, envelopes, platform="win32") is None


def test_it_stays_off_outside_windows_even_when_turned_on(
    caplog: pytest.LogCaptureFixture,
) -> None:
    settings, transport, envelopes = parts(Settings(pc_control=True))
    assert build_pc(settings, transport, envelopes, platform="linux") is None
    assert "só o Windows" in caplog.text


def test_turned_on_declares_the_capability_and_every_command() -> None:
    settings, transport, envelopes = parts(Settings(pc_control=True, pc_apps=["Notas=notepad"]))
    pc = build_pc(
        settings,
        transport,
        envelopes,
        platform="win32",
        pc_input=FakeInput(),
        power=FakePower(),
        launcher=FakeLauncher(),
    )
    assert pc is not None
    assert pc.capabilities == ["pc.control.v1"]
    assert sorted(pc.handlers) == [
        "pc.app.launch.v1",
        "pc.click.v1",
        "pc.key.v1",
        "pc.media.v1",
        "pc.pointer.v1",
        "pc.power.v1",
        "pc.text.v1",
    ]
    assert [app.id for app in pc.apps] == ["notas"]


async def test_the_favorites_list_is_announced_with_ids_and_labels_only() -> None:
    settings, transport, envelopes = parts(
        Settings(pc_control=True, pc_apps=["Navegador=C:\\Segredo\\caminho.exe"])
    )
    pc = build_pc(
        settings,
        transport,
        envelopes,
        platform="win32",
        pc_input=FakeInput(),
        power=FakePower(),
        launcher=FakeLauncher(),
    )
    assert pc is not None
    for step in pc.after_hello:
        await step()
    (message,) = transport.sent
    assert message["type"] == "pc.apps.v1"
    assert message["body"]["apps"] == [{"id": "navegador", "label": "Navegador"}]
    assert "Segredo" not in str(message)


async def test_without_the_control_the_pc_commands_are_refused() -> None:
    handler = build_handler(FakeClock())
    result = await handler(Command("1", "pc.pointer.v1", {"dx": 1, "dy": 1}))
    assert result.status.value == "rejected"


def test_the_shutdown_countdown_has_a_floor() -> None:
    with pytest.raises(ValueError, match="pc_shutdown_delay_seconds"):
        Settings(pc_shutdown_delay_seconds=1)


def test_env_favorites_are_split_on_semicolons(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UNIOVER_PC_APPS", "A=1; B=2;")
    assert Settings().pc_apps == ["A=1", "B=2"]


def test_the_cli_turns_the_control_on_and_off_in_the_config_file(
    isolated_env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["pc-control", "status"]) == EXIT_OK
    assert capsys.readouterr().out.strip() == "desligado"
    assert main(["pc-control", "on"]) == EXIT_OK
    assert tomllib.loads(isolated_env.read_text(encoding="utf-8"))["pc_control"] is True
    assert main(["pc-control", "status"]) == EXIT_OK
    assert "ligado" in capsys.readouterr().out
    assert main(["pc-control", "off"]) == EXIT_OK
    assert tomllib.loads(isolated_env.read_text(encoding="utf-8"))["pc_control"] is False


async def test_run_serves_the_pc_commands_without_any_tv(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pc_input, power, launcher = FakeInput(), FakePower(), FakeLauncher()
    monkeypatch.setattr(
        main_module,
        "build_pc",
        partial(build_pc, platform="win32", pc_input=pc_input, power=power, launcher=launcher),
    )
    ids = [f"0192f1e4-0000-7000-8000-0000000000b{n}" for n in range(8)]

    async def script(connection: ServerConnection) -> None:
        await connection.send(dump(envelope("pc.pointer.v1", {"dx": 4, "dy": -3}, id=ids[0])))
        await connection.send(dump(envelope("pc.click.v1", {"button": "LEFT"}, id=ids[1])))
        await connection.send(dump(envelope("pc.text.v1", {"text": "olá"}, id=ids[2])))
        await connection.send(dump(envelope("pc.power.v1", {"action": "LOCK"}, id=ids[3])))
        await connection.send(dump(envelope("pc.app.launch.v1", {"appId": "notas"}, id=ids[4])))
        await connection.send(dump(envelope("pc.app.launch.v1", {"appId": "cmd"}, id=ids[5])))
        # Fora do contrato (botão que não existe): o envelope recusa antes do handler.
        await connection.send(dump(envelope("pc.click.v1", {"button": "BACK"}, id=ids[6])))
        await asyncio.sleep(0.4)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    silence_noisy_loggers()
    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url,
            agent_id=AGENT_ID,
            allow_insecure=True,
            pc_control=True,
            pc_apps=["Notas=notepad"],
        )
        assert await run(settings, lambda: store) == EXIT_CREDENTIAL_REJECTED

    hello = api.received[0]
    assert hello["body"]["capabilities"] == [
        "transport.keepalive.v1",
        "agent.logs.v1",
        "agent.maintenance.v1",
        "agent.diagnostics.v1",
        "pc.control.v1",
    ]
    announced = next(m for m in api.received if m["type"] == "pc.apps.v1")
    assert announced["body"]["apps"] == [{"id": "notas", "label": "Notas"}]

    results = {
        m["correlationId"]: m["body"] for m in api.received if m["type"] == "command.result.v1"
    }
    # O movimento do mouse é executado e não respondido: a API o manda sem esperar resposta.
    assert ids[0] not in results
    assert results[ids[1]] == {"ok": True}
    assert results[ids[4]] == {"ok": True}
    assert results[ids[5]]["error"]["code"] == "unknown_app"
    assert results[ids[6]]["ok"] is False
    assert pc_input.calls == [("move", 4, -3), ("click", "LEFT", "CLICK"), ("text", "olá")]
    assert power.calls == [("lock",)]
    assert launcher.opened == ["notepad"]


async def test_run_declares_nothing_when_the_control_is_off() -> None:
    async def script(connection: ServerConnection) -> None:
        await asyncio.sleep(0.2)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True)
        assert await run(settings, lambda: store) == EXIT_CREDENTIAL_REJECTED
    assert "pc.control.v1" not in api.received[0]["body"]["capabilities"]
    assert all(m["type"] != "pc.apps.v1" for m in api.received)
