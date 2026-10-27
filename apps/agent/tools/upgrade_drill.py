"""Ensaio automático de atualização do agente instalado no Windows.

Monta uma instalação ISOLADA numa pasta temporária (nada de `%LOCALAPPDATA%\\UniOver` real), com
a versão BASE (padrão: `origin/main`), sobe o supervisor de verdade (lançador, `run-agent.ps1`,
agente e ícone da bandeja, todos ocultos) e força a atualização, pelo mesmo caminho do dia a dia
(arquivo `update-now` + `uniover-agent self-update`), para a CANDIDATA (a árvore local, empacotada
como o zip do GitHub). Depois repete com "candidata+1" (prova que a versão nova se atualiza de
novo) e confere o caminho de falha (uma candidata que não importa é recusada).

Como o código publicado na `main` ainda não tem o modo ensaio do `self_update.py`, a troca da base
para a candidata usa `upgrade_drill_support/sitecustomize.py` (desvia só as duas URLs do GitHub);
as trocas seguintes usam o modo ensaio da própria candidata (`UNIOVER_UPDATE_DRILL`).

Nunca toca na instalação real, na tarefa agendada nem no Cofre de Credenciais: o ambiente do
processo filho é todo redirecionado e o ensaio confere, no fim, que o real ficou igual. Só mata os
processos que ele mesmo criou (pela pasta temporária). Saída: APROVADO/REPROVADO com o motivo.
"""

import argparse
import contextlib
import ctypes
import hashlib
import http.server
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
import zipfile
from collections.abc import Callable, Iterable
from ctypes import wintypes
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
AGENT_REL = "apps/agent"
ICON_REL = "apps/web/public/icons/icon-192.png"
MAIN_REL = "apps/agent/src/uniover_agent/main.py"
INSTALLER_REL = "apps/agent/tools/install-windows.ps1"
# Abaixo disso ficam o Ocioso (0) e o System (4): nunca sao processos do ensaio.
LAST_SYSTEM_PID = 4
SUPPORT = Path(__file__).resolve().parent / "upgrade_drill_support"
SHA = re.compile(r"[0-9a-f]{40}")
AGENT_ID = "drill-agent"
SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
POWERSHELL = SYSTEM32 / "WindowsPowerShell" / "v1.0" / "powershell.exe"
GIT = shutil.which("git") or "git"
CMDKEY = str(SYSTEM32 / "cmdkey.exe")
TASKKILL = str(SYSTEM32 / "taskkill.exe")
# Supervisor, agente (uv e python) e icone: o minimo de processos que a base precisa ter de pe.
MIN_PROCESSES = 3
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_CONSOLE = 0x00000010
CREATE_NEW_PROCESS_GROUP = 0x00000200
# O agente e o ícone ficam de pé (sem cair) por este tempo depois de cada troca.
STABLE_SECONDS = 45
CONSOLE_HOSTS = frozenset({"conhost.exe", "openconsole.exe", "windowsterminal.exe"})


def say(text: str = "") -> None:
    print(text, flush=True)


# --- pacote da candidata (o que o zip do GitHub traria) --------------------------------------


def git(*args: str) -> bytes:
    done = subprocess.run(  # noqa: S603 - git com argumentos fixos
        [GIT, "-C", str(REPO), *args], check=True, capture_output=True
    )
    return done.stdout


def working_tree_files() -> dict[str, bytes]:
    """`apps/agent` e o ícone, como estão na árvore local (inclui o que ainda não foi commitado)."""
    listing = git("ls-files", "-z", "-c", "-o", "--exclude-standard", "--", AGENT_REL, ICON_REL)
    files: dict[str, bytes] = {}
    for name in listing.decode("utf-8").split("\0"):
        path = REPO / name
        if name and path.is_file():
            files[name] = path.read_bytes()
    return files


def ref_files(ref: str) -> dict[str, bytes]:
    """`apps/agent` e o ícone como estão num commit."""
    data = git("archive", "--format=tar", ref, "--", AGENT_REL, ICON_REL)
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as bundle:
        for member in bundle.getmembers():
            handle = bundle.extractfile(member) if member.isfile() else None
            if handle is not None:
                files[member.name] = handle.read()
    return files


def fake_sha(files: dict[str, bytes], tag: str) -> str:
    """Identificador de 40 hexadecimais do conteúdo (a candidata não tem commit publicado)."""
    digest = hashlib.sha1(tag.encode(), usedforsecurity=False)
    for name in sorted(files):
        digest.update(name.encode())
        digest.update(hashlib.sha1(files[name], usedforsecurity=False).digest())
    return digest.hexdigest()


def zip_bytes(files: dict[str, bytes], sha: str) -> bytes:
    """Zip no formato do GitHub: tudo dentro de `uniover-<sha>/`."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in sorted(files):
            bundle.writestr(f"uniover-{sha}/{name}", files[name])
    return buffer.getvalue()


_TRAY_START = b"return Start-Process -FilePath $Uv -ArgumentList $arguments -PassThru -WindowStyle"
DEFECTS = {
    # Prova de que o ensaio pega defeito: o icone da bandeja passa a abrir janela.
    "window": (
        f"{AGENT_REL}/tools/run-agent.ps1",
        _TRAY_START + b" Hidden",
        _TRAY_START + b" Normal",
    ),
    # O agente da versao nova cai logo ao iniciar (comando que nao existe).
    "crash": (
        f"{AGENT_REL}/tools/run-agent.ps1",
        b"uniover-agent run'",
        b"uniover-agent inexistente'",
    ),
}


def with_defect(files: dict[str, bytes], name: str) -> dict[str, bytes]:
    """A candidata com um defeito conhecido plantado (`--inject-defect`), para provar o ensaio."""
    path, old, new = DEFECTS[name]
    if old not in files[path]:
        raise SystemExit(f"o defeito '{name}' nao se aplica mais a {path}")
    return {**files, path: files[path].replace(old, new)}


def next_variant(files: dict[str, bytes]) -> dict[str, bytes]:
    """A candidata seguinte: a mesma árvore mais um arquivo, só para ter outro conteúdo."""
    return {**files, f"{AGENT_REL}/DRILL-NEXT.txt": b"candidata seguinte do ensaio\n"}


def broken_variant(files: dict[str, bytes]) -> dict[str, bytes]:
    """Candidata que não importa: `main.py` levanta erro ao ser carregado."""
    return {**files, MAIN_REL: files[MAIN_REL] + b"\nraise RuntimeError('quebrada de proposito')\n"}


# --- servidor local que faz as vezes do GitHub -----------------------------------------------


class Feed:
    """O que o "GitHub" do ensaio responde agora: o commit atual e os zips conhecidos."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sha = ""
        self.archives: dict[str, bytes] = {}
        self.hits: list[str] = []

    def offer(self, sha: str, archive: bytes | None) -> None:
        with self.lock:
            self.sha = sha
            if archive is not None:
                self.archives[sha] = archive

    def downloads(self, sha: str) -> int:
        with self.lock:
            return self.hits.count(f"/archive/{sha}.zip")


