"""O worker de tela contra o `aiortc` real, com as duas pontas no mesmo processo (só loopback).

Cobre o que o canal falso de `test_pc_screen_worker.py` não alcança: o canal `screen` negociado, a
conferência do endereço do par (que lê partes internas do `aiortc`), o quadro binário fragmentado, a
espera real do buffer destravada por `bufferedamountlow` e o encerramento sem tarefas penduradas.
Nada toca a rede local nem o desktop: os candidatos são só `127.0.0.1` e a captura é falsa.
"""

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import pytest

from uniover_agent.adapters import pc_direct_aiortc, pc_screen_worker
from uniover_agent.adapters.pc_direct_aiortc import aiortc_installed
from uniover_agent.adapters.pc_screen_monitors import Monitor
from uniover_agent.adapters.pc_screen_worker import (
    CHUNK_BYTES,
    FRAME_HEADER,
    FRAME_MAGIC,
    FRAME_VERSION,
    Capture,
    FrameRequest,
    Offer,
    Probes,
    ScreenSession,
)
from uniover_agent.core.pc import lan
from uniover_agent.core.pc.absolute import layout_print

pytestmark = pytest.mark.skipif(not aiortc_installed(), reason="aiortc não está instalado")

TEST_TOKEN = "bilhete-de-teste-loopback"
# Limite de cada espera: só é atingido quando algo quebrou.
WAIT = 10
PRIMARY = Monitor(0, 0, 0, 1920, 1080, True)
# À esquerda e acima do principal: origem negativa no desktop virtual.
SECONDARY = Monitor(1, -1280, -200, 1280, 1024, False)


@pytest.fixture
def loopback_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configura o ambiente para que o loopback 127.0.0.1 seja aceito como rede local."""
    if "aiortc" not in pc_direct_aiortc._loaded:
        # Carrega antes: a carga instala a política de endereços, e a do teste vem depois dela.
        pc_direct_aiortc._loaded["aiortc"] = pc_direct_aiortc._import_aiortc()

    def addresses(use_ipv4: bool, use_ipv6: bool) -> list[str]:
        return ["127.0.0.1"]

    monkeypatch.setattr("aioice.ice.get_host_addresses", addresses)
    monkeypatch.setattr(lan, "ALLOW_LOOPBACK", True)


@pytest.fixture(autouse=True)
def no_real_desktop(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nenhum teste captura a tela nem mede o processo de verdade; quem envia quadro troca isto."""

    def capture(_request: FrameRequest, _previous_crc: int | None) -> Capture:
        raise AssertionError("Captura inesperada.")

    monkeypatch.setattr(pc_screen_worker, "capture_frame", capture)
    monkeypatch.setattr(pc_screen_worker, "private_bytes", lambda: 42_000_000)


class ScreenClient:
    """Cliente WebRTC que simula a outra ponta (app/visualizador) no loopback."""

    def __init__(self, aiortc: Any) -> None:
        self.aiortc = aiortc
        self.connection = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=[]))
        self.channel = self.connection.createDataChannel("screen", ordered=True)
        self.opened = asyncio.Event()
        self.closed = asyncio.Event()
        self.json_messages: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.binary_chunks: asyncio.Queue[bytes] = asyncio.Queue()
        self.channel.on("open", self.opened.set)
        self.channel.on("close", self.closed.set)
        self.channel.on("message", self._on_message)

    def _on_message(self, message: str | bytes) -> None:
        if isinstance(message, str):
            self.json_messages.put_nowait(json.loads(message))
        else:
            self.binary_chunks.put_nowait(message)

    async def offer(self) -> str:
        async with asyncio.timeout(WAIT):
            await self.connection.setLocalDescription(await self.connection.createOffer())
        return str(self.connection.localDescription.sdp)

    async def accept(self, answer_sdp: str) -> None:
        answer = self.aiortc.RTCSessionDescription(sdp=answer_sdp, type="answer")
        await asyncio.wait_for(self.connection.setRemoteDescription(answer), WAIT)

    def send_json(self, message: dict[str, Any]) -> None:
        self.channel.send(json.dumps(message))

    async def next_json(self) -> dict[str, Any]:
        return await asyncio.wait_for(self.json_messages.get(), WAIT)

    async def collect_chunks(self, total_bytes: int) -> list[bytes]:
        """Os pedaços binários, na ordem de chegada, até completar `total_bytes`."""
        chunks: list[bytes] = []
        async with asyncio.timeout(WAIT):
            while sum(map(len, chunks)) < total_bytes:
                chunks.append(await self.binary_chunks.get())
        return chunks

    async def close(self) -> None:
        await asyncio.wait_for(self.connection.close(), WAIT)


@dataclass
class Loopback:
    client: ScreenClient
    session: ScreenSession
    pipe_closed: asyncio.Event
    run_task: asyncio.Task[None]


