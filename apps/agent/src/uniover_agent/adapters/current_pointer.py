r"""Ponteiro da versão em uso: `runtime\current.json`.

Cada versão preparada mora na própria pasta (`app.staging\<sha>`) com o próprio ambiente Python
(`runtime\venv-<sha>`), e nada é renomeado: o ambiente instala o projeto em modo editável, apontando
para a pasta onde foi sincronizado, então mover ou apagar a pasta de um agente vivo o quebraria.
Trocar de versão é só gravar este arquivo, e a volta atrás é gravá-lo de novo com a anterior.

Sem o arquivo (instalação que nunca trocou por ponteiro) vale o layout de sempre: `app` com o
ambiente `runtime\venv`. Esse layout continua sendo o último recurso e nunca é apagado.

Os caminhos do arquivo são relativos à pasta da instalação e validados: nada de caminho absoluto,
`..` ou fora dela. O supervisor (`run-agent.ps1`) e o lançador leem o mesmo formato.
"""

import json
import logging
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Final

_log = logging.getLogger(__name__)

POINTER_FILE: Final = "current.json"
# A versão que ficou pronta (código, ambiente e autoteste) e espera a troca.
PREPARED_FILE: Final = "prepared.json"
# O commit que o supervisor passa para a versão nova agora (`run --handover` em andamento): a poda
# nunca o apaga, esteja ele ou não no ponteiro ainda.
HANDOVER_FILE: Final = "handover-sha.txt"
STAGING_DIR: Final = "app.staging"
VENV_PREFIX: Final = "venv-"
LEGACY_APP: Final = "app"
LEGACY_VENV: Final = "venv"
_SHA = re.compile(r"[0-9a-f]{40}")
_MAX_BYTES: Final = 4096
_MAX_PATH_CHARS: Final = 260


@dataclass(frozen=True, slots=True)
class Slot:
    """Uma versão instalada: o commit (se se sabe) e onde estão o código e o ambiente dela."""

    sha: str | None
    app: Path
    venv: Path


@dataclass(frozen=True, slots=True)
class Pointer:
    current: Slot
    previous: Slot | None
    # `False` = nenhum arquivo: é o layout de sempre (`app` + `runtime\venv`).
    explicit: bool = False


def base_of(source: Path) -> Path:
    """A pasta da instalação a partir da pasta do código (`app` ou `app.staging\\<sha>`)."""
    return source.parent.parent if source.parent.name == STAGING_DIR else source.parent


def pointer_path(base: Path) -> Path:
    return base / "runtime" / POINTER_FILE


def staged_app(base: Path, sha: str) -> Path:
    return base / STAGING_DIR / sha


def staged_venv(base: Path, sha: str) -> Path:
    return base / "runtime" / f"{VENV_PREFIX}{sha}"


def legacy_slot(base: Path) -> Slot:
    return Slot(None, base / LEGACY_APP, base / "runtime" / LEGACY_VENV)


def _relative(base: Path, text: object) -> Path | None:
    """O caminho relativo do arquivo, ou `None` se não for um caminho seguro dentro da pasta."""
    if not isinstance(text, str) or not text or len(text) > _MAX_PATH_CHARS:
        return None
    windows = PureWindowsPath(text)
    posix = PurePosixPath(text)
    if windows.is_absolute() or windows.drive or posix.is_absolute() or ".." in windows.parts:
        return None
    # Sem `..` nem raiz, a junção cai dentro da pasta da instalação por construção.
    return base.joinpath(*windows.parts)


def _slot(base: Path, raw: object) -> Slot | None:
    if not isinstance(raw, dict):
        return None
    app, venv = _relative(base, raw.get("app")), _relative(base, raw.get("venv"))
    if app is None or venv is None:
        return None
    sha = raw.get("sha")
    return Slot(sha if isinstance(sha, str) and _SHA.fullmatch(sha) else None, app, venv)


def _relative_text(base: Path, path: Path) -> str:
    return str(path.resolve().relative_to(base.resolve()))


def _slot_json(base: Path, slot: Slot) -> dict[str, Any]:
    return {
        "sha": slot.sha,
        "app": _relative_text(base, slot.app),
        "venv": _relative_text(base, slot.venv),
    }


def read(base: Path) -> Pointer | None:
    """O ponteiro gravado, ou `None` se não há (ou se o arquivo não é confiável)."""
    path = pointer_path(base)
    try:
        if path.stat().st_size > _MAX_BYTES:
            return None
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except OSError, ValueError:
        return None
    if not isinstance(data, dict):
        return None
    current = _slot(base, data.get("current"))
    if current is None:
        return None
    previous = _slot(base, data.get("previous")) if data.get("previous") else None
    return Pointer(current, previous, explicit=True)


