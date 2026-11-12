"""O mesmo id não executa duas vezes: os ids recentes ficam em memória (2 min ou 512 ids)."""

import asyncio
from collections.abc import Callable
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
from uniover_agent.core.process_message import RECENT_COMMAND_CAPACITY, RECENT_COMMAND_SECONDS

from .support import AGENT_ID, dump, envelope, tv_key


class Counting:
    """Conta as execuções; cada uma devolve um resultado diferente (para ver qual foi repetido)."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, command: Command) -> CommandResult:
        self.calls.append(command.id)
        failed = len(self.calls) > 1
        return CommandResult(
            command.id,
            ResultStatus.FAILED if failed else ResultStatus.OK,
            "segunda" if failed else "",
            "second_run" if failed else "",
        )


class Gated:
    """Um comando que só termina quando o teste deixa."""

    def __init__(self) -> None:
        self.calls = 0
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, command: Command) -> CommandResult:
        self.calls += 1
        self.started.set()
        await self.release.wait()
        return CommandResult(command.id, ResultStatus.OK)


def build(
    handlers: dict[str, Any],
    *,
    silent: tuple[str, ...] = (),
    on_command: Callable[[Command], None] | None = None,
) -> tuple[ProcessMessage, FakeTransport, FakeClock]:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand(handlers, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        silent_types=silent,
        monotonic=clock.monotonic,
        on_command=on_command,
    )
    return process, transport, clock


async def feed(process: ProcessMessage, raw: str) -> None:
    await process(raw)
    await process.drain(1.0)


def bodies(transport: FakeTransport) -> list[dict[str, Any]]:
    return [message["body"] for message in transport.sent]


async def test_a_repeated_id_runs_once_and_gets_the_first_answer_again() -> None:
    handler = Counting()
    process, transport, _ = build({"tv.key.v1": handler})
    command = tv_key("HOME")

    await feed(process, dump(command))
    await feed(process, dump(command))

    assert handler.calls == [command["id"]]
    assert [m["correlationId"] for m in transport.sent] == [command["id"], command["id"]]
    assert bodies(transport) == [{"ok": True}, {"ok": True}]


async def test_a_repeat_is_not_counted_as_use_again() -> None:
    # O agendador da limpeza ouve `on_command`: o repetido não é um uso novo da TV.
    seen: list[str] = []
    process, _, _ = build({"tv.key.v1": Counting()}, on_command=lambda c: seen.append(c.id))
    command = tv_key("HOME")

    await feed(process, dump(command))
    await feed(process, dump(command))

    assert seen == [command["id"]]


async def test_a_failed_first_answer_is_repeated_as_it_was() -> None:
    async def fails(command: Command) -> CommandResult:
        return CommandResult(
            command.id, ResultStatus.FAILED, "a TV não respondeu", "TV_UNREACHABLE"
        )

    process, transport, _ = build({"tv.wake.v1": fails})
    command = envelope("tv.wake.v1", {})

    await feed(process, dump(command))
    await feed(process, dump(command))

    assert len(transport.sent) == 2
    assert transport.sent[0]["body"] == transport.sent[1]["body"]
    assert transport.sent[1]["body"]["error"]["code"] == "TV_UNREACHABLE"


async def test_a_repeat_while_the_first_still_runs_neither_runs_nor_answers() -> None:
    handler = Gated()
    process, transport, _ = build({"tv.wake.v1": handler})
    command = envelope("tv.wake.v1", {})

    await process(dump(command))
    await asyncio.wait_for(handler.started.wait(), timeout=1)
    await process(dump(command))
    assert transport.sent == []

    handler.release.set()
    await process.drain(1.0)
    # A resposta do primeiro leva o mesmo id: serve aos dois pedidos.
    assert handler.calls == 1
    assert [m["correlationId"] for m in transport.sent] == [command["id"]]


async def test_after_two_minutes_the_same_id_runs_again() -> None:
    handler = Counting()
    process, transport, clock = build({"tv.key.v1": handler})
    command = tv_key("HOME")

    await feed(process, dump(command))
    clock.advance(RECENT_COMMAND_SECONDS - 1)
    await feed(process, dump(command))
    assert len(handler.calls) == 1
    clock.advance(2)
    await feed(process, dump(command))

    assert len(handler.calls) == 2
    assert bodies(transport)[-1]["error"]["code"] == "second_run"


async def test_only_the_last_512_ids_are_kept() -> None:
    handler = Counting()
    process, _, _ = build({"tv.key.v1": handler})
    first = tv_key("HOME")
    await feed(process, dump(first))
    for _ in range(RECENT_COMMAND_CAPACITY - 1):
        await process(dump(tv_key("HOME")))
    await process.drain(1.0)

    await feed(process, dump(first))  # ainda entre os 512
    assert handler.calls.count(first["id"]) == 1
    await feed(process, dump(tv_key("HOME")))  # o 513º empurra o mais antigo para fora
    await feed(process, dump(first))

    assert handler.calls.count(first["id"]) == 2


async def test_silent_commands_are_not_kept_so_they_never_push_ids_out() -> None:
    runs: list[str] = []

    async def presence(command: Command) -> CommandResult:
        runs.append(command.id)
        return CommandResult(command.id, ResultStatus.OK)

    process, transport, _ = build({"tv.presence.v1": presence}, silent=("tv.presence.v1",))
    command = envelope("tv.presence.v1", {})

    await feed(process, dump(command))
    await feed(process, dump(command))

    assert runs == [command["id"], command["id"]]
    assert transport.sent == []
