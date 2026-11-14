"""Sondagem ADB que prova uma chave sem nunca oferecer a chave pública.

O protocolo ADB pede a chave pública (``AUTH RSAPUBLICKEY``, tipo 3) quando a TV não
conhece o cliente. Esse pacote abre o aviso de permissão e, por isso, é proibido aqui.
Esta sonda só envia ``CNXN`` e, para um token recebido, ``AUTH SIGNATURE`` (tipo 2).
"""

import asyncio
import struct
from collections.abc import Callable
from enum import StrEnum
from pathlib import Path
from typing import Final, TypeAlias

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa, utils

from uniover_agent.adapters.adb_authorization import KEY_FILE, default_android_dir

_HEADER: Final = struct.Struct("<6I")
_HEADER_SIZE: Final = _HEADER.size
_MAX_DATA: Final = 256 * 1024
_LEGACY_PROTOCOL_VERSION: Final = 0x01000000
_PROTOCOL_VERSION: Final = 0x01000001
_CNXN: Final = 0x4E584E43
_AUTH: Final = 0x48545541
_STLS: Final = 0x534C5453
_AUTH_TOKEN: Final = 1
_AUTH_SIGNATURE: Final = 2
_AUTH_RSAPUBLICKEY: Final = 3
_MAGIC_MASK: Final = 0xFFFFFFFF
_BANNER: Final = b"host::\0"


class ProbeResult(StrEnum):
    """Resultado deliberadamente pequeno da sondagem sem efeito na TV."""

    AUTHORIZED = "authorized"
    UNAUTHORIZED = "unauthorized"
    TLS_REQUIRED = "tls_required"
    UNREACHABLE = "unreachable"
    UNKNOWN = "unknown"


PrivateKeyMaterial: TypeAlias = bytes | rsa.RSAPrivateKey
PrivateKeyLoader: TypeAlias = Callable[[], PrivateKeyMaterial]


class _Packet:
    __slots__ = ("command", "arg0", "arg1", "checksum", "data")

    def __init__(self, command: int, arg0: int, arg1: int, checksum: int, data: bytes) -> None:
        self.command = command
        self.arg0 = arg0
        self.arg1 = arg1
        self.checksum = checksum
        self.data = data


def load_agent_adbkey() -> bytes:
    """Lê o mesmo ``~/.android/adbkey`` que o ``adb`` do agente usa.

    O futuro chamador deve antes chamar ``AdbAuthorization.prepare()`` quando essa
    restauração for necessária; esta função só lê a chave e nunca a cria ou altera.
    """
    path: Path = default_android_dir() / KEY_FILE
    return path.read_bytes()


async def probe(
    host: str,
    port: int,
    private_key_loader: PrivateKeyLoader,
    timeout: float = 3.0,
) -> ProbeResult:
    """Consulta se a TV aceita a chave ADB, sem jamais enviar a chave pública.

    ``private_key_loader`` retorna o PEM de ``adbkey`` ou uma ``RSAPrivateKey`` já
    carregada. O prazo é único para a conexão e todo o aperto de mão.
    """
    writer: asyncio.StreamWriter | None = None
    try:
        async with asyncio.timeout(timeout):
            reader, writer = await asyncio.open_connection(host, port)
            await _write_packet(writer, _CNXN, _PROTOCOL_VERSION, _MAX_DATA, _BANNER)
            # A versão local 1.1 já permite `data_check=0` no AUTH que vem antes do
            # CNXN do par. Um CNXN que depois declare 1.0 é revalidado abaixo.
            first = await _read_packet(reader, allow_zero_checksum=True)
            if first.command == _STLS:
                # TLS exigiria uma negociação diferente; não a implementamos e não
                # mandamos nenhum pacote ADB adicional.
                return ProbeResult.TLS_REQUIRED
            if first.command == _CNXN:
                return ProbeResult.AUTHORIZED if _valid_cnxn(first) else ProbeResult.UNKNOWN
            if first.command != _AUTH or first.arg0 != _AUTH_TOKEN:
                return ProbeResult.UNKNOWN
            if len(first.data) != hashes.SHA1.digest_size:
                return ProbeResult.UNKNOWN

            signature = _sign_token(private_key_loader, first.data)
            await _write_packet(
                writer,
                _AUTH,
                _AUTH_SIGNATURE,
                0,
                signature,
                skip_checksum=_PROTOCOL_VERSION >= 0x01000001,
            )
            second = await _read_packet(reader, allow_zero_checksum=True)
            if second.command == _CNXN:
                return ProbeResult.AUTHORIZED if _valid_cnxn(second) else ProbeResult.UNKNOWN
            if second.command == _AUTH and second.arg0 == _AUTH_TOKEN:
                # A TV recusou a assinatura. O ``finally`` fecha o socket agora; não há
                # fallback para RSAPUBLICKEY, pois ele abriria o aviso na TV.
                return (
                    ProbeResult.UNAUTHORIZED
                    if len(second.data) == hashes.SHA1.digest_size
                    else ProbeResult.UNKNOWN
                )
            return ProbeResult.UNKNOWN
    except TimeoutError:
        return ProbeResult.UNREACHABLE
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        return ProbeResult.UNREACHABLE
    except Exception:
        # Chave que não é RSA/PEM, pacote malformado ou outro desvio do protocolo.
        return ProbeResult.UNKNOWN
    finally:
        if writer is not None:
            # ``close`` encerra o transporte imediatamente. Não esperamos ``wait_closed``:
            # ele não deve estender o limite total da sonda.
            writer.close()


