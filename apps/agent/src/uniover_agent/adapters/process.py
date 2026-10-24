"""Processos filhos sem janela: o agente nunca pode fazer aparecer um console no Windows.

Todo `subprocess` do agente passa por aqui. Os três ajudantes juntam `CREATE_NO_WINDOW` aos
sinalizadores do chamador e **recusam** `shell=True` (um shell abriria o console de que o
sinalizador livra). Fora do Windows o sinalizador é zero e nada muda.
"""

import asyncio
import os
import subprocess
from typing import Any, Final

# 0x08000000 é `subprocess.CREATE_NO_WINDOW`, que só existe no Windows.
NO_WINDOW: Final = 0x08000000 if os.name == "nt" else 0


def hidden_flags(extra: int = 0) -> int:
    """Os sinalizadores de criação do processo: os do chamador mais "sem janela"."""
    return NO_WINDOW | extra


def _checked(kwargs: dict[str, Any]) -> dict[str, Any]:
    if kwargs.get("shell"):
        raise ValueError("shell=True abriria um console; passe a lista de argumentos")
    checked = dict(kwargs)
    checked["creationflags"] = hidden_flags(int(checked.get("creationflags", 0)))
    return checked


def run_hidden(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
    """`subprocess.run` sem janela."""
    checked = _checked(kwargs)
    checked.setdefault("check", False)
    return subprocess.run(args, **checked)  # noqa: S603, PLW1510 - `check` vai em `checked`


def popen_hidden(args: list[str], **kwargs: Any) -> subprocess.Popen[Any]:
    """`subprocess.Popen` sem janela."""
    return subprocess.Popen(args, **_checked(kwargs))  # noqa: S603 - quem chama fixa o executável


async def exec_hidden(*args: str, **kwargs: Any) -> asyncio.subprocess.Process:
    """`asyncio.create_subprocess_exec` sem janela."""
    return await asyncio.create_subprocess_exec(*args, **_checked(kwargs))
