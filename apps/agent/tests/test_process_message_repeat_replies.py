"""A resposta de um comando repetido sai fora do leitor: o websocket parado não trava a recepção."""

import asyncio
from typing import Any

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
from uniover_agent.core.process_message import MAX_PENDING_REPEAT_REPLIES

from .support import AGENT_ID, dump, tv_key


class Counting:
    """Conta as execuções de cada id."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, command: Command) -> CommandResult:
        self.calls.append(command.id)
        return CommandResult(command.id, ResultStatus.OK)


async def feed(process: ProcessMessage, raw: str) -> None:
    await process(raw)
    await process.drain(1.0)


class Pressured(FakeTransport):
    """Transporte sob pressão: com `blocked`, o `send` espera o teste soltar."""

    def __init__(self) -> None:
        super().__init__()
        self.blocked = False
        self.release = asyncio.Event()

    async def send(self, message: dict[str, Any]) -> None:
        if self.blocked:
            await self.release.wait()
        await super().send(message)


def build_pressured(handler: Any) -> tuple[ProcessMessage, Pressured]:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = Pressured()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({"tv.key.v1": handler}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        monotonic=clock.monotonic,
    )
    return process, transport


async def test_a_repeat_whose_answer_is_stuck_does_not_stop_the_reader() -> None:
    handler = Counting()
    process, transport = build_pressured(handler)
    first = tv_key("HOME")
    await feed(process, dump(first))
    transport.blocked = True

    # O reenvio chega com o websocket parado: o leitor volta na hora e atende o que vem depois.
    await asyncio.wait_for(process(dump(first)), timeout=1)
    await asyncio.wait_for(process(dump(first)), timeout=1)
    later = tv_key("BACK")
    await asyncio.wait_for(process(dump(later)), timeout=1)
    for _ in range(10):
        await asyncio.sleep(0)
    assert later["id"] in handler.calls
    assert len(transport.sent) == 1  # só a primeira resposta saiu até aqui

    transport.release.set()
    await process.drain(1.0)
    # Cada pedido recebe a sua resposta (a do repetido segue a cadeia dos repetidos).
    answered = [m["correlationId"] for m in transport.sent]
    assert sorted(answered) == sorted([first["id"]] * 3 + [later["id"]])
    assert handler.calls.count(first["id"]) == 1


async def test_stuck_repeat_answers_are_capped_and_the_overflow_dropped() -> None:
    handler = Counting()
    process, transport = build_pressured(handler)
    first = tv_key("HOME")
    await feed(process, dump(first))
    transport.blocked = True

    for _ in range(MAX_PENDING_REPEAT_REPLIES + 20):
        await asyncio.wait_for(process(dump(first)), timeout=1)
    transport.release.set()
    await process.drain(1.0)

    assert len(transport.sent) == 1 + MAX_PENDING_REPEAT_REPLIES
    assert handler.calls.count(first["id"]) == 1
