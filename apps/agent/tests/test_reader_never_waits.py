"""O leitor nunca espera a TV: a manutenção tem faixa própria e a trava do ADB tem prioridade."""

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
from uniover_agent.core.priority_lock import (
    MAX_NORMAL_WAIT_SECONDS,
    MAX_URGENT_STREAK,
    PriorityLock,
)
from uniover_agent.ports import TransportError

from .support import AGENT_ID, dump, envelope, tv_key

REFRESH = "tv.apps.refresh.v1"
LAUNCH = "tv.app.launch.v1"
NETFLIX = {"target": {"kind": "package", "value": "com.netflix.ninja"}}


class Watched(FakeTransport):
    """Transporte que avisa a cada resultado enviado (o teste espera o aviso, não o relógio)."""

    def __init__(self) -> None:
        super().__init__()
        self.changed = asyncio.Event()

    async def send(self, message: dict[str, Any]) -> None:
        await super().send(message)
        self.changed.set()

    async def wait_for(self, count: int) -> None:
        while len(self.sent) < count:
            self.changed.clear()
            await asyncio.wait_for(self.changed.wait(), 2)

    def ids(self) -> list[str]:
        return [message["correlationId"] for message in self.sent]


class Tv:
    """Handlers que registram a ordem; a lista de apps fica presa até o teste soltar."""

    def __init__(self) -> None:
        self.order: list[str] = []
        self.refresh_started = asyncio.Event()
        self.release_refresh = asyncio.Event()
        self.refresh_cancelled = False

    async def key(self, command: Command) -> CommandResult:
        self.order.append(command.body["key"])
        return CommandResult(command.id, ResultStatus.OK)

    async def launch(self, command: Command) -> CommandResult:
        self.order.append("launch")
        return CommandResult(command.id, ResultStatus.OK)

    async def refresh(self, command: Command) -> CommandResult:
        self.order.append("refresh")
        self.refresh_started.set()
        try:
            await self.release_refresh.wait()
        except asyncio.CancelledError:
            self.refresh_cancelled = True
            raise
        self.order.append("refresh done")
        return CommandResult(command.id, ResultStatus.OK)


def build(tv: Tv, timeout: float | None = None) -> tuple[ProcessMessage, Watched]:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = Watched()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({"tv.key.v1": tv.key, LAUNCH: tv.launch, REFRESH: tv.refresh}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        command_timeout_seconds=timeout,
    )
    return process, transport


async def test_a_key_is_answered_while_the_app_list_is_stuck() -> None:
    tv = Tv()
    process, transport = build(tv)
    refresh = envelope(REFRESH, {})
    await process(dump(refresh))
    await asyncio.wait_for(tv.refresh_started.wait(), 2)
    key = tv_key("RIGHT")
    # O leitor volta na hora: não ficou esperando a lista.
    await asyncio.wait_for(process(dump(key)), 2)
    await transport.wait_for(1)
    assert transport.ids() == [key["id"]]
    assert "refresh done" not in tv.order
    tv.release_refresh.set()
    await transport.wait_for(2)
    assert transport.ids() == [key["id"], refresh["id"]]
    assert transport.sent[1]["body"] == {"ok": True}


async def test_input_keeps_its_arrival_order_in_the_key_chain() -> None:
    tv = Tv()
    process, transport = build(tv)
    await process(dump(envelope(REFRESH, {})))
    await asyncio.wait_for(tv.refresh_started.wait(), 2)
    sent = [
        tv_key("RIGHT"),
        envelope(LAUNCH, NETFLIX),
        tv_key("POWER"),
        tv_key("OK"),
    ]
    for message in sent:
        await process(dump(message))
    await transport.wait_for(4)
    assert tv.order == ["refresh", "RIGHT", "launch", "POWER", "OK"]
    assert transport.ids() == [message["id"] for message in sent]
    tv.release_refresh.set()
    await transport.wait_for(5)


