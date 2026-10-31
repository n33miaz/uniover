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

import hashlib
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import httpx

from uniover_agent.adapters.process import run_hidden

_log = logging.getLogger(__name__)

REPOSITORY = "n33miaz/uniover"
# De que ramo o agente se atualiza. Hoje é a `develop` (decisão do dono: a `develop` é a produção);
# quando a publicação voltar a sair pela `main`, basta trocar este padrão (ou o `update_channel` do
# `agent.toml`, por PC) para `main`.
CHANNELS = ("main", "develop")
DEFAULT_CHANNEL = "develop"
COMMIT_URL = f"https://api.github.com/repos/{REPOSITORY}/commits/{{channel}}"
TREE_URL = f"https://api.github.com/repos/{REPOSITORY}/git/trees/{{sha}}?recursive=1"
ARCHIVE_URL = f"https://github.com/{REPOSITORY}/archive/{{sha}}.zip"
# Ensaio de atualização (`tools/upgrade-drill.ps1`): com `UNIOVER_UPDATE_DRILL=1`, as duas
# consultas deste módulo vão para um servidor local em vez do GitHub. Sem a variável de modo
# nada disso é lido, e em produção ela nunca existe.
DRILL_ENV = "UNIOVER_UPDATE_DRILL"
DRILL_SOURCE_ENV = "UNIOVER_UPDATE_SOURCE_URL"
_DRILL_HOSTS = frozenset({"127.0.0.1", "localhost"})
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


class UpdateRejected(SelfUpdateError):  # noqa: N818 - nome do domínio: o pacote foi recusado
    """O pacote baixado não passou na conferência de integridade: não é para ser instalado."""


def drill_origin() -> str | None:
    """Origem local do ensaio de atualização, ou `None` fora do modo ensaio (o normal).

    No modo ensaio a origem precisa ser `http://` de `127.0.0.1`/`localhost` com porta: qualquer
    outra coisa é recusada em vez de cair no GitHub, para o ensaio nunca baixar código de fora."""
    if os.environ.get(DRILL_ENV) != "1":
        return None
    value = os.environ.get(DRILL_SOURCE_ENV, "").strip().rstrip("/")
    try:
        parts = urlsplit(value)
        valid = parts.scheme == "http" and parts.hostname in _DRILL_HOSTS and parts.port is not None
    except ValueError:
        valid = False
    if not valid or parts.path:
        raise SelfUpdateError("modo ensaio sem origem local válida (http://127.0.0.1:porta)")
    return value


def commit_url(channel: str = DEFAULT_CHANNEL) -> str:
    origin = drill_origin()
    return COMMIT_URL.format(channel=channel) if origin is None else f"{origin}/commit"


def tree_url(sha: str) -> str:
    origin = drill_origin()
    return TREE_URL.format(sha=sha) if origin is None else f"{origin}/tree/{sha}"


def archive_url(sha: str) -> str:
    origin = drill_origin()
    return ARCHIVE_URL.format(sha=sha) if origin is None else f"{origin}/archive/{sha}.zip"


