import json
import uuid
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.core import Accepted, EnvelopeFactory, EnvelopeGate, Rejected

from .support import AGENT_ID, dump, envelope, tv_key

gate = EnvelopeGate(AGENT_ID)


def rejected(raw: str | bytes) -> Rejected:
    outcome = gate.check_inbound(raw)
    assert isinstance(outcome, Rejected)
    return outcome


def test_valid_command_is_accepted_with_typed_model() -> None:
    outcome = gate.check_inbound(dump(tv_key("MUTE")))
    assert isinstance(outcome, Accepted)
    assert outcome.command.type == "tv.key.v1"
    assert outcome.command.body == {"key": "MUTE"}
    assert outcome.command.correlation_id is None
    assert type(outcome.message).__name__ == "TvKeyV1Message"


def test_extra_field_in_envelope_is_rejected() -> None:
    outcome = rejected(dump(tv_key(extra="x")))
    assert outcome.reason == "fora_do_contrato"
    assert outcome.message_type == "tv.key.v1"


def test_extra_field_in_body_is_rejected() -> None:
    data = tv_key()
    data["body"]["surprise"] = 1
    assert rejected(dump(data)).reason == "fora_do_contrato"


def test_value_outside_enum_is_rejected() -> None:
    assert rejected(dump(tv_key("SELF_DESTRUCT"))).reason == "fora_do_contrato"


def test_valid_text_command_is_accepted() -> None:
    outcome = gate.check_inbound(dump(envelope("tv.text.v1", {"text": "matrix"})))
    assert isinstance(outcome, Accepted)
    assert outcome.command.body == {"text": "matrix"}


@pytest.mark.parametrize("text", ["", "a\nb", "a\x07", "a" * 201])
def test_text_command_outside_the_contract_is_rejected(text: str) -> None:
    outcome = rejected(dump(envelope("tv.text.v1", {"text": text})))
    assert outcome.reason == "fora_do_contrato"
    assert outcome.message_type == "tv.text.v1"


def test_unknown_type_is_rejected() -> None:
    outcome = rejected(dump(envelope("tv.explode.v1", {})))
    assert outcome.reason == "tipo_desconhecido"
    assert outcome.message_type == "tv.explode.v1"


def test_wrong_version_is_rejected() -> None:
    assert rejected(dump(tv_key(v=2))).reason == "versao_nao_suportada"


@pytest.mark.parametrize("raw", ["{quebrado", "", "[1, 2]", "42", "null"])
def test_broken_or_non_object_json_is_rejected(raw: str) -> None:
    assert rejected(raw).reason == "json_invalido"


def test_binary_frame_is_rejected() -> None:
    assert rejected(dump(tv_key()).encode()).reason == "quadro_binario"


def test_forged_source_is_rejected() -> None:
    assert rejected(dump(tv_key(source="agent:outro"))).reason == "origem_invalida"


def test_command_for_another_agent_is_rejected() -> None:
    assert rejected(dump(tv_key(target="agent:pc-trabalho"))).reason == "destino_invalido"


def test_bad_timestamp_is_rejected() -> None:
    assert rejected(dump(tv_key(ts="ontem"))).reason == "fora_do_contrato"


def test_detail_never_repeats_received_values() -> None:
    secret = "valor-secreto-123"
    data = tv_key()
    data["body"]["key"] = secret
    outcome = rejected(dump(data))
    assert secret not in outcome.detail
    assert "body.key" in outcome.detail


def test_reply_target_is_the_envelope_id_only_when_it_is_a_uuid() -> None:
    assert rejected(dump(tv_key(id="<script>"))).reply_to is None
    good = str(uuid.uuid4())
    assert rejected(dump(tv_key("NOPE", id=good))).reply_to == good
    # O `correlationId` recebido não serve de destino da resposta.
    other = str(uuid.uuid4())
    assert rejected(dump(tv_key("NOPE", other, id=good))).reply_to == good


def test_deeply_nested_json_is_rejected_not_raised() -> None:
    assert rejected("[" * 100_000).reason == "json_invalido"


def factory() -> EnvelopeFactory:
    return EnvelopeFactory(AGENT_ID, gate, FakeClock())


def test_outbound_hello_is_valid_envelope() -> None:
    hello: dict[str, Any] = factory().hello("0.1.0", ["tv.remote"])
    assert hello["source"] == f"agent:{AGENT_ID}"
    assert hello["target"] == "api"
    assert hello["ts"].endswith("Z")
    assert json.loads(json.dumps(hello)) == hello


def test_outbound_failed_result_requires_error() -> None:
    # O `if/then/else` de `command.result.v1` só o JSON Schema reproduz: o modelo pydantic não.
    bad = factory().result(str(uuid.uuid4()), ok=True)
    bad["body"] = {"ok": False}
    with pytest.raises(ValueError, match="fora do contrato"):
        gate.check_outbound(bad)
    ok_with_error = factory().result(str(uuid.uuid4()), ok=False, code="x", message="y")
    ok_with_error["body"]["ok"] = True
    with pytest.raises(ValueError, match="fora do contrato"):
        gate.check_outbound(ok_with_error)


def test_outbound_unknown_type_is_a_programming_error() -> None:
    with pytest.raises(ValueError, match="desconhecido"):
        gate.check_outbound(envelope("x.y.v1", {}))
