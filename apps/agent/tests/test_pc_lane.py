"""Faixa própria dos comandos do PC: nem esperam as teclas da TV nem as seguram."""

import asyncio
from datetime import UTC, datetime

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
from uniover_agent.core.handle_command import FreshKeyHandler, Handler
from uniover_agent.core.pc.handlers import MAX_POINTER_DELTA
from uniover_agent.core.process_message import MAX_PENDING_PC

from .support import AGENT_ID, dump, envelope, tv_key


class Lab:
    """Handlers falsos de TV e de PC cuja conclusão o teste controla."""

    def __init__(self) -> None:
        self.tv_gate = asyncio.Event()
        self.pc_gate = asyncio.Event()
        self.down_started = asyncio.Event()
        self.log: list[str] = []

    async def tv(self, command: Command) -> CommandResult:
        self.log.append("tv:start")
        await self.tv_gate.wait()
        self.log.append("tv:end")
        return CommandResult(command.id, ResultStatus.OK)

    async def tv_quick(self, command: Command) -> CommandResult:
        self.log.append("tv:quick")
        return CommandResult(command.id, ResultStatus.OK)

    async def pointer(self, command: Command) -> CommandResult:
        if command.body.get("scrollY"):
            self.log.append(f"scroll:{command.body['scrollY']}")
        else:
            self.log.append(f"pointer:{command.body['dx']}")
        return CommandResult(command.id, ResultStatus.OK)

    async def click(self, command: Command) -> CommandResult:
        action = command.body["action"]
        if action == "DOWN":
            # O DOWN é o lento: sem a ordem garantida, o UP chegaria antes dele.
            self.down_started.set()
            try:
                await self.pc_gate.wait()
            except asyncio.CancelledError:
                self.log.append("click:cancelled")
                raise
        self.log.append(f"click:{action}")
        return CommandResult(command.id, ResultStatus.OK)

    def release(self) -> None:
        # No mesmo registro ordenado dos handlers: prova o que veio antes e depois da soltura.
        self.log.append("release")


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


def scroll(amount: int) -> str:
    body = {"dx": 0, "dy": 0, "scrollY": amount}
    return dump(envelope("pc.pointer.v1", body, ts=now()))


def click(action: str) -> str:
    return dump(envelope("pc.click.v1", {"button": "LEFT", "action": action}, ts=now()))


async def settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


async def start_blocked_down(lab: Lab, process: ProcessMessage) -> None:
    """Manda um DOWN e só segue quando o handler dele já está de fato parado esperando."""
    await process(click("DOWN"))
    await asyncio.wait_for(lab.down_started.wait(), 1)
    assert not lab.pc_gate.is_set()
    assert lab.log == []


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
    await start_blocked_down(lab, process)  # preso até o teste soltar
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
    await start_blocked_down(lab, process)
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
    await start_blocked_down(lab, process)  # em andamento, preso
    await process(pointer(5))  # esperando a vez
    await settle()
    process.connection_lost()
    lab.pc_gate.set()
    await settle()
    # A soltura saiu e o que estava na faixa foi cancelado: nem o DOWN nem o movimento rodaram.
    assert sorted(lab.log) == ["click:cancelled", "release"]
    # E a faixa segue servindo comandos novos depois da reconexão.
    await process(pointer(9))
    await settle()
    assert lab.log[-1] == "pointer:9"
    await process.aclose()


async def test_closing_the_agent_stops_the_lane_and_only_then_releases() -> None:
    lab = Lab()
    process, _ = build(lab)
    await start_blocked_down(lab, process)
    await process(pointer(3))
    await process.aclose()
    # A tarefa foi cancelada e terminou ANTES de soltar; nada rodou depois.
    assert lab.log == ["click:cancelled", "release"]
    lab.pc_gate.set()
    await settle()
    assert lab.log == ["click:cancelled", "release"]


async def test_only_the_api_heartbeat_feeds_the_clock_estimate() -> None:
    lab = Lab()
    seen: list[str | None] = []
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({"pc.pointer.v1": lab.pointer}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        FakeTransport(),
        silent_types={"pc.pointer.v1"},
        observe_timestamp=seen.append,
    )
    await process(dump(envelope("api.keepalive.v1", {}, ts="2026-11-07T12:00:00.000Z")))
    await process(
        dump(envelope("pc.pointer.v1", {"dx": 1, "dy": 0}, ts="2026-11-07T12:00:01.000Z"))
    )
    await process.aclose()
    # O comando do PC (que a API poderia ter segurado) não entra: só o batimento.
    assert seen == ["2026-11-07T12:00:00.000Z"]


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