def latest_commit(channel: str = DEFAULT_CHANNEL) -> str:
    """Commit atual do ramo do canal (40 hexadecimais)."""
    url = commit_url(channel)
    try:
        response = httpx.get(
            url,
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
    url = archive_url(sha)
    try:
        with (
            httpx.stream(
                "GET",
                url,
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


def update_in_trial(source: Path) -> bool:
    """A versão instalada ainda está em prova (o supervisor não a confirmou)?

    Enquanto está, a pasta `app.previous` é a última versão que se provou boa: atualizar de novo a
    trocaria por uma versão que ainda ninguém viu funcionar. O arquivo é do supervisor do Windows.
    """
    try:
        text = (source.parent / "runtime" / "update-trial.txt").read_text(encoding="ascii")
    except OSError, ValueError:
        return False
    version = read_version(source)
    return version is not None and text.strip().split("|", 1)[0] == version


def verify_archive(archive: Path, sha: str) -> None:
    """O zip está inteiro (CRC de cada arquivo) e é mesmo do commit pedido.

    O GitHub grava o commit no comentário do zip: um pacote de outro commit, ou de outro lugar, não
    passa. É a conferência que não depende de a rede ser confiável.
    """
    try:
        with zipfile.ZipFile(archive) as bundle:
            damaged = bundle.testzip()
            comment = bundle.comment.decode("ascii", errors="replace").strip()
    except zipfile.BadZipFile, OSError:
        raise UpdateRejected("o pacote baixado não é um zip válido") from None
    if damaged is not None:
        raise UpdateRejected("o pacote baixado está corrompido")
    if comment != sha:
        raise UpdateRejected("o pacote baixado não é do commit esperado")


def _git_blob_sha1(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


def agent_blob_hashes(archive: Path) -> dict[str, tuple[str, str]]:
    """Arquivo de `apps/agent` -> (hash do git dos bytes do zip, o mesmo com fins de linha LF).

    O zip de `git archive` converte fins de linha conforme o `.gitattributes` (os `.ps1` saem em
    CRLF); o hash no repositório é o do texto normalizado em LF. Aceita-se qualquer um dos dois.
    """
    found: dict[str, tuple[str, str]] = {}
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            parts = PurePosixPath(info.filename).parts
            is_agent_file = len(parts) >= len(AGENT_PREFIX) + 2 and parts[1:3] == AGENT_PREFIX
            if not is_agent_file or info.is_dir():
                continue
            if (info.external_attr >> 16) & _FILE_TYPE_MASK == _SYMLINK:
                continue
            data = bundle.read(info)
            found["/".join(parts[3:])] = (
                _git_blob_sha1(data),
                _git_blob_sha1(data.replace(b"\r\n", b"\n")),
            )
    return found


def fetch_git_tree(sha: str) -> dict[str, str] | None:
    """Os arquivos de `apps/agent` do commit segundo o GitHub (caminho -> hash do git).

    `None` quando não dá para conferir (rede, limite de consultas, árvore grande demais para a API):
    quem chama segue sem esta conferência e diz isso no registro, em vez de travar toda
    atualização.
    """
    try:
        response = httpx.get(
            tree_url(sha),
            headers={"Accept": "application/vnd.github+json", "User-Agent": "uniover-agent"},
            timeout=_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPError, ValueError:
        return None
    if (
        not isinstance(data, dict)
        or data.get("truncated")
        or not isinstance(data.get("tree"), list)
    ):
        return None
    prefix = "/".join(AGENT_PREFIX) + "/"
    files: dict[str, str] = {}
    for entry in data["tree"]:
        if not isinstance(entry, dict):
            return None
        path, kind, blob = entry.get("path"), entry.get("type"), entry.get("sha")
        if not isinstance(path, str) or not path.startswith(prefix) or kind != "blob":
            continue
        if entry.get("mode") == "120000":
            continue
        if not isinstance(blob, str):
            return None
        files[path.removeprefix(prefix)] = blob
    return files or None


def verify_tree(
    archive: Path, sha: str, fetch: Callable[[str], dict[str, str] | None] | None = None
) -> bool:
    """Confere cada arquivo do pacote contra a árvore do commit no GitHub.

    Devolve `False` se a árvore não pôde ser obtida (a conferência não aconteceu) e levanta
    `UpdateRejected` se houve conferência e algo não bate: arquivo a mais, a menos ou diferente.
    """
    # Resolvido na chamada (e não no padrão do parâmetro): quem troca `fetch_git_tree` vale.
    expected = (fetch or fetch_git_tree)(sha)
    if expected is None:
        return False
    try:
        actual = agent_blob_hashes(archive)
    except zipfile.BadZipFile, OSError:
        raise UpdateRejected("o pacote baixado não é um zip válido") from None
    if set(actual) != set(expected):
        raise UpdateRejected("os arquivos do pacote não são os do commit")
    for path, blob in expected.items():
        if blob not in actual[path]:
            raise UpdateRejected("um arquivo do pacote difere do commit")
    return True


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


def candidate_env(source: Path) -> Path:
    """Ambiente virtual **descartável** da candidata, ao lado dela (fora da pasta que é trocada).

    O ambiente do agente em execução (`UV_PROJECT_ENVIRONMENT`, `runtime\\venv`) não serve para
    validar a candidata: o `uv sync` de um projeto em outro caminho reinstala o próprio pacote
    nele (inclusive `Scripts\\uniover-agent.exe`, que o agente e esta atualização estão usando) e
    o Windows recusa trocar arquivo em uso. Foi o que fez `uv sync` falhar com `CalledProcessError`.
    """
    return source.with_name(source.name + ".venv")


def _find_uv() -> str:
    uv = os.environ.get("UV") or shutil.which("uv")
    if uv is None:
        raise SelfUpdateError("uv não encontrado para sincronizar as dependências")
    return uv


_SECRET_PAIR = re.compile(
    r"(?i)\b(token|password|passwd|secret|authorization|api[_-]?key|bearer)\b(\s*[=:]\s*|\s+)\S+"
)
_URL_CREDENTIALS = re.compile(r"(?i)(\w+://)[^/\s:@]+(?::[^/\s@]*)?@")
_LONG_TOKEN = re.compile(r"\b[A-Za-z0-9_\-]{32,}\b")
_REASON_LINES = 4
_REASON_LIMIT = 400


def summarize_failure(text: str) -> str:
    """O fim da saída de erro do `uv`, curto e sem segredos (para o registro dizer o motivo).

    Tira credenciais de URL, pares `token=...` e sequências longas que parecem chave."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    tail = " | ".join(lines[-_REASON_LINES:])
    tail = _URL_CREDENTIALS.sub(r"\1***@", tail)
    tail = _SECRET_PAIR.sub(lambda m: f"{m.group(1)}=***", tail)
    tail = _LONG_TOKEN.sub("***", tail)
    return tail[:_REASON_LIMIT]


def _run_uv(  # noqa: PLR0913 - cada argumento é um limite ou um caminho, todos por nome
    arguments: list[str],
    *,
    what: str,
    timeout: int,
    cwd: Path,
    environment: Path,
    pause: float,
    attempts: int = 1,
) -> None:
    """Roda o `uv` sem janela, com o ambiente descartável, e diz o motivo se falhar."""
    uv = _find_uv()
    env = {**os.environ, "UV_PROJECT_ENVIRONMENT": str(environment)}
    reason = ""
    for attempt in range(1, attempts + 1):
        if attempt > 1:
            time.sleep(pause)
        try:
            done = run_hidden(
                [uv, *arguments],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                cwd=cwd,
                env=env,
            )
        except subprocess.TimeoutExpired:
            reason = f"passou de {timeout} s"
            continue
        except OSError as exc:
            reason = f"não consegui executar o uv ({type(exc).__name__})"
            continue
        if done.returncode == 0:
            return
        detail = summarize_failure(f"{done.stderr}\n{done.stdout}")
        reason = f"código {done.returncode}" + (f": {detail}" if detail else "")
    raise SelfUpdateError(f"{what} falhou ({reason})")


def run_uv_sync(source: Path, *, pause: float = 3.0) -> None:
    """Sincroniza a candidata, num ambiente só dela, antes de ela substituir a instalação.

    Tenta de novo uma vez (arquivo preso por antivírus, cache do `uv` em uso, rede) e, se ainda
    falhar, a mensagem leva o motivo (final do erro do `uv`, sem segredos)."""
    environment = candidate_env(source)
    shutil.rmtree(environment, ignore_errors=True)
    _run_uv(
        ["sync", "--locked", "--project", str(source), "--quiet"],
        what="a sincronização das dependências",
        timeout=600,
        cwd=source.parent,
        environment=environment,
        pause=pause,
        attempts=2,
    )


def run_uv_check(source: Path) -> None:
    """Ensaio da candidata antes de ela ser promovida: roda o auto-diagnóstico dela.

    O diagnóstico (`uniover_agent.selfcheck`) importa o código, carrega os contratos e lê a
    configuração **real** deste PC com as regras da versão nova: uma candidata que não aceita o
    `agent.toml` de hoje nunca subiria, e é melhor descobrir isso aqui do que depois da troca. Usa o
    mesmo ambiente
    descartável, sem sincronizar de novo (`--no-sync`), e não toca em nada da instalação."""
    _run_uv(
        [
            "run",
            "--no-sync",
            "--project",
            str(source),
            "python",
            "-m",
            "uniover_agent.selfcheck",
        ],
        what="o auto-diagnóstico da versão nova",
        timeout=120,
        cwd=source.parent,
        environment=candidate_env(source),
        pause=0.0,
    )


@dataclass(frozen=True, slots=True)
class UpdateResult:
    updated: bool
    message: str
    # Para o estado que a tela do dono mostra (`update-status.json`); `None` = nada a registrar.
    # Fora da comparação: quem compara resultados olha só `updated` e `message`.
    outcome: str | None = field(default=None, compare=False)
    latest: str | None = field(default=None, compare=False)
    blocked: str | None = field(default=None, compare=False)
    # A conferência de integridade recusou o pacote (e não uma falha comum de rede ou de disco).
    rejected: bool = field(default=False, compare=False)


def self_update(  # noqa: PLR0911, PLR0913 - dependências injetadas deixam a atualização testável sem rede
    source: Path,
    *,
    sync: bool = True,
    channel: str = DEFAULT_CHANNEL,
    fetch_latest: Callable[[], str] | None = None,
    download: Callable[[str, Path], None] = download_archive,
    run_sync: Callable[[Path], None] = run_uv_sync,
    run_check: Callable[[Path], None] = run_uv_check,
    verify: Callable[[Path, str], None] = verify_archive,
    verify_files: Callable[[Path, str], bool] = verify_tree,
) -> UpdateResult:
    """Atualiza `source` (a `app` instalada) se o ramo do canal andou. Nunca levanta por falha de
    rede nem de disco: devolve o motivo em `message`.

    Antes de trocar a pasta, a candidata passa por: conferência do zip (inteiro e do commit pedido),
    conferência dos arquivos contra a árvore do commit no GitHub, `uv sync --locked` num ambiente só
    dela e o auto-diagnóstico dela. Qualquer falha deixa a instalação como estava.
    """
    if not source.is_dir():
        return UpdateResult(False, "agente não instalado pelo instalador; nada a atualizar")
    if update_in_trial(source):
        # `app.previous` é a última versão que se provou boa: a troca a apagaria.
        return UpdateResult(
            False, "a versão instalada ainda está em prova; atualizo quando ela se confirmar"
        )
    sha: str | None = None
    try:
        sha = (fetch_latest or (lambda: latest_commit(channel)))()
        if read_version(source) == sha:
            return UpdateResult(
                False, "o agente já está na versão mais recente", "up_to_date", latest=sha
            )
        if sha in blocked_versions(source):
            return UpdateResult(
                False,
                "a versão nova caiu repetidamente; aguardando outro commit",
                "blocked",
                latest=sha,
                blocked=sha,
            )
        workspace = Path(tempfile.mkdtemp(prefix="uniover-update-", dir=source.parent))
        try:
            archive = workspace / "main.zip"
            download(sha, archive)
            verify(archive, sha)
            if verify_files(archive, sha):
                _log.info("pacote conferido: os arquivos batem com o commit %s", sha[:12])
            else:
                _log.warning("não consegui conferir os arquivos contra o GitHub; sigo só com o zip")
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
                shutil.rmtree(candidate_env(new), ignore_errors=True)
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
    except UpdateRejected as exc:
        _log.error("atualização recusada: %s", exc, extra={"recorded": True})
        return UpdateResult(False, f"pacote recusado: {exc}", "failed", latest=sha, rejected=True)
    except (SelfUpdateError, OSError) as exc:
        _log.warning("auto-atualização adiada: %s", exc)
        return UpdateResult(False, f"não atualizei agora: {exc}", "failed", latest=sha)
    _log.info("agente atualizado")
    return UpdateResult(True, "agente atualizado", "updated", latest=sha)
