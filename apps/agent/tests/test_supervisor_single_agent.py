"""Supervisor `run-agent.ps1`: no reinício pedido, o agente antigo sai antes de o novo subir.

Dois agentes com a mesma identidade se derrubam no servidor. O reinício rápido (ambiente pronto,
sem sync) não passa pelo `Stop-VenvUsers`, então quem garante a saída do antigo é o próprio
reinício: espera o processo acompanhado sair e encerra qualquer `run` desta instalação que tenha
escapado da árvore dele (um neto cujo pai já morreu). O ícone da bandeja fica.

O laço de verdade, com o `uv` falso de `test_supervisor_guardrails`; e o executável do agente de
verdade, num segundo processo, saindo limpo com o código de "já roda".
"""

import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from uniover_agent.adapters.installation import HOME_ENV
from uniover_agent.adapters.single_instance import ALREADY_RUNNING_MESSAGE, EXIT_ALREADY_RUNNING
from uniover_agent.adapters.startup_trace import process_alive

from . import test_supervisor_guardrails as guardrails
from .support import kill_tree
from .test_single_instance_and_connection_trace import start_holder, stop
from .test_supervisor_guardrails import POWERSHELL, RUNNER, SYSTEM32, Pc, heartbeat, wait_for

windows_only = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path)


