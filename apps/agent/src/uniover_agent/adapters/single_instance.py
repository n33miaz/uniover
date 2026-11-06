r"""Um só agente `run` por instalação: a tarefa agendada e uma execução manual não coexistem.

Dois agentes com a mesma identidade se derrubam no servidor (o canal novo substitui o antigo, e
cada um reconecta tirando o outro do ar) e disputam a fila de diagnóstico em disco (um apaga o
arquivo de envio do outro). Quem sobe primeiro fica com a trava pelo tempo de vida do processo; o
segundo avisa e sai, sem tocar na fila.

No Windows a trava é um mutex nomeado `Local\UniOver-Agent-<hash da instalação>` (some sozinho com
o processo, mesmo numa queda). Fora dele, um arquivo `runtime\agent.lock` criado de forma atômica
com o número do processo, que só é tomado de volta quando esse processo já não existe.
"""

import hashlib
import os
import sys
from pathlib import Path
from typing import Any, Final

from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.startup_trace import process_alive

# Código de saída de quem encontrou outro agente rodando (distinto dos demais).
EXIT_ALREADY_RUNNING: Final = 5
ALREADY_RUNNING_MESSAGE: Final = "outra instância do agente já está rodando"
_ERROR_ALREADY_EXISTS: Final = 183
_ERROR_ACCESS_DENIED: Final = 5
LOCK_FILE: Final = "agent.lock"

# Trava deste processo, por nome: `main` roda várias vezes no mesmo processo nos testes e a TV pode
# pedir um recomeço do `run`, e o processo que já tem a trava não pode ser barrado por ela mesma.
_held: dict[str, Any] = {}


def mutex_name(base: Path) -> str:
    # A mesma pasta escrita de outro jeito (barra final, `/`, caixa, link) tem de dar o mesmo nome.
    canonical = os.path.normcase(os.path.realpath(base))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
    return f"Local\\UniOver-Agent-{digest}"


def _acquire_windows(name: str) -> bool:
    import ctypes  # noqa: PLC0415 - só existe no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.CreateMutexW(None, True, name)
    if not handle:
        # Mutex criado por um processo elevado: a permissão padrão nega acesso ao token limitado
        # da tarefa, e negar acesso quer dizer que já existe dono.
        if ctypes.get_last_error() == _ERROR_ACCESS_DENIED:
            return False
        # Qualquer outra falha: o agente não pode ficar fora do ar por causa da trava.
        return True
    if ctypes.get_last_error() == _ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        return False
    _held[name] = handle
    return True


def _acquire_lockfile(path: Path) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                owner = int(path.read_text(encoding="ascii").strip())
            except OSError, ValueError:
                owner = 0
            if owner and process_alive(owner):
                return False
            path.unlink(missing_ok=True)
            continue
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(str(os.getpid()))
        _held[str(path)] = path
        return True
    return False


def acquire(base: Path | None = None) -> bool:
    """Pega a trava desta instalação; `False` se outro processo já a tem."""
    root = base or installation_base()
    name = mutex_name(root)
    if name in _held or str(root / "runtime" / LOCK_FILE) in _held:
        return True
    try:
        if sys.platform == "win32":
            return _acquire_windows(name)
        return _acquire_lockfile(root / "runtime" / LOCK_FILE)
    except OSError:
        return True
