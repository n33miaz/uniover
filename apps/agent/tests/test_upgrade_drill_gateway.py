"""A API falsa do ensaio: a troca atômica de dono, os códigos de fechamento e as medidas."""

import asyncio
import importlib.util
import json
import os
import subprocess
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


async def test_the_handover_probe_sends_only_when_allowed_and_counts_every_answer(
    gateway: object,
) -> None:
    gateway.begin_handover_probe()  # type: ignore[attr-defined]
    old = await open_agent(gateway)
    await old.send(hello(knows_handover=True))
    candidate = await open_agent(gateway, candidate=True)
    await candidate.send(hello(handover=True))
    accepted = json.loads(await asyncio.wait_for(candidate.recv(), 5))
    assert accepted["type"] == "agent.handover.accepted.v1"
    # Sem a prova de que a entrada do PC é o dublê nada é enviado.
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(candidate.recv(), 0.5)
    gateway.allow_handover_probe()  # type: ignore[attr-defined]

    async def refuse_everything() -> None:
        while True:
            message = json.loads(await candidate.recv())
            if message["type"] != "pc.key.v1":
                continue
            await candidate.send(
                json.dumps(
                    {
                        "type": "command.result.v1",
                        "correlationId": message["id"],
                        "body": {"ok": False, "error": {"code": "agent_starting"}},
                    }
                )
            )

    responder = asyncio.create_task(refuse_everything())
    await asyncio.sleep(0.8)
    # Fecha o emissor (em outra thread: ele espera as respostas em trânsito) e só então conta.
    result = await asyncio.to_thread(gateway.end_handover_probe)  # type: ignore[attr-defined]
    responder.cancel()
    assert result.sent >= 2
    assert result.unanswered == 0
    assert result.starting_refusals == result.answered
    assert 0.4 <= result.start_delay_seconds <= 3.0  # o envio esperou a liberação
    assert result.refusal_window_seconds >= result.start_delay_seconds
    await candidate.close()


# ---- a entrada do PC do ensaio é sempre o dublê (nenhuma tecla de prova chega ao desktop) ----

SUPPORT = TOOLS / "upgrade_drill_support"
SHOW_PC_INPUT = (
    "import os, uniover_agent.adapters.pc_windows as w, uniover_agent.composition.pc as p;"
    "print(p.WindowsPcInput.__name__, w.WindowsPcInput.__name__, w._send_input.__name__,"
    " os.environ.get('UNIOVER_PC_CONTROL'))"
)


def python_with_support(code: str, *, drill: bool, extra_path: Path | None = None) -> str:
    """Roda `code` num Python com o `sitecustomize` do ensaio carregado como no ensaio."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("UNIOVER_")}
    path = [str(extra_path)] if extra_path is not None else []
    env["PYTHONPATH"] = os.pathsep.join([*path, str(SUPPORT)])
    if drill:
        env["UNIOVER_UPDATE_DRILL"] = "1"
        env["UNIOVER_UPDATE_SOURCE_URL"] = "http://127.0.0.1:9"
    result = subprocess.run(  # noqa: S603 - o Python do próprio ambiente de teste
        [sys.executable, "-c", code],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def test_in_the_drill_the_pc_input_and_the_send_input_sink_are_doubles() -> None:
    out = python_with_support(SHOW_PC_INPUT, drill=True)
    assert out == "DrillPcInput DrillPcInput _drill_send_input None"


def test_outside_the_drill_nothing_about_the_pc_input_is_touched() -> None:
    out = python_with_support(SHOW_PC_INPUT, drill=False)
    assert out.startswith("WindowsPcInput WindowsPcInput _send_input")


def test_if_the_double_cannot_be_installed_the_pc_control_is_turned_off(tmp_path: Path) -> None:
    # Fail fechado: sem o dublê, `pc.key.v1` seria recusado pelo agente, nunca enviado ao Windows.
    (tmp_path / "uniover_agent").mkdir()
    (tmp_path / "uniover_agent" / "__init__.py").write_text("raise RuntimeError('quebrado')")
    out = python_with_support(
        "import os; print(os.environ.get('UNIOVER_PC_CONTROL'))", drill=True, extra_path=tmp_path
    )
    assert out == "false"
