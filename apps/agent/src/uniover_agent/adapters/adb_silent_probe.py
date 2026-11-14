"""Sondagem ADB que prova uma chave sem nunca oferecer a chave pública.

O protocolo ADB pede a chave pública (``AUTH RSAPUBLICKEY``, tipo 3) quando a TV não
conhece o cliente. Esse pacote abre o aviso de permissão e, por isso, é proibido aqui.
Esta sonda só envia ``CNXN`` e, para um token recebido, ``AUTH SIGNATURE`` (tipo 2).
"""

import asyncio
import ctypes
import hashlib
import os
import struct
import sys
import uuid
from collections.abc import Awaitable, Callable, Mapping
from enum import StrEnum
from pathlib import Path
from typing import Final

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa, utils

from uniover_agent.adapters.adb_authorization import KEY_FILE, default_android_dir
from uniover_agent.adapters.adb_server_info import adb_server_started_at
from uniover_agent.ports import (
    PROBE_EVENT_KEY_STALE,
    PROBE_EVENT_KEY_UNVERIFIABLE,
    PROBE_EVENT_VENDOR_KEYS,
)

_HEADER: Final = struct.Struct("<6I")
_HEADER_SIZE: Final = _HEADER.size
_MAX_DATA: Final = 256 * 1024
_LEGACY_PROTOCOL_VERSION: Final = 0x01000000
_PROTOCOL_VERSION: Final = 0x01000001
# A partir da 1.1 o `data_check` pode ser zero no AUTH que vem antes do CNXN do par.
_SKIP_CHECKSUM_FROM: Final = 0x01000001
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


type PrivateKeyMaterial = bytes | rsa.RSAPrivateKey
type PrivateKeyLoader = Callable[[], PrivateKeyMaterial]


class _Packet:
    __slots__ = ("arg0", "arg1", "checksum", "command", "data")

    def __init__(self, command: int, arg0: int, arg1: int, checksum: int, data: bytes) -> None:
        self.command = command
        self.arg0 = arg0
        self.arg1 = arg1
        self.checksum = checksum
        self.data = data


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _require_same_key_dir(
    directory: Path, profile: Path | None, environ: Mapping[str, str]
) -> None:
    if profile is not None and not _same_path(directory, profile / ".android"):
        raise OSError("a pasta da chave do adb não é a do perfil do sistema")
    user_home = environ.get("ANDROID_USER_HOME")
    if user_home and not _same_path(directory, Path(user_home)):
        raise OSError("ANDROID_USER_HOME aponta para outra pasta de chaves")
    sdk_home = environ.get("ANDROID_SDK_HOME")
    if sdk_home and not _same_path(directory, Path(sdk_home) / ".android"):
        raise OSError("ANDROID_SDK_HOME aponta para outra pasta de chaves")


def _windows_profile_dir() -> Path | None:
    """A pasta de perfil que o Windows informa (``SHGetKnownFolderPath``), sem ler o ambiente."""
    if sys.platform != "win32":
        return None
    guid = ctypes.create_string_buffer(
        uuid.UUID("5E6C858F-0E22-4760-9AFE-EA3317B67173").bytes_le, 16
    )
    result = ctypes.c_wchar_p()
    status = ctypes.windll.shell32.SHGetKnownFolderPath(guid, 0, None, ctypes.byref(result))
    try:
        if status != 0 or not result.value:
            raise OSError("o Windows não informou a pasta de perfil")
        return Path(result.value)
    finally:
        ctypes.windll.ole32.CoTaskMemFree(result)


