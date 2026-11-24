"""Processo de medição de fotos JPEG pela rede local."""

import asyncio
import contextlib
import ctypes
import hmac
import json
import os
import struct
import sys
import zlib
from collections.abc import Callable
from contextlib import AbstractContextManager
from ctypes import wintypes
from dataclasses import dataclass
from io import BytesIO
from threading import Thread
from time import monotonic, process_time
from typing import Any

from PIL import Image, ImageDraw, ImageGrab

from uniover_agent.adapters.pc_direct_aiortc import _load, prepare_offer
from uniover_agent.adapters.pc_direct_network import is_lan_address
from uniover_agent.adapters.pc_screen_presence import screen_indicator
from uniover_agent.adapters.pc_screen_probes import STATE_LOCKED, STATE_OK, read_cursor, read_state
from uniover_agent.adapters.pc_windows import USER_DESKTOP
from uniover_agent.ports.pc_direct import SCREEN_MAX_LIFETIME_SECONDS

CHUNK_BYTES = 16 * 1024
FRAME_TIMEOUT = 10
MAX_OFFER_BYTES = 128 * 1024
MAX_MESSAGE_CHARS = 4096
MAX_INVALID = 30
MIN_WIDTH = 128
MAX_WIDTH = 1920
MAX_FPS = 10
MARKER_BITS = 16
MARKER_CELL = 8
MAX_MARKER = (1 << MARKER_BITS) - 1
CURSOR_INTERVAL = 1 / 30
STATE_INTERVAL = 0.25
FRAME_MAGIC = b"UOSF"
FRAME_VERSION = 1
# Cabeçalho de 16 bytes: magic, versão, flags (reservado), largura, altura, sequência, tamanho.
FRAME_HEADER = struct.Struct(">4sBBHHHI")


