"""A API falsa do ensaio: a troca atômica de dono, os códigos de fechamento e as medidas."""

import asyncio
import importlib.util
import json
import sys
import uuid
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import httpx
import pytest
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

TOOLS = Path(__file__).resolve().parents[1] / "tools"


def load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


gateway_module = load("upgrade_drill_gateway", TOOLS / "upgrade_drill_gateway.py")


@pytest.fixture
def gateway() -> Iterator[object]:
    server = gateway_module.Gateway()
    server.start()
    try:
        yield server
    finally:
        server.stop()


def hello(*, handover: bool = False, knows_handover: bool = False) -> str:
    capabilities = [gateway_module.HANDOVER_FEATURE] if knows_handover else []
    body: dict[str, object] = {"agentVersion": "0.0.1", "capabilities": capabilities}
    if handover:
        body["handover"] = True
        body["instanceId"] = str(uuid.uuid4())
    return json.dumps({"id": str(uuid.uuid4()), "type": "agent.hello.v1", "body": body})


async def open_agent(server: object, *, candidate: bool = False) -> ClientConnection:
    path = gateway_module.HANDOVER_WS_PATH if candidate else gateway_module.WS_PATH
    return await connect(f"ws://127.0.0.1:{server.port}{path}")  # type: ignore[attr-defined]


async def close_code(agent: ClientConnection) -> int | None:
    try:
        await asyncio.wait_for(agent.recv(), 5)
    except ConnectionClosed as closed:
        return closed.rcvd.code if closed.rcvd else None
    return None


def test_the_info_route_lists_the_handover_only_when_it_is_on(gateway: object) -> None:
    listed = httpx.get(f"{gateway.url}{gateway_module.INFO_PATH}").json()["features"]  # type: ignore[attr-defined]
    assert gateway_module.HANDOVER_FEATURE in listed
    assert "agent.diagnostics.v1" in listed
    gateway.handover_supported = False  # type: ignore[attr-defined]
    listed = httpx.get(f"{gateway.url}{gateway_module.INFO_PATH}").json()["features"]  # type: ignore[attr-defined]
    assert gateway_module.HANDOVER_FEATURE not in listed
    assert httpx.get(f"{gateway.url}/nada").status_code == 404  # type: ignore[attr-defined]


async def test_a_candidate_with_a_handover_hello_is_promoted_gets_the_ack_and_the_old_gets_4410(
    gateway: object,
) -> None:
    old = await open_agent(gateway)
    await old.send(hello(knows_handover=True))
    candidate = await open_agent(gateway, candidate=True)
    sent = hello(handover=True)
    await candidate.send(sent)
    # A confirmação é a primeira coisa que a promovida recebe, com o instanceId e o id do hello.
    ack = json.loads(await asyncio.wait_for(candidate.recv(), 5))
    assert ack["type"] == "agent.handover.accepted.v1"
    assert ack["source"] == "api"
    assert ack["correlationId"] == json.loads(sent)["id"]
    assert ack["body"]["instanceId"] == json.loads(sent)["body"]["instanceId"]
    assert await close_code(old) == 4410
    await asyncio.sleep(0.2)
    assert gateway.connected()  # type: ignore[attr-defined]
    assert gateway.longest_gap_since(0) == 0.0  # type: ignore[attr-defined]
    assert len(gateway.handover_closes(0)) == 1  # type: ignore[attr-defined]
    assert len(gateway.hello_handovers(0)) == 1  # type: ignore[attr-defined]
    assert len(gateway.acks(0)) == 1  # type: ignore[attr-defined]
    await candidate.close()


async def test_an_old_session_that_never_declared_the_capability_gets_4409_not_4410(
    gateway: object,
) -> None:
    old = await open_agent(gateway)
    await old.send(hello())
    candidate = await open_agent(gateway, candidate=True)
    await candidate.send(hello(handover=True))
    ack = json.loads(await asyncio.wait_for(candidate.recv(), 5))
    assert ack["type"] == "agent.handover.accepted.v1"
    assert await close_code(old) == 4409
    assert gateway.handover_closes(0) == []  # type: ignore[attr-defined]
    await candidate.close()


