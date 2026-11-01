"""Supervisor: o `uv sync` que falha depois da promoção de uma versão em prova.

O laço de verdade (`run-agent.ps1`, Windows PowerShell 5.1) com um `uv` falso. Antes, uma versão
nova que não conseguia preparar o ambiente (disco cheio, rede, arquivo preso) fazia o laço esperar
com recuo para sempre: nunca rodava o agente, nunca contava queda e a segunda tentativa apagava o
ambiente que funcionava. Agora três falhas seguidas, com uma versão em prova e a anterior guardada,
voltam para a anterior pela mesma rotina do pedido do dono; sem isso o ambiente estragado continua
se consertando como antes (apagando e criando de novo).
"""

import json
import os
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from uniover_agent.adapters.update_status import STATUS_FILE

SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
POWERSHELL = SYSTEM32 / "WindowsPowerShell" / "v1.0" / "powershell.exe"
TASKKILL = SYSTEM32 / "taskkill.exe"
RUNNER = Path(__file__).parents[1] / "tools" / "run-agent.ps1"
LAUNCHER = Path(__file__).parents[1] / "tools" / "launcher.ps1"
pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

OLD = "a" * 40
BAD = "b" * 40


class Pc:
    """Uma instalação falsa: `app` na versão BAD, `runtime\\venv` com uma marca, `uv` falso."""

    def __init__(self, tmp_path: Path) -> None:
        self.local = tmp_path / "local"
        self.base = self.local / "UniOver"
        self.source = self.base / "app"
        self.previous = self.base / "app.previous"
        self.runtime = self.base / "runtime"
        self.marker = self.runtime / "venv" / "marca-do-ambiente"
        self.record = tmp_path / "chamadas"
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.record.mkdir()
        (self.source / "tools").mkdir(parents=True)
        (self.source / "tools" / "run-agent.ps1").write_bytes(RUNNER.read_bytes())
        (self.source / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (self.source / ".version").write_text(BAD + "\n", encoding="ascii")
        self.marker.parent.mkdir(parents=True)
        self.marker.write_text("ambiente que funcionava", encoding="utf-8")

    def previous_version(self) -> None:
        (self.previous / "tools").mkdir(parents=True)
        (self.previous / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (self.previous / "tools" / "run-agent.ps1").write_text("# anterior\n", encoding="ascii")
        (self.previous / ".version").write_text(OLD + "\n", encoding="ascii")

    def trial(self) -> None:
        (self.runtime / "update-trial.txt").write_text(BAD + "|0", encoding="ascii")

    def uv(self, sync_lines: list[str]) -> None:
        """`self-update` termina logo, `sync` segue as linhas dadas, `run` e `tray` ficam vivos.

        Cada papel deixa seu próprio marcador: o agente e o ícone iniciam em paralelo, e acrescentar
        ambos no mesmo arquivo pode perder uma das chamadas.

        O `sync` fica depois de um rótulo, e não dentro de um bloco entre parênteses: no cmd, um
        `exit /b 1` dentro de um `if` aninhado num bloco não encerra o arquivo, e o `exit /b 0`
        seguinte devolveria sucesso.
        """
        lines = [
            "@echo off",
            'if "%~1"=="sync" goto sync',
            'if "%~5"=="self-update" goto self_update',
            'if "%~5"=="tray" goto tray',
            'if "%~5"=="run" goto run',
            "exit /b 0",
            ":self_update",
            'echo.>"%UNIOVER_TEST_RECORD%\\self-update"',
            "exit /b 0",
            ":tray",
            'echo.>"%UNIOVER_TEST_RECORD%\\tray"',
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
            ":run",
            'echo.>"%UNIOVER_TEST_RECORD%\\run"',
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
            ":sync",
            'if not exist "%UNIOVER_TEST_RECORD%\\sync-1" goto sync_1',
            'if not exist "%UNIOVER_TEST_RECORD%\\sync-2" goto sync_2',
            ":sync_3",
            'echo.>"%UNIOVER_TEST_RECORD%\\sync-3"',
            "goto sync_body",
            ":sync_1",
            'echo.>"%UNIOVER_TEST_RECORD%\\sync-1"',
            "goto sync_body",
            ":sync_2",
            'echo.>"%UNIOVER_TEST_RECORD%\\sync-2"',
            ":sync_body",
            *sync_lines,
            "",
        ]
        (self.bin / "uv.cmd").write_text("\n".join(lines), encoding="ascii")

    def sync_calls(self) -> int:
        return sum((self.record / f"sync-{number}").is_file() for number in range(1, 4))

    def started(self, role: str) -> bool:
        return (self.record / role).is_file()

    def state(self) -> dict[str, object]:
        loaded: dict[str, object] = json.loads(
            (self.runtime / STATUS_FILE).read_text(encoding="utf-8")
        )
        return loaded

    def start(self) -> subprocess.Popen[bytes]:
        environment = os.environ | {
            "LOCALAPPDATA": str(self.local),
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "UNIOVER_TEST_RECORD": str(self.record),
            "UNIOVER_TEST_VENV": str(self.runtime / "venv"),
        }
        return subprocess.Popen(  # noqa: S603 - Windows PowerShell do sistema; script do repositório
            [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(LAUNCHER)],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=0x08000000,
        )


def stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        subprocess.run(  # noqa: S603 - taskkill do sistema, só para encerrar o que o teste abriu
            [str(TASKKILL), "/PID", str(process.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            creationflags=0x08000000,
        )
    process.wait(timeout=10)


def wait_for(check: Callable[[], bool], seconds: float) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.2)
    return check()


def test_three_failed_syncs_of_a_version_in_proof_go_back_without_touching_the_environment(
    tmp_path: Path,
) -> None:
    pc = Pc(tmp_path)
    pc.previous_version()
    pc.trial()
    pc.uv(["exit /b 1"])
    process = pc.start()
    try:
        assert wait_for((pc.runtime / ".blocked-versions").is_file, 120), (
            "a versao em prova deveria voltar para a anterior"
        )
        assert process.poll() is None
    finally:
        stop(process)

    assert (pc.source / ".version").read_text(encoding="ascii").strip() == OLD
    assert not pc.previous.exists()
    assert (pc.runtime / f"app.rejected-{BAD[:12]}" / ".version").is_file()
    assert (pc.runtime / ".blocked-versions").read_text(encoding="ascii").split() == [BAD]
    assert not (pc.runtime / "update-trial.txt").exists()
    # O ambiente que funcionava ficou: exatamente três tentativas, nenhuma segunda com apagamento.
    assert pc.marker.read_text(encoding="utf-8") == "ambiente que funcionava"
    assert pc.sync_calls() == 3
    # Nem o agente nem o ícone chegaram a subir com o ambiente quebrado.
    assert pc.started("self-update")
    assert not pc.started("tray")
    assert not pc.started("run")
    state = pc.state()
    assert (state["outcome"], state["rolledBack"], state["blockedSha"]) == (
        "rolled_back",
        True,
        BAD,
    )
    reason = str(state["reason"])
    assert "ambiente" in reason and "3" in reason
    assert reason.isascii() and len(reason) <= 200


def test_two_failures_followed_by_a_success_never_go_back_and_the_count_starts_over(
    tmp_path: Path,
) -> None:
    pc = Pc(tmp_path)
    pc.previous_version()
    pc.trial()
    record = "%UNIOVER_TEST_RECORD%"
    pc.uv(
        [
            f'if not exist "{record}.1" echo.>"{record}.1" & exit /b 1',
            f'if not exist "{record}.2" echo.>"{record}.2" & exit /b 1',
            "exit /b 0",
        ]
    )
    process = pc.start()
    try:
        assert wait_for(lambda: pc.started("tray") and pc.started("run"), 90), (
            "o agente e o ícone deveriam subir"
        )
        assert process.poll() is None
    finally:
        stop(process)

    assert pc.sync_calls() == 3
    assert (pc.source / ".version").read_text(encoding="ascii").strip() == BAD
    assert pc.previous.is_dir()
    assert (pc.runtime / "update-trial.txt").read_text(encoding="ascii") == f"{BAD}|0"
    assert pc.marker.is_file()
    assert not (pc.runtime / ".blocked-versions").exists()


@pytest.mark.parametrize(
    ("in_proof", "has_previous"),
    [(False, True), (True, False), (False, False)],
    ids=["stable-with-previous", "in-proof-without-previous", "stable-without-previous"],
)
def test_without_a_version_in_proof_and_one_to_go_back_to_a_broken_environment_is_recreated(
    tmp_path: Path, in_proof: bool, has_previous: bool
) -> None:
    pc = Pc(tmp_path)
    if has_previous:
        pc.previous_version()
    if in_proof:
        pc.trial()
    # O sync só passa depois de o ambiente (a marca) ser apagado: como um ambiente corrompido.
    pc.uv(['if exist "%UNIOVER_TEST_VENV%\\marca-do-ambiente" exit /b 1', "exit /b 0"])
    process = pc.start()
    try:
        assert wait_for(lambda: pc.started("tray") and pc.started("run"), 90), (
            "o agente e o ícone deveriam subir"
        )
    finally:
        stop(process)

    assert not pc.marker.exists()
    assert pc.sync_calls() == 2
    assert (pc.source / ".version").read_text(encoding="ascii").strip() == BAD
    assert pc.previous.is_dir() == has_previous
    assert not (pc.runtime / ".blocked-versions").exists()
