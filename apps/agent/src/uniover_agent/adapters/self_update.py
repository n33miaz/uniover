r"""Auto-atualização do agente instalado em `%LOCALAPPDATA%\UniOver\app`.

O fluxo é: perguntar ao GitHub qual é o commit atual da `main`, comparar com o gravado em
`app\.version` e, se mudou, baixar **o zip daquele commit** (e não o da branch, que poderia
andar entre uma chamada e outra), montar a pasta nova ao lado, validá-la e trocar por renomeação,
guardando a anterior para o wrapper do Windows voltar atrás.

Qualquer falha (sem rede, GitHub limitando, zip estranho, pasta travada) deixa a instalação
como estava e é só um aviso: quem chama segue para rodar o agente que já existe.

Por que trocar por renomeação: no Windows não se apaga nem se sobrescreve uma pasta em uso, mas
renomeá-la e pôr outra no lugar vale, desde que ninguém tenha a pasta aberta. O instalador, por
isso, deixa o ambiente virtual **fora** dela (`UV_PROJECT_ENVIRONMENT`) e roda o `uv` com
`--project` (sem mudar o diretório corrente): o próprio processo que atualiza não a trava.
"""

import logging
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import httpx

_log = logging.getLogger(__name__)

REPOSITORY = "n33miaz/uniover"
COMMIT_URL = f"https://api.github.com/repos/{REPOSITORY}/commits/main"
ARCHIVE_URL = f"https://github.com/{REPOSITORY}/archive/{{sha}}.zip"
VERSION_FILE = ".version"
BLOCKED_VERSIONS_FILE = ".blocked-versions"
AGENT_PREFIX = ("apps", "agent")
# Tipo de arquivo nos bits altos do `external_attr` do zip (modo Unix).
_FILE_TYPE_MASK = 0o170000
_SYMLINK = 0o120000
_SHA = re.compile(r"[0-9a-f]{40}")
_TIMEOUT = httpx.Timeout(connect=15.0, read=60.0, write=15.0, pool=15.0)
# O repositório inteiro compactado tem poucos MB; este teto só barra resposta absurda.
_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
_MAX_EXTRACTED_BYTES = 500 * 1024 * 1024


class SelfUpdateError(Exception):
    """A atualização não pôde ser concluída; a instalação atual ficou intacta."""


def latest_commit() -> str:
    """Commit atual da `main` (40 hexadecimais)."""
    try:
        response = httpx.get(
            COMMIT_URL,
            headers={"Accept": "application/vnd.github+json", "User-Agent": "uniover-agent"},
            timeout=_TIMEOUT,
        )
        response.raise_for_status()
        sha = response.json().get("sha")
    except (httpx.HTTPError, ValueError, AttributeError) as exc:
        raise SelfUpdateError(f"não consegui consultar o GitHub ({type(exc).__name__})") from None
    if not isinstance(sha, str) or not _SHA.fullmatch(sha):
        raise SelfUpdateError("resposta do GitHub fora do esperado")
    return sha


def download_archive(sha: str, destination: Path) -> None:
    """Baixa o zip do commit para `destination` (arquivo)."""
    total = 0
    try:
        with (
            httpx.stream(
                "GET",
                ARCHIVE_URL.format(sha=sha),
                headers={"User-Agent": "uniover-agent"},
                follow_redirects=True,
                timeout=_TIMEOUT,
            ) as response,
            destination.open("wb") as handle,
        ):
            response.raise_for_status()
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > _MAX_DOWNLOAD_BYTES:
                    raise SelfUpdateError("o pacote baixado é grande demais")
                handle.write(chunk)
    except httpx.HTTPError as exc:
        raise SelfUpdateError(f"não consegui baixar o pacote ({type(exc).__name__})") from None


def read_version(source: Path) -> str | None:
    try:
        text = (source / VERSION_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def extract_agent(archive: Path, destination: Path) -> None:
    """Extrai `apps/agent` e o ícone público para `destination`.

    Cada caminho é conferido para ficar dentro do destino (zip malicioso com `..` ou caminho
    absoluto não escreve fora) e o que não é arquivo comum é ignorado.
    """
    root = destination.resolve()
    extracted = 0
    try:
        with zipfile.ZipFile(archive) as bundle:
            for info in bundle.infolist():
                parts = PurePosixPath(info.filename).parts
                agent_file = len(parts) >= len(AGENT_PREFIX) + 2 and parts[1:3] == AGENT_PREFIX
                app_icon = parts[1:] == ("apps", "web", "public", "icons", "icon-192.png")
                if not agent_file and not app_icon:
                    continue
                if info.is_dir() or (info.external_attr >> 16) & _FILE_TYPE_MASK == _SYMLINK:
                    continue
                relative = parts[3:] if agent_file else ("assets", "uniover.png")
                target = (root.joinpath(*relative)).resolve()
                if not target.is_relative_to(root):
                    raise SelfUpdateError("o pacote baixado tem um caminho inválido")
                extracted += info.file_size
                if extracted > _MAX_EXTRACTED_BYTES:
                    raise SelfUpdateError("o pacote baixado é grande demais")
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as source, target.open("wb") as out:
                    shutil.copyfileobj(source, out)
    except zipfile.BadZipFile:
        raise SelfUpdateError("o pacote baixado não é um zip válido") from None
    if not (root / "pyproject.toml").is_file():
        raise SelfUpdateError("o pacote baixado não contém apps/agent")
    png, ico = root / "assets" / "uniover.png", root / "assets" / "uniover.ico"
    if png.is_file():
        try:
            from PIL import Image  # noqa: PLC0415 - Pillow só é necessário ao preparar o ícone opcional

            with Image.open(png) as image:
                image.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64)])
        except OSError, ValueError:
            _log.warning("não consegui preparar o ícone da bandeja")
        finally:
            try:
                png.unlink(missing_ok=True)
            except OSError:
                _log.warning("não consegui remover a imagem temporária da bandeja")