def load_agent_adbkey(
    android_dir: Path | None = None,
    profile_dir: Callable[[], Path | None] = _windows_profile_dir,
    environ: Mapping[str, str] | None = None,
) -> bytes:
    """Lê o mesmo ``~/.android/adbkey`` que o ``adb`` do agente usa.

    O futuro chamador deve antes chamar ``AdbAuthorization.prepare()`` quando essa
    restauração for necessária; esta função só lê a chave e nunca a cria ou altera.

    Falha fechado (``OSError``, que a sonda traduz em ``unknown``) quando o ``adb`` poderia ler
    outra chave: no Windows o ``adb.exe`` usa a pasta de perfil do sistema e ignora ``USERPROFILE``
    (medido em 14/11/2026); um ``USERPROFILE`` diferente dela, ou ``ANDROID_USER_HOME`` e
    ``ANDROID_SDK_HOME`` apontando para outro lugar, fariam a sonda provar uma chave e o
    ``adb connect`` assinar com outra, e a TV mostraria o aviso.
    """
    directory = android_dir if android_dir is not None else default_android_dir()
    _require_same_key_dir(directory, profile_dir(), os.environ if environ is None else environ)
    return (directory / KEY_FILE).read_bytes()


def public_key_fingerprint(pem: bytes) -> str | None:
    """SHA-256 (hex) da chave pública da chave privada RSA em PEM; `None` se não for uma."""
    try:
        key = serialization.load_pem_private_key(pem, password=None)
    except Exception:
        return None
    if not isinstance(key, rsa.RSAPrivateKey):
        return None
    der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return hashlib.sha256(der).hexdigest()


async def adbkey_unsafe_reason(
    key_path: Path,
    *,
    environ: Mapping[str, str] | None = None,
    server_started_at: Callable[[], Awaitable[float | None]] = adb_server_started_at,
) -> str | None:
    """Por que o `adb` pode assinar com outra chave que não a do arquivo (`None`: tudo certo).

    O servidor do `adb` guarda a chave que leu ao subir: um arquivo **mais novo** que o servidor
    em execução quer dizer que ele pode ter outra em memória. `ADB_VENDOR_KEYS` põe chaves a mais
    no `adb`. E se não dá para saber (hora do servidor ilegível, arquivo sem data), não se garante
    nada. Sem servidor rodando não há o que divergir: o próximo `adb` lê o arquivo ao subir.
    """
    if (os.environ if environ is None else environ).get("ADB_VENDOR_KEYS"):
        return PROBE_EVENT_VENDOR_KEYS
    try:
        started = await server_started_at()
        modified = (await asyncio.to_thread(key_path.stat)).st_mtime
    except OSError:
        return PROBE_EVENT_KEY_UNVERIFIABLE
    if started is not None and modified > started:
        return PROBE_EVENT_KEY_STALE
    return None


async def probe(  # noqa: PLR0911 - uma saída por resultado do protocolo
    host: str,
    port: int,
    private_key_loader: PrivateKeyLoader,
    timeout: float = 3.0,  # noqa: ASYNC109 - um prazo único para a conexão e o aperto de mão
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
                skip_checksum=_PROTOCOL_VERSION >= _SKIP_CHECKSUM_FROM,
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
    except asyncio.IncompleteReadError, ConnectionError, OSError:
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
    try:
        material = private_key_loader()
    except OSError as exc:
        # Chave ilegível ou que não se pode garantir ser a do `adb` não é TV fora do ar: a sonda
        # não prova nada (`unknown`), e o `OSError` não pode passar por `unreachable`.
        raise ValueError("a chave ADB não pôde ser lida com segurança") from exc
    key = (
        serialization.load_pem_private_key(material, password=None)
        if isinstance(material, bytes)
        else material
    )
    if not isinstance(key, rsa.RSAPrivateKey):
        raise TypeError("a chave ADB precisa ser RSA")
    # O token de 20 bytes já é o digest SHA-1 produzido pelo adbd. Prehashed evita
    # hashear o token uma segunda vez e produz o DigestInfo PKCS#1 v1.5 que o ADB espera.
    prehashed = utils.Prehashed(hashes.SHA1())  # noqa: S303 - o token do adbd é um digest SHA-1
    return key.sign(token, padding.PKCS1v15(), prehashed)


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


async def _write_packet(  # noqa: PLR0913 - o cabeçalho do pacote ADB tem estes campos
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
    return not (packet.arg0 == _LEGACY_PROTOCOL_VERSION and packet.data and packet.checksum == 0)


def _checksum(data: bytes) -> int:
    return sum(data) & _MAGIC_MASK
