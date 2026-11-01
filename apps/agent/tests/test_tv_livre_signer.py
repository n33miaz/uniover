"""Assinatura v2/v3 do APK do TV Livre, com arquivos montados inteiramente no teste."""

import hashlib
import io
import struct
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID

from uniover_agent.adapters.tv_livre_apk import ReleaseApkSource
from uniover_agent.adapters.tv_livre_signer import (
    MAX_APK_BYTES,
    PROJECT_SIGNER_SHA256,
    ApkSignerVerifier,
)
from uniover_agent.ports.tv_livre import LauncherApkError

PSS_SHA256 = 0x0101
PKCS1_SHA256 = 0x0103
DSA_SHA256 = 0x0301
UNKNOWN_ALGORITHM = 0x7FFF0001
V2_ID = 0x7109871A
V3_ID = 0xF05368C0
SIG_BLOCK_MAGIC = b"APK Sig Block 42"
EOCD_MAGIC = b"PK\x05\x06"


def u32(value: int) -> bytes:
    return struct.pack("<I", value)


def u64(value: int) -> bytes:
    return struct.pack("<Q", value)


def length_prefixed(value: bytes) -> bytes:
    return u32(len(value)) + value


def algorithm_hash(algorithm: int) -> hashes.HashAlgorithm:
    if algorithm in {PSS_SHA256, PKCS1_SHA256}:
        return hashes.SHA256()
    raise AssertionError(f"algoritmo de teste desconhecido: {algorithm:#x}")


def record(algorithm: int, value: bytes) -> bytes:
    return length_prefixed(u32(algorithm) + length_prefixed(value))


def eocd_offset(data: bytes) -> int:
    offset = data.rfind(EOCD_MAGIC)
    assert offset >= 0
    assert offset + 22 + struct.unpack_from("<H", data, offset + 20)[0] == len(data)
    return offset


def digest_content(before: bytes, central_directory: bytes, eocd: bytes) -> bytes:
    chunks: list[bytes] = []
    for section in (before, central_directory, eocd):
        for offset in range(0, len(section), 1024 * 1024):
            chunk = section[offset : offset + 1024 * 1024]
            digest = hashes.Hash(hashes.SHA256())
            digest.update(b"\xa5")
            digest.update(u32(len(chunk)))
            digest.update(chunk)
            chunks.append(digest.finalize())
    digest = hashes.Hash(hashes.SHA256())
    digest.update(b"\x5a")
    digest.update(u32(len(chunks)))
    for chunk in chunks:
        digest.update(chunk)
    return digest.finalize()


def certificate(private_key: rsa.RSAPrivateKey) -> bytes:
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Teste TV Livre")]))
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Teste TV Livre")]))
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .sign(private_key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.DER)


def signed_data(  # noqa: PLR0913
    digests: dict[int, bytes],
    cert: bytes,
    *,
    v3: bool,
    attributes: tuple[int, ...],
    min_sdk: int,
    max_sdk: int,
    trailing: bytes = b"",
) -> bytes:
    digest_records = b"".join(record(algorithm, value) for algorithm, value in digests.items())
    attribute_records = b"".join(length_prefixed(u32(attribute) + b"x") for attribute in attributes)
    data = length_prefixed(digest_records) + length_prefixed(length_prefixed(cert))
    if v3:
        data += u32(min_sdk) + u32(max_sdk)
    return data + length_prefixed(attribute_records) + trailing


def sign(private_key: rsa.RSAPrivateKey, data: bytes, algorithm: int) -> bytes:
    if algorithm not in {PSS_SHA256, PKCS1_SHA256}:
        return b"assinatura-de-algoritmo-desconhecido"
    hash_algorithm = algorithm_hash(algorithm)
    if algorithm == PSS_SHA256:
        return private_key.sign(
            data,
            padding.PSS(
                mgf=padding.MGF1(hash_algorithm),
                salt_length=hash_algorithm.digest_size,
            ),
            hash_algorithm,
        )
    return private_key.sign(data, padding.PKCS1v15(), hash_algorithm)