def pids_with(token: str) -> list[int]:
    """Os processos vivos cuja linha de comando traz `token` (o `cmd` que faz o papel do agente)."""
    script = (
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and "
        f"$_.CommandLine.Contains('{token}') -and $_.Name -eq 'cmd.exe' }} | "
        "ForEach-Object { $_.ProcessId }"
    )
    result = subprocess.run(  # noqa: S603 - Windows PowerShell do sistema, consulta só de leitura
        [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        check=False,
        creationflags=0x08000000,
        timeout=60,
    )
    return [int(line) for line in result.stdout.split() if line.strip().isdigit()]


def start_lookalike(command: str) -> subprocess.Popen[bytes]:
    """Um processo de verdade com a linha de comando dada, que só espera (o teste o encerra)."""
    return subprocess.Popen(  # noqa: S603 - cmd do sistema, só espera
        f'cmd.exe /d /c "ping -n 300 127.0.0.1 > nul & rem {command}"',
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=0x08000000,
    )


def escaping_agent(token: str) -> list[str]:
    """Agente falso: na primeira subida deixa um `run` desta instalação fora da própria árvore.

    O `cmd` intermediário sai logo depois do `start`, e o neto fica sem pai: o `taskkill /T` do
    processo acompanhado não o alcança, como um agente que sobreviveu ao encerramento."""
    escaped = '"%UNIOVER_TEST_AGENTS%.escaped"'
    return [
        f"if exist {escaped} goto stay",
        f"echo x> {escaped}",
        'cmd /d /c start "" /b cmd /d /c '
        f'"ping -n 300 127.0.0.1 > nul & rem uniover-agent run %~3 {token}"',
        ":stay",
        "ping -n 300 127.0.0.1 > nul",
        "exit /b 0",
    ]


@windows_only
def test_a_restart_stops_the_old_agent_before_the_new_one_starts(pc: Pc) -> None:
    token = f"escapou-{uuid.uuid4().hex}"
    pc.uv(escaping_agent(token))
    others: list[subprocess.Popen[bytes]] = []
    try:
        with heartbeat(pc.alive), pc.running(UNIOVER_SUPERVISOR_STOP_WAIT_SECONDS="5"):
            assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
            assert wait_for(lambda: len(pids_with(token)) == 1, 60), pc.supervisor_log()
            assert wait_for(lambda: pc.tray_starts() >= 1, 30), pc.supervisor_log()
            # Depois da primeira subida (o sync dela encerra quem usa o ambiente): o que não é o
            # `run` desta versão fica vivo, mesmo com o nome parecido.
            app = pc.base / "app"
            others.append(start_lookalike(f"uniover-agent tray {app}"))
            others.append(start_lookalike(f"uniover-agent run {pc.base / 'app.previous'}"))

            (pc.runtime / "restart-now").write_text("", encoding="ascii")
            assert wait_for(lambda: pc.starts() >= 2, 90), pc.supervisor_log()
            # O antigo saiu ANTES de o novo subir: nunca há dois ao mesmo tempo.
            assert pids_with(token) == [], pc.supervisor_log()
            log = pc.supervisor_log()
            assert "reinicio pedido com o ambiente pronto" in log
            assert "agente antigo desta instalacao ainda estava vivo" in log
            assert (pc.runtime / "stop-reason.txt").read_text(encoding="ascii") == "restart"
            # O ícone e os parecidos ficaram; o reinício não conta como queda.
            assert all(other.poll() is None for other in others)
            assert pc.tray_starts() == 1
            assert "terminou (codigo" not in log
            assert not any(i["kind"] == "process.exited" for i in pc.diagnostics())
    finally:
        for other in others:
            kill_tree(other)
        for pid in pids_with(token):
            subprocess.run(  # noqa: S603 - taskkill do sistema, só o que o teste abriu
                ["taskkill", "/PID", str(pid), "/T", "/F"],  # noqa: S607
                capture_output=True,
                check=False,
            )


@windows_only
def test_restart_waits_and_retries_while_an_old_agent_resists(
    pc: Pc, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # O encerramento falha só para o PID do dublê. Ele aceita "exit" pela entrada padrão,
    # então o teste decide em qual tentativa ele sai, sem depender da velocidade do PC.
    pid_file = tmp_path / "resistente.pid"
    wrapper = tmp_path / "supervisor.ps1"
    wrapper.write_text(
        "function taskkill.exe {\n"
        "  if ((Test-Path $env:RESISTANT_PID) -and "
        "([int]$args[1] -eq [int](Get-Content $env:RESISTANT_PID))) { return }\n"
        "  & (Join-Path $env:SystemRoot 'System32/taskkill.exe') @args\n"
        "}\n& $env:TEST_RUNNER\n",
        encoding="ascii",
    )
    monkeypatch.setattr(guardrails, "RUNNER", wrapper)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with (
        heartbeat(pc.alive),
        pc.running(
            TEST_RUNNER=str(RUNNER),
            RESISTANT_PID=str(pid_file),
            UNIOVER_SUPERVISOR_STOP_WAIT_SECONDS="1",
        ),
    ):
        assert wait_for(lambda: pc.starts() == 1, 60), pc.supervisor_log()
        with subprocess.Popen(  # noqa: S603 - processo do teste, sai pelo stdin
            [
                str(SYSTEM32 / "cmd.exe"),
                "/d",
                "/q",
                "/k",
                f"rem uniover-agent run {pc.base / 'app'}",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=0x08000000,
        ) as old:
            try:
                pid_file.write_text(str(old.pid), encoding="ascii")
                (pc.runtime / "restart-now").touch()
                assert wait_for(lambda: pc.supervisor_log().count("reinicio adiado") >= 2, 60), (
                    pc.supervisor_log()
                )
                assert old.poll() is None
                assert pc.starts() == 1
            finally:
                old.communicate(b"exit\r\n", timeout=10)
        assert wait_for(lambda: pc.starts() == 2, 60), pc.supervisor_log()
        assert pc.tray_starts() == 1
        assert not any(i["kind"] == "process.exited" for i in pc.diagnostics())


@windows_only
@pytest.mark.parametrize("reason", ["restart", "unresponsive"])
def test_a_cim_outage_stops_only_the_tracked_process_and_delays_relaunch(
    pc: Pc, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, reason: str
) -> None:
    # No reinício pedido, o agente sai por conta própria durante a primeira consulta falha.
    # No travamento, só o handle do supervisor pode pará-lo. O filho fica até o CIM voltar.
    unavailable = tmp_path / "sem-cim"
    restored = tmp_path / "cim-restaurado"
    attempted_kill = tmp_path / "parada-por-pid"
    release = tmp_path / "sair"
    child_pid = tmp_path / "filho.pid"
    child = tmp_path / "filho.py"
    child.write_text(
        "import os, sys, time\nfrom pathlib import Path\n"
        "Path(sys.argv[1]).write_text(str(os.getpid()))\n"
        "while not Path(sys.argv[2]).exists(): time.sleep(0.05)\n",
        encoding="ascii",
    )
    pc.uv(
        [
            f'if exist "{child_pid}" goto stay',
            f'"{sys.executable}" "{child}" "{child_pid}" "{release}"',
            "exit /b 0",
            ":stay",
            "ping -n 300 127.0.0.1 > nul",
        ]
    )
    wrapper = tmp_path / "supervisor.ps1"
    wrapper.write_text(
        r"""
function Get-CimInstance {
    [CmdletBinding()] param([string]$ClassName, [uint32]$OperationTimeoutSec)
    if ((Test-Path $env:CIM_DOWN) -and -not (Test-Path $env:CIM_BACK)) {
        if ($env:EXIT_DURING_QUERY -and -not (Test-Path $env:EXIT_DURING_QUERY)) {
            [IO.File]::WriteAllText($env:EXIT_DURING_QUERY, '')
            if (-not $process.WaitForExit(10000)) { throw 'o agente nao saiu' }
            [IO.File]::WriteAllText($env:EXIT_DURING_QUERY, 'saiu')
        }
        throw 'CIM indisponivel'
    }
    CimCmdlets\Get-CimInstance @PSBoundParameters
}
function taskkill.exe {
    if ((Test-Path $env:CIM_DOWN) -and -not (Test-Path $env:CIM_BACK)) {
        [IO.File]::WriteAllText($env:KILL_ATTEMPT, "$args")
        return
    }
    & (Join-Path $env:SystemRoot 'System32/taskkill.exe') @args
}
& $env:TEST_RUNNER
""",
        encoding="ascii",
    )
    monkeypatch.setattr(guardrails, "RUNNER", wrapper)
    try:
        with pc.running(
            TEST_RUNNER=str(RUNNER),
            CIM_DOWN=str(unavailable),
            CIM_BACK=str(restored),
            KILL_ATTEMPT=str(attempted_kill),
            EXIT_DURING_QUERY=str(release) if reason == "restart" else "",
            UNIOVER_SUPERVISOR_HANG_GRACE_SECONDS="600" if reason == "restart" else "1",
            UNIOVER_SUPERVISOR_STOP_WAIT_SECONDS="1",
        ):
            with heartbeat(pc.alive):
                assert wait_for(lambda: child_pid.exists() and child_pid.stat().st_size > 0, 60)
                match = re.search(r"agente iniciado \(pid (\d+)\)", pc.supervisor_log())
                assert match, pc.supervisor_log()
                tracked = int(match[1])
                child_id = int(child_pid.read_text("ascii"))
                unavailable.touch()
                if reason == "restart":
                    (pc.runtime / "restart-now").touch()
            assert wait_for(lambda: pc.supervisor_log().count("reinicio adiado") >= 2, 60), (
                pc.supervisor_log()
            )
            assert (pc.runtime / "stop-reason.txt").read_text("ascii") == reason
            assert not process_alive(tracked)
            assert process_alive(child_id) == (reason == "unresponsive")
            assert not attempted_kill.exists()
            if reason == "restart":
                assert release.read_text("ascii") == "saiu"
            assert pc.starts() == 1
            restored.touch()
            assert wait_for(lambda: pc.starts() == 2, 60), pc.supervisor_log()
            assert not process_alive(child_id)
    finally:
        release.touch()


def ps_quote(value: object) -> str:
    """O valor como literal de aspas simples do PowerShell (aspas internas dobradas)."""
    return "'" + str(value).replace("'", "''") + "'"


def supervisor_routines(base: Path) -> str:
    """As rotinas de parada e as de leitura do ponteiro do supervisor, sem o laço, para uma
    instalação em `base`."""
    source = RUNNER.read_text(encoding="ascii")
    stopping = source[
        source.index("function Get-ProcessTreeItems") : source.index("function Get-RunDescription")
    ]
    pointer = source[
        source.index("function Read-JsonFile") : source.index("function Update-Layout")
    ]
    return (
        stopping
        + pointer
        + f"""
$base = {ps_quote(base)}
$runtime = Join-Path $base 'runtime'
$script:currentSlot = $null
$script:previousSlot = $null
"""
    )


def run_routines(tmp_path: Path, name: str, body: str) -> subprocess.CompletedProcess[bytes]:
    script = tmp_path / name
    # Com BOM, o Windows PowerShell lê o script como UTF-8 e um caminho acentuado sobrevive.
    script.write_text(supervisor_routines(tmp_path / "UniOver") + body, encoding="utf-8-sig")
    return subprocess.run(  # noqa: S603 - PowerShell do sistema com as funções do repositório
        [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
        capture_output=True,
        check=False,
        timeout=60,
    )


@windows_only
def test_stop_requires_the_original_pid_and_creation_time_even_if_cim_fails(tmp_path: Path) -> None:
    # Exercita as rotinas de parada sem iniciar o supervisor. O PID existe de verdade, mas
    # pertence a outro processo; toda tentativa de taskkill fica registrada no dublê.
    result = run_routines(
        tmp_path,
        "parada.ps1",
        """
$ErrorActionPreference = 'Stop'
function Write-SupLog($Level, $Message) {
    if ($Message -like '*ainda estava vivo*') { $script:falseAlarm = $true }
}
function taskkill.exe { $script:kills++ }
function Get-CimInstance {
    if ($script:unavailable) { throw 'CIM indisponivel' }
    return $script:entry
}
$kills = 0
$stopWaitSeconds = 0
$now = Get-CimStartTime (Get-Process -Id $PID)
$old = $now.AddMinutes(-1)
$roots = @{ $PID = $old }
$entry = [pscustomobject]@{ ProcessId = $PID; ParentProcessId = 0; CreationDate = $now }
if (-not (Stop-ProcessTrees $roots 'teste')) { throw 'o PID ja foi reutilizado' }
if (-not (Stop-AgentLeftovers $roots) -or $falseAlarm) { throw 'acusou vivo pelo historico' }
$entry.CreationDate = $old
if (-not (Stop-ProcessTrees $roots 'teste')) { throw 'o handle pertence a outro processo' }
$parent = [pscustomobject]@{ Id = $PID; StartTime = $old; ExitTime = $now }
$entry = [pscustomobject]@{ ProcessId = $PID + 1; ParentProcessId = $PID; CreationDate = $old }
foreach ($outside in @($old.AddSeconds(-1), $now.AddSeconds(1))) {
    $entry.CreationDate = $outside
    if (@(Get-ProcessTreeItems @{} $parent).Count) { throw 'o filho pertence a outro pai' }
}
$unavailable = $true
if (Stop-ProcessTrees $roots 'teste') { throw 'consulta falha passou por arvore vazia' }
if (Stop-AgentLeftovers @{}) { throw 'consulta falha passou por instalacao vazia' }
if ($kills -ne 0) { throw 'tentou encerrar um PID sem identidade confirmada' }
""",
    )
    assert result.returncode == 0, result.stderr


# Dublês das consultas: o inventário é a lista `$entries` (ou falha a partir da consulta
# `$failFrom`), e a parada da árvore só conta as vezes em que foi pedida.
FAKE_INVENTORY = r"""
$ErrorActionPreference = 'Stop'
$log = New-Object System.Collections.ArrayList
function Write-SupLog($Level, $Message) { $null = $log.Add($Message) }
$queries = 0
$failFrom = 0
$entries = @()
function Get-CimInstance {
    $script:queries++
    if ($script:failFrom -and $script:queries -ge $script:failFrom) { throw 'CIM indisponivel' }
    return $script:entries
}
$stops = 0
function Stop-ProcessTrees($Roots, $What, $ExitedParent) { $script:stops++; return $true }
$created = (Get-Date).AddMinutes(-5)
function New-Run([int]$Id, [string]$Place) {
    return [pscustomobject]@{
        ProcessId = $Id; ParentProcessId = 0; CreationDate = $created
        CommandLine = '"C:\uv\uv.exe" run --project "' + $Place + '" --no-dev uniover-agent run'
    }
}
"""


@windows_only
def test_a_run_still_alive_after_the_tree_stop_delays_the_new_agent(tmp_path: Path) -> None:
    # A árvore parou "com sucesso", mas a conferência seguinte ainda acha um `run` desta
    # instalação (escapou da árvore ou subiu durante a parada): o novo não pode subir.
    app = tmp_path / "UniOver" / "app"
    result = run_routines(
        tmp_path,
        "conferencia.ps1",
        FAKE_INVENTORY
        + f"""
$paths = @({ps_quote(app)})
$entries = @(New-Run 4242 {ps_quote(app)})
$roots = @{{}}
if (Stop-AgentLeftovers $roots $null $paths) {{ throw 'subiu com um agente da instalacao vivo' }}
if ($stops -ne 1 -or $queries -ne 2) {{ throw "paradas $stops, consultas $queries" }}
if (-not $roots.ContainsKey(4242)) {{ throw 'o sobrevivente nao ficou para a proxima tentativa' }}
if (-not ($log -like '*seguiu de pe depois da parada (pid 4242)*')) {{ throw ($log -join ' | ') }}

$log.Clear(); $queries = 0; $failFrom = 2
if (Stop-AgentLeftovers @{{}} $null $paths) {{ throw 'conferencia falha liberou a partida' }}
if (-not ($log -like '*depois da parada: CIM indisponivel*')) {{ throw ($log -join ' | ') }}

$queries = 0; $failFrom = 0; $entries = @()
if (-not (Stop-AgentLeftovers @{{}} $null $paths)) {{ throw 'sem sobra a partida devia seguir' }}
if ($queries -ne 2) {{ throw "consultas $queries" }}
""",
    )
    assert result.returncode == 0, result.stderr


@windows_only
def test_after_a_handover_the_check_covers_the_slot_now_in_use(tmp_path: Path) -> None:
    # A partida acompanhada foi da versão A; a passagem trocou o processo pelo da versão B sem
    # voltar ao laço. A conferência acha o `run` de B (e o que sobrou de A), mas nada de outra
    # instalação nem de um nome que só começa igual.
    base = tmp_path / "UniOver"
    old_sha, new_sha = "a" * 40, "b" * 40
    slot_a, venv_a = base / "app.staging" / old_sha, base / "runtime" / f"venv-{old_sha}"
    slot_b, venv_b = base / "app.staging" / new_sha, base / "runtime" / f"venv-{new_sha}"
    (base / "runtime").mkdir(parents=True)
    pointer = {
        "v": 1,
        "current": {
            "sha": new_sha,
            "app": f"app.staging\\{new_sha}",
            "venv": f"runtime\\venv-{new_sha}",
        },
        "previous": {
            "sha": old_sha,
            "app": f"app.staging\\{old_sha}",
            "venv": f"runtime\\venv-{old_sha}",
        },
    }
    (base / "runtime" / "current.json").write_text(
        json.dumps(pointer, ensure_ascii=False), encoding="utf-8"
    )
    other = tmp_path / "Outra" / "UniOver" / "app.staging" / new_sha
    result = run_routines(
        tmp_path,
        "passagem.ps1",
        FAKE_INVENTORY
        + f"""
$entries = @(
    (New-Run 5001 {ps_quote(slot_b)}),
    (New-Run 5002 {ps_quote(slot_a)}),
    (New-Run 5003 {ps_quote(other)}),
    (New-Run 5004 {ps_quote(f"{slot_b}x")}),
    (New-Run 5005 {ps_quote(f"{venv_b}-old")}),
    (New-Run 5006 {ps_quote(base / "app.staging")})
)
$roots = @{{}}
$null = Stop-AgentLeftovers $roots $null @({ps_quote(slot_a)}, {ps_quote(venv_a)})
$found = @($roots.Keys | Sort-Object)
if (($found -join ',') -ne '5001,5002') {{ throw ('encontrados: ' + ($found -join ',')) }}
$places = @(Get-InstallationAgentPaths @({ps_quote(slot_a)}, {ps_quote(venv_a)}))
foreach ($need in @({ps_quote(slot_b)}, {ps_quote(venv_b)})) {{
    if ($places -notcontains $need) {{ throw ('faltou ' + $need) }}
}}
""",
    )
    assert result.returncode == 0, result.stderr


@windows_only
def test_a_plain_restart_leaves_a_single_agent(pc: Pc) -> None:
    """Sem sobra fora da árvore: o reinício troca um agente por outro, sem esperar à toa."""
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running(UNIOVER_SUPERVISOR_STOP_WAIT_SECONDS="5"):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        (pc.runtime / "restart-now").write_text("", encoding="ascii")
        assert wait_for(lambda: pc.starts() >= 2, 60), pc.supervisor_log()
        log = pc.supervisor_log()
        assert "reinicio pedido; reinicio o agente" in log
        assert "agente antigo" not in log
        assert "continua vivo" not in log


def test_a_second_agent_process_exits_cleanly_with_its_own_code(tmp_path: Path) -> None:
    """O executável de verdade, num processo à parte: com a trava de outro, sai com 5 e avisa."""
    base = tmp_path / "UniOver"
    holder = start_holder(base)
    try:
        second = subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys; from uniover_agent.main import main; sys.exit(main(['run']))",
            ],
            env=os.environ | {HOME_ENV: str(base), "PYTHONIOENCODING": "utf-8"},
            capture_output=True,
            encoding="utf-8",
            check=False,
            timeout=120,
        )
    finally:
        stop(holder)
    assert second.returncode == EXIT_ALREADY_RUNNING, second.stderr
    assert ALREADY_RUNNING_MESSAGE in second.stderr
    assert "Traceback" not in second.stderr
    # Saiu antes de tocar em qualquer coisa do primeiro.
    assert not (base / "config").exists()
    assert not (base / "runtime" / "diagnostics.jsonl").exists()
