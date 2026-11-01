"""Confere localmente a assinatura v2/v3 do APK do TV Livre.

O hash publicado ao lado do APK só protege de download corrompido: quem trocasse o arquivo da
publicação trocaria o hash junto. Por isso o agente lê o APK Signing Block, confere a assinatura e
o digest do conteúdo antes de qualquer `adb install`; APKs só com a assinatura JAR v1 são recusados.
"""

import hashlib
import hmac
import struct
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Final

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from uniover_agent.ports.tv_livre import LauncherApkError

PROJECT_SIGNER_SHA256: Final = "f782151a18e6bc3ff22a201ff558fd833feb2120182034a3dec6aeab41b12bfc"

# O APK baixado já tem um teto menor. Este limite adicional impede que um arquivo local adulterado
# ocupe memória ou CPU sem limite antes de a assinatura ser conferida.
MAX_APK_BYTES: Final = 64 * 1024 * 1024
MAX_SIGNING_BLOCK_BYTES: Final = 1024 * 1024
MAX_SIGNING_BLOCK_PAIRS: Final = 32
MAX_SIGNERS: Final = 8
MAX_SIGNATURES_PER_SIGNER: Final = 8
MAX_DIGESTS_PER_SIGNER: Final = 8
MAX_CERTIFICATES_PER_SIGNER: Final = 4
MAX_ATTRIBUTES_PER_SIGNER: Final = 16
MAX_SIGNER_BYTES: Final = 256 * 1024
MAX_SIGNATURE_BYTES: Final = 64 * 1024
MAX_DIGEST_BYTES: Final = 128
MAX_CERTIFICATE_BYTES: Final = 64 * 1024
MAX_PUBLIC_KEY_BYTES: Final = 64 * 1024
MAX_ATTRIBUTE_BYTES: Final = 64 * 1024

_APK_SIG_BLOCK_MAGIC: Final = b"APK Sig Block 42"
_APK_SIG_BLOCK_FOOTER_BYTES: Final = 24
_EOCD_MAGIC: Final = b"PK\x05\x06"
_EOCD_MIN_BYTES: Final = 22
_EOCD_CD_SIZE: Final = 12
_EOCD_CD_OFFSET: Final = 16
_MAX_ZIP_COMMENT: Final = 0xFFFF
_ZIP64_MARKER: Final = 0xFFFFFFFF
_PAIR_ID_BYTES: Final = 4
_CHUNK_BYTES: Final = 1024 * 1024
_V2_BLOCK_ID: Final = 0x7109871A
_V3_BLOCK_ID: Final = 0xF05368C0
_MAX_TRAILING_EMPTY_BYTES: Final = 16
_PROOF_OF_ROTATION_ATTRIBUTE_ID: Final = 0x3BA06F8C


@dataclass(frozen=True, slots=True)
class _SignatureAlgorithm:
    hash_algorithm: type[hashes.HashAlgorithm]
    key_kind: str
    pss: bool = False


_SIGNATURE_ALGORITHMS: Final = {
    0x0101: _SignatureAlgorithm(hashes.SHA256, "rsa", pss=True),
    0x0102: _SignatureAlgorithm(hashes.SHA512, "rsa", pss=True),
    0x0103: _SignatureAlgorithm(hashes.SHA256, "rsa"),
    0x0104: _SignatureAlgorithm(hashes.SHA512, "rsa"),
    0x0201: _SignatureAlgorithm(hashes.SHA256, "ecdsa"),
    0x0202: _SignatureAlgorithm(hashes.SHA512, "ecdsa"),
}


