r"""Auto-atualização do agente instalado em `%LOCALAPPDATA%\UniOver\app`.

O fluxo é: consultar o ramo de produção e seu commit atual no GitHub, comparar com o gravado em
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
import json
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
# `main` e `develop` em agent.toml são valores legados do canal de produção. A branch ativa
# fica em um arquivo, sem precisar alterar cada PC ao migrar para main ou homolog.
CHANNELS = ("main", "develop", "homolog")
DEFAULT_CHANNEL = "develop"
PRODUCTION_ALIASES = ("main", "develop")


def _production_ref() -> str:
    path = Path(__file__).resolve().parents[3] / "tools" / "update-channel.json"
    try:
        ref = json.loads(path.read_text(encoding="utf-8"))["production_ref"]
        if isinstance(ref, str) and ref in CHANNELS:
            return ref
    except OSError, ValueError, KeyError, TypeError:
        pass
    return "develop"


PRODUCTION_REF = _production_ref()
PRODUCTION_REF_URL = (
    f"https://raw.githubusercontent.com/{REPOSITORY}/main/apps/agent/tools/update-channel.json"
)
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
# O tempo de cada leitura é limitado por `_TIMEOUT`, mas um servidor que pinga um byte a cada 59 s
# nunca estoura nenhuma: o download inteiro tem um prazo só.
DOWNLOAD_DEADLINE_SECONDS = 300.0
# Abaixo disto de espaço livre a atualização nem começa: o pacote, a pasta nova e o ambiente
# descartável dela somam centenas de MB, e uma atualização que enche o disco no meio piora o que
# já estava ruim.
MIN_FREE_BYTES = 600 * 1024 * 1024
# Uma versão que o supervisor devolveu por falta de espaço só deixa de estar adiada quando o disco
# volta com folga (o limiar do aviso de pouco espaço do agente): expirar exatamente em
# `MIN_FREE_BYTES` repetiria o ciclo de instalar, não caber e voltar, e cada volta custa o agente
# fora do ar.
DISK_RESUME_BYTES = 2 * 1024 * 1024 * 1024
# A TV conta como em uso se alguém a usou há menos disto (a marca `runtime\tv-last-use`, ver
# `tv_in_use`), e a atualização espera até este teto antes de ir assim mesmo.
TV_IDLE_SECONDS = 600.0
TV_MAX_DEFER_SECONDS = 24 * 3600.0
TV_LAST_USE_FILE = "tv-last-use"
TV_WAIT_FILE = ".update-waiting-for-tv"
TV_AGAIN_FLAG = "again"
# Limites de cada passo (usados por quem os executa e somados em `WORST_CASE_SECONDS`).
FETCH_TIMEOUT_SECONDS = (
    120.0  # a consulta do commit mais recente (várias leituras, cada uma com prazo)
)
EXTRACT_SECONDS = 120.0  # extrair e conferir o pacote, com o disco no limite
SYNC_TIMEOUT_SECONDS = 600
SYNC_ATTEMPTS = 2
SYNC_PAUSE_SECONDS = 3.0
CHECK_TIMEOUT_SECONDS = 120
# O pior caso de uma atualização que ainda anda: tudo isto, em série. O teto de quem a executa por
# fora (o supervisor, em `run-agent.ps1`) tem de passar disto, senão mata uma atualização lenta
# mas legítima, e a próxima tentativa recomeça do zero. A soma vale também por dentro: a consulta
# e a extração não têm prazo próprio, então `self_update` confere o orçamento inteiro entre os
# passos e desiste (antes de trocar as pastas) se ele acabou, em vez de deixar o supervisor matar
# no meio.
WORST_CASE_SECONDS = (
    FETCH_TIMEOUT_SECONDS
    + DOWNLOAD_DEADLINE_SECONDS
    + EXTRACT_SECONDS
    + SYNC_ATTEMPTS * SYNC_TIMEOUT_SECONDS
    + (SYNC_ATTEMPTS - 1) * SYNC_PAUSE_SECONDS
    + CHECK_TIMEOUT_SECONDS
)


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


def active_production_ref() -> str:
    """Lê o canal publicado na main; usa a cópia instalada se a consulta falhar."""
    if drill_origin() is not None:
        return PRODUCTION_REF
    try:
        response = httpx.get(
            PRODUCTION_REF_URL,
            headers={"Accept": "application/json", "User-Agent": "uniover-agent"},
            timeout=_TIMEOUT,
        )
        response.raise_for_status()
        ref = response.json()["production_ref"]
        if isinstance(ref, str) and ref in CHANNELS:
            return ref
    except httpx.HTTPError, ValueError, KeyError, TypeError:
        pass
    return PRODUCTION_REF


def commit_url(channel: str = DEFAULT_CHANNEL, *, production_ref: str = PRODUCTION_REF) -> str:
    origin = drill_origin()
    branch = production_ref if channel in PRODUCTION_ALIASES else channel
    return COMMIT_URL.format(channel=branch) if origin is None else f"{origin}/commit"


def tree_url(sha: str) -> str:
    origin = drill_origin()
    return TREE_URL.format(sha=sha) if origin is None else f"{origin}/tree/{sha}"


def archive_url(sha: str) -> str:
    origin = drill_origin()
    return ARCHIVE_URL.format(sha=sha) if origin is None else f"{origin}/archive/{sha}.zip"


def latest_commit(channel: str = DEFAULT_CHANNEL) -> str:
    """Commit atual do ramo do canal (40 hexadecimais)."""
    ref = active_production_ref() if channel in PRODUCTION_ALIASES else PRODUCTION_REF
    url = commit_url(channel, production_ref=ref)
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


def disk_free_bytes(folder: Path) -> int | None:
    """Espaço livre no disco de `folder`; `None` se não deu para saber (não bloqueia)."""
    try:
        return shutil.disk_usage(folder).free
    except OSError:
        return None


def download_archive(
    sha: str,
    destination: Path,
    *,
    deadline: float = DOWNLOAD_DEADLINE_SECONDS,
    monotonic: Callable[[], float] = time.monotonic,
) -> None:
    """Baixa o zip do commit para `destination` (arquivo), no máximo em `deadline` segundos."""
    total = 0
    url = archive_url(sha)
    give_up_at = monotonic() + deadline
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
                if monotonic() > give_up_at:
                    raise SelfUpdateError(f"o download passou de {deadline:.0f} s")
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


def trial_marker(source: Path) -> Path:
    return source.parent / "runtime" / "update-trial.txt"


def write_trial_marker(source: Path, sha: str) -> None:
    """Grava a prova da versão `sha` (`sha|quedas`), no formato que o supervisor lê.

    Vai ANTES da troca das pastas: uma versão nova nunca fica no ar sem a prova (e sem a volta atrás
    que vem com ela). Se não der para gravar (disco cheio), a troca nem acontece."""
    marker = trial_marker(source)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"{sha}|0", encoding="ascii")


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


DEFERRED_VERSIONS_FILE = ".deferred-versions"
DEFERRED_LOWDISK_FILE = ".deferred-lowdisk"
# O adiamento cresce a cada devolução do mesmo commit: 24 h, 72 h, uma semana. Num PC que segue
# lento, tentar de novo todo dia custaria uns 50 min fora do ar por dia (o sync em prova, 3 vezes).
DEFER_STEPS_SECONDS = (24 * 3600.0, 72 * 3600.0, 7 * 24 * 3600.0)


def lowdisk_deferred(source: Path) -> set[tuple[str, float]]:
    """As devoluções por falta de espaço (`.deferred-lowdisk`, uma linha `sha|epoch` por devolução).

    O `epoch` é o da linha da mesma devolução em `.deferred-versions`: só assim se sabe se a
    devolução MAIS RECENTE de um commit foi por disco. Arquivo à parte de propósito:
    `.deferred-versions` mantém o formato `sha|epoch` que a versão anterior (a que volta numa
    devolução) sabe ler. Uma linha com campo a mais seria ignorada por ela, e a versão devolvida
    seria reinstalada na hora."""
    try:
        text = (source.parent / "runtime" / DEFERRED_LOWDISK_FILE).read_text(encoding="utf-8")
    except OSError:
        return set()
    marks: set[tuple[str, float]] = set()
    for line in text.splitlines():
        sha, _, stamp = line.strip().partition("|")
        try:
            moment = float(stamp)
        except ValueError:
            continue
        if _SHA.fullmatch(sha):
            marks.add((sha, moment))
    return marks


def deferred_versions(source: Path, now: float, *, disk_ok: bool = False) -> set[str]:
    """Commits que o supervisor devolveu por culpa do PC (demora, disco) e não por defeito deles.

    Não são bloqueados, mas voltar a instalar o mesmo commit a cada checagem seria um laço de
    atualizar e voltar: ficam adiados (`sha|epoch`, uma linha por devolução), cada vez por mais
    tempo (`DEFER_STEPS_SECONDS`), contado da última devolução.

    Com `disk_ok` (o disco voltou com folga), pula-se SÓ o primeiro degrau (as 24 h) de um commit
    cuja única devolução foi por falta de espaço: a causa passou, e a primeira falha por disco não
    deve segurar a versão por um dia. A partir da segunda devolução vale o adiamento que cresce
    (72 h, uma semana) mesmo com o disco livre, e uma devolução mais recente por outro motivo
    (demora, prova que não gravou com disco sobrando) também volta ao adiamento normal: sem isso o
    PC fraco repetiria o ciclo de instalar e voltar a cada checagem."""
    try:
        path = source.parent / "runtime" / DEFERRED_VERSIONS_FILE
        entries = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return set()
    returns: dict[str, list[float]] = {}
    for line in entries:
        sha, _, stamp = line.strip().partition("|")
        try:
            since = float(stamp)
        except ValueError:
            continue
        if _SHA.fullmatch(sha):
            returns.setdefault(sha, []).append(since)
    deferred: set[str] = set()
    by_disk = lowdisk_deferred(source) if disk_ok else set()
    for sha, stamps in returns.items():
        if len(stamps) == 1 and (sha, stamps[0]) in by_disk:
            continue
        period = DEFER_STEPS_SECONDS[min(len(stamps), len(DEFER_STEPS_SECONDS)) - 1]
        # Um carimbo no futuro (o relógio voltou) conta como adiado, até um período à frente. Os
        # que passam disso são falsos (a pilha do CMOS acabou e o relógio voltou anos): só eles
        # saem, e vale o maior dos que sobram. Inválido o conjunto todo, a versão nunca mais seria
        # adiada (as devoluções novas levam a data antiga) e voltaria ao laço de instalar e
        # devolver.
        valid = [stamp for stamp in stamps if stamp <= now + period]
        if valid and now - max(valid) < period:
            deferred.add(sha)
    return deferred


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


def run_uv_sync(source: Path, *, pause: float = SYNC_PAUSE_SECONDS) -> None:
    """Sincroniza a candidata, num ambiente só dela, antes de ela substituir a instalação.

    Tenta de novo uma vez (arquivo preso por antivírus, cache do `uv` em uso, rede) e, se ainda
    falhar, a mensagem leva o motivo (final do erro do `uv`, sem segredos)."""
    environment = candidate_env(source)
    shutil.rmtree(environment, ignore_errors=True)
    _run_uv(
        ["sync", "--frozen", "--project", str(source), "--quiet"],
        what="a sincronização das dependências",
        timeout=SYNC_TIMEOUT_SECONDS,
        cwd=source.parent,
        environment=environment,
        pause=pause,
        attempts=SYNC_ATTEMPTS,
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
        timeout=CHECK_TIMEOUT_SECONDS,
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


def promote(source: Path, new: Path, sha: str, record_trial: Callable[[Path, str], None]) -> None:
    """Põe `new` no lugar de `source`, com a prova gravada ANTES (sem ela, a troca não acontece)."""
    try:
        record_trial(source, sha)
    except OSError as exc:
        raise SelfUpdateError(
            f"não consegui registrar a prova da versão nova ({type(exc).__name__})"
        ) from None
    try:
        swap_directories(source, new, keep_previous=True)
    except BaseException:
        # A troca não houve: a prova da versão que não entrou não vale.
        trial_marker(source).unlink(missing_ok=True)
        raise


def tv_in_use(source: Path, now: float, idle_seconds: float = TV_IDLE_SECONDS) -> bool:
    """Alguém usou a TV há menos de `idle_seconds`?

    O agente em execução grava o instante do último uso real (comando, toque na tela do controle)
    como a data de `runtime\\tv-last-use`; aqui só se lê essa data. Sem o arquivo (agente sem TV,
    agente antigo, supervisor que ainda não o criou) a TV conta como parada, como antes. Uma data
    no futuro além da janela é relógio errado e também não prova uso."""
    if idle_seconds <= 0:
        return False
    try:
        stamp = (source.parent / "runtime" / TV_LAST_USE_FILE).stat().st_mtime
    except OSError:
        return False
    return -idle_seconds < now - stamp < idle_seconds


def _clear_tv_wait(source: Path) -> None:
    try:
        (source.parent / "runtime" / TV_WAIT_FILE).unlink(missing_ok=True)
    except OSError:
        _log.debug("não consegui apagar a marca de espera pela TV")


def _read_tv_wait(path: Path) -> tuple[str, float, bool] | None:
    """O relógio da espera: (commit, início, a TV voltou a ser usada na checagem anterior)."""
    try:
        sha, _, rest = path.read_text(encoding="utf-8").strip().partition("|")
        stamp, _, flag = rest.partition("|")
        return sha, float(stamp), flag == TV_AGAIN_FLAG
    except OSError, ValueError:
        return None


def _write_tv_wait(path: Path, sha: str, since: float, *, again: bool) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        flag = f"|{TV_AGAIN_FLAG}" if again else ""
        path.write_text(f"{sha}|{since:.0f}{flag}\n", encoding="utf-8")
    except OSError:
        return False
    return True


def settle_tv_wait(source: Path, *, in_use: bool, max_defer_seconds: float) -> None:
    """Começo de toda checagem: a TV parada fecha ou mantém o relógio da espera.

    Aplicada uma vez, ANTES de qualquer desfecho antecipado da checagem (consulta que falha, versão
    bloqueada ou adiada, pouco espaço), senão uma TV que já parou deixaria o relógio velho para
    sempre. Com a TV em uso nada muda. Parada, o relógio é apagado, salvo se a checagem anterior
    terminou com a TV voltando a ser usada durante a preparação (`mark_tv_busy_again`): então só a
    marca `again` cai, o início continua valendo até a troca, e a TV já precisou ficar parada pela
    janela inteira (`tv_in_use`) para este ponto ser alcançado."""
    if in_use and max_defer_seconds > 0:
        return
    path = source.parent / "runtime" / TV_WAIT_FILE
    state = _read_tv_wait(path)
    if state is None:
        return
    if state[2]:
        _write_tv_wait(path, state[0], state[1], again=False)
    else:
        _clear_tv_wait(source)


def should_wait_for_tv(
    source: Path,
    now: float,
    *,
    sha: str,
    in_use: bool,
    max_defer_seconds: float = TV_MAX_DEFER_SECONDS,
) -> bool:
    """A atualização para `sha` deve esperar a TV parar? Espera no máximo `max_defer_seconds`.

    O relógio da espera começa na primeira checagem em que havia atualização e a TV estava em uso,
    e fica em `runtime\\.update-waiting-for-tv` (`sha|epoch[|again]`; um reinício do agente não o
    zera, senão reinícios seguidos adiariam para sempre). Vale o início MAIS ANTIGO: outro commit
    no meio da espera só troca o `sha` (informativo), e uma checagem que falha não o apaga, senão
    uma TV usada o tempo todo nunca deixaria o teto de 24 h chegar. Só se apaga com a versão atual
    em dia, depois da troca ou pela regra de `settle_tv_wait`. Se o relógio não puder ser gravado
    (disco), não espera: sem como contar, o teto não se faria valer."""
    if not in_use or max_defer_seconds <= 0:
        return False
    path = source.parent / "runtime" / TV_WAIT_FILE
    state = _read_tv_wait(path)
    since = state[1] if state is not None and state[1] <= now else now
    if state is None or state[1] > now or state[0] != sha:
        if not _write_tv_wait(path, sha, since, again=state is not None and state[2]):
            return False
    return now - since < max_defer_seconds


def mark_tv_busy_again(source: Path, sha: str) -> None:
    """A TV voltou a ser usada enquanto a candidata era preparada: a próxima checagem não pode
    apagar o relógio só porque a TV já estava parada quando ela começou."""
    path = source.parent / "runtime" / TV_WAIT_FILE
    state = _read_tv_wait(path)
    if state is not None:
        _write_tv_wait(path, sha, state[1], again=True)


class _TvBusyAgain(SelfUpdateError):  # noqa: N818 - não é um erro: é o adiamento
    """A TV voltou a ser usada enquanto a candidata era preparada: não se troca a versão agora."""


def _low_disk_result(free: int | None, minimum: int, sha: str) -> UpdateResult | None:
    """Sem espaço para baixar e montar a versão nova: adia (volta sozinha na checagem seguinte)."""
    if free is None or free >= minimum:
        return None
    _log.warning("auto-atualização adiada: pouco espaço no disco (%d MB livres)", free >> 20)
    return UpdateResult(
        False,
        f"pouco espaço no disco ({free >> 20} MB livres); a atualização espera ter espaço",
        "failed",
        latest=sha,
    )


def self_update(  # noqa: PLR0911, PLR0912, PLR0913, PLR0915 - dependências injetadas deixam a atualização testável sem rede
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
    free_bytes: Callable[[Path], int | None] = disk_free_bytes,
    min_free_bytes: int = MIN_FREE_BYTES,
    record_trial: Callable[[Path, str], None] = write_trial_marker,
    monotonic: Callable[[], float] = time.monotonic,
    wall: Callable[[], float] = time.time,
    ignore_deferral: bool = False,
    resume_free_bytes: int = DISK_RESUME_BYTES,
    tv_idle_seconds: float = TV_IDLE_SECONDS,
    tv_max_defer_seconds: float = TV_MAX_DEFER_SECONDS,
) -> UpdateResult:
    """Atualiza `source` (a `app` instalada) se o ramo do canal andou. Nunca levanta por falha de
    rede nem de disco: devolve o motivo em `message`.

    Antes de trocar a pasta, a candidata passa por: conferência do zip (inteiro e do commit pedido),
    conferência dos arquivos contra a árvore do commit no GitHub, `uv sync --frozen` num ambiente só
    dela e o auto-diagnóstico dela. Qualquer falha deixa a instalação como estava.

    Não troca a versão com a TV em uso (`tv_idle_seconds`): espera, no máximo `tv_max_defer_seconds`
    desde a primeira vez que adiou. `ignore_deferral` (o "Atualizar agora" do dono) não espera.
    """
    if not source.is_dir():
        return UpdateResult(False, "agente não instalado pelo instalador; nada a atualizar")
    if update_in_trial(source):
        # `app.previous` é a última versão que se provou boa: a troca a apagaria.
        return UpdateResult(
            False, "a versão instalada ainda está em prova; atualizo quando ela se confirmar"
        )
    sha: str | None = None
    started = monotonic()

    def tv_must_wait(candidate: str) -> bool:
        return not ignore_deferral and should_wait_for_tv(
            source,
            wall(),
            sha=candidate,
            in_use=tv_in_use(source, wall(), tv_idle_seconds),
            max_defer_seconds=tv_max_defer_seconds,
        )

    def within_budget() -> None:
        if monotonic() - started > WORST_CASE_SECONDS:
            raise SelfUpdateError("a atualização passou do tempo máximo; fica para a próxima vez")

    try:
        if not ignore_deferral:
            settle_tv_wait(
                source,
                in_use=tv_in_use(source, wall(), tv_idle_seconds),
                max_defer_seconds=tv_max_defer_seconds,
            )
        sha = (fetch_latest or (lambda: latest_commit(channel)))()
        within_budget()
        if read_version(source) == sha:
            _clear_tv_wait(source)
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
        free = free_bytes(source.parent)
        disk_ok = free is None or free >= resume_free_bytes
        if not ignore_deferral and sha in deferred_versions(source, wall(), disk_ok=disk_ok):
            # "deferred" é interno (não existe no contrato): quem grava o estado devolve o que
            # havia.
            return UpdateResult(
                False,
                "esta versão voltou por demora ou disco do PC; tento de novo mais tarde",
                "deferred",
                latest=sha,
            )
        low = _low_disk_result(free, min_free_bytes, sha)
        if low is not None:
            return low
        if tv_must_wait(sha):
            _log.info("atualização adiada: a TV foi usada há pouco; espero ela ficar parada")
            return UpdateResult(
                False,
                "a TV está em uso; a atualização espera ela ficar parada",
                "deferred_busy",
                latest=sha,
            )
        workspace = Path(tempfile.mkdtemp(prefix="uniover-update-", dir=source.parent))
        try:
            archive = workspace / "main.zip"
            download(sha, archive)
            within_budget()
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
                within_budget()
                (new / VERSION_FILE).write_text(sha + "\n", encoding="utf-8")
                if sync:
                    run_sync(new)
                    within_budget()
                run_check(new)
                within_budget()
                # Baixar e montar leva minutos: a TV pode ter voltado a ser usada nesse intervalo.
                if tv_must_wait(sha):
                    raise _TvBusyAgain("a TV voltou a ser usada; a troca fica para quando parar")
                promote(source, new, sha, record_trial)
                _clear_tv_wait(source)
            except BaseException:
                shutil.rmtree(new, ignore_errors=True)
                raise
            finally:
                shutil.rmtree(candidate_env(new), ignore_errors=True)
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
    except _TvBusyAgain:
        mark_tv_busy_again(source, sha or "")
        _log.info("atualização adiada: a TV voltou a ser usada enquanto eu preparava a versão nova")
        return UpdateResult(
            False,
            "a TV está em uso; a atualização espera ela ficar parada",
            "deferred_busy",
            latest=sha,
        )
    except UpdateRejected as exc:
        _log.error("atualização recusada: %s", exc, extra={"recorded": True})
        return UpdateResult(False, f"pacote recusado: {exc}", "failed", latest=sha, rejected=True)
    except (SelfUpdateError, OSError) as exc:
        _log.warning("auto-atualização adiada: %s", exc)
        return UpdateResult(False, f"não atualizei agora: {exc}", "failed", latest=sha)
    _log.info("agente atualizado")
    return UpdateResult(True, "agente atualizado", "updated", latest=sha)
