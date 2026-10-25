"""Roda o lançador de verdade em teste sem competir com o lançador real do computador.

O lançador tem um mutex para não subir dois agentes. Se o teste usasse o mesmo nome, ele poderia
ocupar o mutex do lançador real e fazer o real sair sem subir o agente. A cópia de teste troca o
nome do mutex por um único por execução; o resto do script é o mesmo, byte a byte.
"""

import re
import uuid
from pathlib import Path

TOOLS = Path(__file__).parents[1] / "tools"


def isolated_launcher(directory: Path) -> Path:
    """Cópia de `tools/launcher.ps1` com nomes de mutex só do teste."""
    text = (TOOLS / "launcher.ps1").read_text(encoding="ascii")
    unique = f"UniOverTest{uuid.uuid4().hex}"
    swapped, count = re.subn(r"Local\\UniOverLauncher", f"Local\\\\{unique}", text)
    assert count >= 1, "o lançador deixou de ter mutex: revise este isolamento"
    copy = directory / "launcher-under-test.ps1"
    copy.write_bytes(swapped.encode("ascii"))
    return copy
