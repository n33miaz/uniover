"""Ferramentas do Android (`adb` e `aapt2`) que o agente prepara sozinho quando faltam no PC.

Sem o `adb` não há lista de apps nem digitação pelo ADB; sem o `aapt2` não há ícones. Antes era
preciso baixar os dois à mão e reiniciar o agente. Agora:

* **procura em tempo de execução**: `ToolWatch.path()` procura de novo (no máximo uma vez por
  intervalo) enquanto a ferramenta falta, então o que aparece depois da partida (baixado pelo
  próprio agente, pelo instalador ou pela pessoa) passa a valer sem reiniciar;
* **baixado da Google** por HTTPS, só para a pasta do usuário (`<instalação>/tools`), sem
  administrador e sem janela. O `platform-tools` só é aceito com a assinatura Authenticode válida
  da Google LLC no `adb.exe`; o `aapt2` vem do Maven da Google numa versão fixa, conferido pelo
  SHA-256 publicado ao lado do `.jar` **e** pelo SHA-256 fixado aqui;
* **instalação atômica**: tudo é extraído numa pasta irmã temporária, conferido e só então
  renomeado para o lugar final; nada pela metade fica onde o agente procura;
* **ZIP conferido**: tamanho e número de entradas limitados, nenhum nome absoluto, com `..`, com
  unidade de disco ou link simbólico;
* **sem laço apertado**: uma tentativa por vez, com espera crescente entre as falhas e sem
  baixar em rede tarifada ou sem internet (a tentativa fica para depois);
* registro em pt-BR sem caminho nem endereço: só o nome da ferramenta e o tipo da falha.

Nenhum binário da Google vai no repositório: o download acontece no PC de quem usa.
"""

import asyncio
import base64
import hashlib
import logging
import math
import shutil
import sys
import time
import uuid
import zipfile
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path, PurePosixPath
from typing import Final

import httpx

from uniover_agent.adapters.apk_tools import locate_aapt2
from uniover_agent.adapters.process import run_hidden
from uniover_agent.adapters.ssl_contexts import ssl_contexts
from uniover_agent.adapters.tv_adb import locate_adb

_log = logging.getLogger(__name__)

PLATFORM_TOOLS_URL: Final = (
    "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
)
# Versão do `aapt2` (Maven da Google) e o SHA-256 do `.jar` dela: trocar a
# versão exige trocar o hash junto (o publicado ao lado do arquivo tem de bater com este).
AAPT2_VERSION: Final = "8.7.3-12006047"
AAPT2_SHA256: Final = "9406af8e4742da01e4ce65773e23bda40ed5f599917b38cacc261c9ba0952331"
AAPT2_URL: Final = (
    "https://dl.google.com/android/maven2/com/android/tools/build/aapt2/"
    f"{AAPT2_VERSION}/aapt2-{AAPT2_VERSION}-windows.jar"
)
# A organização (campo O do certificado) que assina o `adb.exe` da Google.
GOOGLE_SIGNER: Final = "Google LLC"

# O `platform-tools` tem ~8 MB compactado e ~17 MB aberto; o `.jar` do `aapt2`, ~2 MB e ~5 MB. Os
# tetos só existem para um arquivo trocado no caminho não encher o disco.
MAX_PLATFORM_TOOLS_BYTES: Final = 64 * 1024 * 1024
MAX_AAPT2_JAR_BYTES: Final = 32 * 1024 * 1024
MAX_EXTRACTED_BYTES: Final = 256 * 1024 * 1024
MAX_ZIP_ENTRIES: Final = 512
_MAX_CHECKSUM_BYTES: Final = 4096
_CHUNK_BYTES: Final = 64 * 1024
_S_IFMT: Final = 0o170000
_S_IFLNK: Final = 0o120000

TOOLS_DIR_NAME: Final = "tools"
PLATFORM_TOOLS_DIR: Final = "platform-tools"
AAPT2_DIR: Final = "aapt2"
ADB_EXE: Final = "adb.exe"
AAPT2_EXE: Final = "aapt2.exe"

