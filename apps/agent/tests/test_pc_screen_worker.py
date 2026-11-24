"""Cobre o caminho de captura sem abrir o desktop ou uma conexão de rede."""

import asyncio
import json
import sys
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from io import BytesIO
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image

from uniover_agent.adapters import pc_screen_worker
from uniover_agent.adapters.pc_screen_monitors import Monitor, list_monitors
from uniover_agent.adapters.pc_screen_worker import (
    CHUNK_BYTES,
    FRAME_HEADER,
    FRAME_MAGIC,
    FRAME_TIMEOUT,
    Capture,
    FrameRequest,
    Offer,
    Probes,
    ScreenSession,
    capture_frame,
    encode_frame,
)
from uniover_agent.ports.pc_direct import SCREEN_MAX_LIFETIME_SECONDS

WORKER = "uniover_agent.adapters.pc_screen_worker"


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

    def capture(request: FrameRequest, _previous: int | None) -> Capture:
        captured.append(request)
        return Capture(7, 1280, 720, b"x" * (CHUNK_BYTES + 1))

    task = asyncio.create_task(measure.stream(capture, lambda: 40_000_000, nullcontext))
    try:
        channel.message(k="s.get", marker=1)
        await asyncio.sleep(0)
        assert channel.sent == []
        assert captured == []

        channel.message(k="auth", token="bilhete-de-teste")
        channel.message(k="s.get", width=1280, fps=8, marker=42, reset=True)
        await asyncio.wait_for(channel.complete.wait(), timeout=1)
        monitor, stats, first, second = channel.sent
        assert json.loads(monitor) == {"k": "s.mon", "monitors": []}
        assert json.loads(stats)["bytes"] == FRAME_HEADER.size + CHUNK_BYTES + 1
        assert json.loads(stats)["privateMB"] == 40
        assert isinstance(first, bytes) and isinstance(second, bytes)
        assert len(first) == CHUNK_BYTES
        assert FRAME_HEADER.size == 16
        magic, _version, _flags, width, height, sequence, size = FRAME_HEADER.unpack(
            first[: FRAME_HEADER.size]
        )
        assert (magic, width, height, sequence, size) == (
            FRAME_MAGIC,
            1280,
            720,
            1,
            CHUNK_BYTES + 1,
        )
        assert (first + second)[FRAME_HEADER.size :] == b"x" * (CHUNK_BYTES + 1)
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
        shot = encode_frame(image, FrameRequest(128, 5, value, False))
    assert shot.jpeg is not None
    with Image.open(BytesIO(shot.jpeg)) as decoded:
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

    await asyncio.wait_for(
        Session(offer).run(offer, pipe_closed, reply, nullcontext, Probes()), timeout=1
    )
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

    async def capture_in_thread(_capture: Any, request: FrameRequest, _previous: Any) -> Capture:
        captures.append(now)
        if len(captures) == 1:
            measure.requests.put_nowait(request)
        else:
            measure.closed.set()
        return Capture(1, 1, 1, b"jpeg")

    monkeypatch.setattr(pc_screen_worker, "monotonic", lambda: now)
    monkeypatch.setattr(f"{WORKER}.asyncio.sleep", sleep)
    monkeypatch.setattr(f"{WORKER}.asyncio.to_thread", capture_in_thread)
    await measure.send_frames(lambda _request, _previous: Capture(0, 1, 1, b""), lambda: 40_000_000)
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

    async def capture_in_thread(_capture: Any, _request: FrameRequest, _previous: Any) -> Capture:
        return Capture(1, 1, 1, b"jpeg")

    monkeypatch.setattr(f"{WORKER}.asyncio.to_thread", capture_in_thread)
    monkeypatch.setattr(pc_screen_worker, "private_bytes", lambda: 0)
    channel.message(k="auth", token=offer.token)
    task = asyncio.create_task(
        measure.run(offer, asyncio.Event(), lambda _reply: None, viewing, Probes())
    )
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


def test_same_crop_skips_the_jpeg_but_not_a_marked_or_reset_request() -> None:
    with Image.new("RGB", (256, 144), "#336699") as image:
        first = encode_frame(image, FrameRequest(128, 5, 0, False))
        same = encode_frame(image, FrameRequest(128, 5, 0, False), first.crc)
        reset = encode_frame(image, FrameRequest(128, 5, 0, True), first.crc)
        marked = encode_frame(image, FrameRequest(128, 5, 3, False), first.crc)
        other = encode_frame(image, FrameRequest(64, 5, 0, False), first.crc)
    assert first.jpeg is not None
    assert (same.jpeg, same.crc) == (None, first.crc)
    assert reset.jpeg is not None and marked.jpeg is not None
    assert marked.crc == first.crc
    assert other.jpeg is not None


