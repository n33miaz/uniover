"""A bandeja é um processo à parte, aberto o dia todo: ela não pode carregar o agente inteiro.

As conferências de módulos rodam num interpretador novo (o `conftest` já importa o `main` neste).
"""

import ast
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from uniover_agent import main as main_module
from uniover_agent import selfcheck
from uniover_agent.config import ConfigError

# O que só a conexão, a TV, o cofre e a atualização usam.
HEAVY = (
    "httpx",
    "cryptography",
    "keyring",
    "zeroconf",
    "samsungtvws",
    "androidtvremote2",
    "websockets",
    "aiortc",
    "requests",
    "uniover_agent.adapters.self_update",
    "uniover_agent.care_setup",
    "uniover_agent.composition.connection",
    "uniover_agent.composition.maintenance",
    "uniover_agent.composition.pairing",
    "uniover_agent.composition.pc",
    "uniover_agent.composition.tv",
)

# Tudo que a bandeja monta antes de abrir o ícone, menos o pystray (que precisa de tela).
_IMPORTS = """
import json, sys
from uniover_agent.main import main
from uniover_agent.adapters import tray_host, tray_status, tray_controller, tray_registry
from uniover_agent.adapters.diagnostics_file import open_diagnostics
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.composition import system
from uniover_agent.config import Settings
Settings()
open_diagnostics(SystemClock())
print(json.dumps(sorted(sys.modules)))
"""

# O comando `tray` de verdade, até o host visual (trocado por um que só lista os módulos).
_TRAY = """
import importlib.abc, importlib.machinery, json, sys

def fake_host(*_args, **_kwargs):
    print(json.dumps(sorted(sys.modules)))
    return True

class Hook(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != "uniover_agent.adapters.tray":
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        original = spec.loader.exec_module

        def exec_module(module):
            original(module)
            module.run_host = fake_host

        spec.loader.exec_module = exec_module
        return spec

sys.meta_path.insert(0, Hook())
from uniover_agent.main import main
sys.exit(main(["tray"]))
"""


def _modules(script: str, tmp_path: Path) -> set[str]:
    home = tmp_path / "home"
    env = {
        **os.environ,
        "LOCALAPPDATA": str(tmp_path / "localappdata"),
        "UNIOVER_HOME": str(home),
        "UNIOVER_CONFIG_FILE": str(tmp_path / "agent.toml"),
        "UNIOVER_UPDATE_DRILL": "1",
    }
    env.pop("UNIOVER_TRAY_NATIVE", None)
    done = subprocess.run(  # noqa: S603 - o próprio interpretador dos testes
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        cwd=tmp_path,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr[-2000:]
    loaded: list[str] = json.loads(done.stdout.strip().splitlines()[-1])
    return set(loaded)


def test_the_tray_modules_do_not_load_the_agent(tmp_path: Path) -> None:
    loaded = _modules(_IMPORTS, tmp_path)
    assert [name for name in HEAVY if name in loaded] == []


@pytest.mark.skipif(os.name != "nt", reason="o host visual da bandeja é do Windows")
def test_the_tray_command_does_not_load_the_agent(tmp_path: Path) -> None:
    loaded = _modules(_TRAY, tmp_path)
    assert "uniover_agent.adapters.tray" in loaded
    assert [name for name in HEAVY if name in loaded] == []


def _lazy_imports_in_main() -> set[str]:
    """Os módulos que o `main` importa dentro de funções (um por comando)."""
    tree = ast.parse(Path(main_module.__file__).read_text(encoding="utf-8"))
    found: set[str] = set()
    for function in ast.walk(tree):
        if not isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        for node in ast.walk(function):
            if isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    candidate = f"{node.module}.{alias.name}"
                    is_module = candidate.count(".") <= 2 and node.module in {
                        "uniover_agent.composition",
                        "uniover_agent.adapters",
                    }
                    found.add(candidate if is_module else node.module)
    return found


def test_every_lazy_import_of_main_is_listed_for_the_selfcheck() -> None:
    lazy = _lazy_imports_in_main()
    # A bandeja tem um passo só dela no auto-diagnóstico (só no Windows, onde ela existe).
    lazy.discard("uniover_agent.adapters.tray")
    assert lazy == set(main_module.LAZY_MODULES)
    assert ("a bandeja carrega", selfcheck._load_tray) in selfcheck.STEPS


def test_the_selfcheck_still_loads_every_part_of_the_agent() -> None:
    selfcheck._load_code()
    assert all(name in sys.modules for name in main_module.LAZY_MODULES)


@pytest.mark.skipif(os.name != "nt", reason="o host visual da bandeja é do Windows")
def test_a_candidate_with_a_broken_tray_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    # `None` em `sys.modules` faz o import lançar, como faria um módulo da bandeja quebrado.
    monkeypatch.setitem(sys.modules, "uniover_agent.adapters.tray", None)
    [problem] = selfcheck.run()
    assert "a bandeja carrega" in problem and "ModuleNotFoundError" in problem
    assert selfcheck.main() == selfcheck.EXIT_PROBLEM


def test_a_secret_store_error_is_still_a_sentence_and_not_a_trace() -> None:
    from uniover_agent.adapters.secret_store_keyring import SecretStoreError  # noqa: PLC0415

    assert SecretStoreError in main_module._expected_errors()
    assert ConfigError in main_module._expected_errors()
