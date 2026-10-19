import logging
import uuid

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.core import (
    Command,
    CommandResult,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ProcessMessage,
    ResultStatus,
)

from .support import AGENT_ID, dump, envelope, tv_key


class Spy:
    def __init__(self, result: CommandResult | Exception | None = None) -> None:
        self.calls: list[Command] = []
        self._result = result

    async def __call__(self, command: Command) -> CommandResult:
        self.calls.append(command)
        if isinstance(self._result, Exception):
            raise self._result
        return self._result or CommandResult(command.id, ResultStatus.OK)


def build(spy: Spy) -> tuple[ProcessMessage, FakeTransport]:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({"tv.key.v1": spy}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
    )
    return process, transport


async def test_valid_command_executes_and_replies_pointing_to_its_id() -> None:
    spy = Spy()
    process, transport = build(spy)
    command = tv_key("HOME")  # a API manda `correlationId: null`
    await process(dump(command))
    assert [c.body for c in spy.calls] == [{"key": "HOME"}]
    (reply,) = transport.sent
    assert reply["type"] == "command.result.v1"
    assert reply["correlationId"] == command["id"]
    assert reply["body"] == {"ok": True}


async def test_reply_points_to_the_command_id_even_with_a_correlation_id() -> None:
    process, transport = build(Spy())
    command = tv_key("HOME", str(uuid.uuid4()))
    await process(dump(command))
    assert transport.sent[0]["correlationId"] == command["id"]


async def test_failed_handler_replies_not_ok() -> None:
    process, transport = build(Spy(RuntimeError("tv offline")))
    await process(dump(tv_key("HOME")))
    (reply,) = transport.sent
    assert reply["body"]["ok"] is False
    assert reply["body"]["error"] == {"code": "failed", "message": "tv offline"}


@pytest.mark.parametrize(
    "raw",
    [
        dump(tv_key(extra="x")),
        dump(envelope("tv.explode.v1", {})),
        dump(tv_key(v=2)),
        "{quebrado",
        dump(tv_key(source="agent:outro")),
        dump(tv_key("NOPE")),
        b"\x00\x01",
    ],
)
async def test_invalid_message_never_reaches_handler_and_is_logged(
    raw: str | bytes, caplog: pytest.LogCaptureFixture
) -> None:
    spy = Spy()
    process, _ = build(spy)
    with caplog.at_level(logging.WARNING):
        await process(raw)
    assert spy.calls == []
    assert "mensagem recusada" in caplog.text
    assert AGENT_ID in caplog.text


async def test_invalid_message_with_valid_id_gets_invalid_message_reply() -> None:
    spy = Spy()
    process, transport = build(spy)
    bad = tv_key("NOPE")
    await process(dump(bad))
    assert spy.calls == []
    (reply,) = transport.sent
    assert reply["correlationId"] == bad["id"]
    assert reply["body"]["ok"] is False
    assert reply["body"]["error"]["code"] == "invalid_message"


@pytest.mark.parametrize("raw", ["{quebrado", dump(tv_key(id="nao-e-uuid")), b"\0"])
async def test_invalid_message_without_valid_id_is_only_logged(raw: str | bytes) -> None:
    process, transport = build(Spy())
    await process(raw)
    assert transport.sent == []


async def test_log_does_not_contain_the_full_body(caplog: pytest.LogCaptureFixture) -> None:
    process, _ = build(Spy())
    data = tv_key()
    data["body"]["extra"] = "CONTEUDO-QUE-NAO-PODE-VAZAR"
    with caplog.at_level(logging.DEBUG):
        await process(dump(data))
    assert "CONTEUDO-QUE-NAO-PODE-VAZAR" not in caplog.text


async def test_known_by_contract_but_without_handler_is_rejected_by_core() -> None:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
    )
    await process(dump(tv_key("HOME")))
    (reply,) = transport.sent
    assert reply["body"]["ok"] is False
    assert reply["body"]["error"]["code"] == "rejected"
