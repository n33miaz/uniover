"""Manifesto Ed25519 da atualização: a assinatura e o hash são obrigatórios."""

import base64
import hashlib
import json
import logging
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from tests.test_self_update import NEW, Installation
from uniover_agent.adapters import self_update as module
from uniover_agent.adapters.self_update import (
    SelfUpdateError,
    SignedManifest,
    UpdateRejected,
    read_manifest,
    verify_manifest_archive,
)


@pytest.fixture
def signing_key(monkeypatch: pytest.MonkeyPatch) -> Ed25519PrivateKey:
    key = Ed25519PrivateKey.from_private_bytes(b"\x01" * 32)
    public = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    monkeypatch.setattr(module, "MANIFEST_PUBLIC_KEYS", (base64.b64encode(public).decode("ascii"),))
    return key


def signed_manifest(key: Ed25519PrivateKey, sha: str = NEW, **changes: str | int) -> bytes:
    fields: dict[str, str | int] = {
        "format": 1,
        "version": "0.60.0",
        "commit": sha,
        "archiveSha256": "2" * 64,
        "archiveUrl": module.archive_url(sha),
        "sequence": 100,
    }
    fields.update(changes)
    return json.dumps(
        fields
        | {
            "signature": base64.b64encode(key.sign(module._manifest_message(fields))).decode(
                "ascii"
            )
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")


def test_a_valid_signed_manifest_is_accepted(signing_key: Ed25519PrivateKey) -> None:
    manifest = read_manifest(signed_manifest(signing_key), NEW)
    assert manifest == SignedManifest("0.60.0", NEW, "2" * 64, module.archive_url(NEW), 100)


def test_a_manifest_with_a_changed_field_is_rejected(signing_key: Ed25519PrivateKey) -> None:
    document = json.loads(signed_manifest(signing_key))
    document["archiveSha256"] = "3" * 64
    with pytest.raises(UpdateRejected, match="assinatura"):
        read_manifest(json.dumps(document).encode("ascii"), NEW)


def test_a_manifest_for_another_commit_or_url_is_rejected(signing_key: Ed25519PrivateKey) -> None:
    with pytest.raises(UpdateRejected, match="commit esperado"):
        read_manifest(signed_manifest(signing_key, "a" * 40), NEW)
    with pytest.raises(UpdateRejected, match="pacote inesperado"):
        read_manifest(signed_manifest(signing_key, archiveUrl="https://example.test/a.zip"), NEW)


def test_the_download_must_match_the_signed_hash(tmp_path: Path) -> None:
    archive = tmp_path / "agent.zip"
    archive.write_bytes("conteúdo assinado".encode())
    manifest = SignedManifest(
        "0.60.0", NEW, hashlib.sha256(archive.read_bytes()).hexdigest(), module.archive_url(NEW)
    )
    verify_manifest_archive(manifest, archive)
    archive.write_bytes(b"troca")
    with pytest.raises(UpdateRejected, match="não confere com o manifesto"):
        verify_manifest_archive(manifest, archive)


def test_a_missing_or_invalid_manifest_never_starts_the_download(
    tmp_path: Path, signing_key: Ed25519PrivateKey
) -> None:
    installed = Installation(tmp_path / "UniOver")
    result = installed.update(NEW, parse_manifest=lambda data, sha: read_manifest(b"{}", sha))
    assert result.rejected
    assert installed.downloads == []


def test_with_a_key_embedded_a_release_without_manifest_is_not_installed(
    tmp_path: Path, signing_key: Ed25519PrivateKey
) -> None:
    def missing() -> bytes:
        raise SelfUpdateError("não consegui obter o manifesto assinado (HTTPStatusError)")

    installed = Installation(tmp_path / "UniOver")
    result = installed.update(NEW, fetch_signed_manifest=missing)
    assert not result.updated
    assert installed.downloads == []


def test_with_a_key_embedded_the_archive_must_match_the_signed_hash(
    tmp_path: Path, signing_key: Ed25519PrivateKey
) -> None:
    installed = Installation(tmp_path / "UniOver")
    result = installed.update(
        NEW,
        fetch_signed_manifest=lambda: signed_manifest(signing_key),
        parse_manifest=read_manifest,
        verify_signed_archive=verify_manifest_archive,
    )
    assert result.rejected
    assert "manifesto assinado" in result.message


def test_without_any_key_the_manifest_is_not_required_and_not_even_fetched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(module, "MANIFEST_PUBLIC_KEYS", ())
    assert not module.signature_required()

    def must_not_fetch() -> bytes:
        raise AssertionError("sem chave embutida o manifesto não é consultado")

    installed = Installation(tmp_path / "UniOver")
    result = installed.update(NEW, fetch_signed_manifest=must_not_fetch)
    assert result.updated


def test_without_any_key_an_unverifiable_tree_still_refuses_the_package(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(module, "MANIFEST_PUBLIC_KEYS", ())
    installed = Installation(tmp_path / "UniOver")
    result = installed.update(NEW, verify_files=module.verify_tree)
    assert result.rejected
    assert "árvore" in result.message


def test_the_inactive_signature_is_logged_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(module, "MANIFEST_PUBLIC_KEYS", ())
    monkeypatch.setattr(module, "_inactive_logged", False)
    with caplog.at_level(logging.INFO):
        module._note_signature_inactive()
        module._note_signature_inactive()
    assert [r.message for r in caplog.records if "ainda não ativa" in r.message] != []
    assert len([r for r in caplog.records if "ainda não ativa" in r.message]) == 1


def test_no_placeholder_key_is_embedded() -> None:
    # Chave "sentinela" (todos os bytes zero) foi removida: só chave real entra na lista.
    assert all(set(base64.b64decode(key)) != {0} for key in module.MANIFEST_PUBLIC_KEYS)


def manifest_at(commit: str, sequence: int) -> SignedManifest:
    return SignedManifest("1", commit, "0" * 64, "u", sequence)


def test_the_sequence_is_signed_and_must_be_a_positive_integer(
    signing_key: Ed25519PrivateKey,
) -> None:
    for bad in (0, -1, True, "7"):
        with pytest.raises(UpdateRejected, match="formato inválido"):
            read_manifest(signed_manifest(signing_key, sequence=bad), NEW)
    document = json.loads(signed_manifest(signing_key))
    document["sequence"] = 101
    with pytest.raises(UpdateRejected, match="assinatura"):
        read_manifest(json.dumps(document).encode("ascii"), NEW)
    document.pop("sequence")
    with pytest.raises(UpdateRejected, match="campos inesperados"):
        read_manifest(json.dumps(document).encode("ascii"), NEW)


def test_a_manifest_older_than_the_accepted_one_is_refused_as_a_downgrade(tmp_path: Path) -> None:
    installed = Installation(tmp_path / "UniOver")
    module.record_manifest_sequence(installed.source, manifest_at("a" * 40, 200))
    assert module.accepted_sequence(installed.source) == (200, "a" * 40)

    with pytest.raises(UpdateRejected, match="rebaixamento"):
        module.check_manifest_sequence(installed.source, manifest_at(NEW, 199))
    with pytest.raises(UpdateRejected, match="rebaixamento"):
        module.check_manifest_sequence(installed.source, manifest_at(NEW, 200))
    # O mesmo commit e o mesmo número é a nova tentativa de uma atualização que falhou.
    module.check_manifest_sequence(installed.source, manifest_at("a" * 40, 200))
    module.check_manifest_sequence(installed.source, manifest_at(NEW, 201))


def test_the_recorded_sequence_only_grows(tmp_path: Path) -> None:
    installed = Installation(tmp_path / "UniOver")
    module.record_manifest_sequence(installed.source, manifest_at("a" * 40, 50))
    module.record_manifest_sequence(installed.source, manifest_at("b" * 40, 40))
    assert module.accepted_sequence(installed.source) == (50, "a" * 40)
    module.record_manifest_sequence(installed.source, manifest_at("c" * 40, 60))
    assert module.accepted_sequence(installed.source) == (60, "c" * 40)


def test_an_old_release_is_not_downloaded_and_a_new_one_is_recorded(
    tmp_path: Path, signing_key: Ed25519PrivateKey
) -> None:
    installed = Installation(tmp_path / "UniOver")
    module.record_manifest_sequence(installed.source, manifest_at("a" * 40, 500))
    result = installed.update(
        NEW,
        fetch_signed_manifest=lambda: signed_manifest(signing_key, sequence=499),
        parse_manifest=read_manifest,
    )
    assert result.rejected
    assert "rebaixamento" in result.message
    assert installed.downloads == []

    result = installed.update(
        NEW,
        fetch_signed_manifest=lambda: signed_manifest(signing_key, sequence=501),
        parse_manifest=read_manifest,
        verify_signed_archive=lambda manifest, archive: None,
    )
    assert result.updated
    assert module.accepted_sequence(installed.source) == (501, NEW)


def test_with_an_active_signature_an_unreachable_tree_does_not_refuse(
    tmp_path: Path, signing_key: Ed25519PrivateKey
) -> None:
    installed = Installation(tmp_path / "UniOver")
    result = installed.update(
        NEW,
        fetch_signed_manifest=lambda: signed_manifest(signing_key),
        parse_manifest=read_manifest,
        verify_signed_archive=lambda manifest, archive: None,
        verify_files=lambda archive, sha: module.verify_tree(archive, sha, lambda _: None),
    )
    assert result.updated


def test_with_an_active_signature_a_divergent_tree_still_refuses(
    tmp_path: Path, signing_key: Ed25519PrivateKey
) -> None:
    def divergent(archive: Path, sha: str) -> bool:
        raise UpdateRejected("um arquivo do pacote difere do commit")

    installed = Installation(tmp_path / "UniOver")
    result = installed.update(
        NEW,
        fetch_signed_manifest=lambda: signed_manifest(signing_key),
        parse_manifest=read_manifest,
        verify_signed_archive=lambda manifest, archive: None,
        verify_files=divergent,
    )
    assert result.rejected