def start_feed(feed: Feed) -> tuple[http.server.ThreadingHTTPServer, int]:
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            with feed.lock:
                feed.hits.append(self.path)
                match = re.fullmatch(r"/archive/([0-9a-f]{40})\.zip", self.path)
                if self.path == "/commit":
                    body, kind = json.dumps({"sha": feed.sha}).encode(), "application/json"
                elif match and match.group(1) in feed.archives:
                    body, kind = feed.archives[match.group(1)], "application/zip"
                else:
                    body, kind = b"", ""
            if not kind:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return None

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, int(server.server_address[1])


# --- processos --------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Proc:
    pid: int
    ppid: int
    name: str
    exe: str
    cmd: str
    created: int
    session: int

    @property
    def key(self) -> tuple[int, int]:
        """PID e instante de criação: o PID sozinho pode ser reaproveitado pelo Windows."""
        return (self.pid, self.created)


_ROLE = re.compile(r"uniover-agent(?:\.exe)?\"?\s+(run|tray)\s*$", re.IGNORECASE)


def role(proc: Proc) -> str:
    """Papel do processo no agente instalado: lançador, supervisor, agente, ícone ou outro."""
    cmd = proc.cmd
    if proc.name.lower() == "powershell.exe":
        if "launcher.ps1" in cmd:
            return "launcher"
        if "run-agent.ps1" in cmd:
            return "supervisor"
    if "self-update" in cmd:
        return "update"
    found = _ROLE.search(cmd)
    if found:
        return "agent" if found.group(1).lower() == "run" else "tray"
    return "other"


_LIST_PROCESSES = (
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
    "$ErrorActionPreference='SilentlyContinue';"
    "@(Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{"
    "p=[int]$_.ProcessId;pp=[int]$_.ParentProcessId;n=$_.Name;e=$_.ExecutablePath;"
    "c=$_.CommandLine;t=[int64]$_.CreationDate.ToFileTimeUtc();s=[int]$_.SessionId}})"
    "|ConvertTo-Json -Compress"
)


def snapshot() -> list[Proc]:
    """Todos os processos do Windows (nome, caminho, linha de comando, criação)."""
    done = subprocess.run(  # noqa: S603 - executável do Windows e texto fixo
        [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-Command", _LIST_PROCESSES],
        check=True,
        capture_output=True,
        creationflags=CREATE_NO_WINDOW,
        timeout=60,
    )
    rows = json.loads(done.stdout.decode("utf-8-sig") or "[]")
    if isinstance(rows, dict):
        rows = [rows]
    return [
        Proc(r["p"], r["pp"], r["n"] or "", r["e"] or "", r["c"] or "", r["t"] or 0, r["s"] or 0)
        for r in rows
    ]


def ancestors_of(pid: int, procs: Iterable[Proc]) -> set[int]:
    by_pid = {p.pid: p for p in procs}
    chain = {pid}
    while pid in by_pid and by_pid[pid].ppid not in chain and by_pid[pid].ppid in by_pid:
        pid = by_pid[pid].ppid
        chain.add(pid)
    return chain


@dataclass(slots=True)
class Tracker:
    """Quais processos pertencem ao ensaio: os que citam a pasta temporária e os descendentes
    dos que já eram do ensaio. Nunca inclui o próprio ensaio nem a instalação real."""

    root: str
    real_base: str
    started: int = 0
    known: dict[tuple[int, int], Proc] = field(default_factory=dict)
    protected: set[int] = field(default_factory=set)

    def is_candidate(self, proc: Proc) -> bool:
        """Processo que pode pertencer ao ensaio: criado depois dele e fora da sessao do sistema."""
        return proc.pid > LAST_SYSTEM_PID and proc.session != 0 and proc.created >= self.started

    def current(self, procs: list[Proc]) -> list[Proc]:
        root, real = self.root.lower(), self.real_base.lower()
        member: dict[int, Proc] = {}
        for proc in procs:
            text = f"{proc.exe}\n{proc.cmd}".lower()
            if proc.pid in self.protected or real in text or not self.is_candidate(proc):
                continue
            if root in text:
                member[proc.pid] = proc
        grew = True
        while grew:
            grew = False
            for proc in procs:
                if (
                    proc.ppid in member
                    and proc.pid not in member
                    and proc.pid not in self.protected
                    and self.is_candidate(proc)
                    and proc.created >= member[proc.ppid].created
                ):
                    member[proc.pid] = proc
                    grew = True
        for proc in member.values():
            self.known[proc.key] = proc
        return sorted(member.values(), key=lambda p: p.pid)


# --- janelas visíveis -------------------------------------------------------------------------

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


class _Entry(ctypes.Structure):
    _fields_ = (
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    )


_kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
_kernel32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
_kernel32.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(_Entry))
_kernel32.Process32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(_Entry))
_kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
_user32.IsWindowVisible.argtypes = (wintypes.HWND,)
_user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
_user32.GetClassNameW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
_user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
_user32.EnumWindows.argtypes = (_ENUM, wintypes.LPARAM)


def process_table() -> dict[int, tuple[int, str]]:
    """PID -> (PID do pai, nome do executável), rápido (sem CIM), para o vigia de janelas."""
    handle = _kernel32.CreateToolhelp32Snapshot(0x2, 0)
    table: dict[int, tuple[int, str]] = {}
    entry = _Entry()
    entry.dwSize = ctypes.sizeof(_Entry)
    ok = _kernel32.Process32FirstW(handle, ctypes.byref(entry))
    while ok:
        table[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile.lower())
        ok = _kernel32.Process32NextW(handle, ctypes.byref(entry))
    _kernel32.CloseHandle(handle)
    return table


