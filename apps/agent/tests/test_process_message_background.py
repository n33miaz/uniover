"""Comandos longos em tarefa própria: as teclas não esperam por eles e o resultado sai no fim."""

import asyncio
import logging

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
from uniover_agent.ports import TransportError

from .support import AGENT_ID, dump, envelope, tv_key

CLEANUP = "tv.cleanup.v1"
REQUEST = {"requestId": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea0"}


class Handlers:
    """Dois comandos: a tecla (rápida) e a limpeza (espera a liberação do teste)."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.started: list[str] = []
        self.finished: list[str] = []
        self.cancelled = False

    async def key(self, command: Command) -> CommandResult:
        self.started.append(command.type)
        self.finished.append(command.type)
        return CommandResult(command.id, ResultStatus.OK)

    async def cleanup(self, command: Command) -> CommandResult:
        self.started.append(command.type)
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        self.finished.append(command.type)
        return CommandResult(command.id, ResultStatus.OK)


def build(
    handlers: Handlers, transport: FakeTransport | None = None
) -> tuple[ProcessMessage, FakeTransport]:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = transport or FakeTransport()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({"tv.key.v1": handlers.key, CLEANUP: handlers.cleanup}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        background_types={CLEANUP},
    )
    return process, transport


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


async def test_a_background_command_does_not_hold_the_next_message() -> None:
    handlers = Handlers()
    process, transport = build(handlers)
    cleanup = envelope(CLEANUP, REQUEST)
    await process(dump(cleanup))
    await settle()
    # A limpeza está rodando e nada foi respondido ainda...
    assert handlers.started == [CLEANUP]
    assert transport.sent == []
    # ...mas uma tecla que chega agora é atendida e respondida na hora.
    key = tv_key("HOME")
    await process(dump(key))
    assert [m["correlationId"] for m in transport.sent] == [key["id"]]
    handlers.release.set()
    await settle()
    assert [m["correlationId"] for m in transport.sent] == [key["id"], cleanup["id"]]
    assert transport.sent[1]["body"] == {"ok": True}


async def test_an_ordinary_command_still_runs_inside_the_message_loop() -> None:
    handlers = Handlers()
    process, transport = build(handlers)
    await process(dump(tv_key("HOME")))
    # Sem `settle`: o resultado já saiu quando a chamada voltou.
    assert len(transport.sent) == 1


async def test_a_failing_background_command_still_answers_not_ok() -> None:
    async def boom(command: Command) -> CommandResult:
        raise RuntimeError("falhou")

    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({CLEANUP: boom}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        background_types={CLEANUP},
    )
    await process(dump(envelope(CLEANUP, REQUEST)))
    await settle()
    (reply,) = transport.sent
    assert reply["body"]["ok"] is False


async def test_a_result_that_cannot_be_sent_is_only_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Down(FakeTransport):
        async def send(self, message: dict[str, object]) -> None:
            raise TransportError("conexão caiu")

    handlers = Handlers()
    handlers.release.set()
    process, _ = build(handlers, Down())
    with caplog.at_level(logging.DEBUG):
        await process(dump(envelope(CLEANUP, REQUEST)))
        await settle()
    assert "não enviado" in caplog.text
    assert "Task exception was never retrieved" not in caplog.text


async def test_an_unexpected_error_while_answering_is_logged_not_raised(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Broken(FakeTransport):
        async def send(self, message: dict[str, object]) -> None:
            raise RuntimeError("inesperado")

    handlers = Handlers()
    handlers.release.set()
    process, _ = build(handlers, Broken())
    with caplog.at_level(logging.ERROR):
        await process(dump(envelope(CLEANUP, REQUEST)))
        await settle()
    assert "falha ao responder" in caplog.text


async def test_closing_cancels_the_commands_still_running() -> None:
    handlers = Handlers()
    process, transport = build(handlers)
    await process(dump(envelope(CLEANUP, REQUEST)))
    await settle()
    await process.aclose()
    assert handlers.cancelled
    assert transport.sent == []
    # Fechar de novo, sem nada rodando, não faz nada.
    await process.aclose()


async def test_an_invalid_background_message_is_still_refused_by_the_gate() -> None:
    handlers = Handlers()
    process, transport = build(handlers)
    await process(dump(envelope(CLEANUP, {})))  # falta o requestId
    await settle()
    assert handlers.started == []
    (reply,) = transport.sent
    assert reply["body"]["ok"] is False
    assert reply["body"]["error"]["code"] == "invalid_message"