async def test_unchanged_screen_answers_s_same_and_cursor_is_throttled() -> None:
    measure, channel = session("192.168.1.6")
    measure.authorized = True
    measure.ready.set()
    positions = iter([(1, 2), (1, 2), (3, 4)])
    calls = 0

    def capture(_request: FrameRequest, previous: int | None) -> Capture:
        nonlocal calls
        calls += 1
        return Capture(9, 10, 10, None if previous == 9 else b"jpeg")

    def cursor() -> tuple[int, int] | None:
        return next(positions, (3, 4))

    probes = Probes(monitors=lambda: [Monitor(0, 0, 0, 1920, 1080, True)], cursor=cursor)
    task = asyncio.create_task(measure.stream(capture, lambda: 0, nullcontext, probes))
    try:
        channel.message(k="s.get")
        await asyncio.sleep(0.2)
        channel.message(k="s.get")
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    texts = [json.loads(item) for item in channel.sent if isinstance(item, str)]
    assert texts[0] == {
        "k": "s.mon",
        "monitors": [{"id": 0, "width": 1920, "height": 1080, "primary": True}],
    }
    assert {"k": "s.same", "crc": 9} in texts
    cursors = [item for item in texts if item["k"] == "s.cur"]
    assert [(item["x"], item["y"]) for item in cursors] == [(1, 2), (3, 4)]
    assert sum(isinstance(item, bytes) for item in channel.sent) == 1


async def test_locked_screen_is_reported_while_idle_and_ends_the_session() -> None:
    measure, channel = session("192.168.1.6")
    measure.authorized = True
    measure.ready.set()
    states = iter(["ok", "elevated", "elevated", "locked"])
    probes = Probes(state=lambda: next(states, "locked"))
    task = asyncio.create_task(
        measure.stream(lambda _r, _p: Capture(0, 1, 1, b""), lambda: 0, nullcontext, probes)
    )
    try:
        await asyncio.wait_for(measure.closed.wait(), timeout=2)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    reported = [json.loads(item)["state"] for item in channel.sent if "state" in str(item)]
    assert reported == ["elevated", "locked"]


def test_same_pixels_with_swapped_dimensions_are_not_the_same_frame() -> None:
    data = bytes(range(256)) * 576
    with (
        Image.frombytes("RGB", (192, 256), data) as tall,
        Image.frombytes("RGB", (256, 192), data) as wide,
    ):
        first = encode_frame(tall, FrameRequest(1920, 5, 0, False))
        second = encode_frame(wide, FrameRequest(1920, 5, 0, False), first.crc)
    assert second.jpeg is not None
    assert second.crc != first.crc


async def test_frame_after_a_marked_one_is_never_answered_with_s_same() -> None:
    measure, channel = session("192.168.1.6")
    measure.authorized = True
    measure.ready.set()
    bases: list[int | None] = []

    def capture(request: FrameRequest, previous: int | None) -> Capture:
        bases.append(previous)
        return Capture(7, 10, 10, None if previous == 7 and not request.marker else b"jpeg")

    task = asyncio.create_task(measure.stream(capture, lambda: 0, nullcontext))
    try:
        for marker in (0, 5, 0, 0):
            channel.message(k="s.get", fps=10, marker=marker)
            await asyncio.sleep(0.25)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    texts = [json.loads(item) for item in channel.sent if isinstance(item, str)]
    assert bases == [None, 7, None, 7]
    assert [item for item in texts if item["k"] == "s.same"] == [{"k": "s.same", "crc": 7}]


async def test_capture_lock_waits_for_the_notice_being_drained() -> None:
    measure, channel = session("192.168.1.6")
    measure.authorized = True
    measure.ready.set()
    channel.bufferedAmount = 1
    release = asyncio.Event()

    async def hold(_threshold: int) -> None:
        await release.wait()

    measure.wait_buffer = hold  # type: ignore[method-assign,assignment]
    notice = asyncio.create_task(measure.report_state("locked"))
    await asyncio.sleep(0.05)
    second = asyncio.create_task(measure.report_state("locked"))
    await asyncio.sleep(0.05)
    assert not notice.done() and not second.done()
    release.set()
    await asyncio.wait_for(asyncio.gather(notice, second), timeout=2)
    assert measure.closed.is_set()


PRIMARY = Monitor(0, 0, 0, 1920, 1080, True)
LEFT = Monitor(1, -1280, -200, 1280, 1024, False)


def test_frame_request_monitor_is_optional_and_validated() -> None:
    assert FrameRequest.parse({"k": "s.get"}).monitor is None
    assert FrameRequest.parse({"k": "s.get", "monitor": 3}).monitor == 3
    assert FrameRequest.parse({"k": "s.get", "monitor": None}).monitor is None
    for bad in (True, -1, 1.5, "1", 2**31):
        with pytest.raises(ValueError):
            FrameRequest.parse({"k": "s.get", "monitor": bad})


