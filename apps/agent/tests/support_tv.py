"""TV falsa em loopback: fala o Android TV Remote v2 de verdade (TLS + protobuf com tamanho).

Serve para exercitar o adaptador contra a biblioteca **real** sem tocar em nenhuma TV nem na rede:
o servidor manda `remote_configure`, `remote_set_active` e `remote_start`, empurra volume e app, e
registra as teclas e os links que recebe.
"""

import asyncio
import ssl
from pathlib import Path
from types import TracebackType

from androidtvremote2.certificate_generator import generate_selfsigned_cert
from androidtvremote2.remotemessage_pb2 import RemoteKeyCode, RemoteMessage

# PING | KEY | POWER | VOLUME | APP_LINK, as capacidades que a TV real anuncia.
FEATURES = 1 | 2 | 32 | 64 | 512


def write_certificate(directory: Path, name: str) -> None:
    """Grava `cert.pem` e `key.pem` autoassinados (descartáveis, só de teste)."""
    cert_pem, key_pem = generate_selfsigned_cert(name)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "cert.pem").write_bytes(cert_pem)
    (directory / "key.pem").write_bytes(key_pem)


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def frame(message: RemoteMessage) -> bytes:
    payload = bytes(message.SerializeToString())
    return _varint(len(payload)) + payload


def _read_frames(buffer: bytearray) -> list[RemoteMessage]:
    messages: list[RemoteMessage] = []
    while buffer:
        length = 0
        shift = 0
        position = 0
        while True:
            if position >= len(buffer):
                return messages
            byte = buffer[position]
            position += 1
            length |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        if len(buffer) < position + length:
            return messages
        message = RemoteMessage()
        message.ParseFromString(bytes(buffer[position : position + length]))
        del buffer[: position + length]
        messages.append(message)
    return messages


class FakeTvServer:
    """`standby_on_power`: ao receber `POWER` a TV avisa que desligou (`remote_start` com
    `started=False`) e fecha a conexão que o recebeu; as novas conexões seguem aceitas e já nascem
    avisando "desligada", como uma TV em standby que ainda atende o serviço do controle."""

    def __init__(
        self, tmp_path: Path, *, send_start: bool = True, standby_on_power: bool = False
    ) -> None:
        self._send_start = send_start
        self._standby_on_power = standby_on_power
        self._started = True
        self.port = 0
        self.keys: list[tuple[int, int]] = []
        self.links: list[str] = []
        self.texts: list[str] = []
        self.connections = 0
        self._writers: list[asyncio.StreamWriter] = []
        self._server: asyncio.Server | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        server_dir = tmp_path / "tv-server"
        write_certificate(server_dir, "tv-falsa")
        self._ssl = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._ssl.load_cert_chain(server_dir / "cert.pem", server_dir / "key.pem")

    async def __aenter__(self) -> FakeTvServer:
        self._server = await asyncio.start_server(self._serve, "127.0.0.1", 0, ssl=self._ssl)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.drop_all()
        assert self._server is not None
        self._server.close()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self._server.wait_closed()

    def drop_all(self) -> None:
        """Derruba todas as conexões abertas (o que o limpador da TV faz com o serviço)."""
        for writer in self._writers:
            writer.close()
        self._writers.clear()

    def push_volume(self, level: int, maximum: int = 100) -> None:
        message = RemoteMessage()
        message.remote_set_volume_level.volume_level = level
        message.remote_set_volume_level.volume_max = maximum
        for writer in self._writers:
            writer.write(frame(message))

    def push_text_field(  # noqa: PLR0913 - espelha os campos da mensagem da TV
        self,
        value: str,
        *,
        counter: int = 1,
        label: str = "",
        start: int = 0,
        end: int = 0,
        show_request: bool = False,
        app: str | None = None,
    ) -> None:
        """A TV informa o campo de texto em foco: pela edição (`remote_ime_key_inject`) ou pelo
        pedido de teclado (`remote_ime_show_request`)."""
        message = RemoteMessage()
        field = (
            message.remote_ime_show_request.remote_text_field_status
            if show_request
            else message.remote_ime_key_inject.text_field_status
        )
        if app is not None and not show_request:
            message.remote_ime_key_inject.app_info.app_package = app
        field.counter_field = counter
        field.value = value
        field.start = start
        field.end = end
        field.label = label
        for writer in self._writers:
            writer.write(frame(message))

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        self._tasks.add(task)
        self.connections += 1
        self._writers.append(writer)
        try:
            await self._conversation(reader, writer)
        except ConnectionError, ssl.SSLError, asyncio.IncompleteReadError:
            pass
        finally:
            writer.close()
            self._tasks.discard(task)

    async def _go_standby(self, writer: asyncio.StreamWriter) -> None:
        self._started = False
        # A conexão que vai fechar não pode continuar na lista de quem recebe os avisos da TV.
        if writer in self._writers:
            self._writers.remove(writer)
        off = RemoteMessage()
        off.remote_start.started = False
        writer.write(frame(off))
        await writer.drain()
        writer.close()

    async def _conversation(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        configure = RemoteMessage()
        configure.remote_configure.code1 = FEATURES
        configure.remote_configure.device_info.vendor = "TCL"
        configure.remote_configure.device_info.model = "S65A"
        configure.remote_configure.device_info.app_version = "1.0"
        writer.write(frame(configure))
        active = RemoteMessage()
        active.remote_set_active.active = FEATURES
        writer.write(frame(active))
        if self._send_start:
            start = RemoteMessage()
            start.remote_start.started = self._started
            writer.write(frame(start))
            app = RemoteMessage()
            app.remote_ime_key_inject.app_info.app_package = "com.exemplo.video"
            writer.write(frame(app))
            self.push_volume(20)
        buffer = bytearray()
        while True:
            data = await reader.read(4096)
            if not data:
                return
            buffer += data
            for message in _read_frames(buffer):
                if message.HasField("remote_key_inject"):
                    inject = message.remote_key_inject
                    self.keys.append((int(inject.key_code), int(inject.direction)))
                    if self._standby_on_power and inject.key_code == RemoteKeyCode.KEYCODE_POWER:
                        await self._go_standby(writer)
                        return
                elif message.HasField("remote_app_link_launch_request"):
                    self.links.append(message.remote_app_link_launch_request.app_link)
                elif message.HasField("remote_ime_batch_edit"):
                    for edit in message.remote_ime_batch_edit.edit_info:
                        self.texts.append(edit.text_field_status.value)
