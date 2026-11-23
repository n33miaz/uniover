"""Ordem entre as duas entradas das teclas da TV: a nuvem (socket) e o canal direto (a ponte).

Aqui o laço de eventos é o de verdade. A nuvem é um socket local lido por um leitor que entrega
cada quadro ao `ProcessMessage`, no formato do leitor do agente (`Connection._read`). O canal
direto é a `TvDirectBridge` de produção, chamada de outra thread, como o laço do canal faz, e
levando a tecla ao laço principal com `call_soon_threadsafe`, como o `MainLoopCaller`. A faixa da
TV fica no laço principal, que é o padrão: a faixa em thread própria está desligada.

O que estes testes delimitam:

* **garantido:** a cadeia das teclas executa na ordem em que cada tecla ENTRA nela, venha de onde
  vier. Uma tecla da nuvem cujo quadro o leitor já entregou fica na frente de uma tecla direta que
  chega depois, mesmo que a TV ainda esteja ocupada com ela. Cada caminho, sozinho, mantém a própria
  ordem, mesmo depois de uma parada do laço;
* **não garantido:** a ordem de CHEGADA ao agente entre os dois caminhos. A tecla direta entra
  quando o callback dela roda; a da nuvem, só quando o laço lê o socket e o leitor processa o
  quadro. Depois de uma parada, os callbacks postados durante ela já estão na fila de prontos, e o
  socket só é consultado depois. Uma tecla da nuvem que chegou antes, durante a parada, passa a
  executar depois da direta. O transporte de verdade (websockets) põe mais um passo no caminho da
  nuvem, o que só aumenta essa vantagem do canal direto.
"""

import asyncio
import json
import socket
import threading
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvRemote
from uniover_agent.core import (
    Command,
    CommandResult,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ProcessMessage,
    TvSessionManager,
    tv_key_handler,
)
from uniover_agent.core.pc.tv_bridge import TvDirectBridge

from .support import AGENT_ID, dump, envelope

# Teto de cada espera: nada aqui depende de tempo, só de eventos; o teto só evita travar a suíte.
WAIT_SECONDS = 5.0


class GatedRemote(FakeTvRemote):
    """Com `hold` ligado, a próxima tecla avisa (`busy`) e espera `gate`: a TV ainda ocupada.

    Cada tecla aplicada vai também para `applied`, que o teste consome na ordem."""

    def __init__(self) -> None:
        super().__init__()
        self.hold = False
        self.busy = asyncio.Event()
        self.gate = asyncio.Event()
        self.applied: asyncio.Queue[str] = asyncio.Queue()

    async def send_key(
        self, key: str, direction: str = "SHORT", *, before_send: Callable[[], None] | None = None
    ) -> None:
        if self.hold:
            self.hold = False
            self.busy.set()
            await self.gate.wait()
        await super().send_key(key, direction, before_send=before_send)
        self.applied.put_nowait(key)


@dataclass
class Rig:
    process: ProcessMessage
    remote: GatedRemote
    bridge: TvDirectBridge
    cloud: socket.socket
    clock: FakeClock
    # Cada tecla, no instante em que entrou na cadeia (o leitor a processou ou o callback da ponte
    # rodou no laço principal).
    entered: asyncio.Queue[str]
    direct_results: list[str]

    def write_cloud(self, key: str) -> None:
        """Um quadro da nuvem com a tecla, no socket (de qualquer thread)."""
        frame = dump(envelope("tv.key.v3", {"key": key}))
        self.cloud.sendall(frame.encode() + b"\n")

    def submit_direct(self, key: str) -> None:
        """Uma tecla pelo canal direto (chamado da thread do canal)."""
        self.bridge.submit(
            Command(f"direto-{key}", "tv.key.v3", {"key": key}),
            self.clock.monotonic(),
            lambda result: self.direct_results.append(result.status.value),
        )

    async def wait_keys(self, count: int) -> list[str]:
        """As próximas `count` teclas que a TV aplicou, na ordem."""
        async with asyncio.timeout(WAIT_SECONDS):
            return [await self.remote.applied.get() for _ in range(count)]

    async def wait_entered(self, key: str) -> None:
        """Espera `key` entrar na cadeia (executando ou ainda na vez)."""
        async with asyncio.timeout(WAIT_SECONDS):
            assert await self.entered.get() == key


async def read_cloud(
    reader: asyncio.StreamReader, process: ProcessMessage, entered: asyncio.Queue[str]
) -> None:
    # Como o leitor do agente: um quadro por vez, entregue ao `ProcessMessage` antes do próximo.
    while line := await reader.readline():
        await process(line.decode())
        entered.put_nowait(json.loads(line)["body"]["key"])