class _InvalidApkSignatureError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _Reader:
    """Leitor pequeno para os campos little-endian, com tamanho, do APK Signing Block."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._position = 0

    @property
    def remaining(self) -> int:
        return len(self._data) - self._position

    def u32(self) -> int:
        value: int = struct.unpack("<I", self.take(4))[0]
        return value

    def u64(self) -> int:
        value: int = struct.unpack("<Q", self.take(8))[0]
        return value

    def take(self, length: int) -> bytes:
        if length < 0 or length > self.remaining:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "A assinatura do APK está truncada."
            )
        start = self._position
        self._position += length
        return self._data[start : start + length]

    def length_prefixed(self, maximum: int, name: str) -> bytes:
        length = self.u32()
        if length > maximum:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", f"O APK traz {name} grande demais."
            )
        return self.take(length)

    def finish(self) -> None:
        if self.remaining:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "A assinatura do APK tem dados extras."
            )


def _records(data: bytes, *, maximum_count: int, maximum_bytes: int, name: str) -> Iterator[bytes]:
    reader = _Reader(data)
    count = 0
    while reader.remaining:
        count += 1
        if count > maximum_count:
            raise _InvalidApkSignatureError("apk_signature_invalid", f"O APK traz {name} demais.")
        yield reader.length_prefixed(maximum_bytes, name)


def _u32_at(data: bytes, offset: int, message: str) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise _InvalidApkSignatureError("apk_signature_invalid", message)
    value: int = struct.unpack_from("<I", data, offset)[0]
    return value


def _u16_at(data: bytes, offset: int, message: str) -> int:
    if offset < 0 or offset + 2 > len(data):
        raise _InvalidApkSignatureError("apk_signature_invalid", message)
    value: int = struct.unpack_from("<H", data, offset)[0]
    return value


def _u64_at(data: bytes, offset: int, message: str) -> int:
    if offset < 0 or offset + 8 > len(data):
        raise _InvalidApkSignatureError("apk_signature_invalid", message)
    value: int = struct.unpack_from("<Q", data, offset)[0]
    return value


def _read_exact(handle: BinaryIO, offset: int, length: int, message: str) -> bytes:
    handle.seek(offset)
    data = handle.read(length)
    if len(data) != length:
        raise _InvalidApkSignatureError("apk_signature_invalid", message)
    return data


def _find_eocd(handle: BinaryIO, file_size: int) -> tuple[int, bytes]:
    tail_size = min(file_size, _EOCD_MIN_BYTES + _MAX_ZIP_COMMENT)
    tail_offset = file_size - tail_size
    tail = _read_exact(handle, tail_offset, tail_size, "O APK não tem o fim de ZIP esperado.")
    for local_offset in range(tail_size - _EOCD_MIN_BYTES, -1, -1):
        if tail[local_offset : local_offset + 4] != _EOCD_MAGIC:
            continue
        comment_length = _u16_at(tail, local_offset + 20, "O APK não tem o fim de ZIP esperado.")
        if local_offset + _EOCD_MIN_BYTES + comment_length == tail_size:
            return tail_offset + local_offset, tail[local_offset:]
    raise _InvalidApkSignatureError("apk_signature_invalid", "O APK não tem o fim de ZIP esperado.")


@dataclass(frozen=True, slots=True)
class _ApkLayout:
    path: Path
    before_signing_block_length: int
    central_directory_offset: int
    central_directory_length: int
    eocd: bytes
    signing_blocks: dict[int, bytes]


def _read_apk_layout(path: Path) -> _ApkLayout:
    file_size = path.stat().st_size
    if file_size > MAX_APK_BYTES:
        raise _InvalidApkSignatureError("apk_too_large", "O APK do launcher é grande demais.")
    if file_size < _EOCD_MIN_BYTES:
        raise _InvalidApkSignatureError("apk_signature_invalid", "O APK não tem ZIP válido.")
    with path.open("rb") as handle:
        eocd_offset, eocd = _find_eocd(handle, file_size)
        central_directory_offset = _u32_at(eocd, _EOCD_CD_OFFSET, "O APK não tem ZIP válido.")
        central_directory_length = _u32_at(eocd, _EOCD_CD_SIZE, "O APK não tem ZIP válido.")
        if _ZIP64_MARKER in (central_directory_offset, central_directory_length):
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "O APK usa ZIP64, que não é aceito."
            )
        if (
            central_directory_offset < _APK_SIG_BLOCK_FOOTER_BYTES
            or central_directory_offset + central_directory_length != eocd_offset
        ):
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "O APK não tem diretório ZIP válido."
            )
        footer_offset = central_directory_offset - _APK_SIG_BLOCK_FOOTER_BYTES
        footer = _read_exact(
            handle,
            footer_offset,
            _APK_SIG_BLOCK_FOOTER_BYTES,
            "O APK não tem bloco v2/v3 válido.",
        )
        size = _u64_at(footer, 0, "O APK não tem bloco v2/v3 válido.")
        if footer[8:] != _APK_SIG_BLOCK_MAGIC:
            raise _InvalidApkSignatureError(
                "apk_signature_missing", "O APK não tem assinatura v2 ou v3."
            )
        if size < _APK_SIG_BLOCK_FOOTER_BYTES or size > MAX_SIGNING_BLOCK_BYTES:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "O bloco de assinatura é grande demais."
            )
        signing_block_offset = central_directory_offset - size - 8
        if signing_block_offset < 0:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "O bloco de assinatura não confere."
            )
        signing_block = _read_exact(
            handle,
            signing_block_offset,
            size + 8,
            "O bloco de assinatura está truncado.",
        )
    if _u64_at(signing_block, 0, "O bloco de assinatura não confere.") != size:
        raise _InvalidApkSignatureError(
            "apk_signature_invalid", "O bloco de assinatura não confere."
        )
    pairs = _Reader(signing_block[8:-_APK_SIG_BLOCK_FOOTER_BYTES])
    blocks: dict[int, bytes] = {}
    pair_count = 0
    while pairs.remaining:
        pair_count += 1
        if pair_count > MAX_SIGNING_BLOCK_PAIRS:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "O bloco de assinatura tem pares demais."
            )
        pair_size = pairs.u64()
        if pair_size < _PAIR_ID_BYTES or pair_size > pairs.remaining:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "O bloco de assinatura está truncado."
            )
        pair = _Reader(pairs.take(pair_size))
        block_id = pair.u32()
        value = pair.take(pair.remaining)
        if block_id in blocks:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "O APK repete um bloco de assinatura."
            )
        blocks[block_id] = value
    adjusted_eocd = bytearray(eocd)
    struct.pack_into("<I", adjusted_eocd, _EOCD_CD_OFFSET, signing_block_offset)
    return _ApkLayout(
        path,
        signing_block_offset,
        central_directory_offset,
        central_directory_length,
        bytes(adjusted_eocd),
        blocks,
    )


def _section_chunks(handle: BinaryIO, offset: int, length: int) -> Iterator[bytes]:
    handle.seek(offset)
    remaining = length
    while remaining:
        chunk = handle.read(min(_CHUNK_BYTES, remaining))
        if not chunk:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "O APK foi cortado durante a leitura."
            )
        remaining -= len(chunk)
        yield chunk


def _content_digest(layout: _ApkLayout, hash_algorithm: type[hashes.HashAlgorithm]) -> bytes:
    chunks: list[bytes] = []
    with layout.path.open("rb") as handle:
        sections = (
            _section_chunks(handle, 0, layout.before_signing_block_length),
            _section_chunks(
                handle, layout.central_directory_offset, layout.central_directory_length
            ),
            (layout.eocd,),
        )
        for section in sections:
            for chunk in section:
                digest = hashes.Hash(hash_algorithm())
                digest.update(b"\xa5")
                digest.update(struct.pack("<I", len(chunk)))
                digest.update(chunk)
                chunks.append(digest.finalize())
    digest = hashes.Hash(hash_algorithm())
    digest.update(b"\x5a")
    digest.update(struct.pack("<I", len(chunks)))
    for chunk in chunks:
        digest.update(chunk)
    return digest.finalize()


def _parse_algorithm_records(data: bytes, *, maximum: int, name: str) -> dict[int, bytes]:
    parsed: dict[int, bytes] = {}
    for record in _records(
        data, maximum_count=maximum, maximum_bytes=MAX_SIGNATURE_BYTES, name=name
    ):
        reader = _Reader(record)
        algorithm = reader.u32()
        value_limit = MAX_DIGEST_BYTES if name == "digest" else MAX_SIGNATURE_BYTES
        value = reader.length_prefixed(value_limit, name)
        reader.finish()
        if algorithm in parsed:
            raise _InvalidApkSignatureError("apk_signature_invalid", f"O APK repete um {name}.")
        parsed[algorithm] = value
    return parsed


def _first_certificate(data: bytes) -> x509.Certificate:
    certificates = list(
        _records(
            data,
            maximum_count=MAX_CERTIFICATES_PER_SIGNER,
            maximum_bytes=MAX_CERTIFICATE_BYTES,
            name="certificado",
        )
    )
    if not certificates:
        raise _InvalidApkSignatureError("apk_signature_invalid", "O APK não traz certificado.")
    try:
        return x509.load_der_x509_certificate(certificates[0])
    except ValueError:
        raise _InvalidApkSignatureError(
            "apk_signature_invalid", "O certificado do APK não é válido."
        ) from None


def _check_attributes(data: bytes) -> None:
    for record in _records(
        data,
        maximum_count=MAX_ATTRIBUTES_PER_SIGNER,
        maximum_bytes=MAX_ATTRIBUTE_BYTES,
        name="atributo",
    ):
        reader = _Reader(record)
        attribute_id = reader.u32()
        reader.take(reader.remaining)
        if attribute_id == _PROOF_OF_ROTATION_ATTRIBUTE_ID:
            # Aceitar rotação exigiria avaliar uma cadeia de certificados; com pino estrito, recusar
            # é mais seguro do que confiar no certificado atual sem conferir os anteriores.
            raise _InvalidApkSignatureError(
                "rotacao_nao_suportada", "O APK usa rotação de certificado não suportada."
            )


def _verify_signature(
    public_key: object,
    signature: bytes,
    signed_data: bytes,
    algorithm: _SignatureAlgorithm,
) -> None:
    try:
        if algorithm.key_kind == "rsa":
            if not isinstance(public_key, rsa.RSAPublicKey):
                raise _InvalidApkSignatureError(
                    "apk_signature_invalid", "A chave do APK não é RSA."
                )
            hash_algorithm = algorithm.hash_algorithm()
            signature_padding = (
                padding.PSS(
                    mgf=padding.MGF1(hash_algorithm),
                    salt_length=hash_algorithm.digest_size,
                )
                if algorithm.pss
                else padding.PKCS1v15()
            )
            public_key.verify(signature, signed_data, signature_padding, hash_algorithm)
            return
        if not isinstance(public_key, ec.EllipticCurvePublicKey):
            raise _InvalidApkSignatureError("apk_signature_invalid", "A chave do APK não é ECDSA.")
        public_key.verify(signature, signed_data, ec.ECDSA(algorithm.hash_algorithm()))
    except InvalidSignature, TypeError, ValueError:
        raise _InvalidApkSignatureError(
            "apk_signature_invalid", "A assinatura do APK não confere."
        ) from None


def _finish_signed_data(signed: _Reader) -> None:
    """O apksigner fecha os dados assinados com um elemento vazio (4 bytes zero); só isso é aceito.

    Os dados já estão cobertos pela assinatura, então o resto é inofensivo, mas qualquer coisa
    diferente de elementos vazios continua sendo recusada.
    """
    if signed.remaining % 4 or signed.remaining > _MAX_TRAILING_EMPTY_BYTES:
        signed.finish()
    if any(signed.take(signed.remaining)):
        raise _InvalidApkSignatureError(
            "apk_signature_invalid", "A assinatura do APK tem dados extras."
        )


def _verify_signer(signer: bytes, layout: _ApkLayout, *, v3: bool, pinned: str) -> None:
    reader = _Reader(signer)
    signed_data = reader.length_prefixed(MAX_SIGNER_BYTES, "dados assinados")
    outer_min_sdk = outer_max_sdk = None
    if v3:
        outer_min_sdk = reader.u32()
        outer_max_sdk = reader.u32()
        if outer_min_sdk > outer_max_sdk:
            raise _InvalidApkSignatureError(
                "apk_signature_invalid", "Os limites SDK da assinatura v3 são inválidos."
            )
    signatures = _parse_algorithm_records(
        reader.length_prefixed(MAX_SIGNER_BYTES, "lista de assinaturas"),
        maximum=MAX_SIGNATURES_PER_SIGNER,
        name="assinatura",
    )
    declared_public_key = reader.length_prefixed(MAX_PUBLIC_KEY_BYTES, "chave pública")
    reader.finish()

    signed = _Reader(signed_data)
    digests = _parse_algorithm_records(
        signed.length_prefixed(MAX_SIGNER_BYTES, "lista de digests"),
        maximum=MAX_DIGESTS_PER_SIGNER,
        name="digest",
    )
    certificate = _first_certificate(
        signed.length_prefixed(MAX_SIGNER_BYTES, "lista de certificados")
    )
    if v3 and (signed.u32(), signed.u32()) != (outer_min_sdk, outer_max_sdk):
        raise _InvalidApkSignatureError(
            "apk_signature_invalid", "Os limites SDK da assinatura v3 não conferem."
        )
    _check_attributes(signed.length_prefixed(MAX_SIGNER_BYTES, "lista de atributos"))
    _finish_signed_data(signed)

    # A especificação exige a mesma lista, na mesma ordem: a ordem também é assinada e
    # impede trocar algoritmos de lugar.
    if list(signatures) != list(digests):
        raise _InvalidApkSignatureError(
            "apk_signature_invalid", "As assinaturas e os digests do APK não correspondem."
        )
    supported = sorted(set(signatures) & _SIGNATURE_ALGORITHMS.keys())
    if not supported:
        raise _InvalidApkSignatureError(
            "apk_signature_unsupported", "O APK usa um algoritmo de assinatura não suportado."
        )

    public_key = certificate.public_key()
    try:
        certificate_public_key = public_key.public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    except ValueError:
        raise _InvalidApkSignatureError(
            "apk_signature_invalid", "A chave do certificado não é válida."
        ) from None
    if not hmac.compare_digest(certificate_public_key, declared_public_key):
        raise _InvalidApkSignatureError(
            "apk_public_key_mismatch", "A chave declarada pelo APK não confere com o certificado."
        )

    for algorithm_id in supported:
        algorithm = _SIGNATURE_ALGORITHMS[algorithm_id]
        _verify_signature(public_key, signatures[algorithm_id], signed_data, algorithm)
        if not hmac.compare_digest(
            digests[algorithm_id], _content_digest(layout, algorithm.hash_algorithm)
        ):
            raise _InvalidApkSignatureError(
                "apk_content_mismatch", "O conteúdo do APK mudou depois de ser assinado."
            )
    certificate_digest = hashlib.sha256(
        certificate.public_bytes(serialization.Encoding.DER)
    ).hexdigest()
    if not hmac.compare_digest(certificate_digest, pinned):
        raise _InvalidApkSignatureError(
            "apk_signer_mismatch", "O launcher baixado não foi assinado pelo certificado esperado."
        )


def _signers(block: bytes, scheme: str) -> list[bytes]:
    """Lê o valor de um bloco v2/v3: uma sequência com tamanho de assinantes com tamanho."""
    outer = _Reader(block)
    sequence = outer.length_prefixed(MAX_SIGNING_BLOCK_BYTES, f"lista de assinantes {scheme}")
    outer.finish()
    signers = list(
        _records(
            sequence,
            maximum_count=MAX_SIGNERS,
            maximum_bytes=MAX_SIGNER_BYTES,
            name=f"assinante {scheme}",
        )
    )
    if not signers:
        raise _InvalidApkSignatureError(
            "apk_signature_invalid", f"O APK não traz assinante {scheme}."
        )
    return signers


class ApkSignerVerifier:
    """Valida o APK localmente; `pinned` só existe para gerar certificados efêmeros nos testes."""

    def __init__(self, *, pinned: str = PROJECT_SIGNER_SHA256) -> None:
        self._pinned = pinned.lower()

    async def __call__(self, apk: Path) -> None:
        try:
            layout = _read_apk_layout(apk)
            v2 = layout.signing_blocks.get(_V2_BLOCK_ID)
            if v2 is None:
                raise _InvalidApkSignatureError(
                    "apk_signature_missing", "O APK não tem assinatura v2 ou v3."
                )
            signers = _signers(v2, "v2")
            for signer in signers:
                _verify_signer(signer, layout, v3=False, pinned=self._pinned)
            v3 = layout.signing_blocks.get(_V3_BLOCK_ID)
            if v3 is not None:
                for signer in _signers(v3, "v3"):
                    _verify_signer(signer, layout, v3=True, pinned=self._pinned)
        except OSError:
            raise LauncherApkError(
                "apk_unavailable", "Não consegui ler o APK do launcher."
            ) from None
        except _InvalidApkSignatureError as exc:
            raise LauncherApkError(exc.code, exc.message) from None
