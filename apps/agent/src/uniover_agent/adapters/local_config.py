"""Arquivo de configuração local do usuário (`agent.toml`), fora do repositório.

Guarda só dados não secretos: o endereço da API e o `agentId` recebido no pareamento.
"""

import json
import tomllib
from pathlib import Path
from typing import Any


def save_agent_config(path: Path, *, api_url: str, agent_id: str) -> None:
    """Grava `api_url` e `agent_id`, preservando as demais chaves que o usuário tenha posto."""
    data: dict[str, Any] = {}
    if path.exists():
        with path.open("rb") as handle:
            data = tomllib.load(handle)
    data["api_url"] = api_url
    data["agent_id"] = agent_id
    path.parent.mkdir(parents=True, exist_ok=True)
    # Só cadeias de texto simples: `json.dumps` produz aspas e escapes válidos em TOML.
    lines = [
        f"{key} = {json.dumps(value)}" for key, value in data.items() if isinstance(value, str)
    ]
    lines += [
        f"{key} = {str(value).lower()}" for key, value in data.items() if isinstance(value, bool)
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
