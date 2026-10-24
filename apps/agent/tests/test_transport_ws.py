import asyncio
import json
import logging

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.adapters.transport_ws import MAX_MESSAGE_BYTES, WebSocketTransport, build_ws_url
from uniover_agent.core import (
    ConnectionSupervisor,
    EnvelopeFactory,
    EnvelopeGate,
    ProcessMessage,
)
from uniover_agent.main import build_handler
from uniover_agent.ports import ConnectionReplaced, CredentialRejected, TransportError

from .support import AGENT_ID, TOKEN, FakeApi, dump, tv_key


def transport_for(api: FakeApi, token: str | None = TOKEN) -> WebSocketTransport:
    return WebSocketTransport(api.url, lambda: token, open_timeout=5)


async def drain(transport: WebSocketTransport) -> list[str | bytes]:
    return [message async for message in transport.incoming()]


def test_ws_url_swaps_scheme_and_points_to_agent_channel() -> None:
    assert (
        build_ws_url("https://api.exemplo.test", "pc-casa")
        == "wss://api.exemplo.test/api/v1/devices/agents/pc-casa/ws"
    )
    assert (
        build_ws_url("http://127.0.0.1:5000/", "x1")
        == "ws://127.0.0.1:5000/api/v1/devices/agents/x1/ws"
    )


def test_url_without_tls_is_refused_unless_ws_scheme_for_development() -> None:
    with pytest.raises(ValueError, match="wss://"):
        WebSocketTransport("https://x/ws", lambda: "t")


def test_insecure_scheme_logs_a_warning(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING):
        WebSocketTransport("ws://127.0.0.1:1/ws", lambda: "t")
    assert "sem criptografia" in caplog.text


async def test_sends_token_only_in_authorization_header() -> None:
    async with FakeApi() as api:
        transport = transport_for(api)
        await transport.connect()
        assert transport.connected
        await transport.send({"hello": 1})
        await transport.close()
        await asyncio.sleep(0.05)
    assert api.authorizations == [f"Bearer {TOKEN}"]
    assert TOKEN not in api.paths[0]
    assert "?" not in api.paths[0]
    assert api.received == [{"hello": 1}]


async def test_missing_token_is_credential_rejected_without_connecting() -> None:
    async with FakeApi() as api:
        with pytest.raises(CredentialRejected):
            await transport_for(api, token=None).connect()
    assert api.connections == 0


@pytest.mark.parametrize("status", [401, 403])
async def test_handshake_refusal_by_credential(status: int) -> None:
    async with FakeApi(reject_status=status) as api:
        with pytest.raises(CredentialRejected):
            await transport_for(api).connect()


@pytest.mark.parametrize("status", [429, 500, 502, 503])
async def test_other_handshake_failures_are_transient(status: int) -> None:
    async with FakeApi(reject_status=status) as api:
        with pytest.raises(TransportError) as caught:
            await transport_for(api).connect()
    assert not isinstance(caught.value, CredentialRejected)
    assert TOKEN not in str(caught.value)


async def test_refused_connection_is_transient() -> None:
    transport = WebSocketTransport("ws://127.0.0.1:1/ws", lambda: "t", open_timeout=2)
    with pytest.raises(TransportError):
        await transport.connect()


async def test_receives_raw_text_frames() -> None:
    command = dump(tv_key())

    async def script(connection: ServerConnection) -> None:
        await connection.send("{quebrado")
        await connection.send(command)
        await connection.close()

    async with FakeApi(script) as api:
        transport = transport_for(api)
        await transport.connect()
        assert await drain(transport) == ["{quebrado", command]
        await transport.close()


@pytest.mark.parametrize(
    ("code", "reason", "expected"),
    [
        (1000, "replaced", ConnectionReplaced),
        (4409, "replaced", ConnectionReplaced),
        (4409, "", ConnectionReplaced),
        (4403, "revoked", CredentialRejected),
        (1008, "revoked", CredentialRejected),
        (4403, "", CredentialRejected),
        (1012, "reinicio", None),
    ],
)
async def test_close_reasons_are_mapped(
    code: int, reason: str, expected: type[Exception] | None
) -> None:
    async def script(connection: ServerConnection) -> None:
        await connection.close(code, reason)

    async with FakeApi(script) as api:
        transport = transport_for(api)
        await transport.connect()
        if expected is None:
            with pytest.raises(TransportError):
                await drain(transport)
        else:
            with pytest.raises(expected):
                await drain(transport)
        await transport.close()