@asynccontextmanager
async def rig() -> AsyncIterator[Rig]:
    loop = asyncio.get_running_loop()
    clock = FakeClock()  # parado: nenhuma tecla envelhece; só a ordem está em jogo
    remote = GatedRemote()
    session = TvSessionManager(clock, remote)
    keys = tv_key_handler(session, monotonic=clock.monotonic)
    gate = EnvelopeGate(AGENT_ID)
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({"tv.key.v3": keys}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        FakeTransport(),
        monotonic=clock.monotonic,
    )

    entered: asyncio.Queue[str] = asyncio.Queue()

    def deliver(
        command: Command,
        received_at: float,
        on_result: Callable[[CommandResult], None],
        valid: Callable[[], bool],
    ) -> None:
        process.submit_direct_tv(command, received_at, on_result, valid)
        entered.put_nowait(command.body["key"])

    def to_main(callback: Callable[..., None], *args: Any) -> None:
        # Como o `MainLoopCaller`: da thread do canal ao laço principal, sem esperar.
        loop.call_soon_threadsafe(callback, *args)

    def to_lane(callback: Callable[[], None]) -> None:
        callback()  # o `ack` voltaria ao laço do canal; aqui só se anota o resultado

    bridge = TvDirectBridge(deliver, to_main=to_main, to_lane=to_lane)
    agent_side, cloud_side = socket.socketpair()
    reader, writer = await asyncio.open_connection(sock=agent_side)
    reading = asyncio.create_task(read_cloud(reader, process, entered))
    built = Rig(process, remote, bridge, cloud_side, clock, entered, [])
    try:
        # A sessão já aberta, como no uso: a primeira tecla abre e as do teste só disputam a vez.
        built.write_cloud("HOME")
        await built.wait_entered("HOME")
        assert await built.wait_keys(1) == ["HOME"]
        yield built
    finally:
        cloud_side.close()
        reading.cancel()
        await asyncio.gather(reading, return_exceptions=True)
        writer.close()
        await asyncio.gather(writer.wait_closed(), return_exceptions=True)
        await process.aclose()


async def stall_while(action: Callable[[], None]) -> None:
    """Prende o laço principal (um callback que bloqueia) enquanto outra thread roda `action`.

    Tudo o que `action` manda (bytes no socket, teclas pela ponte) chega com o laço parado."""
    loop = asyncio.get_running_loop()
    stalled = threading.Event()
    release = threading.Event()

    def block() -> None:
        stalled.set()
        release.wait(WAIT_SECONDS)

    def other_thread() -> None:
        if stalled.wait(WAIT_SECONDS):
            try:
                action()
            finally:
                release.set()

    worker = threading.Thread(target=other_thread)
    worker.start()
    loop.call_soon(block)
    try:
        await asyncio.sleep(0)  # o `block` roda aqui e só volta com a ação feita
    finally:
        release.set()
        await asyncio.to_thread(worker.join, WAIT_SECONDS)
    assert stalled.is_set()


# --- garantido --------------------------------------------------------------------------------


async def test_a_cloud_key_already_read_stays_ahead_of_a_later_direct_key() -> None:
    async with rig() as r:
        r.remote.hold = True
        r.write_cloud("RIGHT")
        await r.wait_entered("RIGHT")
        await asyncio.wait_for(r.remote.busy.wait(), WAIT_SECONDS)

        # A TV ainda está com o RIGHT quando o OK chega pela ponte.
        await asyncio.to_thread(r.submit_direct, "OK")
        await r.wait_entered("OK")
        r.remote.gate.set()

        assert await r.wait_keys(2) == ["RIGHT", "OK"]
        assert r.direct_results == ["ok"]


async def test_a_direct_key_already_queued_stays_ahead_of_a_later_cloud_key() -> None:
    async with rig() as r:
        r.remote.hold = True
        await asyncio.to_thread(r.submit_direct, "DOWN")
        await r.wait_entered("DOWN")
        await asyncio.wait_for(r.remote.busy.wait(), WAIT_SECONDS)

        r.write_cloud("LEFT")
        await r.wait_entered("LEFT")
        r.remote.gate.set()

        assert await r.wait_keys(2) == ["DOWN", "LEFT"]


async def test_each_path_keeps_its_own_order_across_a_stall() -> None:
    async with rig() as r:

        def arrive() -> None:
            r.write_cloud("RIGHT")
            r.submit_direct("UP")
            r.write_cloud("LEFT")
            r.submit_direct("DOWN")

        await stall_while(arrive)
        sent = await r.wait_keys(4)

        cloud = [key for key in sent if key in {"RIGHT", "LEFT"}]
        direct = [key for key in sent if key in {"UP", "DOWN"}]
        assert cloud == ["RIGHT", "LEFT"]
        assert direct == ["UP", "DOWN"]


# --- não garantido ----------------------------------------------------------------------------


class DirectOvertookCloud(AssertionError):  # noqa: N818 - lê-se como o fato observado
    """A tecla direta, que chegou depois, executou antes da tecla da nuvem."""


@pytest.mark.xfail(
    raises=DirectOvertookCloud,
    strict=True,
    reason=(
        "a ordem de chegada entre a nuvem e o canal direto não é garantida depois de uma parada "
        "do laço: a tecla direta entra na cadeia antes de o socket ser lido"
    ),
)
async def test_a_cloud_key_that_arrived_first_during_a_stall_runs_first() -> None:
    async with rig() as r:

        def arrive() -> None:
            r.write_cloud("RIGHT")  # chega primeiro ao agente...
            r.submit_direct("OK")  # ...e esta depois, ainda com o laço parado

        await stall_while(arrive)
        sent = await r.wait_keys(2)

        # Só a inversão é a falha esperada; qualquer outra coisa (tecla perdida, repetida, prazo
        # estourado) falha o teste de verdade.
        if sent == ["OK", "RIGHT"]:
            raise DirectOvertookCloud(sent)
        assert sent == ["RIGHT", "OK"]