# Quanto esperar entre uma procura no disco e outra enquanto a ferramenta falta.
DEFAULT_RECHECK_SECONDS: Final = 60.0
# A primeira tentativa de download espera a partida assentar (conexão com a API, TV).
DEFAULT_FIRST_DELAY_SECONDS: Final = 20.0
# Espera depois de cada falha seguida: 5 min, 15 min, 1 h e, daí em diante, 6 h.
DEFAULT_BACKOFF_SECONDS: Final = (300.0, 900.0, 3600.0, 6 * 3600.0)
_DOWNLOAD_TIMEOUT_SECONDS: Final = 120.0
_NETWORK_CHECK_TIMEOUT_SECONDS: Final = 20.0

READY: Final = "ready"
MISSING: Final = "missing"
PROVISIONING: Final = "provisioning"
FAILED: Final = "failed"
DISABLED: Final = "disabled"

ClientFactory = Callable[[], Awaitable[httpx.AsyncClient]]
SignatureCheck = Callable[[Path], None]


class ProvisionError(Exception):
    """A ferramenta não foi preparada; `reason` é uma linha em pt-BR, sem caminho nem endereço."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def tools_root(base: Path) -> Path:
    """`<instalação>/tools`: onde o instalador e o agente guardam o que baixam da Google."""
    return base / TOOLS_DIR_NAME


def provisioned_adb(base: Path) -> Path:
    return tools_root(base) / PLATFORM_TOOLS_DIR / ADB_EXE


def provisioned_aapt2(base: Path) -> Path:
    return tools_root(base) / AAPT2_DIR / AAPT2_EXE


# --- ZIP conferido --------------------------------------------------------------------------------


def _safe_member(name: str) -> PurePosixPath:
    """O nome da entrada como caminho relativo seguro; recusa o que escaparia do destino."""
    if not name or "\\" in name or ":" in name or name.startswith("/") or "\x00" in name:
        raise ProvisionError("o pacote baixado tem um nome de arquivo inválido")
    path = PurePosixPath(name.rstrip("/"))
    if not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ProvisionError("o pacote baixado tem um nome de arquivo inválido")
    return path


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    # Modo Unix nos 16 bits altos: 0o120000 é link simbólico.
    return (info.external_attr >> 16) & _S_IFMT == _S_IFLNK


def extract_zip(
    archive: Path,
    destination: Path,
    *,
    keep: Callable[[PurePosixPath], bool] = lambda _member: True,
    max_total: int = MAX_EXTRACTED_BYTES,
    max_entries: int = MAX_ZIP_ENTRIES,
) -> list[PurePosixPath]:
    """Extrai `archive` em `destination` (que já existe), conferindo cada entrada antes.

    Recusa o pacote inteiro (`ProvisionError`) se qualquer nome escapar da pasta, se houver link
    simbólico, entradas demais ou bytes demais (o declarado e o lido). Devolve o que extraiu.
    """
    root = destination.resolve()
    extracted: list[PurePosixPath] = []
    try:
        with zipfile.ZipFile(archive) as bundle:
            infos = bundle.infolist()
            if len(infos) > max_entries:
                raise ProvisionError("o pacote baixado tem arquivos demais")
            members = [(info, _safe_member(info.filename)) for info in infos]
            if any(_is_symlink(info) for info, _ in members):
                raise ProvisionError("o pacote baixado traz um link simbólico")
            if sum(info.file_size for info, _ in members) > max_total:
                raise ProvisionError("o pacote baixado é grande demais")
            total = 0
            for info, member in members:
                if not keep(member):
                    continue
                target = root.joinpath(*member.parts)
                if not target.resolve().is_relative_to(root):
                    raise ProvisionError("o pacote baixado tem um nome de arquivo inválido")
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                written = 0
                with bundle.open(info) as source, target.open("xb") as sink:
                    while chunk := source.read(_CHUNK_BYTES):
                        written += len(chunk)
                        total += len(chunk)
                        if written > info.file_size or total > max_total:
                            raise ProvisionError("o pacote baixado é grande demais")
                        sink.write(chunk)
                extracted.append(member)
    except zipfile.BadZipFile, zipfile.LargeZipFile:
        raise ProvisionError("o arquivo baixado não é um pacote ZIP válido") from None
    return extracted


# --- assinatura do Windows (Authenticode) ---------------------------------------------------------


def verify_google_signature(path: Path) -> None:
    """Exige assinatura Authenticode válida, com certificado da Google LLC, no executável.

    Usa o `WinVerifyTrust` do próprio Windows (sem PowerShell: o módulo de segurança dele pode não
    carregar em alguns perfis). Sem checagem de revogação online: nada sai para a rede aqui.
    """
    if sys.platform != "win32":
        raise ProvisionError("a assinatura do adb só pode ser conferida no Windows")
    organization = _authenticode_organization(path)
    if organization != GOOGLE_SIGNER:
        raise ProvisionError("o adb baixado não está assinado pela Google")


def _authenticode_organization(path: Path) -> str | None:  # noqa: PLR0915  # pragma: no cover
    """A organização de quem assinou `path`, se a assinatura é válida; `ProvisionError` se não é."""
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    class Guid(ctypes.Structure):
        _fields_ = (
            ("data1", wintypes.DWORD),
            ("data2", wintypes.WORD),
            ("data3", wintypes.WORD),
            ("data4", ctypes.c_ubyte * 8),
        )

    class FileInfo(ctypes.Structure):
        _fields_ = (
            ("cb_struct", wintypes.DWORD),
            ("file_path", wintypes.LPCWSTR),
            ("file", wintypes.HANDLE),
            ("known_subject", ctypes.c_void_p),
        )

    class TrustData(ctypes.Structure):
        _fields_ = (
            ("cb_struct", wintypes.DWORD),
            ("policy_callback_data", ctypes.c_void_p),
            ("sip_client_data", ctypes.c_void_p),
            ("ui_choice", wintypes.DWORD),
            ("revocation_checks", wintypes.DWORD),
            ("union_choice", wintypes.DWORD),
            ("file", ctypes.POINTER(FileInfo)),
            ("state_action", wintypes.DWORD),
            ("state_data", wintypes.HANDLE),
            ("url_reference", wintypes.LPCWSTR),
            ("prov_flags", wintypes.DWORD),
            ("ui_context", wintypes.DWORD),
            ("signature_settings", ctypes.c_void_p),
        )

    class ProviderCert(ctypes.Structure):
        _fields_ = (("cb_struct", wintypes.DWORD), ("cert", ctypes.c_void_p))

    wintrust = ctypes.WinDLL("wintrust")
    crypt32 = ctypes.WinDLL("crypt32")
    verify = wintrust.WinVerifyTrust
    verify.argtypes = (wintypes.HWND, ctypes.POINTER(Guid), ctypes.c_void_p)
    verify.restype = ctypes.c_long
    provider_data = wintrust.WTHelperProvDataFromStateData
    provider_data.argtypes = (wintypes.HANDLE,)
    provider_data.restype = ctypes.c_void_p
    signer_of = wintrust.WTHelperGetProvSignerFromChain
    signer_of.argtypes = (ctypes.c_void_p, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    signer_of.restype = ctypes.c_void_p
    cert_of = wintrust.WTHelperGetProvCertFromChain
    cert_of.argtypes = (ctypes.c_void_p, wintypes.DWORD)
    cert_of.restype = ctypes.POINTER(ProviderCert)
    name_of = crypt32.CertGetNameStringW
    name_of.argtypes = (
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.LPWSTR,
        wintypes.DWORD,
    )
    name_of.restype = wintypes.DWORD

    # WINTRUST_ACTION_GENERIC_VERIFY_V2 = {00AAC56B-CD44-11D0-8CC2-00C04FC295EE}
    tail = (ctypes.c_ubyte * 8)(*bytes.fromhex("8CC200C04FC295EE"))
    action = Guid(0x00AAC56B, 0xCD44, 0x11D0, tail)
    file_info = FileInfo(ctypes.sizeof(FileInfo), str(path), None, None)
    data = TrustData()
    data.cb_struct = ctypes.sizeof(TrustData)
    data.ui_choice = 2  # WTD_UI_NONE
    data.revocation_checks = 0  # WTD_REVOKE_NONE
    data.union_choice = 1  # WTD_CHOICE_FILE
    data.file = ctypes.pointer(file_info)
    data.state_action = 1  # WTD_STATEACTION_VERIFY
    data.prov_flags = 0x10  # WTD_REVOCATION_CHECK_NONE
    status = verify(None, ctypes.byref(action), ctypes.byref(data))
    try:
        if status != 0:
            raise ProvisionError(f"assinatura do adb inválida (código 0x{status & 0xFFFFFFFF:08X})")
        provider = provider_data(data.state_data)
        signer = signer_of(provider, 0, False, 0) if provider else None
        cert = cert_of(signer, 0) if signer else None
        if not cert:
            raise ProvisionError("não foi possível ler quem assinou o adb")
        buffer = ctypes.create_unicode_buffer(256)
        oid = ctypes.c_char_p(b"2.5.4.10")  # organizationName
        name_of(cert.contents.cert, 3, 0, oid, buffer, 256)  # CERT_NAME_ATTR_TYPE
        return buffer.value or None
    finally:
        data.state_action = 2  # WTD_STATEACTION_CLOSE
        verify(None, ctypes.byref(action), ctypes.byref(data))


# --- rede tarifada ou sem internet ---------------------------------------------------------------

# WinRT pelo PowerShell 5.1: o perfil da conexão com a internet e o custo dela (sem administrador).
_NETWORK_COST_SCRIPT: Final = (
    "$p=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,"
    "ContentType=WindowsRuntime]::GetInternetConnectionProfile();"
    "if($null -eq $p){'offline'}else{$c=$p.GetConnectionCost();"
    "[string]$c.NetworkCostType+'|'+[string]$c.Roaming+'|'+[string]$c.OverDataLimit}"
)


def network_block_reason() -> str | None:
    """Por que não baixar agora (sem internet, rede tarifada); `None` se pode ou se não se sabe."""
    if sys.platform != "win32":
        return None
    encoded = base64.b64encode(_NETWORK_COST_SCRIPT.encode("utf-16-le")).decode("ascii")
    try:
        done = run_hidden(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            capture_output=True,
            text=True,
            timeout=_NETWORK_CHECK_TIMEOUT_SECONDS,
        )
    except OSError, ValueError:
        return None
    except Exception as exc:  # TimeoutExpired e afins: na dúvida, tenta baixar
        _log.debug("custo da rede não lido (%s)", type(exc).__name__)
        return None
    return parse_network_cost(done.stdout if done.returncode == 0 else "")


def parse_network_cost(output: str) -> str | None:
    """Lê a saída do script de custo da rede (última linha)."""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return None
    last = lines[-1]
    if last == "offline":
        return "sem conexão com a internet"
    parts = last.split("|")
    if len(parts) != 3:  # noqa: PLR2004 - tipo|roaming|acima do limite
        return None
    cost, roaming, over_limit = parts
    if cost in {"Fixed", "Variable"} or roaming == "True" or over_limit == "True":
        return "rede tarifada (o download fica para uma rede sem limite)"
    return None


async def network_block_reason_async() -> str | None:
    return await asyncio.to_thread(network_block_reason)


# --- download e instalação ------------------------------------------------------------------------


async def _default_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        follow_redirects=True,
        timeout=_DOWNLOAD_TIMEOUT_SECONDS,
        verify=await ssl_contexts.verified(),
    )


def _remove_staging(path: Path, root: Path) -> None:
    """Apaga só uma pasta temporária nossa, irmã das ferramentas: nunca algo fora de `tools`."""
    if path.parent.resolve() != root.resolve() or not path.name.startswith(".uniover-"):
        raise ValueError("pasta temporária fora do lugar esperado")
    shutil.rmtree(path, ignore_errors=True)


def _move_into_place(staged: Path, final: Path, executable: str, root: Path) -> Path:
    """Troca atômica: a pasta pronta vira `final`; uma `final` sem executável sai de lado antes."""
    if (final / executable).is_file():
        # Outro (o instalador, a pessoa) já pôs a ferramenta ali enquanto baixávamos: vale a dele.
        return final / executable
    aside: Path | None = None
    if final.exists():
        aside = root / f".uniover-{final.name}-{uuid.uuid4().hex}.old"
        final.rename(aside)
    try:
        staged.rename(final)
    except OSError:
        if aside is not None and not final.exists():
            aside.rename(final)
        raise
    if aside is not None:
        _remove_staging(aside, root)
    return final / executable


class AndroidToolsInstaller:
    """Baixa, confere e instala o `platform-tools` e o `aapt2` em `<instalação>/tools`."""

    def __init__(  # noqa: PLR0913 - dependências injetadas para os testes
        self,
        base: Path,
        *,
        client_factory: ClientFactory | None = None,
        verify_signature: SignatureCheck = verify_google_signature,
        platform_tools_url: str = PLATFORM_TOOLS_URL,
        aapt2_url: str = AAPT2_URL,
        aapt2_sha256: str = AAPT2_SHA256,
    ) -> None:
        for url in (platform_tools_url, aapt2_url):
            if not url.startswith("https://"):
                raise ValueError("as ferramentas do Android só são baixadas por HTTPS")
        self._root = tools_root(base)
        self._client_factory = client_factory or _default_client
        self._verify_signature = verify_signature
        self._platform_tools_url = platform_tools_url
        self._aapt2_url = aapt2_url
        self._aapt2_sha256 = aapt2_sha256.lower()

    async def install_adb(self) -> Path:
        """Baixa o `platform-tools`, exige a assinatura da Google no `adb.exe` e o instala."""
        staging = await asyncio.to_thread(self._new_staging, PLATFORM_TOOLS_DIR)
        try:
            archive = staging / "download.zip"
            async with await self._client_factory() as client:
                await _download(client, self._platform_tools_url, archive, MAX_PLATFORM_TOOLS_BYTES)
            return await asyncio.to_thread(self._finish_adb, staging, archive)
        finally:
            await asyncio.to_thread(_remove_staging, staging, self._root)

    def _finish_adb(self, staging: Path, archive: Path) -> Path:
        unpacked = staging / "unpacked"
        unpacked.mkdir()
        extract_zip(
            archive,
            unpacked,
            keep=lambda member: member.parts[0] == PLATFORM_TOOLS_DIR,
        )
        folder = unpacked / PLATFORM_TOOLS_DIR
        adb = folder / ADB_EXE
        if not adb.is_file():
            raise ProvisionError("o pacote baixado não traz o adb")
        self._verify_signature(adb)
        return _move_into_place(folder, self._root / PLATFORM_TOOLS_DIR, ADB_EXE, self._root)

    async def install_aapt2(self) -> Path:
        """Baixa o `.jar` fixado do `aapt2`, confere os hashes e instala só o `aapt2.exe`."""
        staging = await asyncio.to_thread(self._new_staging, AAPT2_DIR)
        try:
            archive = staging / "download.jar"
            async with await self._client_factory() as client:
                published = await _published_sha256(client, f"{self._aapt2_url}.sha256")
                if published != self._aapt2_sha256:
                    raise ProvisionError("o hash publicado do aapt2 não é o esperado")
                digest = await _download(client, self._aapt2_url, archive, MAX_AAPT2_JAR_BYTES)
            if digest != self._aapt2_sha256:
                raise ProvisionError("o aapt2 baixado não confere com o hash publicado")
            return await asyncio.to_thread(self._finish_aapt2, staging, archive)
        finally:
            await asyncio.to_thread(_remove_staging, staging, self._root)

    def _finish_aapt2(self, staging: Path, archive: Path) -> Path:
        folder = staging / AAPT2_DIR
        folder.mkdir()
        extract_zip(archive, folder, keep=lambda member: member.name in {AAPT2_EXE, "NOTICE"})
        if not (folder / AAPT2_EXE).is_file():
            raise ProvisionError("o pacote baixado não traz o aapt2")
        return _move_into_place(folder, self._root / AAPT2_DIR, AAPT2_EXE, self._root)

    def _new_staging(self, label: str) -> Path:
        self._root.mkdir(parents=True, exist_ok=True)
        staging = self._root / f".uniover-{label}-{uuid.uuid4().hex}.partial"
        staging.mkdir()
        return staging


async def _download(client: httpx.AsyncClient, url: str, target: Path, max_bytes: int) -> str:
    """Grava a resposta em `target` (no máximo `max_bytes`) e devolve o SHA-256 em hexadecimal."""
    digest = hashlib.sha256()
    total = 0
    async with client.stream("GET", url) as response:
        response.raise_for_status()
        declared = response.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > max_bytes:
            raise ProvisionError("o arquivo publicado é grande demais")
        with target.open("xb") as handle:
            async for chunk in response.aiter_bytes(_CHUNK_BYTES):
                total += len(chunk)
                if total > max_bytes:
                    raise ProvisionError("o arquivo publicado é grande demais")
                digest.update(chunk)
                handle.write(chunk)
    if total == 0:
        raise ProvisionError("o arquivo baixado veio vazio")
    return digest.hexdigest()


async def _published_sha256(client: httpx.AsyncClient, url: str) -> str:
    response = await client.get(url)
    response.raise_for_status()
    text = response.text[:_MAX_CHECKSUM_BYTES].strip()
    token = text.split()[0].lower() if text else ""
    if len(token) != 64 or any(char not in "0123456789abcdef" for char in token):  # noqa: PLR2004
        raise ProvisionError("o hash publicado do aapt2 é ilegível")
    return token


# --- vigia: procurar a ferramenta de novo e prepará-la em segundo plano -----------------------


class ToolWatch:
    """O caminho atual de uma ferramenta, procurado de novo enquanto falta, e o preparo dela.

    `path()` é barato e pode ser chamado a cada comando: com a ferramenta achada só confere se o
    arquivo continua lá; sem ela, procura no disco no máximo uma vez a cada `recheck_seconds`.
    `run()` é a tarefa de fundo: espera a partida assentar, tenta baixar (se pode) e, entre uma
    tentativa e outra, segue procurando no disco. Termina quando a ferramenta aparece.
    """

    def __init__(  # noqa: PLR0913 - dependências injetadas para os testes
        self,
        label: str,
        find: Callable[[], Path | None],
        install: Callable[[], Awaitable[Path]] | None = None,
        *,
        network_block: Callable[[], Awaitable[str | None]] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        recheck_seconds: float = DEFAULT_RECHECK_SECONDS,
        first_delay_seconds: float = DEFAULT_FIRST_DELAY_SECONDS,
        backoff_seconds: Sequence[float] = DEFAULT_BACKOFF_SECONDS,
    ) -> None:
        if recheck_seconds <= 0 or not backoff_seconds or min(backoff_seconds) <= 0:
            raise ValueError("os intervalos do vigia precisam ser positivos")
        self.label = label
        self._find = find
        self._install = install
        self._network_block = network_block
        self._monotonic = monotonic
        self._sleep = sleep
        self._recheck_seconds = recheck_seconds
        self._first_delay_seconds = first_delay_seconds
        self._backoff = tuple(backoff_seconds)
        self._path: Path | None = None
        self._checked_at = -math.inf
        self._listeners: list[Callable[[Path], None]] = []
        self.state = MISSING if install is not None else DISABLED
        self.reason: str | None = None
        self.attempts = 0
        self._next_attempt_at: float | None = None

    @property
    def can_provision(self) -> bool:
        return self._install is not None

    def on_found(self, listener: Callable[[Path], None]) -> None:
        """Chamado (no laço) quando a ferramenta que faltava aparece."""
        self._listeners.append(listener)

    def path(self) -> Path | None:
        """O caminho atual, ou `None` se a ferramenta ainda falta (procura de vez em quando)."""
        current = self._path
        if current is not None:
            if current.is_file():
                return current
            _log.warning("o %s sumiu do disco; procurando de novo", self.label)
            self._path = None
            self.state = MISSING if self._install is not None else DISABLED
        if self._monotonic() - self._checked_at < self._recheck_seconds:
            return None
        return self.refresh()

    def refresh(self) -> Path | None:
        """Procura agora, sem esperar o intervalo."""
        self._checked_at = self._monotonic()
        try:
            found = self._find()
        except OSError as exc:
            _log.info("procura do %s falhou (%s)", self.label, type(exc).__name__)
            found = None
        if found is not None and self._path is None:
            self._became_available(found)
        return found

    def _became_available(self, path: Path) -> None:
        was_missing = self.state != READY
        self._path = path
        self.state = READY
        self.reason = None
        self._next_attempt_at = None
        if not was_missing:
            return
        for listener in list(self._listeners):
            try:
                listener(path)
            except Exception:
                _log.exception("falha ao avisar que o %s ficou disponível", self.label)

    def status_line(self) -> str:
        """Uma linha para o registro e o diagnóstico: pronto, baixando, falhou (e por quê)."""
        if self.state == READY:
            return f"{self.label} pronto"
        if self.state == PROVISIONING:
            return f"{self.label} sendo baixado da Google em segundo plano"
        if self.state == DISABLED:
            return f"{self.label} não encontrado (download automático desligado)"
        if self.state == FAILED and self.reason:
            wait = ""
            if self._next_attempt_at is not None:
                minutes = max(1, round((self._next_attempt_at - self._monotonic()) / 60))
                wait = f"; nova tentativa em {minutes} min"
            return f"{self.label} não preparado: {self.reason}{wait}"
        return f"{self.label} não encontrado; o download da Google começa em segundo plano"

    async def run(self) -> None:
        """Tarefa de fundo: até a ferramenta aparecer, procura no disco e tenta baixar."""
        if self.refresh() is not None:
            return
        if self._install is not None and self._first_delay_seconds > 0:
            await self._sleep(self._first_delay_seconds)
        while self.refresh() is None:
            due = self._next_attempt_at is None or self._monotonic() >= self._next_attempt_at
            if self._install is not None and due:
                path = await self._attempt(self._install)
                if path is not None:
                    self._became_available(path)
                    return
            # Sempre espera antes de olhar de novo: nunca um laço apertado.
            await self._sleep(self._recheck_seconds)

    async def _attempt(self, install: Callable[[], Awaitable[Path]]) -> Path | None:
        reason: str | None = None
        if self._network_block is not None:
            try:
                reason = await self._network_block()
            except Exception as exc:
                _log.debug("estado da rede não lido (%s)", type(exc).__name__)
        if reason is None:
            self.state = PROVISIONING
            _log.info("%s não encontrado: baixando da Google em segundo plano", self.label)
            try:
                path = await install()
            except ProvisionError as exc:
                reason = exc.reason
            except httpx.HTTPError as exc:
                reason = f"falha no download ({type(exc).__name__})"
            except OSError as exc:
                reason = f"falha ao gravar no disco ({type(exc).__name__})"
            except Exception as exc:
                _log.exception("erro inesperado ao preparar o %s", self.label)
                reason = f"erro inesperado ({type(exc).__name__})"
            else:
                _log.info("%s baixado, conferido e instalado", self.label)
                self.attempts = 0
                return path
        delay = self._backoff[min(self.attempts, len(self._backoff) - 1)]
        self.attempts += 1
        self.state = FAILED
        self.reason = reason
        self._next_attempt_at = self._monotonic() + delay
        _log.warning("%s", self.status_line())
        return None


# --- montagem ------------------------------------------------------------------------------------


def _download_allowed(configured: str | None, enabled: bool) -> bool:
    # Caminho configurado é escolha explícita: não se baixa nada por cima dela. Os pacotes são do
    # Windows; fora dele não há o que baixar.
    return enabled and not configured and sys.platform == "win32"


def adb_watch(
    configured: str | None,
    base: Path,
    *,
    download: bool = True,
    installer: AndroidToolsInstaller | None = None,
    network_block: Callable[[], Awaitable[str | None]] | None = network_block_reason_async,
) -> ToolWatch:
    """Vigia do `adb`: a procura de sempre (`locate_adb`) e, se pode, o download da Google."""
    install = None
    if _download_allowed(configured, download):
        install = (installer or AndroidToolsInstaller(base)).install_adb
    return ToolWatch(
        "adb", lambda: locate_adb(configured, base), install, network_block=network_block
    )


def find_aapt2(configured: str | None, base: Path) -> Path | None:
    """O `aapt2` configurado; senão o do Android SDK; senão o que o agente baixou."""
    found = locate_aapt2(configured)
    if found is not None or configured:
        return found
    own = provisioned_aapt2(base)
    return own if own.is_file() else None


def aapt2_watch(
    configured: str | None,
    base: Path,
    *,
    download: bool = True,
    installer: AndroidToolsInstaller | None = None,
    network_block: Callable[[], Awaitable[str | None]] | None = network_block_reason_async,
) -> ToolWatch:
    """Vigia do `aapt2`: a procura de sempre mais a pasta do agente e, se pode, o download."""
    install = None
    if _download_allowed(configured, download):
        install = (installer or AndroidToolsInstaller(base)).install_aapt2
    return ToolWatch(
        "aapt2", lambda: find_aapt2(configured, base), install, network_block=network_block
    )