def visible_windows() -> list[tuple[int, int, str, str]]:
    """Janelas de topo visíveis: (identificador, PID dono, classe, título)."""
    found: list[tuple[int, int, str, str]] = []

    def visit(hwnd: int, _param: int) -> bool:
        if _user32.IsWindowVisible(hwnd):
            pid = wintypes.DWORD()
            _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            klass, title = ctypes.create_unicode_buffer(256), ctypes.create_unicode_buffer(256)
            _user32.GetClassNameW(hwnd, klass, 256)
            _user32.GetWindowTextW(hwnd, title, 256)
            found.append((int(hwnd), pid.value, klass.value, title.value))
        return True

    _user32.EnumWindows(_ENUM(visit), 0)
    return found


class WindowWatch:
    """Amostra, de 0,4 em 0,4 s, as janelas visíveis dos processos do ensaio durante todo o ensaio
    (pega também uma janela que só pisca). Janelas novas de console de fora da árvore (o Windows
    Terminal pode abrir o console do processo fora dela) viram só aviso."""

    def __init__(self) -> None:
        self.seeds: set[int] = set()
        self.offenders: dict[tuple[int, str, str], str] = {}
        self.suspects: dict[tuple[int, str, str], str] = {}
        self._baseline = {w[0] for w in visible_windows()}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.is_set():
            with contextlib.suppress(Exception):
                self.sample()
            self._stop.wait(0.4)

    def sample(self) -> None:
        table = process_table()
        tree = set(self.seeds)
        grew = True
        while grew:
            grew = False
            for pid, (ppid, _) in table.items():
                if ppid in tree and pid not in tree:
                    tree.add(pid)
                    grew = True
        for hwnd, pid, klass, title in visible_windows():
            name = table.get(pid, (0, "?"))[1]
            key = (pid, klass, title)
            if pid in tree:
                self.offenders.setdefault(key, name)
            elif hwnd not in self._baseline and name in CONSOLE_HOSTS:
                self.suspects.setdefault(key, name)


# --- ambiente isolado do filho ----------------------------------------------------------------


def build_env(  # noqa: PLR0913 - cada argumento é um caminho do ambiente isolado
    base_env: dict[str, str],
    *,
    root: Path,
    port: int,
    uv_dir: str,
    uv_cache: str,
    uv_python: str,
    support: Path,
) -> dict[str, str]:
    """Ambiente do processo filho: tudo que o agente usa aponta para a pasta temporária.

    Só o filho é afetado (o processo do ensaio e o Windows ficam como estavam)."""
    env = dict(base_env)
    for name in list(env):
        if name.upper().startswith("UNIOVER_") or name.upper() in {
            "VIRTUAL_ENV",
            "UV_PROJECT_ENVIRONMENT",
            "PYTHONHOME",
            "PYTHONPATH",
            "PYTHON_KEYRING_BACKEND",
        }:
            del env[name]
    virtual = base_env.get("VIRTUAL_ENV")
    path_items = [
        item
        for item in env.get("PATH", "").split(os.pathsep)
        if item and not (virtual and Path(item).parent == Path(virtual))
    ]
    env["PATH"] = os.pathsep.join([uv_dir, *path_items])
    env.update(
        LOCALAPPDATA=str(root / "L"),
        APPDATA=str(root / "A"),
        USERPROFILE=str(root / "H"),
        TEMP=str(root / "T"),
        TMP=str(root / "T"),
        UV_CACHE_DIR=uv_cache,
        UV_PYTHON_INSTALL_DIR=uv_python,
        PYTHONPATH=str(support),
        PYTHON_KEYRING_BACKEND="drill_keyring.DrillKeyring",
        UNIOVER_UPDATE_DRILL="1",
        UNIOVER_UPDATE_SOURCE_URL=f"http://127.0.0.1:{port}",
        NO_PROXY="127.0.0.1,localhost",
        no_proxy="127.0.0.1,localhost",
        PYTHONUTF8="1",
    )
    return env


INSTALL_BASE = r"""
param([string]$Installer, [string]$Ref, [string]$Uv, [string]$ApiUrl)
# Instala a versao base com as proprias funcoes do instalador dela (as que baixam e extraem o
# codigo, gravam a configuracao e o lancador). Nao usa Stop-Agent nem Register-AgentTask.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
$base = Join-Path $env:LOCALAPPDATA 'UniOver'
$source = Join-Path $base 'app'
$config = Join-Path $base 'config\agent.toml'
$launcher = Join-Path $base 'launcher.ps1'
$fallback = Join-Path $base 'run-agent.fallback.ps1'
$tokens = $null
$errors = $null
$parser = [System.Management.Automation.Language.Parser]
$ast = $parser::ParseFile($Installer, [ref]$tokens, [ref]$errors)
$names = @('Write-Config', 'Set-ConfigValues', 'Move-Folder', 'Get-MoveFailureReason')
$names += @('Get-AgentSource', 'Write-AgentLauncher')
foreach ($name in $names) {
    $wanted = $name
    $kind = [System.Management.Automation.Language.FunctionDefinitionAst]
    $found = $ast.Find({ param($node) ($node -is $kind) -and ($node.Name -eq $wanted) }, $true)
    # Instaladores anteriores a este diagnostico nao tem essa funcao; as demais sao indispensaveis.
    if (-not $found -and $wanted -eq 'Get-MoveFailureReason') { continue }
    if (-not $found) { throw "funcao $wanted nao encontrada no instalador da base" }
    Invoke-Expression $found.Extent.Text
}
foreach ($folder in @('runtime', 'config', 'logs', 'web')) {
    New-Item -ItemType Directory -Path (Join-Path $base $folder) -Force | Out-Null
}
Get-AgentSource $source
Set-ConfigValues $config @{ api_url = $ApiUrl; allow_insecure = $true; agent_id = 'drill-agent' }
$env:UNIOVER_CONFIG_FILE = $config
$env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'runtime\venv'
& $Uv sync --project $source --quiet
if ($LASTEXITCODE -ne 0) { throw 'uv sync da base falhou' }
Write-AgentLauncher
Write-Host 'base instalada'
"""


# --- o ensaio ---------------------------------------------------------------------------------


