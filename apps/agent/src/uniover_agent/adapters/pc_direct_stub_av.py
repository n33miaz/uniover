"""Um `av` de mentira, só para o `aiortc` poder ser importado sem o pacote verdadeiro.

O `aiortc` importa o `av` (FFmpeg, ~70 MB, com x264 e x265 sob GPL) ao carregar, mesmo que só se
use o canal de dados. O agente não instala o `av` (`exclude-dependencies` no `pyproject.toml`);
este módulo fabrica um no lugar, qualquer atributo devolvendo um objeto vazio. Nada de mídia
passa por aqui: se
algo tentasse usar áudio ou vídeo, o objeto vazio não faria nada de útil. Instalar só se o `av` de
verdade não existe, e antes do primeiro `import aiortc`.
"""

import importlib.abc
import importlib.machinery
import sys
import types
from typing import Any


class _Empty:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    def __getattr__(self, name: str) -> _Empty:
        return _Empty()

    def __call__(self, *args: Any, **kwargs: Any) -> _Empty:
        return _Empty()


class _FakeModule(types.ModuleType):
    __path__: list[str] = []  # noqa: RUF012 - a importação exige o atributo, e nunca é alterado

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        return type(name, (_Empty,), {})


class _Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname == "av" or fullname.startswith("av."):
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec: Any) -> types.ModuleType:
        return _FakeModule(spec.name)

    def exec_module(self, module: types.ModuleType) -> None:
        return None


def install() -> None:
    """Põe o `av` falso no caminho de importação (uma vez só)."""
    if not any(isinstance(finder, _Finder) for finder in sys.meta_path):
        sys.meta_path.insert(0, _Finder())
