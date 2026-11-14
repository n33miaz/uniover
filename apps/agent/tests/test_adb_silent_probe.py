"""A sonda ADB só assina tokens; nunca oferece a chave pública à TV."""

from __future__ import annotations

import asyncio
import struct
from collections.abc import Awaitable, Callable
from types import TracebackType
from typing import cast

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa, utils

from uniover_agent.adapters import adb_silent_probe as silent_probe
from uniover_agent.adapters.adb_silent_probe import ProbeResult, probe

_HEADER = struct.Struct("<6I")
_CNXN = 0x4E584E43
_AUTH = 0x48545541
_STLS = 0x534C5453
_AUTH_TOKEN = 1
_AUTH_SIGNATURE = 2
_AUTH_RSAPUBLICKEY = 3
_MAGIC_MASK = 0xFFFFFFFF
_LEGACY_VERSION = 0x01000000
_VERSION_1_1 = 0x01000001
_MAX_DATA = 256 * 1024
_TOKEN = bytes(range(20))


class Packet:
    def __init__(self, command: int, arg0: int, arg1: int, checksum: int, data: bytes) -> None:
        self.command = command
        self.arg0 = arg0
        self.arg1 = arg1
        self.checksum = checksum
        self.data = data


async def read_packet(reader: asyncio.StreamReader) -> Packet:
    command, arg0, arg1, size, checksum, magic = _HEADER.unpack(
        await reader.readexactly(_HEADER.size)
    )
    assert magic == command ^ _MAGIC_MASK
    data = await reader.readexactly(size)
    return Packet(command, arg0, arg1, checksum, data)


async def write_packet(
    writer: asyncio.StreamWriter,
    command: int,
    arg0: int = 0,
    arg1: int = 0,
    data: bytes = b"",
    checksum: int | None = None,
) -> None:
    data_check = checksum_for(data) if checksum is None else checksum
    writer.write(
        _HEADER.pack(
            command, arg0, arg1, len(data), data_check, command ^ _MAGIC_MASK
        )
        + data
    )
    await writer.drain()


def checksum_for(data: bytes) -> int:
    return sum(data) & _MAGIC_MASK


async def write_cnxn(
    writer: asyncio.StreamWriter,
    *,
    version: int = _VERSION_1_1,
    max_data: int = _MAX_DATA,
    checksum: int | None = None,
) -> None:
    await write_packet(
        writer,
        _CNXN,
        version,
        max_data,
        b"device::\0",
        checksum,
    )


Handler = Callable[
    [asyncio.StreamReader, asyncio.StreamWriter, "FakeAdbServer"], Awaitable[None]
]


class FakeAdbServer:
    """Servidor ADB mínimo, isolado em loopback, que também observa o EOF do cliente."""

    def __init__(self, handler: Handler) -> None:
        self._handler = handler
        self._server: asyncio.Server | None = None
        self._writers: set[asyncio.StreamWriter] = set()
        self._tasks: set[asyncio.Task[None]] = set()
        self._error: Exception | None = None
        self.finished = asyncio.Event()
        self.packets: list[Packet] = []
        self.port = 0

    async def __aenter__(self) -> FakeAdbServer:
        self._server = await asyncio.start_server(self._connected, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        for writer in self._writers:
            writer.close()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    def _connected(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        task = asyncio.create_task(self._serve(reader, writer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await self._handler(reader, writer, self)
        except Exception as error:
            self._error = error
        finally:
            writer.close()
            self._writers.discard(writer)
            self.finished.set()

    async def assert_finished(self) -> None:
        await asyncio.wait_for(self.finished.wait(), 1)
        if self._error is not None:
            raise self._error


async def expect_cnxn(reader: asyncio.StreamReader, server: FakeAdbServer) -> None:
    packet = await read_packet(reader)
    server.packets.append(packet)
    assert packet.command == _CNXN
    assert packet.arg0 == _VERSION_1_1
    assert packet.arg1 == _MAX_DATA
    assert packet.checksum == checksum_for(packet.data)
    assert packet.data == b"host::\0"


async def expect_client_close(reader: asyncio.StreamReader) -> None:
    assert await asyncio.wait_for(reader.read(), 1) == b""


def assert_never_sent_public_key(server: FakeAdbServer) -> None:
    assert not any(
        packet.command == _AUTH and packet.arg0 == _AUTH_RSAPUBLICKEY for packet in server.packets
    )


@pytest.fixture
def private_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.mark.parametrize(
    ("version", "checksum"),
    [(_VERSION_1_1, 0), (_LEGACY_VERSION, None)],
)
async def test_no_auth_is_authorized_and_the_socket_is_closed(
    private_key: rsa.RSAPrivateKey, version: int, checksum: int | None
) -> None:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: FakeAdbServer
    ) -> None:
        await expect_cnxn(reader, server)
        await write_cnxn(writer, version=version, checksum=checksum)
        await expect_client_close(reader)

    async with FakeAdbServer(handler) as server:
        result = await probe("127.0.0.1", server.port, lambda: private_key)
        await server.assert_finished()

    assert result is ProbeResult.AUTHORIZED
    assert_never_sent_public_key(server)


async def test_stls_is_reported_without_another_packet(private_key: rsa.RSAPrivateKey) -> None:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: FakeAdbServer
    ) -> None:
        await expect_cnxn(reader, server)
        await write_packet(writer, _STLS)
        await expect_client_close(reader)

    async with FakeAdbServer(handler) as server:
        result = await probe("127.0.0.1", server.port, lambda: private_key)
        await server.assert_finished()

    assert result is ProbeResult.TLS_REQUIRED
    assert len(server.packets) == 1
    assert_never_sent_public_key(server)


@pytest.mark.parametrize(
    ("version", "max_data"),
    [(0x01000002, _MAX_DATA), (_VERSION_1_1, 0)],
)
async def test_invalid_cnxn_is_unknown(
    private_key: rsa.RSAPrivateKey, version: int, max_data: int
) -> None:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: FakeAdbServer
    ) -> None:
        await expect_cnxn(reader, server)
        await write_cnxn(writer, version=version, max_data=max_data)
        await expect_client_close(reader)

    async with FakeAdbServer(handler) as server:
        result = await probe("127.0.0.1", server.port, lambda: private_key)
        await server.assert_finished()

    assert result is ProbeResult.UNKNOWN
    assert_never_sent_public_key(server)


async def test_legacy_cnxn_with_zero_checksum_is_unknown(private_key: rsa.RSAPrivateKey) -> None:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: FakeAdbServer
    ) -> None:
        await expect_cnxn(reader, server)
        await write_cnxn(writer, version=_LEGACY_VERSION, checksum=0)
        await expect_client_close(reader)

    async with FakeAdbServer(handler) as server:
        result = await probe("127.0.0.1", server.port, lambda: private_key)
        await server.assert_finished()

    assert result is ProbeResult.UNKNOWN
    assert_never_sent_public_key(server)


