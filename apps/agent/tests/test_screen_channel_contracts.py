"""Contrato do canal de dados `screen`: o esquema vale sobre o objeto nu que trafega, sem envelope.

Confere os exemplos de `contracts/agent/screen` contra o JSON Schema e contra o modelo gerado.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from pydantic import BaseModel, ValidationError

from uniover_agent.contracts.pc_screen_cur_v1 import PcScreenCurV1Message
from uniover_agent.contracts.pc_screen_get_v1 import PcScreenGetV1Message
from uniover_agent.contracts.pc_screen_mon_v1 import PcScreenMonV1Message
from uniover_agent.contracts.pc_screen_same_v1 import PcScreenSameV1Message
from uniover_agent.contracts.pc_screen_stat_v1 import PcScreenStatV1Message
from uniover_agent.contracts.pc_screen_state_v1 import PcScreenStateV1Message
from uniover_agent.contracts.registry import MESSAGE_MODELS

SCREEN = Path(__file__).resolve().parents[3] / "contracts" / "agent" / "screen"

pytestmark = pytest.mark.skipif(
    not SCREEN.is_dir(), reason="pasta contracts/ fora do alcance (app testado sozinho)"
)

# `k` do objeto -> (nome do esquema, modelo gerado).
MESSAGES: dict[str, tuple[str, type[BaseModel]]] = {
    "s.get": ("pc.screen.get.v1", PcScreenGetV1Message),
    "s.mon": ("pc.screen.mon.v1", PcScreenMonV1Message),
    "s.same": ("pc.screen.same.v1", PcScreenSameV1Message),
    "s.cur": ("pc.screen.cur.v1", PcScreenCurV1Message),
    "s.state": ("pc.screen.state.v1", PcScreenStateV1Message),
    "s.stat": ("pc.screen.stat.v1", PcScreenStatV1Message),
}

MONITOR = {"id": 0, "primary": True, "width": 1920, "height": 1080}


def load(folder: str) -> list[tuple[str, dict[str, Any]]]:
    return [
        (path.name, json.loads(path.read_text(encoding="utf-8")))
        for path in sorted((SCREEN / "examples" / folder).glob("*.json"))
    ]


def schema_accepts(document: dict[str, Any]) -> bool:
    name = MESSAGES[document["k"]][0]
    path = SCREEN / "messages" / f"{name}.schema.json"
    return bool(
        Draft202012Validator(json.loads(path.read_text(encoding="utf-8"))).is_valid(document)
    )


def model_of(document: dict[str, Any]) -> BaseModel:
    return MESSAGES[document["k"]][1].model_validate(document)


def test_every_schema_has_a_model_and_stays_out_of_the_envelope_registry() -> None:
    names = {name for name, _ in MESSAGES.values()}
    assert {p.name.removesuffix(".schema.json") for p in (SCREEN / "messages").iterdir()} == names
    assert {document["k"] for _, document in load("valid")} == set(MESSAGES)
    assert names.isdisjoint(MESSAGE_MODELS)


@pytest.mark.parametrize(
    ("name", "document"), load("valid"), ids=lambda v: v if isinstance(v, str) else ""
)
def test_every_valid_bare_object_is_accepted(name: str, document: dict[str, Any]) -> None:
    assert name == f"{MESSAGES[document['k']][0]}.json"
    assert schema_accepts(document)
    model_of(document)


@pytest.mark.parametrize(
    ("name", "document"), load("invalid"), ids=lambda v: v if isinstance(v, str) else ""
)
def test_every_invalid_object_is_refused(name: str, document: dict[str, Any]) -> None:
    assert not schema_accepts(document), f"{name} foi aceito pelo esquema"
    with pytest.raises(ValidationError):
        model_of(document)


@pytest.mark.parametrize(
    "document",
    [
        {"k": "s.cur", "x": 0, "y": True},
        {"k": "s.get", "width": "1280"},
        {"k": "s.get", "reset": 1},
        {"k": "s.mon", "monitors": [{**MONITOR, "id": "0"}]},
        {"k": "s.mon", "monitors": [{**MONITOR, "primary": "true"}]},
        {"k": "s.mon", "monitors": [MONITOR], "layout": "42"},
        {"k": "s.same", "crc": "42"},
        {"k": "s.stat", "bytes": "42", "cpu": None, "privateMB": 1.5},
        {"k": "s.stat", "bytes": 42, "cpu": "1.5", "privateMB": 1.5},
        {"k": "s.stat", "bytes": 42, "cpu": None, "privateMB": "1.5"},
    ],
)
def test_scalar_values_are_not_coerced(document: dict[str, Any]) -> None:
    assert not schema_accepts(document)
    with pytest.raises(ValidationError):
        model_of(document)


MONITOR_INTEGRAL = {"id": 0.0, "primary": True, "width": 1920.0, "height": 1080.0, "x": -5.0}


@pytest.mark.parametrize(
    ("document", "path", "expected"),
    [
        ({"k": "s.same", "crc": 42.0}, ("crc",), 42),
        ({"k": "s.stat", "bytes": 0.0, "cpu": None, "privateMB": 1.5}, ("bytes",), 0),
        ({"k": "s.cur", "x": -0.0, "y": 1e2}, ("y",), 100),
        ({"k": "s.get", "width": 1280.0}, ("width",), 1280),
        ({"k": "s.get", "monitor": 0.0}, ("monitor",), 0),
        ({"k": "s.mon", "monitors": [MONITOR_INTEGRAL]}, ("monitors", 0, "x"), -5),
        ({"k": "s.mon", "monitors": [MONITOR_INTEGRAL]}, ("monitors", 0, "width"), 1920),
        ({"k": "s.mon", "monitors": [MONITOR], "layout": 42.0}, ("layout",), 42),
    ],
)
def test_integral_number_is_an_integer_like_in_the_schema(
    document: dict[str, Any], path: tuple[str | int, ...], expected: int
) -> None:
    assert schema_accepts(document)
    for model in (
        model_of(document),
        MESSAGES[document["k"]][1].model_validate_json(json.dumps(document)),
    ):
        value: Any = model.model_dump()
        for key in path:
            value = value[key]
        assert value == expected
        assert type(value) is int


@pytest.mark.parametrize(
    "document",
    [
        {"k": "s.same", "crc": 42.5},
        {"k": "s.same", "crc": True},
        {"k": "s.stat", "bytes": 0.5, "cpu": None, "privateMB": 1.5},
        {"k": "s.stat", "bytes": False, "cpu": None, "privateMB": 1.5},
        {"k": "s.cur", "x": 0, "y": "1"},
        {"k": "s.get", "width": 1280.5},
        {"k": "s.get", "width": 1921.0},
        {"k": "s.get", "monitor": True},
        {"k": "s.mon", "monitors": [{**MONITOR, "x": 0.25}]},
        {"k": "s.mon", "monitors": [{**MONITOR, "id": False}]},
        {"k": "s.mon", "monitors": [MONITOR], "layout": 4294967296.0},
        {"k": "s.mon", "monitors": [MONITOR], "layout": 1.5},
    ],
)
def test_fraction_bool_text_and_out_of_range_integral_are_refused(
    document: dict[str, Any],
) -> None:
    assert not schema_accepts(document)
    model = MESSAGES[document["k"]][1]
    with pytest.raises(ValidationError):
        model.model_validate(document)
    with pytest.raises(ValidationError):
        model.model_validate_json(json.dumps(document))


def test_an_enveloped_object_is_not_a_channel_message() -> None:
    enveloped = {"v": 1, "type": "pc.screen.get.v1", "body": {"k": "s.get"}}
    for name, model in MESSAGES.values():
        path = SCREEN / "messages" / f"{name}.schema.json"
        schema = json.loads(path.read_text(encoding="utf-8"))
        assert not Draft202012Validator(schema).is_valid(enveloped)
        with pytest.raises(ValidationError):
            model.model_validate(enveloped)


@pytest.mark.parametrize("field", ["x", "y", "left", "top"])
def test_monitor_position_may_be_omitted_but_not_null(field: str) -> None:
    omitted = {"k": "s.mon", "monitors": [MONITOR]}
    assert schema_accepts(omitted)
    assert model_of(omitted).model_dump() == omitted
    null = {"k": "s.mon", "monitors": [{**MONITOR, field: None}]}
    assert not schema_accepts(null)
    with pytest.raises(ValidationError):
        model_of(null)


@pytest.mark.parametrize("field", ["monitor", "width", "fps", "marker", "reset"])
def test_optional_request_field_is_not_nullable(field: str) -> None:
    document = {"k": "s.get", field: None}
    assert not schema_accepts(document)
    with pytest.raises(ValidationError):
        model_of(document)


def test_layout_stays_nullable() -> None:
    document = {"k": "s.mon", "monitors": [MONITOR], "layout": None}
    assert schema_accepts(document)
    assert model_of(document).model_dump() == document