def signer(  # noqa: PLR0913
    private_key: rsa.RSAPrivateKey,
    cert: bytes,
    digests: dict[int, bytes],
    signature_algorithms: tuple[int, ...],
    *,
    v3: bool,
    attributes: tuple[int, ...],
    min_sdk: int,
    max_sdk: int,
    declared_public_key: bytes | None = None,
    trailing: bytes = b"",
) -> bytes:
    data = signed_data(
        digests,
        cert,
        v3=v3,
        attributes=attributes,
        min_sdk=min_sdk,
        max_sdk=max_sdk,
        trailing=trailing,
    )
    signatures = b"".join(
        record(algorithm, sign(private_key, data, algorithm)) for algorithm in signature_algorithms
    )
    public_key = declared_public_key or private_key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    outer = length_prefixed(data)
    if v3:
        outer += u32(min_sdk) + u32(max_sdk)
    return outer + length_prefixed(signatures) + length_prefixed(public_key)


def unsigned_apk() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("classes.dex", b"conteudo do launcher")
        archive.comment = b"comentario assinado"
    return output.getvalue()


def signed_apk(  # noqa: PLR0913
    path: Path,
    *,
    algorithms: tuple[int, ...] = (PSS_SHA256,),
    signature_algorithms: tuple[int, ...] | None = None,
    include_v3: bool = False,
    digest_overrides: dict[int, bytes] | None = None,
    attributes: tuple[int, ...] = (),
    min_sdk: int = 21,
    max_sdk: int = 35,
    declared_public_key: bytes | None = None,
    trailing: bytes = b"",
) -> str:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = certificate(private_key)
    unsigned = unsigned_apk()
    eocd = eocd_offset(unsigned)
    central_offset = struct.unpack_from("<I", unsigned, eocd + 16)[0]
    before = unsigned[:central_offset]
    central_directory = unsigned[central_offset:eocd]
    adjusted_eocd = bytearray(unsigned[eocd:])
    struct.pack_into("<I", adjusted_eocd, 16, central_offset)
    content_digest = digest_content(before, central_directory, bytes(adjusted_eocd))
    digests = {algorithm: content_digest for algorithm in algorithms}
    digests.update(digest_overrides or {})
    signature_algorithms = signature_algorithms or algorithms

    def pair(block_id: int, *, v3: bool) -> bytes:
        # O valor do bloco é uma sequência com tamanho de assinantes com tamanho.
        value = length_prefixed(
            length_prefixed(
                signer(
                    private_key,
                    cert,
                    digests,
                    signature_algorithms,
                    v3=v3,
                    attributes=attributes if v3 else (),
                    min_sdk=min_sdk,
                    max_sdk=max_sdk,
                    declared_public_key=declared_public_key,
                    trailing=trailing,
                )
            )
        )
        return u64(4 + len(value)) + u32(block_id) + value

    pairs = [pair(V2_ID, v3=False)]
    if include_v3:
        pairs.append(pair(V3_ID, v3=True))
    pair_data = b"".join(pairs)
    block_size = len(pair_data) + 24
    signing_block = u64(block_size) + pair_data + u64(block_size) + SIG_BLOCK_MAGIC
    final_eocd = bytearray(unsigned[eocd:])
    struct.pack_into("<I", final_eocd, 16, central_offset + len(signing_block))
    path.write_bytes(before + signing_block + central_directory + final_eocd)
    return hashlib.sha256(cert).hexdigest()


@pytest.mark.parametrize(
    ("algorithm", "include_v3"),
    [(PSS_SHA256, True), (PKCS1_SHA256, False)],
    ids=["pss-sha256", "pkcs1-sha256"],
)
async def test_the_aosp_rsa_algorithm_ids_are_verified_with_their_real_padding(
    tmp_path: Path,
    algorithm: int,
    include_v3: bool,
) -> None:
    apk = tmp_path / "launcher.apk"
    pin = signed_apk(apk, algorithms=(algorithm,), include_v3=include_v3)

    await ApkSignerVerifier(pinned=pin)(apk)


async def test_an_apk_signed_by_another_certificate_is_refused(tmp_path: Path) -> None:
    apk = tmp_path / "launcher.apk"
    signed_apk(apk)
    other_certificate = signed_apk(tmp_path / "outro-launcher.apk")

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=other_certificate)(apk)

    assert raised.value.code == "apk_signer_mismatch"