async def test_a_maintenance_command_past_its_deadline_answers_an_error_and_frees_the_lane() -> (
    None
):
    tv = Tv()
    process, transport = build(tv, timeout=0.01)
    stuck = envelope(REFRESH, {})
    await process(dump(stuck))
    # A lista nunca é solta: o teto a corta e responde no formato do tempo esgotado.
    await transport.wait_for(1)
    assert transport.ids() == [stuck["id"]]
    assert transport.sent[0]["body"]["ok"] is False
    assert transport.sent[0]["body"]["error"]["code"] == "tv_unreachable"
    assert tv.refresh_cancelled
    # A faixa ficou livre: a próxima manutenção roda (e termina).
    tv.refresh_started.clear()
    tv.release_refresh.set()
    following = envelope(REFRESH, {})
    await process(dump(following))
    await transport.wait_for(2)
    assert transport.ids()[1] == following["id"]
    assert transport.sent[1]["body"] == {"ok": True}


async def test_maintenance_runs_one_at_a_time_in_arrival_order() -> None:
    tv = Tv()
    process, transport = build(tv, timeout=30.0)
    first, second = envelope(REFRESH, {}), envelope(REFRESH, {})
    await process(dump(first))
    await process(dump(second))
    await asyncio.wait_for(tv.refresh_started.wait(), 2)
    for _ in range(5):
        await asyncio.sleep(0)
    assert tv.order == ["refresh"]  # a segunda espera a vez, sem rodar junto
    tv.release_refresh.set()
    await transport.wait_for(2)
    assert transport.ids() == [first["id"], second["id"]]
    assert tv.order == ["refresh", "refresh done", "refresh", "refresh done"]


async def test_closing_answers_every_accepted_command_exactly_once() -> None:
    tv = Tv()
    process, transport = build(tv)
    running = envelope(REFRESH, {})
    queued = envelope(REFRESH, {})
    await process(dump(running))
    await process(dump(queued))
    await asyncio.wait_for(tv.refresh_started.wait(), 2)
    done_key = tv_key("RIGHT")
    await process(dump(done_key))
    await transport.wait_for(1)  # a tecla terminou e respondeu antes do fechamento
    await process.aclose()
    assert tv.refresh_cancelled
    # O que estava em curso e o que esperava a vez recebem `agent_stopping`; a tecla, nada a mais.
    assert sorted(transport.ids()) == sorted([done_key["id"], running["id"], queued["id"]])
    stopping = [m for m in transport.sent if m["correlationId"] != done_key["id"]]
    assert {m["body"]["error"]["code"] for m in stopping} == {"agent_stopping"}
    assert all(m["body"]["ok"] is False for m in stopping)
    # Nada roda depois: o comando que esperava nunca chegou à TV.
    assert tv.order.count("refresh") == 1


async def test_after_the_handover_drain_what_is_left_is_answered_not_dropped() -> None:
    tv = Tv()
    process, transport = build(tv)
    stuck = envelope(REFRESH, {})
    await process(dump(stuck))
    await asyncio.wait_for(tv.refresh_started.wait(), 2)
    key = tv_key("OK")
    await process(dump(key))
    # A passagem dá um prazo curto; a tecla termina dentro dele, a lista não.
    await process.drain(0.01)
    assert transport.ids() == [key["id"]]
    await process.aclose()
    assert transport.ids() == [key["id"], stuck["id"]]
    assert transport.sent[1]["body"]["error"]["code"] == "agent_stopping"


async def test_closing_with_the_transport_gone_only_logs() -> None:
    class Gone(Watched):
        async def send(self, message: dict[str, Any]) -> None:
            raise TransportError("fechado")

    tv = Tv()
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({REFRESH: tv.refresh}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        Gone(),
    )
    await process(dump(envelope(REFRESH, {})))
    await asyncio.wait_for(tv.refresh_started.wait(), 2)
    # A resposta não tem por onde sair: a API encerra o comando pelo prazo dela.
    await asyncio.wait_for(process.aclose(), 2)
    assert tv.refresh_cancelled


# --- a trava do ADB ---------------------------------------------------------------------------