async def test_a_accepted_signature_is_authorized(private_key: rsa.RSAPrivateKey) -> None:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: FakeAdbServer
    ) -> None:
        await expect_cnxn(reader, server)
        await write_packet(writer, _AUTH, _AUTH_TOKEN, data=_TOKEN, checksum=0)
        signature = await read_packet(reader)
        server.packets.append(signature)
        assert signature.command == _AUTH
        assert signature.arg0 == _AUTH_SIGNATURE
        assert signature.checksum == 0
        private_key.public_key().verify(
            signature.data,
            _TOKEN,
            padding.PKCS1v15(),
            utils.Prehashed(hashes.SHA1()),
        )
        await write_cnxn(writer, checksum=0)
        await expect_client_close(reader)

    async with FakeAdbServer(handler) as server:
        result = await probe("127.0.0.1", server.port, lambda: private_key)
        await server.assert_finished()

    assert result is ProbeResult.AUTHORIZED
    assert_never_sent_public_key(server)


async def test_a_second_token_is_unauthorized_and_no_more_bytes_are_written(
    private_key: rsa.RSAPrivateKey,
) -> None:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: FakeAdbServer
    ) -> None:
        await expect_cnxn(reader, server)
        await write_packet(writer, _AUTH, _AUTH_TOKEN, data=_TOKEN)
        signature = await read_packet(reader)
        server.packets.append(signature)
        assert signature.command == _AUTH and signature.arg0 == _AUTH_SIGNATURE
        await write_packet(writer, _AUTH, _AUTH_TOKEN, data=_TOKEN)
        # A recusa fecha o transporte: se existisse fallback, este read receberia AUTH tipo 3.
        await expect_client_close(reader)

    async with FakeAdbServer(handler) as server:
        result = await probe("127.0.0.1", server.port, lambda: private_key)
        await server.assert_finished()

    assert result is ProbeResult.UNAUTHORIZED
    assert_never_sent_public_key(server)


async def test_a_truncated_second_token_is_unknown(private_key: rsa.RSAPrivateKey) -> None:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: FakeAdbServer
    ) -> None:
        await expect_cnxn(reader, server)
        await write_packet(writer, _AUTH, _AUTH_TOKEN, data=_TOKEN)
        signature = await read_packet(reader)
        server.packets.append(signature)
        assert signature.command == _AUTH and signature.arg0 == _AUTH_SIGNATURE
        await write_packet(writer, _AUTH, _AUTH_TOKEN, data=_TOKEN[:-1])
        await expect_client_close(reader)

    async with FakeAdbServer(handler) as server:
        result = await probe("127.0.0.1", server.port, lambda: private_key)
        await server.assert_finished()

    assert result is ProbeResult.UNKNOWN
    assert_never_sent_public_key(server)


async def test_timeout_is_unreachable_and_still_never_sends_a_public_key(
    private_key: rsa.RSAPrivateKey,
) -> None:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: FakeAdbServer
    ) -> None:
        await expect_cnxn(reader, server)
        await expect_client_close(reader)  # não responde: o prazo total deve vencer

    async with FakeAdbServer(handler) as server:
        result = await probe("127.0.0.1", server.port, lambda: private_key, timeout=0.01)
        await server.assert_finished()

    assert result is ProbeResult.UNREACHABLE
    assert_never_sent_public_key(server)


async def test_garbage_packet_is_unknown_and_never_sends_a_public_key(
    private_key: rsa.RSAPrivateKey,
) -> None:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: FakeAdbServer
    ) -> None:
        await expect_cnxn(reader, server)
        await write_packet(writer, 0x59414B4F)  # OKAY não é resposta válida para CNXN.
        await expect_client_close(reader)

    async with FakeAdbServer(handler) as server:
        result = await probe("127.0.0.1", server.port, lambda: private_key)
        await server.assert_finished()

    assert result is ProbeResult.UNKNOWN
    assert_never_sent_public_key(server)


async def test_the_public_key_packet_is_rejected_before_any_write() -> None:
    class MemoryWriter:
        def __init__(self) -> None:
            self.writes: list[bytes] = []

        def write(self, data: bytes) -> None:
            self.writes.append(data)

        async def drain(self) -> None:
            return None

    memory = MemoryWriter()
    with pytest.raises(AssertionError, match="RSAPUBLICKEY"):
        await silent_probe._write_packet(
            cast(asyncio.StreamWriter, memory), _AUTH, _AUTH_RSAPUBLICKEY, 0, b"never"
        )
    assert memory.writes == []