@pytest.mark.parametrize("part", ["before", "central", "eocd", "comment"])
async def test_each_signed_zip_section_rejects_an_altered_byte(
    tmp_path: Path,
    part: str,
) -> None:
    apk = tmp_path / "launcher.apk"
    pin = signed_apk(apk)
    changed = bytearray(apk.read_bytes())
    eocd = eocd_offset(changed)
    central_offset = struct.unpack_from("<I", changed, eocd + 16)[0]
    if part == "before":
        changed[changed.index(b"conteudo")] ^= 1
    elif part == "central":
        changed[central_offset + 46] ^= 1
    elif part == "eocd":
        changed[eocd + 4] ^= 1
    else:
        changed[-1] ^= 1
    apk.write_bytes(changed)

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(apk)

    assert raised.value.code == "apk_content_mismatch"


async def test_a_declared_public_key_different_from_the_certificate_is_refused(
    tmp_path: Path,
) -> None:
    apk = tmp_path / "launcher.apk"
    pin = signed_apk(apk, declared_public_key=b"chave-publica-diferente")

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(apk)

    assert raised.value.code == "apk_public_key_mismatch"


async def test_every_supported_signature_and_digest_must_match_the_content(
    tmp_path: Path,
) -> None:
    apk = tmp_path / "launcher.apk"
    pin = signed_apk(
        apk,
        algorithms=(PSS_SHA256, PKCS1_SHA256),
        digest_overrides={PKCS1_SHA256: b"\0" * 32},
    )

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(apk)

    assert raised.value.code == "apk_content_mismatch"


async def test_signature_and_digest_algorithm_lists_must_match(tmp_path: Path) -> None:
    apk = tmp_path / "launcher.apk"
    pin = signed_apk(
        apk,
        algorithms=(PSS_SHA256,),
        signature_algorithms=(PKCS1_SHA256,),
    )

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(apk)

    assert raised.value.code == "apk_signature_invalid"


async def test_signature_and_digest_lists_must_keep_the_same_order(tmp_path: Path) -> None:
    apk = tmp_path / "launcher.apk"
    pin = signed_apk(
        apk,
        algorithms=(PSS_SHA256, PKCS1_SHA256),
        signature_algorithms=(PKCS1_SHA256, PSS_SHA256),
    )

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(apk)

    assert raised.value.code == "apk_signature_invalid"


async def test_unknown_algorithms_need_a_valid_supported_peer(tmp_path: Path) -> None:
    accepted = tmp_path / "accepted.apk"
    pin = signed_apk(
        accepted,
        algorithms=(PSS_SHA256, UNKNOWN_ALGORITHM),
    )

    await ApkSignerVerifier(pinned=pin)(accepted)

    unsupported = tmp_path / "unsupported.apk"
    pin = signed_apk(unsupported, algorithms=(DSA_SHA256,))
    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(unsupported)

    assert raised.value.code == "apk_signature_unsupported"


async def test_an_apk_without_a_v2_or_v3_block_is_refused(tmp_path: Path) -> None:
    apk = tmp_path / "launcher.apk"
    apk.write_bytes(unsigned_apk())

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned="00" * 32)(apk)

    assert raised.value.code == "apk_signature_missing"


async def test_a_refused_signature_removes_the_downloaded_apk(tmp_path: Path) -> None:
    apk = b"PK\x03\x04" + b"x" * 40
    digest = hashlib.sha256(apk).hexdigest()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".sha256"):
            return httpx.Response(200, text=digest)
        return httpx.Response(200, content=apk)

    async def refuse(_: Path) -> None:
        raise LauncherApkError("apk_signature_invalid", "Assinatura recusada no teste.")

    source = ReleaseApkSource(
        "https://exemplo.test/x",
        tmp_path,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        verifier=refuse,
    )

    with pytest.raises(LauncherApkError) as raised:
        await source.fetch()

    assert raised.value.code == "apk_signature_invalid"
    assert not (tmp_path / "uniover-launcher.apk").exists()