async def test_s_mon_lists_every_monitor_and_requests_pick_one_by_id() -> None:
    measure, channel = session("192.168.1.6")
    measure.authorized = True
    measure.ready.set()
    areas: list[tuple[int, int, int, int] | None] = []

    def capture(request: FrameRequest, _previous: int | None) -> Capture:
        areas.append(request.area)
        return Capture(len(areas), 10, 10, b"jpeg")

    probes = Probes(monitors=lambda: [LEFT, PRIMARY])
    task = asyncio.create_task(measure.stream(capture, lambda: 0, nullcontext, probes))
    try:
        channel.message(k="s.get")
        await asyncio.sleep(0.05)
        channel.message(k="s.get", monitor=1)
        await asyncio.sleep(0.3)
        channel.message(k="s.get", monitor=0)
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    first = json.loads(channel.sent[0])
    assert first == {
        "k": "s.mon",
        "monitors": [
            {"id": 1, "width": 1280, "height": 1024, "primary": False},
            {"id": 0, "width": 1920, "height": 1080, "primary": True},
        ],
    }
    # Sem monitor pedido a captura fica no caminho do principal (sem área).
    assert areas == [None, (-1280, -200, 0, 824), (0, 0, 1920, 1080)]


async def test_monitor_layout_is_reread_and_announced_when_it_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(f"{WORKER}.MONITOR_RECHECK_FRAMES", 2)
    measure, channel = session("192.168.1.6")
    measure.authorized = True
    measure.ready.set()
    layout = [PRIMARY]
    areas: list[tuple[int, int, int, int] | None] = []

    def capture(request: FrameRequest, _previous: int | None) -> Capture:
        areas.append(request.area)
        return Capture(len(areas), 10, 10, b"jpeg")

    task = asyncio.create_task(
        measure.stream(capture, lambda: 0, nullcontext, Probes(monitors=lambda: list(layout)))
    )
    try:
        channel.message(k="s.get", monitor=0)
        await asyncio.sleep(0.1)
        layout[:] = [Monitor(0, 0, 0, 2560, 1440, True)]
        for _ in range(3):
            channel.message(k="s.get", monitor=0)
            await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    texts = [json.loads(m) for m in channel.sent if isinstance(m, str)]
    announced = [m for m in texts if m.get("k") == "s.mon"]
    assert [a["monitors"][0]["width"] for a in announced] == [1920, 2560]
    assert areas[0] == (0, 0, 1920, 1080)
    assert areas[-1] == (0, 0, 2560, 1440)


async def test_unknown_monitor_triggers_a_layout_reread_before_rejecting() -> None:
    measure, channel = session("192.168.1.6")
    measure.authorized = True
    measure.ready.set()
    layout = [PRIMARY]
    areas: list[tuple[int, int, int, int] | None] = []

    def capture(request: FrameRequest, _previous: int | None) -> Capture:
        areas.append(request.area)
        return Capture(1, 10, 10, b"jpeg")

    task = asyncio.create_task(
        measure.stream(capture, lambda: 0, nullcontext, Probes(monitors=lambda: list(layout)))
    )
    try:
        await asyncio.sleep(0.05)
        layout.append(LEFT)
        channel.message(k="s.get", monitor=1)
        await asyncio.sleep(0.2)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert (measure.invalid, areas) == (0, [LEFT.area])


async def test_unknown_monitor_is_an_invalid_request_and_the_loop_survives() -> None:
    measure, channel = session("192.168.1.6")
    measure.authorized = True
    measure.ready.set()
    captured: list[FrameRequest] = []

    def capture(request: FrameRequest, _previous: int | None) -> Capture:
        captured.append(request)
        return Capture(1, 10, 10, b"jpeg")

    task = asyncio.create_task(
        measure.stream(capture, lambda: 0, nullcontext, Probes(monitors=lambda: [PRIMARY]))
    )
    try:
        channel.message(k="s.get", monitor=7)
        await asyncio.sleep(0.05)
        assert (measure.invalid, captured, measure.closed.is_set()) == (1, [], False)
        channel.message(k="s.get")
        await asyncio.sleep(0.1)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(captured) == 1 and captured[0].monitor is None


def test_capture_uses_the_virtual_rectangle_and_the_width_limit_applies_to_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    grabbed: list[dict[str, Any]] = []

    def grab(**kwargs: Any) -> Image.Image:
        grabbed.append(kwargs)
        return Image.new("RGB", (1280, 1024), "#112233")

    monkeypatch.setattr(f"{WORKER}.ImageGrab.grab", grab)
    monkeypatch.setattr(
        "uniover_agent.adapters.pc_windows._input_desktop_name",
        lambda: "default",
        raising=False,
    )
    request = FrameRequest(640, 5, 0, False, 1, LEFT.area)
    shot = capture_frame(request)
    assert grabbed == [{"bbox": (-1280, -200, 0, 824), "all_screens": True}]
    assert (shot.width, shot.height) == (640, 512)


@pytest.mark.skipif(sys.platform != "win32", reason="usa a API real de monitores do Windows")
def test_list_monitors_reads_the_real_layout() -> None:
    monitors = list_monitors()
    assert monitors
    assert [m.id for m in monitors] == list(range(len(monitors)))
    assert sum(m.primary for m in monitors) == 1
    assert all(m.width > 0 and m.height > 0 for m in monitors)