@dataclass(slots=True)
class Verdict:
    failures: list[str] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        mark = "[ OK ]" if ok else "[FALHA]"
        say(f"  {mark} {name}" + (f" - {detail}" if detail and not ok else ""))
        if not ok:
            self.failures.append(f"{name}" + (f" ({detail})" if detail else ""))
        return ok


def wait_until(check: Callable[[], bool], timeout: float, interval: float = 2.0) -> bool:
    end = time.monotonic() + timeout
    while True:
        if check():
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(interval)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def sync_failure_wrapper() -> str:
    """`uv.cmd` do ensaio: falha so os tres primeiros syncs do supervisor e depois chama o uv real.

    So conta o `uv sync --project <app>` do supervisor: a atualizacao automatica tambem sincroniza
    (a candidata, em `app.new`) pelo mesmo `uv` e nao pode gastar as tres falhas.
    """
    return "\r\n".join(
        (
            "@echo off",
            'if /I not "%~1"=="sync" goto real_uv',
            'if /I not "%~3"=="%UNIOVER_DRILL_APP%" goto real_uv',
            "set count=0",
            'if exist "%UNIOVER_DRILL_SYNC_COUNT%" set /p count=<"%UNIOVER_DRILL_SYNC_COUNT%"',
            "set /a count=%count%+1",
            '>"%UNIOVER_DRILL_SYNC_COUNT%" echo %count%',
            "if %count% LEQ 3 exit /b 1",
            ":real_uv",
            '"%UNIOVER_DRILL_REAL_UV%" %*',
            "",
        )
    )