def _sign_token(private_key_loader: PrivateKeyLoader, token: bytes) -> bytes:
    material = private_key_loader()
    key = (
        serialization.load_pem_private_key(material, password=None)
        if isinstance(material, bytes)
        else material
    )
    if not isinstance(key, rsa.RSAPrivateKey):
        raise TypeError("a chave ADB precisa ser RSA")
    # O token de 20 bytes já é o digest SHA-1 produzido pelo adbd. Prehashed evita
    # hashear o token uma segunda vez e produz o DigestInfo PKCS#1 v1.5 que o ADB espera.
    return key.sign(token, padding.PKCS1v15(), utils.Prehashed(hashes.SHA1()))


async def _read_packet(reader: asyncio.StreamReader, *, allow_zero_checksum: bool) -> _Packet:
    command, arg0, arg1, size, checksum, magic = _HEADER.unpack(
        await reader.readexactly(_HEADER_SIZE)
    )
    if magic != (command ^ _MAGIC_MASK):
        raise ValueError("magic ADB inválido")
    if size > _MAX_DATA:
        raise ValueError("pacote ADB grande demais")
    data = await reader.readexactly(size)
    if checksum != 0 and _checksum(data) != checksum:
        raise ValueError("checksum ADB inválido")
    if checksum == 0 and data and not allow_zero_checksum:
        raise ValueError("checksum ADB ausente no modo legado")
    return _Packet(command, arg0, arg1, checksum, data)


async def _write_packet(
    writer: asyncio.StreamWriter,
    command: int,
    arg0: int,
    arg1: int,
    data: bytes,
    *,
    skip_checksum: bool = False,
) -> None:
    _guard_silent_auth(command, arg0)
    writer.write(
        _HEADER.pack(
            command,
            arg0,
            arg1,
            len(data),
            0 if skip_checksum else _checksum(data),
            command ^ _MAGIC_MASK,
        )
        + data
    )
    await writer.drain()


def _guard_silent_auth(command: int, arg0: int) -> None:
    """Impede o pacote que faria a TV exibir o aviso de autorização."""
    if command == _AUTH and arg0 == _AUTH_RSAPUBLICKEY:
        raise AssertionError("a sonda silenciosa nunca pode enviar AUTH RSAPUBLICKEY")
    if command == _AUTH and arg0 != _AUTH_SIGNATURE:
        raise AssertionError("a sonda silenciosa só pode enviar AUTH SIGNATURE")


def _valid_cnxn(packet: _Packet) -> bool:
    """O CNXN só negocia as duas versões que esta sonda entende."""
    if packet.arg0 not in (_LEGACY_PROTOCOL_VERSION, _PROTOCOL_VERSION) or packet.arg1 <= 0:
        return False
    # Zero é checksum legítimo para payload vazio; com banner não vazio ele só vale em 1.1.
    return not (
        packet.arg0 == _LEGACY_PROTOCOL_VERSION and packet.data and packet.checksum == 0
    )


def _checksum(data: bytes) -> int:
    return sum(data) & _MAGIC_MASK
