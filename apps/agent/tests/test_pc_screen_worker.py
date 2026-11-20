"""Cobre o caminho de captura sem abrir o desktop ou uma conexão de rede."""

import asyncio
import json
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from io import BytesIO
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image

from uniover_agent.adapters import pc_screen_worker
from uniover_agent.adapters.pc_screen_worker import (
    CHUNK_BYTES,
    FRAME_TIMEOUT,
    FrameRequest,
    Offer,
    ScreenSession,
    encode_frame,
)
from uniover_agent.ports.pc_direct import SCREEN_MAX_LIFETIME_SECONDS


class Channel:
    def __init__(self) -> None:
        self.label = "screen"
        self.ordered = True
        self.maxRetransmits = None
        self.maxPacketLifeTime = None
        self.bufferedAmount = 0
        self.handlers: dict[str, Any] = {}
        self.sent: list[str | bytes] = []
        self.complete = asyncio.Event()

    def on(self, event: str, handler: Any) -> None:
        self.handlers[event] = handler

    def send(self, payload: str | bytes) -> None:
        self.sent.append(payload)
        if len(self.sent) == 4:
            self.complete.set()

    def close(self) -> None:
        if "close" in self.handlers:
            self.handlers["close"]()

    def message(self, **payload: Any) -> None:
        self.handlers["message"](json.dumps(payload))


def session(address: str) -> tuple[ScreenSession, Channel]:
    connection = SimpleNamespace(_nominated={1: SimpleNamespace(remote_addr=(address, 1234))})
    measure = ScreenSession(Offer("oferta", "bilhete-de-teste", 10, 60))
    measure.peer = SimpleNamespace(
        connectionState="connected",
        sctp=SimpleNamespace(
            transport=SimpleNamespace(transport=SimpleNamespace(_connection=connection))
        ),
    )
    channel = Channel()
    measure.adopt(channel)
    return measure, channel


async def test_auth_then_frame_with_marker_and_metrics() -> None:
    measure, channel = session("192.168.1.6")
    captured: list[FrameRequest] = []

    def capture(request: FrameRequest) -> bytes:
        captured.append(request)
        return b"x" * (CHUNK_BYTES + 1)

    task = asyncio.create_task(measure.stream(capture, lambda: 40_000_000, nullcontext))
    try:
        channel.message(k="s.get", marker=1)
        await asyncio.sleep(0)
        assert channel.sent == []
        assert captured == []

        channel.message(k="auth", token="bilhete-de-teste")
        channel.message(k="s.get", width=1280, fps=8, marker=42, reset=True)
        await asyncio.wait_for(channel.complete.wait(), timeout=1)
        ready, header, first, second = channel.sent
        assert json.loads(ready) == {"k": "ready"}
        assert json.loads(header)["bytes"] == CHUNK_BYTES + 1
        assert json.loads(header)["privateMB"] == 40
        assert first == b"x" * CHUNK_BYTES
        assert second == b"x"
        assert captured == [FrameRequest(1280, 8, 42, True)]
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_rejects_non_lan_expired_and_wrong_token() -> None:
    for address, token, expired in (
        ("8.8.8.8", "bilhete-de-teste", False),
        ("192.168.1.6", "outro-bilhete", False),
        ("192.168.1.6", "bilhete-de-teste", True),
    ):
        measure, channel = session(address)
        if expired:
            measure.auth_deadline -= 2 * FRAME_TIMEOUT
        channel.message(k="auth", token=token)
        assert measure.closed.is_set()
        assert not measure.authorized
        assert channel.sent == []


def test_jpeg_contains_all_marker_bits_at_requested_width() -> None:
    value = 0xB739
    with Image.new("RGB", (512, 288), "#887799") as image:
        jpeg = encode_frame(image, FrameRequest(128, 5, value, False))
    with Image.open(BytesIO(jpeg)) as decoded:
        assert decoded.size == (128, 72)
        rgb = decoded.convert("RGB")
        decoded_value = 0
        for bit in range(16):
            pixel = rgb.getpixel((4 + 8 * bit, 4))
            assert isinstance(pixel, tuple)
            if pixel[0] > 128:
                decoded_value |= 1 << bit
        assert decoded_value == value


async def test_closing_parent_pipe_closes_peer() -> None:
    offer = Offer("oferta", "bilhete-de-teste", 10, 60)
    pipe_closed = asyncio.Event()
    peer_closed = asyncio.Event()

    async def close_peer() -> None:
        peer_closed.set()

    class Session(ScreenSession):
        async def answer(self, sdp: str) -> str:
            assert sdp == "oferta"
            self.peer = SimpleNamespace(close=close_peer)
            return "resposta"

    replies: list[dict[str, str]] = []

    def reply(data: dict[str, str]) -> None:
        replies.append(data)
        pipe_closed.set()

    await asyncio.wait_for(Session(offer).run(offer, pipe_closed, reply, nullcontext), timeout=1)
    assert peer_closed.is_set()
    assert replies == [{"sdp": "resposta"}]