class Drill:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.verdict = Verdict()
        self.feed = Feed()
        self.started = time.time()
        long_temp = Path(os.path.realpath(tempfile.gettempdir()))
        # Curto (como numa instalação real, perto do limite de 260 caracteres) e sem curingas.
        self.root = long_temp / f"ud{uuid.uuid4().hex[:8]}"
        self.base = self.root / "L" / "UniOver"
        real_local = os.environ.get("LOCALAPPDATA", "")
        self.real_base = Path(os.path.realpath(real_local)) / "UniOver" if real_local else Path("?")
        self.tracker = Tracker(
            str(self.root),
            str(self.real_base),
            started=int(self.started * 10_000_000) + 116_444_736_000_000_000,
        )
        self.watch: WindowWatch | None = None
        self.server: http.server.ThreadingHTTPServer | None = None
        self.env: dict[str, str] = {}
        self.launcher: subprocess.Popen[bytes] | None = None
        self.uv = ""

    # ---- utilidades

    @property
    def app(self) -> Path:
        return self.base / "app"

    def version(self) -> str:
        return read_text(self.app / ".version")

    def blocked(self) -> list[str]:
        """Versões que o supervisor recusou depois de quedas repetidas (volta para a anterior)."""
        text = read_text(self.base / "runtime" / ".blocked-versions")
        return [line[:12] for line in text.splitlines() if line.strip()]

    def log_text(self) -> str:
        return read_text(self.base / "logs" / "agent.log")

    def update_state(self) -> dict[str, object]:
        try:
            loaded = json.loads((self.base / "runtime" / "update-status.json").read_text("utf-8"))
        except OSError, json.JSONDecodeError:
            return {}
        return loaded if isinstance(loaded, dict) else {}

    def tree(self) -> list[Proc]:
        procs = snapshot()
        if not self.tracker.protected:
            self.tracker.protected = ancestors_of(os.getpid(), procs)
        current = self.tracker.current(procs)
        if self.watch is not None:
            self.watch.seeds = {p.pid for p in current}
        return current

    def alive(self, key: tuple[int, int], procs: list[Proc]) -> bool:
        return any(p.key == key for p in procs)

    def roles(self, procs: list[Proc], *names: str) -> list[Proc]:
        return [p for p in procs if role(p) in names]

    def run_child(self, args: list[str], timeout: int = 600) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(  # noqa: S603 - ferramentas fixas, ambiente isolado
            args,
            env=self.env,
            cwd=self.root,
            capture_output=True,
            timeout=timeout,
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )

    def tool(self, command: str, *args: str) -> str:
        done = subprocess.run(  # noqa: S603
            [command, *args], capture_output=True, text=True, check=False, timeout=60
        )
        return done.stdout.strip()

    # ---- impressão digital da instalação real (tem de ficar igual)

    def real_fingerprint(self) -> dict[str, object]:
        def digest(relative: str) -> str:
            try:
                return hashlib.sha256((self.real_base / relative).read_bytes()).hexdigest()[:16]
            except OSError:
                return "-"

        top = sorted(p.name for p in self.real_base.iterdir()) if self.real_base.is_dir() else []
        task = subprocess.run(  # noqa: S603 - só leitura
            [
                str(POWERSHELL),
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Export-ScheduledTask -TaskName 'UniOver agente' | Out-String",
            ],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
            check=False,
            timeout=60,
        )
        vault = subprocess.run(  # noqa: S603 - só leitura
            [CMDKEY, "/list"],
            capture_output=True,
            text=True,
            creationflags=CREATE_NO_WINDOW,
            check=False,
            timeout=60,
        )
        real = {
            p.pid for p in snapshot() if str(self.real_base).lower() in f"{p.exe}\n{p.cmd}".lower()
        }
        return {
            "pastas e arquivos de topo": top,
            "arquivos do supervisor e versao": {
                name: digest(name)
                for name in (
                    "launcher.ps1",
                    "run-agent.ps1",
                    "run-agent.fallback.ps1",
                    "app/.version",
                )
            },
            "tarefa agendada": hashlib.sha256(task.stdout).hexdigest()[:16],
            "Cofre de Credenciais": sorted(
                line.strip() for line in vault.stdout.splitlines() if "uniover" in line.lower()
            ),
            "processos reais": real,
        }

    # ---- fases

    def prepare(self, base_sha: str) -> None:
        for name in ("L", "A", "H", "T", "support"):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        support = self.root / "support"
        for item in SUPPORT.glob("*.py"):
            shutil.copyfile(item, support / item.name)
        installer = support / "base-install-windows.ps1"
        installer.write_bytes(git("show", f"{base_sha}:{INSTALLER_REL}"))
        (support / "install-base.ps1").write_text(INSTALL_BASE, encoding="ascii")
        uv = shutil.which("uv")
        if uv is None:
            raise SystemExit("uv nao encontrado no PATH")
        self.uv = uv
        cache = self.root / "uvcache" if self.args.cold_cache else None
        self.server, port = start_feed(self.feed)
        self.env = build_env(
            dict(os.environ),
            root=self.root,
            port=port,
            uv_dir=str(Path(uv).parent),
            uv_cache=str(cache or self.tool(uv, "cache", "dir")),
            uv_python=self.tool(uv, "python", "dir"),
            support=support,
        )
        # Trava de seguranca: nada do ambiente filho pode apontar para a instalacao real.
        for name in ("LOCALAPPDATA", "APPDATA", "USERPROFILE", "TEMP", "TMP"):
            value = Path(os.path.realpath(self.env[name]))
            if not value.is_relative_to(self.root):
                raise SystemExit(f"{name} do ensaio fora da pasta temporaria: {value}")
        if self.base.is_relative_to(self.real_base) or self.real_base.is_relative_to(self.base):
            raise SystemExit("a pasta do ensaio se confunde com a instalacao real")
        self.watch = WindowWatch()
        self.watch.start()

    def install_base(self, base_sha: str) -> bool:
        support = self.root / "support"
        say(f"Instalando a base {base_sha[:12]} (instalador da base, em {self.root})...")
        done = self.run_child(
            [
                str(POWERSHELL),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(support / "install-base.ps1"),
                "-Installer",
                str(support / "base-install-windows.ps1"),
                "-Ref",
                base_sha,
                "-Uv",
                self.env["PATH"].split(os.pathsep)[0] + "\\uv.exe",
                "-ApiUrl",
                self.env["UNIOVER_UPDATE_SOURCE_URL"],
            ]
        )
        output = (done.stdout + done.stderr).decode("utf-8", errors="replace").strip()
        ok = done.returncode == 0 and self.version() == base_sha
        return self.verdict.check(
            "base instalada isoladamente", ok, output[-400:] or f"codigo {done.returncode}"
        )

    def preflight(self, base_sha: str) -> bool:
        """Confere o isolamento ANTES de subir qualquer coisa com o ambiente do ensaio."""
        runtime_env = {"UV_PROJECT_ENVIRONMENT": str(self.base / "runtime" / "venv")}
        saved = self.env
        self.env = {**saved, **runtime_env}
        try:
            uv = saved["PATH"].split(os.pathsep)[0] + "\\uv.exe"
            keyring = self.run_child(
                [
                    uv,
                    "run",
                    "--project",
                    str(self.app),
                    "python",
                    "-c",
                    "import keyring;print(type(keyring.get_keyring()).__module__)",
                ]
            )
            where = keyring.stdout.decode("utf-8", errors="replace").strip().splitlines()
            ok_keyring = bool(where) and where[-1] == "drill_keyring"
            self.verdict.check(
                "cofre falso em uso (o Cofre de Credenciais real nao e aberto)",
                ok_keyring,
                (where[-1] if where else keyring.stderr.decode(errors="replace")[-300:]),
            )
            self.feed.offer(base_sha, None)
            shim = self.run_child(
                [
                    uv,
                    "run",
                    "--project",
                    str(self.app),
                    "python",
                    "-c",
                    "from uniover_agent.adapters.self_update import latest_commit;"
                    "print(latest_commit())",
                ]
            )
            seen = shim.stdout.decode("utf-8", errors="replace").strip().splitlines()
            ok_shim = bool(seen) and seen[-1] == base_sha and "/commit" in self.feed.hits
            self.verdict.check(
                "a base consulta o servidor local, nao o GitHub",
                ok_shim,
                (seen[-1] if seen else shim.stderr.decode(errors="replace")[-300:]),
            )
            return ok_keyring and ok_shim
        finally:
            self.env = saved

    def start_supervisor(self) -> None:
        info = subprocess.STARTUPINFO()
        info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        info.wShowWindow = subprocess.SW_HIDE
        # Como a tarefa agendada: console proprio, oculto, `-WindowStyle Hidden`. Nada de
        # CREATE_NO_WINDOW aqui: os filhos herdariam um console sem janela e um defeito que
        # mostrasse janela passaria sem ser visto.
        self.launcher = subprocess.Popen(  # noqa: S603
            [
                str(POWERSHELL),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                str(self.base / "launcher.ps1"),
            ],
            env=self.env,
            cwd=self.root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            startupinfo=info,
            creationflags=CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP,
        )

    def stable_pair(self, seconds: float, since: float = 0.0) -> tuple[bool, str]:
        """Agente e ícone de pé, e os mesmos processos durante `seconds` (sem queda e sem
        recomeço do supervisor)."""
        first: set[tuple[int, int]] | None = None
        end = time.monotonic() + seconds
        while True:
            procs = self.tree()
            pair = self.roles(procs, "agent", "tray")
            kinds = {role(p) for p in pair}
            if kinds != {"agent", "tray"}:
                return False, "agente ou icone fora do ar"
            keys = {p.key for p in pair}
            if since and any(p.created / 1e7 - 11644473600 < since - 2 for p in pair):
                return False, "ha processo de antes da troca"
            if first is None:
                first = keys
            elif keys != first:
                return False, "agente ou icone reiniciou durante a espera"
            if time.monotonic() >= end:
                return True, ""
            time.sleep(3)

    def wait_ready(self) -> bool:
        say("Subindo o supervisor (lancador, run-agent.ps1, agente e icone)...")
        self.start_supervisor()
        up = wait_until(
            lambda: {role(p) for p in self.tree()} >= {"supervisor", "agent", "tray"}, 300
        )
        if not self.verdict.check("base no ar (supervisor, agente e icone)", up):
            return False
        ok, why = self.stable_pair(25)
        starts = self.log_text().count(f"agente {AGENT_ID} iniciando")
        self.verdict.check("base estavel por 25 s", ok, why)
        self.verdict.check(
            "agente da base registrou 'iniciando'", starts >= 1, "sem a linha no log"
        )
        return ok and starts >= 1

    def offer(
        self, label: str, files: dict[str, bytes], sha: str, *, expect_swap: bool, source: str
    ) -> bool:
        say(f"\n== {label} ({source}) ==")
        phase_start = time.monotonic()
        self.feed.offer(sha, zip_bytes(files, sha))
        before = self.tree()
        before_keys = {p.key for p in before}
        launcher = self.roles(before, "launcher")
        supervisor = self.roles(before, "supervisor")
        old_version = self.version()
        trial_before = read_text(self.base / "runtime" / "update-trial.txt")
        log_before = self.log_text()
        starts_before = log_before.count(f"agente {AGENT_ID} iniciando")
        deferred_before = log_before.count("auto-atualização adiada")
        (self.base / "runtime" / "update-now").touch()
        timeout = self.args.timeout
        ok = True
        if expect_swap:
            swapped = wait_until(lambda: self.version() == sha, timeout)
            ok &= self.verdict.check(
                f"a troca acontece (app\\.version = {sha[:12]})",
                swapped,
                f"ficou {self.version()[:12]}",
            )
            if not swapped:
                return False
            swap_time = (self.app / ".version").stat().st_mtime
            ok &= self.after_swap(
                before_keys, launcher, supervisor, old_version, sha, swap_time, starts_before
            )
        else:
            asked = wait_until(lambda: self.feed.downloads(sha) > 0, timeout)
            ok &= self.verdict.check("a candidata quebrada foi baixada e testada", asked)
            refused = wait_until(
                lambda: self.log_text().count("auto-atualização adiada") > deferred_before, timeout
            )
            reason = [
                line for line in self.log_text().splitlines() if "auto-atualização adiada" in line
            ]
            ok &= self.verdict.check(
                "a candidata quebrada e recusada na verificacao",
                refused and "verificação rápida" in (reason[-1] if reason else ""),
                reason[-1][-200:] if reason else "sem aviso no log",
            )
            time.sleep(20)
            ok &= self.after_refusal(before_keys, old_version, trial_before)
        say(f"  ({time.monotonic() - phase_start:.0f} s)")
        return ok

    def stop_everything(self) -> bool:
        """Derruba o lancador (e com ele supervisor, agente e icone), como um reinicio do PC."""
        if self.launcher is not None:
            self.kill(self.launcher.pid)
        return wait_until(
            lambda: not self.roles(self.tree(), "launcher", "supervisor", "agent", "tray"), 30, 0.5
        )

    def recover_interrupted_swap(self, sha: str) -> bool:
        """Deixa o estado entre as duas renomeacoes e espera o lancador conserta-lo.

        O lancador que recupera e o que o proprio agente instalado copiou para a raiz (e a unica
        via pela qual a recuperacao chega a quem ja esta instalado); depois da queda, como depois
        de um reinicio do PC, quem sobe e um lancador novo lido do disco.
        """
        say("\n== E. queda entre as renomeacoes da troca ==")
        old = read_text(self.base / "app.previous" / ".version")
        delivered = (self.base / "launcher.ps1").read_bytes() == (
            self.app / "tools" / "launcher.ps1"
        ).read_bytes()
        stopped = self.stop_everything()
        candidate = self.base / "app.new"
        if candidate.exists() or not stopped:
            return self.verdict.check(
                "o ensaio parou tudo e nao ha candidata sobrando antes da queda simulada",
                False,
                f"parado={stopped} candidata={candidate.exists()}",
            )
        shutil.move(str(self.app), str(candidate))
        self.start_supervisor()
        restored = wait_until(
            lambda: (
                self.version() == sha
                and not candidate.exists()
                and bool(self.roles(self.tree(), "supervisor"))
            ),
            self.args.timeout,
        )
        results = [
            self.verdict.check(
                "o lancador instalado e o da versao instalada (a atualizacao o entregou)", delivered
            ),
            self.verdict.check(
                "o lancador recupera app.new quando app some entre as renomeacoes",
                restored,
                f"ficou {self.version()[:12]}",
            ),
            self.verdict.check(
                "a versao anterior continua guardada depois da recuperacao",
                old == read_text(self.base / "app.previous" / ".version"),
            ),
            self.verdict.check(
                "a recuperacao deixa a versao promovida em teste",
                read_text(self.base / "runtime" / "update-trial.txt") == f"{sha}|0",
            ),
            self.verdict.check(
                # O estado (update-status.json) nao entra: o supervisor que sobe em seguida faz a
                # propria checagem e o reescreve; o teste de unidade do lancador o cobre.
                "a recuperacao registra o ocorrido no log do agente",
                "promovi app.new" in self.log_text(),
            ),
        ]
        return all(results)

    def rollback_after_sync_failure(self, bad: str) -> bool:
        """Faz tres syncs falharem na versao em teste e confere a volta automatica."""
        say("\n== F. sync falha depois da promocao ==")
        previous = read_text(self.base / "app.previous" / ".version")
        if not previous:
            return self.verdict.check(
                "ha uma versao anterior para voltar depois da falha de sync", False
            )
        trial = self.base / "runtime" / "update-trial.txt"
        trial.write_text(f"{bad}|0", encoding="ascii")
        marker = self.base / "runtime" / "venv" / "marca-antes-do-sync.txt"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("ambiente que funcionava", encoding="utf-8")
        fake_bin = self.root / "sync-failure-bin"
        fake_bin.mkdir(exist_ok=True)
        (fake_bin / "uv.cmd").write_text(sync_failure_wrapper(), encoding="ascii", newline="")
        counter = self.root / "sync-count.txt"
        environment = {
            **self.env,
            "PATH": os.pathsep.join((str(fake_bin), self.env["PATH"])),
            "UNIOVER_DRILL_REAL_UV": self.uv,
            "UNIOVER_DRILL_SYNC_COUNT": str(counter),
            "UNIOVER_DRILL_APP": str(self.app),
        }
        stopped = self.stop_everything()
        self.env = environment
        self.start_supervisor()
        rolled_back = wait_until(
            lambda: (
                self.version() == previous
                and bad[:12] in self.blocked()
                and self.update_state().get("rolledBack") is True
            ),
            self.args.timeout,
        )
        # O estado guarda a volta (rolledBack, blockedSha) mesmo depois de o supervisor da versao
        # anterior reescrever `outcome` e `reason` na propria checagem; o texto do motivo e o
        # `outcome` ficam para o teste de unidade do supervisor.
        current = self.update_state()
        results = [
            self.verdict.check("o supervisor anterior parou antes do sync com falha", stopped),
            self.verdict.check(
                "tres falhas de sync na versao em teste voltam para a anterior", rolled_back
            ),
            self.verdict.check(
                "o ambiente que funcionava nao foi apagado durante as tres falhas",
                marker.is_file()
                and marker.read_text(encoding="utf-8") == "ambiente que funcionava",
            ),
            self.verdict.check(
                "a versao recusada foi bloqueada e saiu de teste",
                not trial.exists()
                and (self.base / "runtime" / f"app.rejected-{bad[:12]}").is_dir(),
            ),
            self.verdict.check(
                "a volta por sync fica registrada no estado, com a versao bloqueada",
                current.get("rolledBack") is True and current.get("blockedSha") == bad,
                str(current),
            ),
        ]
        return all(results)

    def leftovers(self) -> list[str]:
        names = sorted(p.name for p in self.base.iterdir())
        return [
            n
            for n in names
            if n in {"app.new", "app.new.venv", "app.old"} or n.startswith("uniover-update-")
        ]

    def after_refusal(
        self, before_keys: set[tuple[int, int]], old_version: str, trial_before: str
    ) -> bool:
        procs = self.tree()
        keys = {p.key for p in self.roles(procs, "supervisor", "agent", "tray")}
        before = {k for k in before_keys if any(p.key == k for p in procs)}
        results = [
            self.verdict.check(
                "a versao em uso continua a mesma", self.version() == old_version, self.version()
            ),
            self.verdict.check(
                "supervisor, agente e icone seguem os mesmos processos",
                {k for k in keys} <= before_keys and len(keys) >= MIN_PROCESSES,
                f"{len(keys)} processos, {len(before)} de antes",
            ),
            self.verdict.check(
                "sem restos da tentativa", not self.leftovers(), str(self.leftovers())
            ),
            self.verdict.check(
                "a versao recusada nao foi bloqueada e o estado de teste nao mudou",
                not (self.base / "runtime" / ".blocked-versions").exists()
                and read_text(self.base / "runtime" / "update-trial.txt") == trial_before,
            ),
        ]
        return all(results)

    def after_swap(  # noqa: PLR0913, PLR0917 - cada argumento é um fato medido antes da troca
        self,
        before_keys: set[tuple[int, int]],
        launcher: list[Proc],
        supervisor: list[Proc],
        old_version: str,
        sha: str,
        swap_time: float,
        starts_before: int,
    ) -> bool:
        results: list[bool] = []

        def restarted() -> bool:
            procs = self.tree()
            fresh = self.roles(procs, "supervisor", "agent", "tray")
            return {role(p) for p in fresh} == {"supervisor", "agent", "tray"} and not any(
                p.key in before_keys for p in fresh
            )

        back = wait_until(restarted, self.args.timeout)
        seen = sorted(role(p) for p in self.tree() if role(p) != "other")
        results.append(
            self.verdict.check(
                "o supervisor reinicia e sobe agente e icone novos (novo run-agent.ps1)",
                back,
                f"em {self.args.timeout} s so havia: {seen}; "
                f"versao em uso {self.version()[:12]}; "
                f"bloqueadas (voltou para a anterior): {self.blocked()}",
            )
        )
        if not back:
            return False
        stable, why = self.stable_pair(STABLE_SECONDS, since=swap_time)
        results.append(
            self.verdict.check(
                f"agente e icone sobem da versao nova e ficam {STABLE_SECONDS} s de pe", stable, why
            )
        )
        procs = self.tree()
        launcher_now = self.roles(procs, "launcher")
        results.append(
            self.verdict.check(
                "o mesmo lancador continua (nao precisou de ninguem)",
                [p.key for p in launcher_now] == [p.key for p in launcher],
            )
        )
        launcher_pids = {p.pid for p in launcher_now}
        survivors = [
            f"{p.name}({p.pid},{role(p)})"
            for p in procs
            if p.key in before_keys
            and role(p) != "launcher"
            # O console oculto do lancador (que nao reinicia) fica; o dos outros some com eles.
            and not (p.name.lower() in CONSOLE_HOSTS and p.ppid in launcher_pids)
        ]
        results.append(
            self.verdict.check(
                "nenhum processo sobrou da versao velha", not survivors, str(survivors)
            )
        )
        shape = {role(p) for p in procs if p.name.lower() != "conhost.exe"}
        results.append(
            self.verdict.check(
                "so ha lancador, supervisor, agente e icone",
                shape <= {"launcher", "supervisor", "agent", "tray", "other"}
                and not self.roles(procs, "update"),
                str(sorted(shape)),
            )
        )
        starts = self.log_text().count(f"agente {AGENT_ID} iniciando")
        results.append(
            self.verdict.check(
                "o agente novo registrou 'iniciando' depois da troca", starts > starts_before
            )
        )
        results.append(
            self.verdict.check(
                "a versao velha ficou em app.previous",
                read_text(self.base / "app.previous" / ".version") == old_version,
            )
        )
        results.append(
            self.verdict.check(
                "em teste, sem queda e sem bloqueio",
                read_text(self.base / "runtime" / "update-trial.txt") == f"{sha}|0"
                and not (self.base / "runtime" / ".blocked-versions").exists(),
                read_text(self.base / "runtime" / "update-trial.txt"),
            )
        )
        results.append(
            self.verdict.check(
                "sem restos da atualizacao", not self.leftovers(), str(self.leftovers())
            )
        )
        return all(results)

    def windows_check(self) -> None:
        if self.watch is None:
            return
        seen = [f"{n} pid {k[0]} '{k[2]}' ({k[1]})" for k, n in self.watch.offenders.items()]
        self.verdict.check(
            "nenhuma janela visivel em nenhum processo do ensaio", not seen, str(seen)
        )
        for key, name in self.watch.suspects.items():
            say(f"  [AVISO] janela de console nova fora da arvore: {name} pid {key[0]} ({key[1]})")

    def cleanup(self) -> None:
        """Encerra só os processos do ensaio (os que citam a pasta temporária e seus filhos)."""
        if self.watch is not None:
            self.watch.stop()
        try:
            procs = self.tree()
        except Exception:
            procs = []
        victims = [p for p in procs if p.pid not in self.tracker.protected]
        say(f"\nLimpeza: {len(victims)} processo(s) do ensaio.")
        for proc in victims:
            say(f"  encerrando {proc.name} pid {proc.pid} ({role(proc)})")
        if self.launcher is not None and self.launcher.poll() is None:
            self.kill(self.launcher.pid)
        for proc in victims:
            self.kill(proc.pid)
        end = time.monotonic() + 30
        while time.monotonic() < end:
            left = [p for p in self.tree() if p.pid not in self.tracker.protected]
            if not left:
                break
            for proc in left:
                self.kill(proc.pid)
            time.sleep(1)
        if self.server is not None:
            self.server.shutdown()
        if not self.args.keep_files:
            for _ in range(20):
                shutil.rmtree(self.root, ignore_errors=True)
                if not self.root.exists():
                    break
                time.sleep(1)
        say(
            f"Pasta temporaria removida: {not self.root.exists()}"
            if not self.args.keep_files
            else f"Pasta temporaria mantida em {self.root}"
        )

    def kill(self, pid: int) -> None:
        if pid in self.tracker.protected or pid == os.getpid():
            return
        subprocess.run(  # noqa: S603 - só o PID que o ensaio criou
            [TASKKILL, "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )

    def keep_evidence(self) -> None:
        folder = Path(tempfile.gettempdir()) / f"upgrade-drill-{time.strftime('%Y%m%d-%H%M%S')}"
        folder.mkdir(parents=True, exist_ok=True)
        for name in ("logs/agent.log", "runtime/update-trial.txt", "runtime/.blocked-versions"):
            with contextlib.suppress(OSError):
                shutil.copyfile(self.base / name, folder / Path(name).name)
        with contextlib.suppress(Exception):
            table = [f"{p.pid} {p.ppid} {role(p)} {p.name} {p.cmd}" for p in self.tree()]
            (folder / "processos.txt").write_text("\n".join(table), encoding="utf-8")
        say(f"Evidencias guardadas em {folder}")


def resolve_base(requested: str | None) -> str:
    if requested:
        return git("rev-parse", "--verify", f"{requested}^{{commit}}").decode().strip()
    with contextlib.suppress(subprocess.CalledProcessError):
        git("fetch", "origin", "main", "--quiet")
    return git("rev-parse", "--verify", "origin/main^{commit}").decode().strip()


def main(argv: list[str] | None = None) -> int:  # noqa: PLR0915 - roteiro linear do ensaio
    parser = argparse.ArgumentParser(description="Ensaio automatico de atualizacao do agente.")
    parser.add_argument("--base-sha", help="commit da versao base (padrao: origin/main)")
    parser.add_argument("--candidate-ref", help="commit da candidata (padrao: arvore local)")
    parser.add_argument("--timeout", type=int, default=420, help="espera maxima por troca, em s")
    parser.add_argument("--cold-cache", action="store_true", help="cache do uv novo (mais lento)")
    parser.add_argument("--keep-files", action="store_true", help="nao apaga a pasta temporaria")
    parser.add_argument(
        "--inject-defect",
        choices=sorted(DEFECTS),
        help="planta um defeito conhecido na candidata (o ensaio tem de REPROVAR)",
    )
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
    if os.name != "nt":
        say("O ensaio so roda no Windows.")
        return 2
    started = time.monotonic()
    base_sha = resolve_base(args.base_sha)
    files = ref_files(args.candidate_ref) if args.candidate_ref else working_tree_files()
    if args.inject_defect:
        files = with_defect(files, args.inject_defect)
    candidate_sha = fake_sha(files, "candidate")
    next_files = next_variant(files)
    next_sha = fake_sha(next_files, "next")
    broken_files = broken_variant(files)
    broken_sha = fake_sha(broken_files, "broken")
    say("Ensaio de atualizacao do agente")
    say(f"  base       : {base_sha[:12]} (origem {args.base_sha or 'origin/main'})")
    say(f"  candidata  : {candidate_sha[:12]} ({args.candidate_ref or 'arvore local'})")
    phases = [
        ("A. candidata quebrada (recusa, a base segue)", broken_files, broken_sha, False, "base"),
        ("B. base -> candidata", files, candidate_sha, True, "base"),
        ("C. candidata -> candidata+1", next_files, next_sha, True, "candidata"),
        (
            "D. candidata+1 recebe candidata quebrada (recusa)",
            broken_variant(next_files),
            fake_sha(broken_variant(next_files), "broken-next"),
            False,
            "candidata",
        ),
    ]
    drill = Drill(args)
    real_before = drill.real_fingerprint()
    fatal = ""
    try:
        drill.prepare(base_sha)
        proceed = drill.install_base(base_sha) and drill.preflight(base_sha) and drill.wait_ready()
        for label, tree, sha, expect_swap, code in phases:
            if not proceed:
                break
            proceed = drill.offer(
                label, tree, sha, expect_swap=expect_swap, source=f"codigo da {code}"
            )
        if proceed:
            proceed = drill.recover_interrupted_swap(next_sha)
        if proceed:
            proceed = drill.rollback_after_sync_failure(next_sha)
        say("")
        drill.windows_check()
    except KeyboardInterrupt:
        fatal = "interrompido pelo usuario"
    except Exception as exc:
        fatal = f"erro no proprio ensaio: {type(exc).__name__}: {exc}"
    if drill.verdict.failures or fatal:
        with contextlib.suppress(Exception):
            drill.keep_evidence()
    drill.cleanup()
    real_after = drill.real_fingerprint()
    changed = [
        name
        for name in real_before
        if name != "processos reais" and real_before[name] != real_after[name]
    ]
    gone = sorted(set(real_before["processos reais"]) - set(real_after["processos reais"]))  # type: ignore[call-overload]
    real_ok = drill.verdict.check(
        "a instalacao real, a tarefa agendada e o Cofre ficaram intactos",
        not changed and not gone,
        f"mudou: {changed}; processos reais que sumiram: {gone} "
        "(pode ser a atualizacao real concorrente; rode de novo)",
    )
    elapsed = time.monotonic() - started
    reasons = [*drill.verdict.failures, *([fatal] if fatal else [])]
    say("")
    if reasons or not real_ok:
        say(f"REPROVADO ({elapsed:.0f} s)")
        for reason in reasons:
            say(f"  - {reason}")
        return 1
    say(f"APROVADO ({elapsed:.0f} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
