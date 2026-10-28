"""Paridade do contrato: os exemplos de `contracts/agent/examples` contra o que o agente usa.

Os modelos pydantic gerados não reproduzem o `if/then/else` de alguns esquemas, então o veredito vem
do portão (esquema JSON + modelo tipado), que é o que decide o que o agente executa ou envia.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.contracts.registry import MESSAGE_MODELS
from uniover_agent.core import Accepted, EnvelopeGate, Rejected

EXAMPLES = Path(__file__).resolve().parents[3] / "contracts" / "agent" / "examples"

pytestmark = pytest.mark.skipif(
    not EXAMPLES.is_dir(), reason="pasta contracts/ fora do alcance (app testado sozinho)"
)

# Recusas por forma do contrato (e não por quem enviou ou para quem foi).
CONTRACT_REASONS = {
    "fora_do_contrato",
    "tipo_desconhecido",
    "versao_nao_suportada",
    "json_invalido",
}


def load(folder: str) -> list[tuple[str, dict[str, Any]]]:
    return [
        (path.name, json.loads(path.read_text(encoding="utf-8")))
        for path in sorted((EXAMPLES / folder).glob("*.json"))
    ]


def gate_for(document: dict[str, Any]) -> EnvelopeGate:
    target = str(document.get("target", ""))
    return EnvelopeGate(target.removeprefix("agent:") if target.startswith("agent:") else "pc-casa")


@pytest.mark.parametrize(
    ("name", "document"), load("valid"), ids=lambda v: v if isinstance(v, str) else ""
)
def test_every_valid_example_is_accepted(name: str, document: dict[str, Any]) -> None:
    gate = gate_for(document)
    message_type = document["type"]
    assert name == f"{message_type}.json"
    MESSAGE_MODELS[message_type].model_validate(document)
    if document["source"] == "api":
        outcome = gate.check_inbound(json.dumps(document))
        assert isinstance(outcome, Accepted), outcome
    else:
        gate.check_outbound(document)  # levanta ValueError se fugir do contrato


@pytest.mark.parametrize(
    ("name", "document"), load("invalid"), ids=lambda v: v if isinstance(v, str) else ""
)
def test_every_invalid_example_is_refused_for_its_shape(
    name: str, document: dict[str, Any]
) -> None:
    gate = gate_for(document)
    if document["source"] == "api":
        outcome = gate.check_inbound(json.dumps(document))
        assert isinstance(outcome, Rejected), f"{name} foi aceito"
        assert outcome.reason in CONTRACT_REASONS
    else:
        with pytest.raises(ValueError, match="fora do contrato"):
            gate.check_outbound(document)


def test_every_message_type_has_a_valid_example() -> None:
    types = {document["type"] for _, document in load("valid")}
    assert types == set(MESSAGE_MODELS)


def test_new_tv_messages_have_at_least_one_invalid_example() -> None:
    invalid_types = {document["type"] for _, document in load("invalid")}
    for message_type in (
        "tv.key.v2",
        "tv.power.off.v1",
        "tv.key.v3",
        "tv.wake.v1",
        "tv.app.launch.v1",
        "tv.apps.refresh.v1",
        "tv.apps.v1",
        "tv.text.v1",
        "tv.watchdog.v1",
        "tv.cleanup.v1",
        "tv.cleanup.result.v1",
        "tv.cleanup.config.v1",
    ):
        assert message_type in invalid_types