async def test_capture_respects_requested_frame_period(monkeypatch: pytest.MonkeyPatch) -> None:
    measure, _channel = session("192.168.1.6")
    request = FrameRequest(1280, 8, 0, False)
    measure.requests.put_nowait(request)
    now = 100.0
    captures: list[float] = []

    async def sleep(delay: float) -> None:
        nonlocal now
        now += delay

    async def capture_in_thread(_capture: Any, request: FrameRequest) -> bytes:
        captures.append(now)
        if len(captures) == 1:
            measure.requests.put_nowait(request)
        else:
            measure.closed.set()
        return b"jpeg"

    monkeypatch.setattr(pc_screen_worker, "monotonic", lambda: now)
    monkeypatch.setattr(pc_screen_worker.asyncio, "sleep", sleep)
    monkeypatch.setattr(pc_screen_worker.asyncio, "to_thread", capture_in_thread)
    await measure.send_frames(lambda _request: b"", lambda: 40_000_000)
    assert captures == [100.0, 100.125]


@pytest.mark.parametrize("keep_requesting", [False, True], ids=["sem-pedidos", "tempo-maximo"])
async def test_worker_closes_when_the_screen_deadline_expires(
    monkeypatch: pytest.MonkeyPatch, keep_requesting: bool
) -> None:
    loop = asyncio.get_running_loop()
    now = loop.time()
    monkeypatch.setattr(loop, "time", lambda: now)
    monkeypatch.setattr(pc_screen_worker, "monotonic", lambda: now)
    offer = Offer("oferta", "bilhete-de-teste", 10, SCREEN_MAX_LIFETIME_SECONDS)
    measure, channel = session("192.168.1.6")
    measure.deadline = now + offer.lifetime
    peer_closed = asyncio.Event()
    viewing_started = asyncio.Event()

    async def close_peer() -> None:
        peer_closed.set()

    async def answer(_sdp: str) -> str:
        return "resposta"

    @contextmanager
    def viewing() -> Iterator[None]:
        viewing_started.set()
        yield

    monkeypatch.setattr(measure.peer, "close", close_peer, raising=False)
    monkeypatch.setattr(measure, "answer", answer)

    async def capture_in_thread(_capture: Any, _request: FrameRequest) -> bytes:
        return b"jpeg"

    monkeypatch.setattr(pc_screen_worker.asyncio, "to_thread", capture_in_thread)
    monkeypatch.setattr(pc_screen_worker, "private_bytes", lambda: 0)
    channel.message(k="auth", token=offer.token)
    task = asyncio.create_task(measure.run(offer, asyncio.Event(), lambda _reply: None, viewing))
    try:
        await viewing_started.wait()
        if keep_requesting:
            # Mantém o fluxo ativo até o limite, inclusive com pedido pendente nesse instante.
            for _ in range((offer.lifetime - 1) // (FRAME_TIMEOUT - 1)):
                now += FRAME_TIMEOUT - 1
                channel.message(k="s.get")
                await asyncio.sleep(0)
            assert not task.done()
            assert len(channel.sent) > 1
            now = measure.deadline
            channel.message(k="s.get")
        else:
            now += FRAME_TIMEOUT
        for _ in range(10):
            await asyncio.sleep(0)
        assert task.done()
        await task
        assert peer_closed.is_set()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_pipe_ignores_bytes_after_the_offer_until_eof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = asyncio.get_running_loop()
    offer: asyncio.Future[bytes] = loop.create_future()
    closed = asyncio.Event()
    chunks = iter([b'{"sdp":', b'"oferta"}\nresto', b"mais bytes", b""])
    reads: list[bytes] = []

    def read(_fd: int, _size: int) -> bytes:
        chunk = next(chunks)
        reads.append(chunk)
        return chunk

    monkeypatch.setattr(
        pc_screen_worker, "sys", SimpleNamespace(stdin=SimpleNamespace(fileno=lambda: 0))
    )
    monkeypatch.setattr(pc_screen_worker, "os", SimpleNamespace(read=read))
    pc_screen_worker._read_pipe(loop, offer, closed)

    assert await offer == b'{"sdp":"oferta"}'
    assert reads[-2:] == [b"mais bytes", b""]
    assert closed.is_set()
