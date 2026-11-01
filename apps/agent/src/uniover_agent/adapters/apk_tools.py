"""Ferramentas locais dos ícones: `aapt2`, leitura dentro do APK, cache e pasta temporária.

* `aapt2` (do Android SDK, `build-tools`) é opcional: sem ele não há ícones, e isso nunca é erro
  fatal. Roda sem shell, com `argv` em lista e tempo limite;
* o APK nunca é extraído: `zipfile` abre o arquivo e lê só a imagem escolhida, depois de conferir o
  tamanho declarado, para uma entrada gigante nunca ir para a memória;
* o cache e a pasta temporária ficam sob o usuário (`%LOCALAPPDATA%` e a pasta temporária dele) e os
  nomes de arquivo só nascem de pacotes validados.
"""

import asyncio
import logging
import os
import re
import sys
import tempfile
import uuid
import zipfile
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Final

from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.tv_adb import run_process
from uniover_agent.adapters.tv_adb_parsing import AdbOutput, is_valid_package
from uniover_agent.ports import AppIcon, CachedIcon, IconToolError

_log = logging.getLogger(__name__)

DEFAULT_AAPT_TIMEOUT_SECONDS: Final = 30.0
_AAPT_EXECUTABLE: Final = "aapt2.exe" if sys.platform == "win32" else "aapt2"
_SCRATCH_DIR_NAME: Final = "uniover-agent-apk"
_VERSION_PART: Final = re.compile(r"\d+")

Runner = Callable[[Sequence[str], float], Awaitable[AdbOutput]]


def _version_key(path: Path) -> tuple[int, ...]:
    """`35.0.0` -> (35, 0, 0): comparar como número, não como texto (`9.0.0` < `34.0.0`)."""
    return tuple(int(part) for part in _VERSION_PART.findall(path.parent.name))


def _sdk_roots() -> list[Path]:
    roots: list[Path] = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        roots.append(Path(local) / "Android" / "Sdk")
    for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = os.environ.get(name)
        if value:
            roots.append(Path(value))
    return roots


def locate_aapt2(configured: str | None) -> Path | None:
    """Acha o `aapt2`: o caminho configurado, senão o mais novo em `build-tools` do Android SDK.

    Caminho configurado que não existe **não** cai nos outros: foi uma escolha explícita errada.
    Sem `aapt2` devolve `None` e o agente simplesmente segue sem ícones.
    """
    return locate_build_tool(_AAPT_EXECUTABLE, configured)


def locate_build_tool(executable: str, configured: str | None) -> Path | None:
    """Uma ferramenta de `build-tools` (a mais nova) do Android SDK; mesma regra do `aapt2`."""
    if configured:
        path = Path(configured)
        return path if path.is_file() else None
    found: list[Path] = []
    for root in _sdk_roots():
        try:
            found.extend(root.glob(f"build-tools/*/{executable}"))
        except OSError:
            continue
    found = [path for path in found if path.is_file()]
    return max(found, key=_version_key) if found else None


class Aapt2Inspector:
    """Implementa `ApkInspector` com o `aapt2` e o `zipfile`."""

    def __init__(
        self,
        aapt_path: Path,
        *,
        timeout: float = DEFAULT_AAPT_TIMEOUT_SECONDS,
        runner: Runner | None = None,
    ) -> None:
        self._aapt = str(aapt_path)
        self._timeout = timeout
        self._run: Runner = runner or run_process

    async def dump_badging(self, apk: Path) -> str:
        return await self._dump("badging", apk)

    async def dump_resources(self, apk: Path) -> str:
        # Sem `--no-values`: ele tira justamente as linhas `(file)` de onde sai o ícone legado.
        return await self._dump("resources", apk)

    async def _dump(self, what: str, apk: Path) -> str:
        try:
            output = await self._run([self._aapt, "dump", what, str(apk)], self._timeout)
        except TimeoutError:
            raise IconToolError("o aapt2 demorou demais") from None
        except OSError as exc:
            _log.warning("não foi possível executar o aapt2 (%s)", type(exc).__name__)
            raise IconToolError("não foi possível executar o aapt2") from None
        if output.returncode != 0:
            raise IconToolError("o aapt2 não conseguiu ler o APK")
        return output.text

    async def read_member(self, apk: Path, name: str, max_bytes: int) -> bytes | None:
        return await asyncio.to_thread(_read_member, apk, name, max_bytes)


