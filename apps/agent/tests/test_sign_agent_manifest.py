"""Ativação da assinatura na publicação: o que o job faz com chave embutida e segredo."""

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

AGENT = Path(__file__).resolve().parent.parent
KEY = "chave-publica-a"


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


def test_the_publish_workflow_uses_the_activation_decision_and_a_sequence() -> None:
    workflow = (AGENT.parent.parent / ".github" / "workflows" / "deploy.yml").read_text(
        encoding="utf-8"
    )
    assert "sign_agent_manifest.py activation" in workflow
    assert '"$action" != "sign"' in workflow
    assert '--sequence "$sequence"' in workflow
    assert "AGENT_SIGNING_KEY" in workflow