async def test_message_over_64kb_closes_the_connection() -> None:
    async def script(connection: ServerConnection) -> None:
        await connection.send("x" * (MAX_MESSAGE_BYTES + 1))

    async with FakeApi(script) as api:
        transport = transport_for(api)
        await transport.connect()
        with pytest.raises(TransportError, match="1009"):
            await drain(transport)
        await transport.close()


async def test_send_after_close_is_a_transport_error() -> None:
    async with FakeApi() as api:
        transport = transport_for(api)
        await transport.connect()
        await transport.close()
        with pytest.raises(TransportError):
            await transport.send({"a": 1})


def supervisor_for(
    api: FakeApi, clock: FakeClock
) -> tuple[ConnectionSupervisor, list[str | bytes]]:
    gate = EnvelopeGate(AGENT_ID)
    envelopes = EnvelopeFactory(AGENT_ID, gate, clock)
    transport = transport_for(api)
    process = ProcessMessage(AGENT_ID, gate, build_handler(clock), envelopes, transport)
    seen: list[str | bytes] = []

    async def spy(raw: str | bytes) -> None:
        seen.append(raw)
        await process(raw)

    supervisor = ConnectionSupervisor(
        transport, spy, envelopes, clock, lambda: 0.5, agent_version="0.1.0", capabilities=()
    )
    return supervisor, seen


async def test_reconnects_after_the_server_drops_the_connection() -> None:
    async def script(connection: ServerConnection) -> None:
        if script.calls == 0:  # type: ignore[attr-defined]
            script.calls += 1  # type: ignore[attr-defined]
            await connection.recv()  # espera o hello antes de derrubar
            await connection.close(1012, "reinicio")

    script.calls = 0  # type: ignore[attr-defined]
    clock = FakeClock()
    async with FakeApi(script) as api:
        supervisor, _ = supervisor_for(api, clock)
        task = asyncio.create_task(supervisor.run())
        for _ in range(200):
            if api.connections >= 2 and api.received:
                break
            await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert api.connections >= 2
    assert clock.sleeps[0] == 1
    # A primeira conexão consumiu o hello no roteiro; a segunda também anunciou o agente.
    assert [m["type"] for m in api.received] == ["agent.hello.v1"]


async def test_sends_an_application_keepalive_while_the_channel_is_idle() -> None:
    received: list[dict[str, object]] = []

    async def script(connection: ServerConnection) -> None:
        received.append(json.loads(await connection.recv()))
        received.append(json.loads(await connection.recv()))
        await connection.close(4403, "revoked")

    clock = FakeClock()
    async with FakeApi(script) as api:
        gate = EnvelopeGate(AGENT_ID)
        envelopes = EnvelopeFactory(AGENT_ID, gate, clock)
        transport = transport_for(api)
        process = ProcessMessage(AGENT_ID, gate, build_handler(clock), envelopes, transport)
        supervisor = ConnectionSupervisor(
            transport,
            process,
            envelopes,
            clock,
            lambda: 0.5,
            agent_version="0.1.0",
            capabilities=("transport.keepalive.v1",),
            keepalive_interval=0.01,
        )

        await asyncio.wait_for(supervisor.run(), timeout=5)

    assert [message["type"] for message in received] == ["agent.hello.v1", "agent.keepalive.v1"]


async def test_invalid_message_from_server_is_not_executed_and_revocation_stops() -> None:
    first_id = "0192f1e4-0000-7000-8000-000000000008"
    second_id = "0192f1e4-0000-7000-8000-000000000009"

    async def script(connection: ServerConnection) -> None:
        await connection.send(dump(tv_key(extra="x", id=first_id)))
        await connection.send(dump(tv_key("NOPE", id=second_id)))
        await asyncio.sleep(0.2)
        await connection.close(4403, "revoked")

    clock = FakeClock()
    async with FakeApi(script) as api:
        supervisor, seen = supervisor_for(api, clock)
        await asyncio.wait_for(supervisor.run(), timeout=10)
    assert api.connections == 1
    assert len(seen) == 2
    replies = [m for m in api.received if m["type"] == "command.result.v1"]
    assert [r["correlationId"] for r in replies] == [first_id, second_id]
    assert all(r["body"]["error"]["code"] == "invalid_message" for r in replies)
    assert clock.sleeps == []


async def test_replaced_by_the_server_waits_longer() -> None:
    async def script(connection: ServerConnection) -> None:
        await connection.close(4409, "replaced")

    clock = FakeClock()
    async with FakeApi(script) as api:
        supervisor, _ = supervisor_for(api, clock)
        task = asyncio.create_task(supervisor.run())
        for _ in range(100):
            if clock.sleeps:
                break
            await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert clock.sleeps[0] == 60