def _read_member(apk: Path, name: str, max_bytes: int) -> bytes | None:
    try:
        with zipfile.ZipFile(apk) as archive:
            try:
                info = archive.getinfo(name)
            except KeyError:
                return None
            # O tamanho declarado é conferido antes de ler: entrada grande nunca vai para a memória.
            if info.is_dir() or info.file_size > max_bytes:
                return None
            data = archive.read(info)
    except (zipfile.BadZipFile, OSError, NotImplementedError, RuntimeError, EOFError) as exc:
        raise IconToolError("o APK copiado não pôde ser lido") from exc
    return data if len(data) <= max_bytes else None


def default_icons_dir() -> Path:
    """`icons` na pasta de instalação (fora do repositório, por usuário)."""
    return installation_base() / "icons"


_MIME_BY_SUFFIX: Final = {".png": "image/png", ".webp": "image/webp"}
_SUFFIX_BY_MIME: Final = {mime: suffix for suffix, mime in _MIME_BY_SUFFIX.items()}
_NONE_SUFFIX: Final = ".none"
# Versão da regra que escolhe o ícone, gravada no nome do arquivo. Quem muda a regra sobe este
# número: o que foi guardado pela regra antiga (um banner, ou um "sem ícone" que a regra nova
# talvez resolva) deixa de ser lido e é apagado quando o app for resolvido de novo.
_SELECTION_RULE: Final = 2


class FileIconCache:
    """Cache em disco: `<pacote>-<versionCode>.r<regra>.png|.webp`, ou `.none` (sem ícone útil)."""

    def __init__(self, directory: Path) -> None:
        self._dir = directory

    def _stem(self, package: str, version: int) -> str:
        # Defesa em profundidade: o nome do arquivo só nasce de pacote no formato do Android.
        if not is_valid_package(package) or version < 0:
            raise ValueError("pacote ou versão inválidos para o cache")
        return f"{package}-{version}.r{_SELECTION_RULE}"

    def load(self, package: str, version: int) -> CachedIcon | None:
        stem = self._stem(package, version)
        for suffix, mime in _MIME_BY_SUFFIX.items():
            path = self._dir / f"{stem}{suffix}"
            try:
                return CachedIcon(AppIcon(mime, path.read_bytes()))
            except FileNotFoundError:
                continue
            except OSError as exc:
                _log.warning("cache de ícone ilegível (%s)", type(exc).__name__)
                return None
        if (self._dir / f"{stem}{_NONE_SUFFIX}").is_file():
            return CachedIcon(None)
        return None

    def store(self, package: str, version: int, icon: AppIcon | None) -> None:
        stem = self._stem(package, version)
        suffix = _NONE_SUFFIX if icon is None else _SUFFIX_BY_MIME.get(icon.mime)
        if suffix is None:
            raise ValueError("tipo de imagem não guardado em cache")
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            target = self._dir / f"{stem}{suffix}"
            temporary = self._dir / f"{stem}.{uuid.uuid4().hex}.tmp"
            temporary.write_bytes(b"" if icon is None else icon.data)
            temporary.replace(target)
            # Versão nova substitui as antigas (e a entrada de outro tipo da mesma versão).
            for other in self._dir.glob(f"{package}-*"):
                if other != target and other.suffix in {*_MIME_BY_SUFFIX, _NONE_SUFFIX}:
                    other.unlink(missing_ok=True)
        except OSError as exc:
            # Sem cache o ícone ainda é publicado; só será baixado de novo na próxima vez.
            _log.warning("não foi possível guardar o ícone em cache (%s)", type(exc).__name__)


class TempApkScratch:
    """Pasta temporária do usuário: o APK existe só o tempo de ler o ícone."""

    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory or Path(tempfile.gettempdir()) / _SCRATCH_DIR_NAME

    def purge(self) -> None:
        """Remove sobras de uma execução anterior que caiu no meio de uma cópia."""
        try:
            for leftover in self._dir.glob("*.apk"):
                leftover.unlink(missing_ok=True)
        except OSError as exc:
            _log.debug("sobras de APK não removidas (%s)", type(exc).__name__)

    def new_path(self) -> Path:
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        return self._dir / f"{uuid.uuid4().hex}.apk"

    def discard(self, path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            # No Windows um arquivo ainda aberto não some; a limpeza da próxima partida resolve.
            _log.debug("APK temporário não apagado (%s)", type(exc).__name__)