def _integer(value: Any, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ValueError("Valor numérico inválido.")
    return value


@dataclass(frozen=True)
class Offer:
    sdp: str
    token: str
    token_ttl: int
    lifetime: int

    @classmethod
    def parse(cls, line: bytes) -> Offer:
        data = json.loads(line)
        if not isinstance(data, dict):
            raise ValueError("Oferta inválida.")
        sdp, token = data.get("sdp"), data.get("token")
        if (
            not isinstance(sdp, str)
            or not isinstance(token, str)
            or not token
            or not token.isascii()
        ):
            raise ValueError("Oferta inválida.")
        return cls(
            sdp,
            token,
            _integer(data.get("tokenTtlSeconds"), 1, SCREEN_MAX_LIFETIME_SECONDS),
            _integer(data.get("maxLifetimeSeconds"), 1, SCREEN_MAX_LIFETIME_SECONDS),
        )


@dataclass(frozen=True)
class FrameRequest:
    width: int
    fps: int
    marker: int
    reset: bool

    @classmethod
    def parse(cls, message: dict[str, Any]) -> FrameRequest:
        reset = message.get("reset", False)
        if message.get("k") != "s.get" or not isinstance(reset, bool):
            raise ValueError("Pedido de quadro inválido.")
        return cls(
            _integer(message.get("width", 1280), MIN_WIDTH, MAX_WIDTH),
            _integer(message.get("fps", 5), 1, MAX_FPS),
            _integer(message.get("marker", 0), 0, MAX_MARKER),
            reset,
        )


class DesktopLockedError(RuntimeError):
    """O desktop de entrada deixou de ser o do usuário."""


@dataclass(frozen=True)
class Capture:
    """Um recorte já reduzido. `jpeg` é `None` quando o CRC32 é igual ao do quadro anterior."""

    crc: int
    width: int
    height: int
    jpeg: bytes | None


def frame_header(capture: Capture, sequence: int) -> bytes:
    if capture.jpeg is None:
        raise ValueError("Quadro sem imagem.")
    return FRAME_HEADER.pack(
        FRAME_MAGIC,
        FRAME_VERSION,
        0,
        capture.width,
        capture.height,
        sequence & 0xFFFF,
        len(capture.jpeg),
    )


def encode_frame(
    image: Image.Image, request: FrameRequest, previous_crc: int | None = None
) -> Capture:
    image = image.convert("RGB")
    if image.width > request.width:
        height = max(1, round(image.height * request.width / image.width))
        image = image.resize((request.width, height), Image.Resampling.BOX)
    # O CRC cobre só o recorte, antes da marca de medição, que muda a cada pedido.
    crc = zlib.crc32(image.tobytes())
    if request.marker == 0 and not request.reset and crc == previous_crc:
        return Capture(crc, image.width, image.height, None)
    if request.marker:
        marker = ImageDraw.Draw(image)
        for bit in range(MARKER_BITS):
            x = bit * MARKER_CELL
            tone = 255 if request.marker & (1 << bit) else 0
            marker.rectangle((x, 0, x + MARKER_CELL - 1, MARKER_CELL - 1), fill=(tone, tone, tone))
    with BytesIO() as output:
        image.save(output, format="JPEG", quality=60)
        return Capture(crc, image.width, image.height, output.getvalue())


def capture_frame(request: FrameRequest, previous_crc: int | None = None) -> Capture:
    from uniover_agent.adapters.pc_windows import _input_desktop_name  # noqa: PLC0415

    desktop = _input_desktop_name()
    if desktop is None or desktop.lower() != USER_DESKTOP:
        raise DesktopLockedError
    # O monitor principal sempre começa em (0, 0). O modo DPI do processo fornece pixels físicos.
    metrics = ctypes.windll.user32.GetSystemMetrics
    with ImageGrab.grab(bbox=(0, 0, metrics(0), metrics(1))) as image:
        return encode_frame(image, request, previous_crc)


def monitor_size() -> tuple[int, int]:
    metrics = ctypes.windll.user32.GetSystemMetrics
    return metrics(0), metrics(1)


class _MemoryCounters(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("faults", wintypes.DWORD),
        ("sizes", ctypes.c_size_t * 8),
        ("private_usage", ctypes.c_size_t),
    ]


def private_bytes() -> int:
    kernel = ctypes.windll.kernel32
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    read = ctypes.windll.psapi.GetProcessMemoryInfo
    read.argtypes = (wintypes.HANDLE, ctypes.POINTER(_MemoryCounters), wintypes.DWORD)
    counters = _MemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    if not read(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise OSError("Falha ao medir a memória privada.")
    return int(counters.private_usage)


def _remote_is_lan(peer: Any) -> bool:
    try:
        pair = peer.sctp.transport.transport._connection._nominated[1]
        return is_lan_address(str(pair.remote_addr[0]))
    except AttributeError, IndexError, KeyError, TypeError, ValueError:
        return False


@dataclass(frozen=True)
class Probes:
    """Leituras opcionais do desktop; sem elas a sessão só envia quadros."""

    monitor: Callable[[], tuple[int, int]] | None = None
    cursor: Callable[[], tuple[int, int] | None] | None = None
    state: Callable[[], str] | None = None


class ScreenSession:
    def __init__(self, offer: Offer) -> None:
        started = monotonic()
        self.token = offer.token
        self.auth_deadline = started + offer.token_ttl
        self.deadline = started + offer.lifetime
        self.authorized = False
        self.invalid = 0
        self.peer: Any = None
        self.channel: Any = None
        self.closed = asyncio.Event()
        self.ready = asyncio.Event()
        self.buffer_low = asyncio.Event()
        self.requests: asyncio.Queue[FrameRequest] = asyncio.Queue(maxsize=1)
        self.crc: int | None = None
        self.sequence = 0
        self.state = STATE_OK

    async def answer(self, sdp: str) -> str:
        prepared = prepare_offer(sdp)
        aiortc = await _load()
        peer = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=[]))
        self.peer = peer
        peer.on("connectionstatechange", self.on_state)
        peer.on("datachannel", self.adopt)
        await peer.setRemoteDescription(aiortc.RTCSessionDescription(sdp=prepared, type="offer"))
        await peer.setLocalDescription(await peer.createAnswer())
        return str(peer.localDescription.sdp)

    def on_state(self) -> None:
        if self.peer.connectionState in {"closed", "failed", "disconnected"} or (
            self.peer.connectionState == "connected" and not _remote_is_lan(self.peer)
        ):
            self.closed.set()

    def adopt(self, channel: Any) -> None:
        if (
            self.channel is not None
            or channel.label != "screen"
            or not channel.ordered
            or channel.maxRetransmits is not None
            or channel.maxPacketLifeTime is not None
        ):
            channel.close()
            return
        self.channel = channel
        channel.on("message", self.on_message)
        channel.on("close", self.closed.set)
        channel.on("bufferedamountlow", self.buffer_low.set)

    def on_message(self, message: Any) -> None:
        if self.closed.is_set():
            return
        try:
            if not isinstance(message, str) or len(message) > MAX_MESSAGE_CHARS:
                raise ValueError
            data = json.loads(message)
            if not isinstance(data, dict):
                raise ValueError
            if not self.authorized:
                if data.get("k") == "auth":
                    self.authenticate(data.get("token"))
                    return
                raise ValueError
            request = FrameRequest.parse(data)
            self.requests.put_nowait(request)
        except ValueError, RecursionError, asyncio.QueueFull:
            self.invalid += 1
            if self.invalid >= MAX_INVALID:
                self.closed.set()

    def authenticate(self, token: Any) -> None:
        if (
            self.peer.connectionState != "connected"
            or not _remote_is_lan(self.peer)
            or monotonic() >= self.auth_deadline
            or not isinstance(token, str)
            or not token.isascii()
            or not hmac.compare_digest(self.token, token)
        ):
            self.closed.set()
            return
        self.authorized = True
        self.token = ""
        self.ready.set()

    def send_json(self, data: dict[str, Any]) -> None:
        self.channel.send(json.dumps(data))

    async def stream(
        self,
        capture: Callable[[FrameRequest, int | None], Capture],
        memory: Callable[[], int],
        viewing: Callable[[], AbstractContextManager[None]],
        probes: Probes | None = None,
    ) -> None:
        async with asyncio.timeout_at(min(self.auth_deadline, monotonic() + FRAME_TIMEOUT)):
            await self.ready.wait()
        if self.closed.is_set():
            return
        with viewing():
            await self.send_frames(capture, memory, probes or Probes())

    async def report_state(self, state: str) -> None:
        """Avisa só quando o estado muda; o bloqueio encerra a sessão depois do aviso sair."""
        if state == self.state:
            return
        self.state = state
        self.send_json({"k": "s.state", "state": state})
        if state == STATE_LOCKED:
            # O fechamento do SCTP só pode ocorrer após o envio da notificação.
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(1):
                    await self.wait_buffer(0)
            self.closed.set()

    async def watch_state(self, read: Callable[[], str]) -> None:
        while not self.closed.is_set():
            await self.report_state(read())
            await asyncio.sleep(STATE_INTERVAL)

    async def watch_cursor(self, read: Callable[[], tuple[int, int] | None]) -> None:
        last = None
        while not self.closed.is_set():
            position = read()
            # Com o canal cheio de quadro, a posição é descartada: a próxima leitura é mais nova.
            if (
                position is not None
                and position != last
                and self.channel.bufferedAmount <= 4 * CHUNK_BYTES
            ):
                last = position
                self.send_json({"k": "s.cur", "x": position[0], "y": position[1]})
            await asyncio.sleep(CURSOR_INTERVAL)

    async def send_frames(
        self,
        capture: Callable[[FrameRequest, int | None], Capture],
        memory: Callable[[], int],
        probes: Probes | None = None,
    ) -> None:
        probes = probes or Probes()
        mon: dict[str, Any] = {"k": "s.mon"}
        if probes.monitor is not None:
            mon["width"], mon["height"] = probes.monitor()
        self.send_json(mon)
        watchers = [
            asyncio.create_task(watcher)
            for watcher in (
                self.watch_state(probes.state) if probes.state else None,
                self.watch_cursor(probes.cursor) if probes.cursor else None,
            )
            if watcher is not None
        ]
        try:
            await self.frame_loop(capture, memory)
        finally:
            for watcher in watchers:
                watcher.cancel()
            await asyncio.gather(*watchers, return_exceptions=True)

    async def frame_loop(
        self, capture: Callable[[FrameRequest, int | None], Capture], memory: Callable[[], int]
    ) -> None:
        start, cpu, peak = monotonic(), process_time(), 0
        last_capture = 0.0
        while not self.closed.is_set():
            async with asyncio.timeout(FRAME_TIMEOUT):
                request = await self.requests.get()
                await asyncio.sleep(max(0, last_capture + 1 / request.fps - monotonic()))
                last_capture = monotonic()
                if request.reset:
                    start, cpu, peak = last_capture, process_time(), 0
                try:
                    shot = await asyncio.to_thread(capture, request, self.crc)
                except DesktopLockedError:
                    await self.report_state(STATE_LOCKED)
                    return
                self.crc = shot.crc
                peak = max(peak, memory())
                if self.closed.is_set():
                    return
                if shot.jpeg is None:
                    self.send_json({"k": "s.same", "crc": shot.crc})
                    continue
                self.sequence += 1
                payload = frame_header(shot, self.sequence) + shot.jpeg
                if request.marker:
                    # Só a medição pede a marca; ela também recebe o custo do processo.
                    elapsed = monotonic() - start
                    self.send_json(
                        {
                            "k": "s.stat",
                            "bytes": len(payload),
                            "cpu": 100 * (process_time() - cpu) / elapsed if elapsed > 0 else None,
                            "privateMB": peak / 1_000_000,
                        }
                    )
                for offset in range(0, len(payload), CHUNK_BYTES):
                    await self.wait_buffer(4 * CHUNK_BYTES - 1)
                    self.channel.send(payload[offset : offset + CHUNK_BYTES])
                await self.wait_buffer(0)

    async def wait_buffer(self, threshold: int) -> None:
        self.channel.bufferedAmountLowThreshold = threshold
        if self.channel.bufferedAmount > threshold:
            self.buffer_low.clear()
            await self.buffer_low.wait()

    async def run(
        self,
        offer: Offer,
        pipe_closed: asyncio.Event,
        reply: Callable[[dict[str, str]], None],
        viewing: Callable[[], AbstractContextManager[None]],
        probes: Probes | None = None,
    ) -> None:
        async def connect_and_stream() -> None:
            async with asyncio.timeout_at(self.deadline):
                try:
                    reply({"sdp": await self.answer(offer.sdp)})
                except Exception:
                    reply({"error": "Não foi possível aceitar a oferta da tela."})
                    return
                await self.stream(
                    capture_frame,
                    private_bytes,
                    viewing,
                    Probes(monitor_size, read_cursor, read_state) if probes is None else probes,
                )

        tasks = [
            asyncio.create_task(connect_and_stream()),
            asyncio.create_task(pipe_closed.wait()),
            asyncio.create_task(self.closed.wait()),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self.peer is not None:
                await self.peer.close()


def _read_pipe(
    loop: asyncio.AbstractEventLoop,
    offer: asyncio.Future[bytes],
    closed: asyncio.Event,
) -> None:
    # Leitura crua em thread daemon evita esperar pelo pai no encerramento do loop.
    buffer = bytearray()
    try:
        while len(buffer) <= MAX_OFFER_BYTES:
            chunk = os.read(sys.stdin.fileno(), 4096)
            if not chunk:
                break
            buffer.extend(chunk)
            newline = buffer.find(b"\n")
            if 0 <= newline <= MAX_OFFER_BYTES:
                loop.call_soon_threadsafe(offer.set_result, bytes(buffer[:newline]))
                # Depois da oferta, só o EOF do pai encerra a sessão.
                while os.read(sys.stdin.fileno(), 4096):
                    pass
                break
    except OSError:
        pass
    finally:
        if not loop.is_closed():
            loop.call_soon_threadsafe(closed.set)


async def main() -> None:
    loop = asyncio.get_running_loop()
    raw: asyncio.Future[bytes] = loop.create_future()
    closed = asyncio.Event()
    Thread(target=_read_pipe, args=(loop, raw, closed), daemon=True).start()

    def reply(data: dict[str, str]) -> None:
        print(json.dumps(data), flush=True)

    startup = asyncio.create_task(closed.wait())
    try:
        await asyncio.wait(
            (raw, startup), timeout=FRAME_TIMEOUT, return_when=asyncio.FIRST_COMPLETED
        )
        if not raw.done() or closed.is_set():
            return
        try:
            offer = Offer.parse(raw.result())
        except ValueError, RecursionError:
            reply({"error": "Oferta inválida."})
            return
        user = ctypes.windll.user32
        user.SetProcessDpiAwarenessContext.argtypes = (ctypes.c_void_p,)
        if not user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            reply({"error": "Não foi possível habilitar as coordenadas físicas da tela."})
            return
        await ScreenSession(offer).run(offer, closed, reply, screen_indicator)
    finally:
        startup.cancel()


if __name__ == "__main__":
    asyncio.run(main())
