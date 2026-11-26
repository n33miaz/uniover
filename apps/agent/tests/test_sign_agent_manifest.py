"""Ativação da assinatura na publicação: o que o job faz com chave embutida e segredo."""

import base64
import importlib.util
from pathlib import Path
from types import ModuleType

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from uniover_agent.adapters import self_update

AGENT = Path(__file__).resolve().parent.parent
KEY = "chave-publica-a"
COMMIT = "a" * 40


def load_tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "sign_agent_manifest", AGENT / "tools" / "sign_agent_manifest.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = load_tool()


def test_without_embedded_key_and_without_secret_the_release_only_warns() -> None:
    action, message = tool.decide_activation((), None)
    assert action == "skip"
    assert "ainda não está ativa" in message


def test_with_embedded_key_and_without_secret_the_release_fails() -> None:
    action, message = tool.decide_activation((KEY,), None)
    assert action == "fail"
    assert "AGENT_SIGNING_KEY" in message


def test_with_a_secret_the_manifest_is_signed_and_a_foreign_key_fails() -> None:
    assert tool.decide_activation((KEY,), KEY) == ("sign", "")
    assert tool.decide_activation((KEY, "outra"), KEY)[0] == "sign"
    assert tool.decide_activation((KEY,), "estranha")[0] == "fail"
    action, message = tool.decide_activation((), KEY)
    assert action == "sign"
    assert "só passa a valer" in message


def test_the_activation_command_exits_with_failure_when_a_keyed_release_has_no_secret(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("AGENT_SIGNING_KEY", raising=False)
    monkeypatch.setattr(tool, "embedded_keys", lambda: (KEY,))
    assert tool.activation() == 1
    assert "::error::" in capsys.readouterr().err
    monkeypatch.setattr(tool, "embedded_keys", lambda: ())
    assert tool.activation() == 0
    captured = capsys.readouterr()
    assert captured.out.strip() == "skip"
    assert "::warning::" in captured.err


def signed_manifest(folder: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, str]:
    """Assina um manifesto com uma chave nova e devolve o arquivo e a pública correspondente."""
    private_key = Ed25519PrivateKey.generate()
    private = private_key.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public = private_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    path = folder / "uniover-agent-manifest.json"
    args = tool.parser().parse_args(
        [
            "sign",
            "--version=1.2.3",
            f"--commit={COMMIT}",
            f"--archive-sha256={'b' * 64}",
            f"--archive-url={self_update.archive_url(COMMIT)}",
            "--sequence=1",
            f"--output={path}",
        ]
    )
    monkeypatch.setenv("AGENT_SIGNING_KEY", base64.b64encode(private).decode("ascii"))
    assert tool.sign(args) == 0
    # A conferência do Release público não usa a privada.
    monkeypatch.delenv("AGENT_SIGNING_KEY")
    return path, base64.b64encode(public).decode("ascii")


def verify(path: Path, commit: str = COMMIT) -> int:
    args = tool.parser().parse_args(["verify", f"--commit={commit}", f"--manifest={path}"])
    return int(tool.verify(args))


def test_a_public_manifest_signed_by_an_embedded_key_is_accepted_and_left_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path, public = signed_manifest(tmp_path, monkeypatch)
    monkeypatch.setattr(self_update, "MANIFEST_PUBLIC_KEYS", (public,))
    before = path.read_bytes()
    assert verify(path) == 0
    assert path.read_bytes() == before


@pytest.mark.parametrize("problem", ["commit", "key", "content", "json"])
def test_a_keyed_release_rejects_a_public_manifest_the_agent_would_refuse(
    problem: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    path, public = signed_manifest(tmp_path, monkeypatch)
    if problem == "key":
        other = tmp_path / "other"
        other.mkdir()
        public = signed_manifest(other, monkeypatch)[1]
    if problem == "content":
        path.write_text(path.read_text("utf-8").replace("1.2.3", "9.9.9"), encoding="utf-8")
    if problem == "json":
        path.write_text("{", encoding="utf-8")
    monkeypatch.setattr(self_update, "MANIFEST_PUBLIC_KEYS", (public,))
    assert verify(path, "c" * 40 if problem == "commit" else COMMIT) == 1
    assert "::error::" in capsys.readouterr().err


def test_a_public_release_without_manifest_fails_only_with_an_embedded_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    missing = tmp_path / "uniover-agent-manifest.json"
    monkeypatch.setattr(self_update, "MANIFEST_PUBLIC_KEYS", (KEY,))
    assert verify(missing) == 1
    assert "::error::" in capsys.readouterr().err
    monkeypatch.setattr(self_update, "MANIFEST_PUBLIC_KEYS", ())
    assert verify(missing) == 0
    assert "::warning::" in capsys.readouterr().err
    assert not missing.exists()


@pytest.mark.parametrize(
    ("content", "expected"),
    [(f'{{"commit":"{COMMIT}"}}', 0), ('{"commit":"outro"}', 1), ("[]", 1), ("{", 1)],
)
def test_without_embedded_key_a_public_manifest_only_needs_to_match_the_commit(
    content: str, expected: int, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "uniover-agent-manifest.json"
    path.write_text(content, encoding="utf-8")
    monkeypatch.setattr(self_update, "MANIFEST_PUBLIC_KEYS", ())
    assert verify(path) == expected


def test_the_publish_workflow_uses_the_activation_decision_and_a_sequence() -> None:
    workflow = (AGENT.parent.parent / ".github" / "workflows" / "deploy.yml").read_text(
        encoding="utf-8"
    )
    assert "sign_agent_manifest.py activation" in workflow
    assert '"$action" != "sign"' in workflow
    assert '--sequence "$sequence"' in workflow
    assert "AGENT_SIGNING_KEY" in workflow
