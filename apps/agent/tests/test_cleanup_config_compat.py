"""A configuração da limpeza continua entendida por agente antigo e novo.

O PC que ainda não se atualizou valida o corpo com o schema antigo (`additionalProperties: false`):
um campo a mais derruba a mensagem inteira, inclusive a limpeza que já funcionava. Por isso a API só
manda os campos dos ajustes leves a quem anuncia `tv.light-settings.v1`, e a todos os outros manda o
corpo antigo exato.
"""

import json
from typing import Any

from jsonschema import Draft202012Validator

from uniover_agent.core import Accepted, EnvelopeGate

# O corpo da versão anterior do contrato, copiado como era (sem os campos dos ajustes leves).
OLD_BODY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["lightEnabled", "deepEnabled", "deepThresholdMb"],
    "properties": {
        "lightEnabled": {"type": "boolean"},
        "deepEnabled": {"type": "boolean"},
        "deepThresholdMb": {"type": "integer", "minimum": 64, "maximum": 512},
        "closeBackgroundApps": {"type": "boolean"},
    },
}
OLD_BODY = {
    "lightEnabled": True,
    "deepEnabled": False,
    "deepThresholdMb": 160,
    "closeBackgroundApps": False,
}
NEW_BODY = {
    **OLD_BODY,
    "focusEnabled": True,
    "shortAnimationsEnabled": True,
    "restrictedPackages": ["com.example.video"],
}


def envelope(body: dict[str, Any]) -> str:
    return json.dumps(
        {
            "v": 1,
            "id": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e90",
            "type": "tv.cleanup.config.v1",
            "source": "api",
            "target": "agent:pc-tv",
            "ts": "2026-10-28T12:00:00Z",
            "correlationId": None,
            "body": body,
        }
    )


def test_the_old_schema_refuses_the_new_fields_which_is_why_they_are_gated_by_capability() -> None:
    validator = Draft202012Validator(OLD_BODY_SCHEMA)
    assert validator.is_valid(OLD_BODY)
    assert not validator.is_valid(NEW_BODY)


def test_the_current_agent_accepts_the_old_body_and_the_new_one() -> None:
    gate = EnvelopeGate("pc-tv")
    assert isinstance(gate.check_inbound(envelope(OLD_BODY)), Accepted)
    assert isinstance(gate.check_inbound(envelope(NEW_BODY)), Accepted)


def test_the_new_fields_are_bounded() -> None:
    gate = EnvelopeGate("pc-tv")
    too_many = {**NEW_BODY, "restrictedPackages": [f"com.example.app{i}" for i in range(101)]}
    bad_name = {**NEW_BODY, "restrictedPackages": ["com.exemplo; reboot"]}
    assert not isinstance(gate.check_inbound(envelope(too_many)), Accepted)
    assert not isinstance(gate.check_inbound(envelope(bad_name)), Accepted)


def test_the_current_agent_accepts_the_focus_closing_flag_and_refuses_a_non_boolean() -> None:
    gate = EnvelopeGate("pc-tv")
    assert isinstance(
        gate.check_inbound(envelope({**NEW_BODY, "focusClosesBackground": True})), Accepted
    )
    assert not isinstance(
        gate.check_inbound(envelope({**NEW_BODY, "focusClosesBackground": "sim"})), Accepted
    )