async def assert_no_pending_tasks() -> None:
    """As tarefas das duas pontas (worker e `aiortc`) precisam terminar depois do fechamento."""

    def others() -> set[asyncio.Task[Any]]:
        return asyncio.all_tasks() - {asyncio.current_task()}

    try:
        async with asyncio.timeout(WAIT):
            while tasks := others():
                await asyncio.wait(tasks)
    except TimeoutError:
        pytest.fail(f"Tarefas penduradas: {others()}")


async def client_for_loopback() -> ScreenClient:
    return ScreenClient(await asyncio.wait_for(pc_direct_aiortc._load(), WAIT))


@contextlib.asynccontextmanager
async def running_session(probes: Probes) -> AsyncIterator[Loopback]:
    """`ScreenSession.run` ligado ao cliente, com o canal `screen` já aberto."""
    client = await client_for_loopback()
    pipe_closed = asyncio.Event()
    run_task: asyncio.Task[None] | None = None
    try:
        offer = Offer(sdp=await client.offer(), token=TEST_TOKEN, token_ttl=30, lifetime=60)
        session = ScreenSession(offer)
        answer: asyncio.Future[dict[str, str]] = asyncio.get_running_loop().create_future()
        run_task = asyncio.create_task(
            session.run(offer, pipe_closed, answer.set_result, contextlib.nullcontext, probes)
        )
        reply = await asyncio.wait_for(answer, WAIT)
        await client.accept(reply["sdp"])
        await asyncio.wait_for(client.opened.wait(), WAIT)
        yield Loopback(client, session, pipe_closed, run_task)
    finally:
        pipe_closed.set()
        try:
            if run_task is not None:
                await asyncio.wait_for(run_task, WAIT)
        finally:
            await client.close()
    await assert_no_pending_tasks()


