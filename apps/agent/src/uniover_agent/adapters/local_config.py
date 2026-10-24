"""Arquivo de configuração local do usuário (`agent.toml`), fora do repositório.

Guarda só dados não secretos: o endereço da API, o `agentId` recebido no pareamento e o que o
agente descobre sozinho sobre a TV (tipo, endereço e identificador estável).
"""

import json
import os
import tomllib
from pathlib import Path
from typing import Any

# `None` apaga a chave; o resto é gravado como texto, número, booleano ou lista de textos.
ConfigValue = str | bool | int | float | list[str] | None


def _toml_value(value: Any) -> str | None:
    """Só o que o `agent.toml` usa; `json.dumps` dá aspas e escapes válidos em TOML."""
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, str | int | float):
        return json.dumps(value)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return json.dumps(value)
    return None


def update_config(path: Path, values: dict[str, ConfigValue]) -> None:
    """Grava as chaves dadas (ou apaga as que vêm `None`), preservando todas as outras.

    Preservar listas e números importa: o agente reescreve este arquivo durante o uso (ao
    reencontrar a TV) e não pode perder, por exemplo, `tv_cleanup_keep`. A gravação é atômica
    (arquivo temporário e troca): uma queda de energia no meio não deixa o arquivo pela metade.
    """
    data: dict[str, Any] = {}
    if path.exists():
        with path.open("rb") as handle:
            data = tomllib.load(handle)
    for key, value in values.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{key} = {text}" for key, value in data.items() if (text := _toml_value(value))]
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def save_agent_config(path: Path, *, api_url: str, agent_id: str) -> None:
    """Grava `api_url` e `agent_id`, preservando as demais chaves que o usuário tenha posto."""
    update_config(path, {"api_url": api_url, "agent_id": agent_id})