async def test_a_backlog_merges_the_newest_moves_and_keeps_the_whole_path() -> None:
    lab = Lab()
    process, _ = build(lab)
    await start_blocked_down(lab, process)  # trava a faixa: o DOWN está em execução, fora da fila
    total = MAX_PENDING_PC + 72
    for step in range(total):
        await process(pointer(step + 1))
        assert len(process._pc_queue) <= MAX_PENDING_PC
    lab.pc_gate.set()
    await settle()
    await asyncio.sleep(0.05)
    moved = [int(entry.split(":")[1]) for entry in lab.log if entry.startswith("pointer")]
    # A fila guardou no máximo `MAX_PENDING_PC` movimentos e a soma do caminho não se perdeu.
    assert lab.log[0] == "click:DOWN"
    assert len(moved) == MAX_PENDING_PC
    assert sum(moved) == sum(range(1, total + 1))
    assert all(abs(delta) <= MAX_POINTER_DELTA for delta in moved)
    await process.aclose()


async def test_a_sum_past_the_real_limit_is_not_merged_the_oldest_move_is_dropped_instead(
    caplog: pytest.LogCaptureFixture,
) -> None:
    lab = Lab()
    process, _ = build(lab)
    await start_blocked_down(lab, process)
    total = MAX_PENDING_PC + 40
    big = MAX_POINTER_DELTA * 3 // 4  # dois deles passam do limite do adaptador
    with caplog.at_level("WARNING"):
        for _ in range(total):
            await process(pointer(big))
    assert caplog.text.count("descartando") == 1
    lab.pc_gate.set()
    await settle()
    await asyncio.sleep(0.05)
    moved = [int(entry.split(":")[1]) for entry in lab.log if entry.startswith("pointer")]
    assert moved == [big] * MAX_PENDING_PC  # nenhum passou do limite; sobraram os mais novos
    await process.aclose()


async def test_moves_and_scrolls_are_never_merged_so_their_order_is_kept() -> None:
    lab = Lab()
    process, _ = build(lab)
    await start_blocked_down(lab, process)
    total = MAX_PENDING_PC + 40
    sent = [("pointer" if n % 2 == 0 else "scroll", n + 1) for n in range(total)]
    for kind, value in sent:
        await process(pointer(value) if kind == "pointer" else scroll(value))
    lab.pc_gate.set()
    await settle()
    await asyncio.sleep(0.05)
    expected = [f"{kind}:{value}" for kind, value in sent[-MAX_PENDING_PC:]]
    # Nada se somou (vizinhos de tipos diferentes); o mais antigo saiu e a ordem ficou.
    assert lab.log[1:] == expected
    await process.aclose()


@pytest.mark.parametrize(("before", "after"), [(94, 100), (5, 200)])
async def test_merging_moves_never_carries_motion_across_a_click(before: int, after: int) -> None:
    lab = Lab()
    process, _ = build(lab)
    await start_blocked_down(lab, process)
    for _ in range(before):
        await process(pointer(1))
    await process(click("UP"))
    for _ in range(after):
        await process(pointer(1000))
    lab.pc_gate.set()
    await settle()
    await asyncio.sleep(0.05)
    up = lab.log.index("click:UP")
    moved_before = [int(e.split(":")[1]) for e in lab.log[:up] if e.startswith("pointer")]
    moved_after = [int(e.split(":")[1]) for e in lab.log[up:] if e.startswith("pointer")]
    # Tudo o que veio antes do UP ainda roda antes dele, e tudo o que veio depois, depois.
    assert sum(moved_before) == before
    assert sum(moved_after) == after * 1000
    assert len(moved_before) + 1 + len(moved_after) <= MAX_PENDING_PC
    await process.aclose()


async def test_a_backlog_warns_once_per_overflow(caplog: pytest.LogCaptureFixture) -> None:
    lab = Lab()
    process, _ = build(lab)
    await start_blocked_down(lab, process)
    with caplog.at_level("WARNING"):
        for step in range(MAX_PENDING_PC + 50):
            await process(pointer(step))
    assert caplog.text.count("faixa do PC cheia") == 1
    await process.aclose()


async def test_a_backlog_never_drops_a_command_that_has_an_answer() -> None:
    lab = Lab()
    process, transport = build(lab)
    await start_blocked_down(lab, process)
    await process(click("UP"))
    for step in range(MAX_PENDING_PC + 20):
        await process(pointer(step))
    lab.pc_gate.set()
    await settle()
    await asyncio.sleep(0.05)
    assert "click:UP" in lab.log
    assert lab.log.index("click:DOWN") < lab.log.index("click:UP")
    assert len(transport.sent) == 2  # as respostas do DOWN e do UP; o movimento é silencioso
    await process.aclose()


async def test_finished_pointer_moves_leave_nothing_behind() -> None:
    lab = Lab()
    process, _ = build(lab)
    for step in range(500):
        await process(pointer(step))
        if step % 50 == 0:
            await settle()
    await settle()
    await asyncio.sleep(0.05)
    assert len([entry for entry in lab.log if entry.startswith("pointer")]) == 500
    # Fila vazia e só o consumidor único vivo: nada acumula com o uso do mouse.
    assert len(process._pc_queue) == 0
    assert len(process._tasks) == 1
    await process.aclose()
    assert len(process._tasks) == 0