async def test_screen_worker_loopback_full_flow(
    loopback_only: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fluxo completo: anúncio dos monitores, cursor no secundário, quadro maior que o limite do
    buffer, um segundo pedido (outro monitor) respondido depois dele e fechamento pelo cliente.
    """
    # Passa do limiar do laço (4 pedaços); o período 251 faz cada pedaço ser diferente dos outros.
    large_jpeg = (bytes(range(251)) * 400)[: 6 * CHUNK_BYTES + 123]
    small_jpeg = b"MONITOR-SECUNDARIO"
    captured: list[FrameRequest] = []

    def capture(request: FrameRequest, _previous_crc: int | None) -> Capture:
        captured.append(request)
        if request.monitor is None:
            return Capture(12345, 1280, 720, large_jpeg)
        return Capture(54321, 640, 512, small_jpeg)

    monkeypatch.setattr(pc_screen_worker, "capture_frame", capture)
    monitors = [PRIMARY, SECONDARY]
    probes = Probes(monitors=lambda: monitors, cursor=lambda: (-640, 100), state=lambda: "ok")

    async with running_session(probes) as loopback:
        client, session = loopback.client, loopback.session

        # Espia a espera real, sem trocá-la. Quando ela retorna, guarda o limiar, se havia o que
        # esperar na entrada e se o buffer de fato desceu até o limiar.
        waits: list[tuple[int, bool, bool]] = []
        real_wait = session.wait_buffer

        async def spy(threshold: int) -> None:
            blocked = session.channel.bufferedAmount > threshold
            await real_wait(threshold)
            waits.append((threshold, blocked, session.channel.bufferedAmount <= threshold))

        monkeypatch.setattr(session, "wait_buffer", spy)

        client.send_json({"k": "auth", "token": TEST_TOKEN})

        assert await client.next_json() == {
            "k": "s.mon",
            "monitors": [
                {"id": 0, "width": 1920, "height": 1080, "primary": True, "x": 0, "y": 0},
                {"id": 1, "width": 1280, "height": 1024, "primary": False, "x": -1280, "y": -200},
            ],
            "layout": layout_print(monitors),
        }
        assert await client.next_json() == {"k": "s.cur", "x": -640, "y": 100}

        # Com marca, o worker manda as estatísticas antes do quadro.
        client.send_json({"k": "s.get", "width": 1280, "fps": 5, "marker": 42, "reset": True})
        stats = await client.next_json()
        total = FRAME_HEADER.size + len(large_jpeg)
        assert stats["k"] == "s.stat"
        assert stats["bytes"] == total
        assert stats["privateMB"] == 42.0

        chunks = await client.collect_chunks(total)
        assert [len(chunk) for chunk in chunks] == [CHUNK_BYTES] * 6 + [FRAME_HEADER.size + 123]
        frame = b"".join(chunks)
        assert FRAME_HEADER.unpack(frame[: FRAME_HEADER.size]) == (
            FRAME_MAGIC,
            FRAME_VERSION,
            0,
            1280,
            720,
            1,
            len(large_jpeg),
        )
        assert frame[FRAME_HEADER.size :] == large_jpeg

        # O pedido seguinte só é atendido se a drenagem final do quadro anterior terminou.
        client.send_json({"k": "s.get", "width": 640, "fps": 10, "monitor": SECONDARY.id})
        second = b"".join(await client.collect_chunks(FRAME_HEADER.size + len(small_jpeg)))
        assert FRAME_HEADER.unpack(second[: FRAME_HEADER.size])[3:] == (
            640,
            512,
            2,
            len(small_jpeg),
        )
        assert second[FRAME_HEADER.size :] == small_jpeg
        assert [request.area for request in captured] == [None, SECONDARY.area]

        # As duas esperas do laço (entre pedaços e no fim do quadro) bloquearam e foram soltas.
        assert (4 * CHUNK_BYTES - 1, True, True) in waits
        assert (0, True, True) in waits
        assert all(drained for _threshold, _blocked, drained in waits)

        client.channel.close()
        await asyncio.wait_for(asyncio.shield(loopback.run_task), WAIT)
        assert not loopback.pipe_closed.is_set()
        assert session.closed.is_set()
        assert session.peer.connectionState == "closed"


async def test_screen_worker_loopback_wait_buffer_backpressure_and_event(
    loopback_only: None,
) -> None:
    """`wait_buffer` só retorna quando o canal real esvazia e dispara `bufferedamountlow`."""
    client = await client_for_loopback()
    session: ScreenSession | None = None
    try:
        offer = Offer(sdp=await client.offer(), token=TEST_TOKEN, token_ttl=30, lifetime=60)
        session = ScreenSession(offer)
        await client.accept(await asyncio.wait_for(session.answer(offer.sdp), WAIT))
        await asyncio.wait_for(client.opened.wait(), WAIT)
        assert session.channel is not None

        low_event_fired = asyncio.Event()
        session.channel.on("bufferedamountlow", low_event_fired.set)

        payload = b"B" * (64 * 1024)
        session.channel.send(payload)
        assert session.channel.bufferedAmount == len(payload)
        assert not low_event_fired.is_set()

        await asyncio.wait_for(session.wait_buffer(0), WAIT)

        assert low_event_fired.is_set()
        assert session.channel.bufferedAmount == 0
        assert await client.collect_chunks(len(payload)) == [payload]
    finally:
        try:
            if session is not None and session.peer is not None:
                await asyncio.wait_for(session.peer.close(), WAIT)
        finally:
            await client.close()
    await assert_no_pending_tasks()


async def test_screen_worker_loopback_same_frame_response(
    loopback_only: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Quadro repetido sem marca é respondido com `s.same` pelo canal real."""
    jpeg = b"IMAGE-DATA"

    def capture(_request: FrameRequest, previous_crc: int | None) -> Capture:
        return Capture(999, 640, 480, None if previous_crc == 999 else jpeg)

    monkeypatch.setattr(pc_screen_worker, "capture_frame", capture)
    request = {"k": "s.get", "width": 640, "fps": 10, "marker": 0, "reset": False}

    async with running_session(Probes(monitors=lambda: [PRIMARY])) as loopback:
        client = loopback.client
        client.send_json({"k": "auth", "token": TEST_TOKEN})
        assert (await client.next_json())["k"] == "s.mon"

        client.send_json(request)
        first = b"".join(await client.collect_chunks(FRAME_HEADER.size + len(jpeg)))
        assert first[FRAME_HEADER.size :] == jpeg

        client.send_json(request)
        assert await client.next_json() == {"k": "s.same", "crc": 999}
        assert client.binary_chunks.empty()


async def test_screen_worker_loopback_pipe_closed_termination(loopback_only: None) -> None:
    """O fim do pipe do processo pai encerra a sessão autorizada e derruba o canal do cliente."""
    async with running_session(Probes(monitors=lambda: [])) as loopback:
        client, session = loopback.client, loopback.session
        client.send_json({"k": "auth", "token": TEST_TOKEN})
        assert (await client.next_json())["k"] == "s.mon"
        assert not loopback.run_task.done()

        loopback.pipe_closed.set()
        await asyncio.wait_for(asyncio.shield(loopback.run_task), WAIT)

        assert session.peer.connectionState == "closed"
        await asyncio.wait_for(client.closed.wait(), WAIT)


async def test_screen_worker_loopback_invalid_auth_token_closes_session(
    loopback_only: None,
) -> None:
    """Token errado encerra a sessão sem anunciar monitores nem capturar."""
    async with running_session(Probes(monitors=lambda: [PRIMARY])) as loopback:
        client, session = loopback.client, loopback.session
        client.send_json({"k": "auth", "token": "token-falso"})

        await asyncio.wait_for(asyncio.shield(loopback.run_task), WAIT)
        await asyncio.wait_for(client.closed.wait(), WAIT)

        assert session.closed.is_set()
        assert not session.authorized
        assert session.peer.connectionState == "closed"
        assert client.json_messages.empty()
        assert client.binary_chunks.empty()
