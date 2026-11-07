"""Faixa própria dos comandos do PC: nem esperam as teclas da TV nem as seguram."""

import asyncio
from datetime import UTC, datetime

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
from uniover_agent.core.handle_command import FreshKeyHandler, Handler

from .support import AGENT_ID, dump, envelope, tv_key


class Lab:
    """Handlers falsos de TV e de PC cuja conclusão o teste controla."""

    def __init__(self) -> None:
        self.tv_gate = asyncio.Event()
        self.pc_gate = asyncio.Event()
        self.log: list[str] = []
        self.released = 0

    async def tv(self, command: Command) -> CommandResult:
        self.log.append("tv:start")
        await self.tv_gate.wait()
        self.log.append("tv:end")
        return CommandResult(command.id, ResultStatus.OK)

    async def tv_quick(self, command: Command) -> CommandResult:
        self.log.append("tv:quick")
        return CommandResult(command.id, ResultStatus.OK)

    async def pointer(self, command: Command) -> CommandResult:
        self.log.append(f"pointer:{command.body['dx']}")
        return CommandResult(command.id, ResultStatus.OK)

    async def click(self, command: Command) -> CommandResult:
        action = command.body["action"]
        if action == "DOWN":
            # O DOWN é o lento: sem a ordem garantida, o UP chegaria antes dele.
            await self.pc_gate.wait()
        self.log.append(f"click:{action}")
        return CommandResult(command.id, ResultStatus.OK)

    def release(self) -> None:
        self.released += 1


def build(
    lab: Lab, *, tv: Handler | None = None, timeout: float | None = None
) -> tuple[ProcessMessage, FakeTransport]:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    handlers: dict[str, Handler] = {
        "tv.key.v1": FreshKeyHandler(tv or lab.tv),
        "pc.pointer.v1": lab.pointer,
        "pc.click.v1": lab.click,
    }
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand(handlers, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        silent_types={"pc.pointer.v1"},
        command_timeout_seconds=timeout,
        release_inputs=lab.release,
    )
    return process, transport


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def pointer(dx: int) -> str:
    return dump(envelope("pc.pointer.v1", {"dx": dx, "dy": 0}, ts=now()))


def click(action: str) -> str:
    return dump(envelope("pc.click.v1", {"button": "LEFT", "action": action}, ts=now()))


async def settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


async def test_the_pointer_is_not_held_up_by_a_slow_tv_key() -> None:
    lab = Lab()
    process, _ = build(lab)
    await process(dump(tv_key("HOME")))
    await settle()
    assert lab.log == ["tv:start"]  # a tecla da TV está presa
    await process(pointer(7))
    await settle()
    # O ponteiro foi executado com a tecla ainda em andamento.
    assert lab.log == ["tv:start", "pointer:7"]
    lab.tv_gate.set()
    await settle()
    assert lab.log[-1] == "tv:end"
    await process.aclose()


async def test_a_tv_key_is_not_held_up_by_a_slow_pc_command() -> None:
    lab = Lab()
    process, _ = build(lab, tv=lab.tv_quick)
    await process(click("DOWN"))  # preso até o teste soltar
    await settle()
    await process(dump(tv_key("HOME")))
    await settle()
    assert lab.log == ["tv:quick"]
    lab.pc_gate.set()
    await settle()
    assert lab.log == ["tv:quick", "click:DOWN"]
    await process.aclose()


async def test_pc_commands_keep_their_order_even_when_the_first_is_slow() -> None:
    lab = Lab()
    process, _ = build(lab)
    await process(click("DOWN"))
    await process(pointer(1))
    await process(pointer(2))
    await process(click("UP"))
    await settle()
    assert lab.log == []  # tudo espera pelo DOWN, que é o primeiro
    lab.pc_gate.set()
    await settle()
    assert lab.log == ["click:DOWN", "pointer:1", "pointer:2", "click:UP"]
    await process.aclose()


async def test_pc_commands_are_answered_without_the_tv_timeout() -> None:
    lab = Lab()
    process, transport = build(lab, timeout=0.0001)
    lab.pc_gate.set()
    await process(click("DOWN"))
    await asyncio.sleep(0.05)
    (reply,) = transport.sent
    assert reply["body"] == {"ok": True}
    await process.aclose()


async def test_losing_the_connection_drops_what_was_waiting_and_releases_the_buttons() -> None:
    lab = Lab()
    process, _ = build(lab)
    await process(click("DOWN"))  # em andamento, preso
    await process(pointer(5))  # esperando a vez
    await settle()
    process.connection_lost()
    assert lab.released == 1
    lab.pc_gate.set()
    await settle()
    # Nada do que estava na faixa roda depois de soltar tudo.
    assert lab.log == []
    # E a faixa segue servindo comandos novos depois da reconexão.
    await process(pointer(9))
    await settle()
    assert lab.log == ["pointer:9"]
    await process.aclose()


async def test_closing_the_agent_releases_the_buttons_after_stopping_the_lane() -> None:
    lab = Lab()
    process, _ = build(lab)
    await process(click("DOWN"))
    await settle()
    await process.aclose()
    assert lab.released == 1
    lab.pc_gate.set()
    await settle()
    assert lab.log == []


async def test_a_failing_release_never_breaks_the_shutdown() -> None:
    def broken() -> None:
        raise OSError("sem acesso")

    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        FakeTransport(),
        release_inputs=broken,
    )
    process.connection_lost()
    await process.aclose()


async def test_a_backlog_of_pointer_moves_is_capped_when_the_lane_is_stuck() -> None:
    lab = Lab()
    process, _ = build(lab)
    await process(click("DOWN"))  # trava a faixa
    for step in range(300):
        await process(pointer(step))
    lab.pc_gate.set()
    await settle()
    await asyncio.sleep(0.05)
    moved = [entry for entry in lab.log if entry.startswith("pointer")]
    assert 0 < len(moved) < 300
    # O que ficou é o começo da fila, na ordem.
    assert moved == [f"pointer:{n}" for n in range(len(moved))]
    await process.aclose()