async def test_a_malicious_length_and_an_oversized_file_are_refused(
    tmp_path: Path,
) -> None:
    malformed = tmp_path / "malformed.apk"
    pin = signed_apk(malformed)
    data = bytearray(malformed.read_bytes())
    eocd = eocd_offset(data)
    central_offset = struct.unpack_from("<I", data, eocd + 16)[0]
    block_size = struct.unpack_from("<Q", data, central_offset - 24)[0]
    signing_block_offset = central_offset - block_size - 8
    outer_signers_length = signing_block_offset + 8 + 8 + 4
    struct.pack_into("<I", data, outer_signers_length, 0xFFFFFFFF)
    malformed.write_bytes(data)

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(malformed)

    assert raised.value.code == "apk_signature_invalid"

    oversized = tmp_path / "large.apk"
    with oversized.open("wb") as handle:
        handle.truncate(MAX_APK_BYTES + 1)
    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(oversized)

    assert raised.value.code == "apk_too_large"


async def test_certificate_rotation_and_invalid_v3_sdk_range_are_refused(
    tmp_path: Path,
) -> None:
    rotation = tmp_path / "rotation.apk"
    pin = signed_apk(rotation, include_v3=True, attributes=(0x3BA06F8C,))

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(rotation)

    assert raised.value.code == "rotacao_nao_suportada"

    invalid_range = tmp_path / "range.apk"
    pin = signed_apk(invalid_range, include_v3=True, min_sdk=35, max_sdk=21)
    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(invalid_range)

    assert raised.value.code == "apk_signature_invalid"


def test_the_production_pin_is_the_projects_published_signing_certificate() -> None:
    published = Path(__file__).resolve().parents[3] / "apps" / "tv-launcher" / "signing-cert.sha256"
    if not published.is_file():
        pytest.skip("pasta apps/tv-launcher fora do alcance (app testado sozinho)")

    assert PROJECT_SIGNER_SHA256 == published.read_text(encoding="utf-8").strip().lower()


REAL_APK = Path(__file__).parent / "fixtures" / "uniover-launcher-project-signed.apk"
REAL_PIN = "f782151a18e6bc3ff22a201ff558fd833feb2120182034a3dec6aeab41b12bfc"


async def test_the_real_apk_signed_by_the_project_is_accepted_with_the_production_pin() -> None:
    await ApkSignerVerifier()(REAL_APK)
    await ApkSignerVerifier(pinned=REAL_PIN)(REAL_APK)


async def test_the_real_apk_is_refused_with_another_pin() -> None:
    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned="00" * 32)(REAL_APK)

    assert raised.value.code == "apk_signer_mismatch"


@pytest.mark.parametrize("part", ["entry", "central", "eocd"])
async def test_the_real_apk_is_refused_when_one_byte_of_a_signed_section_changes(
    tmp_path: Path,
    part: str,
) -> None:
    changed = bytearray(REAL_APK.read_bytes())
    eocd = eocd_offset(changed)
    central_offset = struct.unpack_from("<I", changed, eocd + 16)[0]
    if part == "entry":
        with zipfile.ZipFile(REAL_APK) as archive:
            first = min(archive.infolist(), key=lambda item: item.header_offset)
        name_length, extra_length = struct.unpack_from("<HH", changed, first.header_offset + 26)
        data_start = first.header_offset + 30 + name_length + extra_length
        assert first.compress_size > 0
        changed[data_start] ^= 1
    elif part == "central":
        changed[central_offset + 46] ^= 1
    else:
        changed[eocd + 4] ^= 1
    apk = tmp_path / "launcher.apk"
    apk.write_bytes(changed)

    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier()(apk)

    assert raised.value.code == "apk_content_mismatch"


@pytest.mark.parametrize(
    ("trailing", "accepted"),
    [(b"\x00\x00\x00\x00", True), (b"\x00\x00\x00", False), (b"\x00\x00\x00\x01", False)],
    ids=["empty-element", "misaligned", "non-zero"],
)
async def test_signed_data_may_only_end_with_empty_elements(
    tmp_path: Path,
    trailing: bytes,
    accepted: bool,
) -> None:
    apk = tmp_path / "launcher.apk"
    pin = signed_apk(apk, trailing=trailing)

    if accepted:
        await ApkSignerVerifier(pinned=pin)(apk)
        return
    with pytest.raises(LauncherApkError) as raised:
        await ApkSignerVerifier(pinned=pin)(apk)

    assert raised.value.code == "apk_signature_invalid"