def resolve(base: Path) -> Pointer:
    """O ponteiro gravado ou, sem ele, o layout de sempre."""
    return read(base) or Pointer(legacy_slot(base), None)


def current_app(base: Path) -> Path:
    """A pasta do código da versão em uso."""
    return resolve(base).current.app


def previous_app(base: Path) -> Path:
    """A pasta da versão anterior: a do ponteiro ou, sem ele, a `app.previous` de sempre."""
    pointer = resolve(base)
    return pointer.previous.app if pointer.previous is not None else base / "app.previous"


def write(base: Path, pointer: Pointer) -> None:
    """Grava o ponteiro de uma vez (arquivo temporário e `os.replace`: nunca meio arquivo)."""
    path = pointer_path(base)
    body: dict[str, Any] = {"v": 1, "current": _slot_json(base, pointer.current)}
    if pointer.previous is not None:
        body["previous"] = _slot_json(base, pointer.previous)
    temp = path.with_name(path.name + ".tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp.write_text(json.dumps(body, sort_keys=True), encoding="utf-8")
    os.replace(temp, path)


def switch_to(base: Path, target: Slot) -> Pointer:
    """A versão em uso passa a ser `target`; a que estava vira a anterior (para voltar atrás)."""
    pointer = Pointer(target, resolve(base).current, explicit=True)
    write(base, pointer)
    return pointer


def slot_ready(slot: Slot) -> bool:
    """A versão está inteira: código, marca da versão e ambiente Python."""
    return (
        (slot.app / "pyproject.toml").is_file()
        and (slot.app / "tools" / "run-agent.ps1").is_file()
        and (slot.app / ".version").is_file()
        and (slot.venv / "Scripts" / "python.exe").is_file()
    )


def handover_sha(base: Path) -> str | None:
    """O commit em passagem agora (o supervisor grava e apaga a marca), ou `None`."""
    try:
        text = (base / "runtime" / HANDOVER_FILE).read_text(encoding="ascii").strip()
    except OSError, ValueError:
        return None
    return text if _SHA.fullmatch(text) else None


def prune(base: Path, *, keep_extra: frozenset[str] = frozenset()) -> list[str]:
    """Apaga as versões preparadas que o ponteiro não usa mais (só a atual e a anterior ficam).

    O layout de sempre (`app`, `runtime\\venv`) nunca é tocado, e `keep_extra` protege um commit que
    acabou de ser preparado e ainda espera a troca. Devolve o que removeu, uma frase por pasta."""
    pointer = resolve(base)
    used = {slot.sha for slot in (pointer.current, pointer.previous) if slot is not None}
    wanted = {sha for sha in used if sha} | set(keep_extra)
    # Também nunca a versão que está sendo passada agora, mesmo antes de o ponteiro a nomear.
    passing = handover_sha(base)
    if passing is not None:
        wanted.add(passing)
    done: list[str] = []
    candidates = [(base / STAGING_DIR, False), (base / "runtime", True)]
    for folder, is_runtime in candidates:
        try:
            entries = [item for item in folder.iterdir() if item.is_dir()]
        except OSError:
            continue
        for item in entries:
            name = item.name
            if is_runtime:
                if not name.startswith(VENV_PREFIX):
                    continue
                name = name.removeprefix(VENV_PREFIX)
            if not _SHA.fullmatch(name) or name in wanted:
                continue
            try:
                shutil.rmtree(item)
            except OSError:
                _log.info("não consegui remover a versão antiga %s agora", name[:12])
                continue
            done.append(f"versão preparada antiga ({name[:12]})")
    return done


def prepared_path(base: Path) -> Path:
    return base / "runtime" / PREPARED_FILE


def write_prepared(base: Path, sha: str) -> None:
    """Marca `sha` como preparada: o supervisor troca para ela assim que puder."""
    path = prepared_path(base)
    slot = Slot(sha, staged_app(base, sha), staged_venv(base, sha))
    temp = path.with_name(path.name + ".tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp.write_text(json.dumps(_slot_json(base, slot), sort_keys=True), encoding="utf-8")
    os.replace(temp, path)


def read_prepared(base: Path) -> Slot | None:
    """A versão preparada, só se ainda está inteira (e é mesmo a do commit que o arquivo diz)."""
    try:
        data = json.loads(prepared_path(base).read_text(encoding="utf-8-sig"))
    except OSError, ValueError:
        return None
    slot = _slot(base, data)
    if slot is None or slot.sha is None:
        return None
    if slot.app != staged_app(base, slot.sha) or not slot_ready(slot):
        return None
    return slot


def clear_prepared(base: Path) -> None:
    try:
        prepared_path(base).unlink(missing_ok=True)
    except OSError:
        _log.info("não consegui apagar a marca da versão preparada")
