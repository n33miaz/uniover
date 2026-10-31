r"""Arrumação automática da pasta de instalação, a cada vez que o agente sobe.

A pasta é organizada em `app` (código), `runtime` (estado e ambiente Python), `config`, `logs`,
`web`, `tv` (certificados) e `icons`. Com o tempo sobram restos das atualizações: versões recusadas,
pastas candidatas que ficaram pela metade, arquivos temporários. Aqui eles saem sozinhos, sem que o
dono precise saber que existem, e cada ação vai para o registro.

Só se apaga o que tem nome conhecido e fica dentro da pasta de instalação; a versão em uso, a
anterior guardada para voltar atrás, a configuração, o certificado da TV e os registros nunca são
tocados.
"""

import logging
import shutil
import time
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

STANDARD_FOLDERS: Final = ("runtime", "config", "logs", "web", "icons")
# Quantas versões recusadas ou incompletas ficam guardadas para quem quiser olhar o que deu errado.
KEEP_REJECTED: Final = 2
# Resto de uma atualização que nunca terminou: depois de um dia não está mais em andamento.
STALE_SECONDS: Final = 24 * 3600
_REJECTED_PREFIXES: Final = ("app.rejected-", "app.incomplete-")
_STALE_ROOT_NAMES: Final = ("app.new", "app.new.venv")
_STALE_ROOT_PREFIX: Final = "uniover-update-"


def _age(path: Path, now: float) -> float:
    try:
        return now - path.stat().st_mtime
    except OSError:
        return 0.0


def _remove(path: Path, done: list[str], what: str) -> None:
    try:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    except OSError:
        _log.info("não consegui remover %s agora; tento de novo na próxima vez", what)
        return
    done.append(what)


def _prune_rejected(runtime: Path, done: list[str]) -> None:
    for prefix in _REJECTED_PREFIXES:
        try:
            found = sorted(
                (
                    item
                    for item in runtime.iterdir()
                    if item.is_dir() and item.name.startswith(prefix)
                ),
                key=lambda item: item.stat().st_mtime,
                reverse=True,
            )
        except OSError:
            continue
        for old in found[KEEP_REJECTED:]:
            _remove(old, done, f"versão recusada antiga ({prefix.rstrip('-')})")


def tidy(root: Path, *, now: float | None = None) -> list[str]:
    """Cria o que falta da estrutura e remove os restos. Devolve o que fez, uma frase por ação."""
    moment = now if now is not None else time.time()
    done: list[str] = []
    for name in STANDARD_FOLDERS:
        folder = root / name
        if not folder.is_dir():
            try:
                folder.mkdir(parents=True, exist_ok=True)
            except OSError:
                _log.warning("não consegui criar a pasta %s", name)
                continue
            done.append(f"pasta {name} criada")
    runtime = root / "runtime"
    if runtime.is_dir():
        _prune_rejected(runtime, done)
        try:
            for item in runtime.iterdir():
                if item.suffix == ".tmp" and _age(item, moment) > STALE_SECONDS:
                    _remove(item, done, "arquivo temporário velho")
        except OSError:
            pass
    try:
        for item in root.iterdir():
            stale = item.name in _STALE_ROOT_NAMES or item.name.startswith(_STALE_ROOT_PREFIX)
            if stale and _age(item, moment) > STALE_SECONDS:
                _remove(item, done, "resto de uma atualização que não terminou")
    except OSError:
        pass
    for action in done:
        _log.info("arrumação da pasta: %s", action)
    return done