def blocked_versions(source: Path) -> set[str]:
    """Commits recusados pelo monitor do Windows depois de uma queda repetida."""
    try:
        runtime_file = source.parent / "runtime" / BLOCKED_VERSIONS_FILE
        path = runtime_file if runtime_file.exists() else source.parent / BLOCKED_VERSIONS_FILE
        entries = path.read_text(encoding="utf-8").splitlines()
        return {line.strip() for line in entries if _SHA.fullmatch(line.strip())}
    except OSError:
        return set()


def swap_directories(current: Path, new: Path, *, keep_previous: bool = False) -> None:
    """Troca `current` por `new` por renomeação, com volta atrás se a segunda falhar.

    No Windows instalado, mantém uma cópia anterior para o wrapper poder voltar se a versão
    nova morrer logo após iniciar. Os testes e outros chamadores podem pedir a troca efêmera.
    """
    old = current.with_name(current.name + (".previous" if keep_previous else ".old"))
    shutil.rmtree(old, ignore_errors=True)
    try:
        current.rename(old)
    except OSError:
        raise SelfUpdateError("a pasta do agente está em uso; fica para a próxima vez") from None
    try:
        new.rename(current)
    except OSError:
        old.rename(current)
        raise SelfUpdateError("não consegui pôr a versão nova no lugar") from None
    if not keep_previous:
        shutil.rmtree(old, ignore_errors=True)


def run_uv_sync(source: Path) -> None:
    """Sincroniza a candidata antes de ela substituir a instalação atual."""
    uv = os.environ.get("UV") or shutil.which("uv")
    if uv is None:
        raise SelfUpdateError("uv não encontrado para sincronizar as dependências")
    try:
        subprocess.run(  # noqa: S603 - executável do próprio uv, argumentos fixos
            [uv, "sync", "--project", str(source), "--quiet"],
            check=True,
            timeout=600,
            cwd=source.parent,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SelfUpdateError(
            f"não consegui sincronizar as dependências ({type(exc).__name__})"
        ) from None


def run_uv_check(source: Path) -> None:
    """Importa o núcleo e o contrato mínimo antes de promover uma atualização."""
    uv = os.environ.get("UV") or shutil.which("uv")
    if uv is None:
        raise SelfUpdateError("uv não encontrado para testar a atualização")
    try:
        subprocess.run(  # noqa: S603 - executável do próprio uv, argumentos fixos
            [
                uv,
                "run",
                "--project",
                str(source),
                "python",
                "-c",
                "import uniover_agent.main; import uniover_agent.contracts.agent_hello_v1",
            ],
            check=True,
            timeout=120,
            cwd=source.parent,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SelfUpdateError(
            f"a verificação rápida da atualização falhou ({type(exc).__name__})"
        ) from None


@dataclass(frozen=True, slots=True)
class UpdateResult:
    updated: bool
    message: str


def self_update(  # noqa: PLR0913 - dependências injetadas deixam a atualização testável sem rede
    source: Path,
    *,
    sync: bool = True,
    fetch_latest: Callable[[], str] = latest_commit,
    download: Callable[[str, Path], None] = download_archive,
    run_sync: Callable[[Path], None] = run_uv_sync,
    run_check: Callable[[Path], None] = run_uv_check,
) -> UpdateResult:
    """Atualiza `source` (a `app` instalada) se a `main` andou. Nunca levanta por falha de
    rede nem de disco: devolve o motivo em `message`."""
    if not source.is_dir():
        return UpdateResult(False, "agente não instalado pelo instalador; nada a atualizar")
    try:
        sha = fetch_latest()
        if read_version(source) == sha:
            return UpdateResult(False, "o agente já está na versão mais recente")
        if sha in blocked_versions(source):
            return UpdateResult(False, "a versão nova caiu repetidamente; aguardando outro commit")
        workspace = Path(tempfile.mkdtemp(prefix="uniover-update-", dir=source.parent))
        try:
            archive = workspace / "main.zip"
            download(sha, archive)
            new = source.with_name(source.name + ".new")
            shutil.rmtree(new, ignore_errors=True)
            try:
                new.mkdir()
                extract_agent(archive, new)
                (new / VERSION_FILE).write_text(sha + "\n", encoding="utf-8")
                if sync:
                    run_sync(new)
                run_check(new)
                swap_directories(source, new, keep_previous=True)
            except BaseException:
                shutil.rmtree(new, ignore_errors=True)
                raise
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
    except (SelfUpdateError, OSError) as exc:
        _log.warning("auto-atualização adiada: %s", exc)
        return UpdateResult(False, f"não atualizei agora: {exc}")
    _log.info("agente atualizado")
    return UpdateResult(True, "agente atualizado")