async def test_a_plain_connection_replaces_the_old_one_at_once_with_4409_and_gets_no_ack(
    gateway: object,
) -> None:
    old = await open_agent(gateway)
    await old.send(hello())
    new = await open_agent(gateway)
    # Sem esperar nenhum quadro da nova.
    assert await close_code(old) == 4409
    await new.send(hello())
    await asyncio.sleep(0.2)
    assert gateway.handover_closes(0) == []  # type: ignore[attr-defined]
    assert gateway.acks(0) == []  # type: ignore[attr-defined]
    await new.close()


@pytest.mark.parametrize("variant", ["plain-hello", "handover-without-instance", "not-a-hello"])
async def test_a_candidate_without_a_valid_handover_hello_is_dropped_and_the_old_stays(
    gateway: object, variant: str
) -> None:
    old = await open_agent(gateway)
    await old.send(hello())
    candidate = await open_agent(gateway, candidate=True)
    first = {
        "plain-hello": hello(),
        "handover-without-instance": json.dumps(
            {"type": "agent.hello.v1", "body": {"agentVersion": "0", "handover": True}}
        ),
        "not-a-hello": json.dumps({"type": "agent.keepalive.v1", "body": {}}),
    }[variant]
    await candidate.send(first)
    assert await close_code(candidate) == 1008
    await asyncio.sleep(0.2)
    assert gateway.connected()  # type: ignore[attr-defined]
    assert gateway.acks(0) == []  # type: ignore[attr-defined]
    assert gateway.handover_closes(0) == []  # type: ignore[attr-defined]
    assert len(gateway.dropped_candidates(0)) == 1  # type: ignore[attr-defined]
    # A antiga segue aberta e a única conexão contada.
    await old.send(hello())
    await old.close()


async def test_the_candidate_route_does_not_exist_when_the_api_does_not_know_the_handover(
    gateway: object,
) -> None:
    gateway.handover_supported = False  # type: ignore[attr-defined]
    old = await open_agent(gateway)
    await old.send(hello(knows_handover=True))
    with pytest.raises(InvalidStatus) as refused:
        await open_agent(gateway, candidate=True)
    assert refused.value.response.status_code == 404
    # Ninguém foi substituído: a antiga segue como a atual.
    await asyncio.sleep(0.2)
    assert gateway.connected()  # type: ignore[attr-defined]
    assert gateway.acks(0) == []  # type: ignore[attr-defined]
    await old.close()


async def test_a_silent_candidate_is_dropped_without_touching_the_old_one(
    gateway: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(gateway_module, "FIRST_FRAME_WAIT_SECONDS", 0.3)
    old = await open_agent(gateway)
    await old.send(hello())
    silent = await open_agent(gateway, candidate=True)
    await asyncio.sleep(0.8)
    assert len(gateway.dropped_candidates(0)) == 1  # type: ignore[attr-defined]
    assert gateway.connected()  # type: ignore[attr-defined]
    assert gateway.handover_closes(0) == []  # type: ignore[attr-defined]
    await silent.close()
    await old.close()


async def test_a_gap_without_any_agent_is_measured(gateway: object) -> None:
    first = await open_agent(gateway)
    await first.send(hello())
    await asyncio.sleep(0.2)
    await first.close()
    await asyncio.sleep(0.4)
    second = await open_agent(gateway)
    await second.send(hello())
    await asyncio.sleep(0.2)
    gap = gateway.longest_gap_since(0)  # type: ignore[attr-defined]
    assert 0.3 <= gap <= 1.5
    assert len(gateway.disconnections_since(0)) == 1  # type: ignore[attr-defined]
    await second.close()


async def test_the_diagnostic_kinds_the_agent_sends_are_kept(gateway: object) -> None:
    agent = await open_agent(gateway)
    await agent.send(hello())
    event = {"id": "x", "at": "x", "kind": "update.window", "severity": "info", "detail": "d"}
    await agent.send(json.dumps({"type": "agent.diagnostics.v1", "body": {"events": [event]}}))
    await asyncio.sleep(0.3)
    assert gateway.diagnostics == ["update.window"]  # type: ignore[attr-defined]
    await agent.close()
