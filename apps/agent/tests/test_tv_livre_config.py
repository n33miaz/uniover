"""A escrita da configuração do launcher contra o contrato `contracts/tv-launcher`.

Os mesmos exemplos que o launcher lê (válidos e inválidos) passam pelo escritor estrito do agente, e
o que ele produz precisa validar no esquema JSON do contrato.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from uniover_agent.core.tv.livre_config import InvalidConfigError, build_launcher_config

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "tv-launcher"

pytestmark = pytest.mark.skipif(
    not CONTRACT.is_dir(), reason="pasta contracts/ fora do alcance (app testado sozinho)"
)

# O agente acrescenta estes campos; a API nunca os manda.
ADDED_BY_AGENT = ("schema", "revision")
# Exemplos inválidos só por `schema`/`revision`: nada a ver com o corpo que a API manda.
ABOUT_THE_ENVELOPE = {"future-version.json", "missing-revision.json"}


def load(folder: str) -> list[tuple[str, dict[str, Any]]]:
    return [
        (path.name, json.loads(path.read_text(encoding="utf-8")))
        for path in sorted((CONTRACT / "examples" / folder).glob("*.json"))
    ]


def body_of(document: dict[str, Any]) -> tuple[str, bool]:
    body = {k: v for k, v in document.items() if k not in ADDED_BY_AGENT}
    has_photo = False
    wallpaper = body.get("wallpaper")
    if isinstance(wallpaper, dict) and "photo" in wallpaper:
        wallpaper = {k: v for k, v in wallpaper.items() if k != "photo"}
        body["wallpaper"] = wallpaper
        has_photo = True
    return json.dumps(body), has_photo


@pytest.fixture(scope="module")
def validator() -> Draft202012Validator:
    schema = json.loads((CONTRACT / "config.v1.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


@pytest.mark.parametrize(
    ("name", "document"), load("valid"), ids=lambda v: v if isinstance(v, str) else ""
)
def test_every_valid_example_is_written_and_validates(
    name: str, document: dict[str, Any], validator: Draft202012Validator
) -> None:
    text, has_photo = body_of(document)

    written = build_launcher_config(text, document["revision"], photo=has_photo)

    assert list(validator.iter_errors(written)) == []
    assert written["schema"] == 1
    assert written["revision"] == document["revision"]


@pytest.mark.parametrize(
    ("name", "document"), load("invalid"), ids=lambda v: v if isinstance(v, str) else ""
)
def test_every_invalid_example_is_refused(name: str, document: dict[str, Any]) -> None:
    if name in ABOUT_THE_ENVELOPE:
        pytest.skip("inválido só pelo envelope do arquivo, que o agente monta")
    # Sem tirar o nome da foto: o escritor recusa que a API escolha o arquivo.
    text = json.dumps({k: v for k, v in document.items() if k not in ADDED_BY_AGENT})

    with pytest.raises(InvalidConfigError):
        build_launcher_config(text, 1, photo=False)


def test_the_photo_name_is_chosen_by_the_agent_and_only_for_photo_wallpapers() -> None:
    photo = build_launcher_config('{"wallpaper":{"type":"photo"}}', 1, photo=True)
    gradient = build_launcher_config('{"wallpaper":{"type":"gradient"}}', 1, photo=True)
    no_photo = build_launcher_config('{"wallpaper":{"type":"photo"}}', 1, photo=False)

    assert photo["wallpaper"]["photo"] == "wallpaper.jpg"
    assert "photo" not in gradient["wallpaper"]
    assert "photo" not in no_photo["wallpaper"]


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        "[]",
        '{"clock":[]}',
        '{"clock":{"seconds":1}}',
        '{"clock":{"size":"huge"}}',
        '{"wallpaper":{"dim":0.9}}',
        '{"wallpaper":{"dim":true}}',
        '{"wallpaper":{"colors":[]}}',
        '{"wallpaper":{"colors":["#1","#2","#3","#4"]}}',
        '{"apps":{"items":["a.b","a.b"]}}',
        '{"apps":{"items":"x"}}',
        '{"sleep":{"maxMinutes":721}}',
        '{"sleep":{"maxMinutes":true}}',
        '{"icons":{"shape":"square"}}',
        '{"other":{}}',
    ],
)
def test_malformed_configs_are_refused(text: str) -> None:
    with pytest.raises(InvalidConfigError):
        build_launcher_config(text, 1, photo=False)


@pytest.mark.parametrize("revision", [-1, 2147483648, True])
def test_the_revision_must_be_a_non_negative_int32(revision: Any) -> None:
    with pytest.raises(InvalidConfigError):
        build_launcher_config("{}", revision, photo=False)