async def test_the_urgent_waiter_goes_ahead_of_the_one_that_came_first() -> None:
    lock = PriorityLock()
    order: list[str] = []

    async def take(name: str, *, urgent: bool) -> None:
        await lock.acquire(urgent=urgent)
        order.append(name)
        lock.release()

    await lock.acquire()
    tasks = [
        asyncio.create_task(take("lista", urgent=False)),
        asyncio.create_task(take("ícones", urgent=False)),
        asyncio.create_task(take("texto 1", urgent=True)),
        asyncio.create_task(take("texto 2", urgent=True)),
    ]
    await asyncio.sleep(0)
    lock.release()
    await asyncio.gather(*tasks)
    assert order == ["texto 1", "texto 2", "lista", "ícones"]
    assert not lock.locked()


class Now:
    """Relógio falso da trava (só anda quando o teste manda)."""

    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


async def typing_and_listing(
    lock: PriorityLock, rounds: int, on_grant: Callable[[], None] = lambda: None
) -> list[str]:
    """Duas rajadas de digitação que se revezam (sempre há entrada esperando enquanto duram) e
    uma lista que chegou antes delas."""
    order: list[str] = []

    async def typing(name: str) -> None:
        for index in range(rounds):
            async with lock.urgent():
                order.append(f"{name} {index}")
                on_grant()
                await asyncio.sleep(0)

    async def listing() -> None:
        async with lock:
            order.append("lista")

    await lock.acquire()
    waiting = asyncio.create_task(listing())
    await asyncio.sleep(0)
    bursts = [asyncio.create_task(typing("a")), asyncio.create_task(typing("b"))]
    await asyncio.sleep(0)
    lock.release()
    await asyncio.wait_for(asyncio.gather(waiting, *bursts), 2)
    assert not lock.locked()
    return order


async def test_maintenance_runs_once_the_input_stops() -> None:
    # Sem envelhecimento a valer (teto alto, relógio parado): só a pausa da entrada a libera.
    lock = PriorityLock(monotonic=Now(), max_urgent_streak=1000)
    order = await typing_and_listing(lock, 10)
    assert len(order) == 21
    assert order.index("lista") >= 18


async def test_a_continuous_typing_stream_gives_way_after_the_streak_limit() -> None:
    lock = PriorityLock(monotonic=Now())
    order = await typing_and_listing(lock, 30)
    # A lista chegou primeiro; passou para trás só por `MAX_URGENT_STREAK` vezes seguidas.
    assert order.index("lista") == MAX_URGENT_STREAK
    assert len(order) == 61


async def test_a_continuous_typing_stream_gives_way_after_the_wait_limit() -> None:
    now = Now()

    def tick() -> None:
        now.value += 0.5  # cada grupo digitado leva meio segundo

    lock = PriorityLock(monotonic=now, max_urgent_streak=1000)
    order = await typing_and_listing(lock, 30, tick)
    # Com 4 grupos (2 s) a lista já esperou o bastante: a vez seguinte é dela.
    assert order.index("lista") == int(MAX_NORMAL_WAIT_SECONDS / 0.5)


async def test_a_waiter_cancelled_after_being_handed_the_lock_passes_it_on() -> None:
    lock = PriorityLock()
    await lock.acquire()
    handed = asyncio.create_task(lock.acquire(urgent=True))
    after = asyncio.create_task(lock.acquire())
    await asyncio.sleep(0)
    lock.release()  # a vez vai para `handed`, que é cancelado antes de rodar
    handed.cancel()
    await asyncio.gather(handed, return_exceptions=True)
    assert await asyncio.wait_for(after, 2) is True
    lock.release()
    assert not lock.locked()


async def test_a_waiter_cancelled_while_waiting_leaves_the_queue() -> None:
    lock = PriorityLock()
    await lock.acquire()
    gone = asyncio.create_task(lock.acquire())
    await asyncio.sleep(0)
    gone.cancel()
    await asyncio.gather(gone, return_exceptions=True)
    lock.release()
    assert not lock.locked()
    # Sem fila, quem chega pega na hora.
    assert await asyncio.wait_for(lock.acquire(), 2) is True
