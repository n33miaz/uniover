"""Caminho de atualização: o PC já instalado recebe a versão nova sozinho, sem administrador.

Ninguém tem acesso físico a esse PC: se a atualização quebrar o lançador ou a tarefa, o agente fica
sem controle para sempre. Aqui se prova cada etapa que a atualização executa lá.
"""

import os
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from uniover_agent.adapters import installation
from uniover_agent.adapters.installation import launcher_task_script, migrate_layout

from .launcher_isolation import isolated_launcher

TOOLS = Path(__file__).parents[1] / "tools"
POWERSHELL = os.path.join(
    os.environ["SystemRoot"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
)


class FakeSystem:
    """O Windows simulado: grava o que foi chamado e responde como o sistema responderia."""

    def __init__(self, *, wsh: bool = True, task_code: int = 0, power_code: int = 0) -> None:
        self.wsh = wsh
        self.task_code = task_code
        self.power_code = power_code
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        self.calls.append(args)
        name = Path(args[0]).name.lower()
        if name == "wscript.exe" and self.wsh:
            # O script de prova só cria o arquivo que recebe como argumento: cria o mesmo.
            script, mark = Path(args[-2]), Path(args[-1])
            assert script.read_bytes() == installation.WSH_PROBE_VBS.encode("ascii")
            mark.write_text("ok", encoding="ascii")
            return subprocess.CompletedProcess(args, 0, b"", b"")
        if name == "powershell.exe":
            return subprocess.CompletedProcess(args, self.task_code, b"", b"")
        if name == "powercfg.exe":
            return subprocess.CompletedProcess(args, self.power_code, b"", b"")
        return subprocess.CompletedProcess(args, 0, b"", b"")

    def names(self) -> list[str]:
        return [Path(call[0]).name.lower() for call in self.calls]


def installed_pc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """O PC como a develop o deixa: lançador estável, supervisor, tarefa antiga, config e Cofre."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    # Aqui a pasta temporária faz as vezes da instalação real do usuário.
    monkeypatch.setattr(installation, "_is_real_installation", lambda _root: True)
    base = tmp_path / "UniOver"
    (base / "app" / "tools").mkdir(parents=True)
    (base / "app" / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    for name in ("launcher.ps1", "run-agent.ps1"):
        (base / "app" / "tools" / name).write_bytes((TOOLS / name).read_bytes())
    (base / "launcher.ps1").write_text("# lancador antigo\n", encoding="ascii")
    (base / "run-agent.fallback.ps1").write_text("# supervisor conhecido bom\n", encoding="ascii")
    for folder in ("config", "runtime", "logs", "web"):
        (base / folder).mkdir()
    (base / "config" / "agent.toml").write_text('agent_id = "pc-do-amigo"\n', encoding="utf-8")
    return base


def forbid_real_system(monkeypatch: pytest.MonkeyPatch, system: FakeSystem) -> None:
    monkeypatch.setattr(installation, "run_hidden", system)
    monkeypatch.setattr(
        installation,
        "popen_hidden",
        lambda *_a, **_k: pytest.fail("a atualização não deve iniciar outro lançador"),
    )


def test_the_installed_pc_is_updated_without_admin_and_keeps_everything(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    base = installed_pc(tmp_path, monkeypatch)
    system = FakeSystem()
    forbid_real_system(monkeypatch, system)

    assert migrate_layout() == base

    # O Script Host é provado, a tarefa é trocada e a energia é ajustada, nessa ordem.
    assert system.names() == ["wscript.exe", "powershell.exe", "powercfg.exe", "powercfg.exe"]
    task_call = system.calls[1]
    script = task_call[-1]
    assert "Set-ScheduledTask" in script
    assert "wscript.exe" in script
    assert str(base / "launcher.vbs") in script
    everything = " ".join(item for call in system.calls for item in call)
    assert "-Verb" not in everything, "nada pede administrador"
    assert "RunAs" not in everything
    assert [call[1:] for call in system.calls[2:]] == [
        ["/change", "standby-timeout-ac", "0"],
        ["/change", "hibernate-timeout-ac", "0"],
    ]
    assert (base / "launcher.vbs").read_bytes() == installation.LAUNCHER_VBS.encode("ascii")
    # O lançador de agora vem do código novo; o supervisor conhecido bom e a identidade ficam.
    assert (base / "launcher.ps1").read_bytes() == (TOOLS / "launcher.ps1").read_bytes()
    assert (base / "run-agent.fallback.ps1").read_text(encoding="ascii").startswith("# supervisor")
    assert (base / "config" / "agent.toml").read_text(
        encoding="utf-8"
    ) == 'agent_id = "pc-do-amigo"\n'
    log = (base / "logs" / "agent.log").read_text(encoding="utf-8")
    assert "tarefa agendada passou a abrir o lançador sem console" in log
    assert "ficou de fora (exige administrador)" in log

    # Repetir não faz nada: cada ajuste vale uma vez por versão.
    system.calls.clear()
    migrate_layout()
    assert system.calls == []


def test_an_isolated_folder_never_touches_the_machine_wide_task_or_power_plan(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Um ensaio ou um teste troca LOCALAPPDATA para isolar o agente; a tarefa agendada e o plano de
    # energia, porém, são da máquina inteira e só a instalação de verdade pode mexer neles.
    base = installed_pc(tmp_path, monkeypatch)
    monkeypatch.undo()
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    system = FakeSystem()
    forbid_real_system(monkeypatch, system)

    assert migrate_layout() == base

    assert system.calls == []
    assert not (base / "launcher.vbs").exists()
    assert not (base / "runtime" / "launcher-task").exists()
    assert not (base / "runtime" / "power-settings").exists()


@pytest.mark.skipif(os.name != "nt", reason="a pasta do usuário vem do registro do Windows")
def test_the_real_folder_is_the_one_the_system_reports_not_the_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import winreg  # noqa: PLC0415 - só existe no Windows

    key = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
        real = Path(str(winreg.QueryValueEx(handle, "Local AppData")[0])) / "UniOver"
    assert installation._is_real_installation(real)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert installation._is_real_installation(real)
    assert not installation._is_real_installation(tmp_path / "UniOver")


def test_a_task_swap_that_fails_leaves_the_old_task_and_waits_before_trying_again(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    base = installed_pc(tmp_path, monkeypatch)
    system = FakeSystem(task_code=3)  # a troca foi revertida pelo próprio script
    forbid_real_system(monkeypatch, system)

    migrate_layout()

    assert not (base / "runtime" / "launcher-task").exists()
    assert (base / "runtime" / "launcher-task.failed").exists()
    assert "tarefa mantida" in (base / "logs" / "agent.log").read_text(encoding="utf-8")
    # O resto da atualização segue: o lançador novo e a energia entram mesmo assim.
    assert (base / "launcher.ps1").read_bytes() == (TOOLS / "launcher.ps1").read_bytes()
    assert "powercfg.exe" in system.names()

    system.calls.clear()
    migrate_layout()
    assert "powershell.exe" not in system.names(), "espera antes de tentar de novo"

    old = time.time() - installation.RETRY_AFTER_SECONDS - 10
    os.utime(base / "runtime" / "launcher-task.failed", (old, old))
    system.task_code = 0
    migrate_layout()
    assert "powershell.exe" in system.names()
    assert (base / "runtime" / "launcher-task").exists()
    assert not (base / "runtime" / "launcher-task.failed").exists()


def test_without_a_working_script_host_the_task_is_not_touched(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    base = installed_pc(tmp_path, monkeypatch)
    system = FakeSystem(wsh=False)
    forbid_real_system(monkeypatch, system)

    migrate_layout()

    assert "powershell.exe" not in system.names(), "nenhuma troca sem provar o Script Host"
    assert not (base / "runtime" / "launcher-task").exists()
    assert not (base / "runtime" / "wsh-probe.vbs").exists()
    assert "Script Host" in (base / "logs" / "agent.log").read_text(encoding="utf-8")


def test_power_settings_that_need_admin_are_skipped_quietly_and_logged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    base = installed_pc(tmp_path, monkeypatch)
    system = FakeSystem(power_code=1)
    forbid_real_system(monkeypatch, system)

    migrate_layout()  # não levanta nada

    log = (base / "logs" / "agent.log").read_text(encoding="utf-8")
    assert "energia: não consegui aplicar standby-timeout-ac, hibernate-timeout-ac" in log
    assert (base / "runtime" / "launcher-task").exists(), "a tarefa não depende da energia"
    assert (base / "app" / "tools" / "run-agent.ps1").exists()


def test_the_real_launcher_swap_works_in_task_scheduler_and_rolls_back_on_failure(
    tmp_path: Path,
) -> None:
    """Contra o Agendador de verdade, com uma tarefa de teste de nome único (a real fica)."""
    name = f"UniOver-teste-{uuid.uuid4().hex[:12]}"
    old_script = tmp_path / "launcher.ps1"
    old_script.write_text("# antigo\n", encoding="ascii")
    new_root = tmp_path / "UniOver"
    new_root.mkdir()

    def powershell(command: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - executável do sistema; comandos do próprio teste
            [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
            creationflags=0x08000000,
        )

    def actions() -> list[str]:
        shown = powershell(
            f"(Get-ScheduledTask -TaskName '{name}').Actions | "
            "ForEach-Object { $_.Execute + '|' + $_.Arguments }"
        )
        return [line for line in shown.stdout.splitlines() if line.strip()]

    create = powershell(
        f"$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-File \"{old_script}\"';"
        "$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;"
        f"Register-ScheduledTask -TaskName '{name}' -Action $a -Trigger $t -Force | Out-Null"
    )
    if create.returncode != 0:
        pytest.skip("o Agendador não aceitou registrar a tarefa de teste")
    old_action = f'powershell.exe|-File "{old_script}"'
    try:
        assert actions() == [old_action]

        # Falha: um caractere que o XML da tarefa não admite; a tarefa volta ao que era.
        broken = new_root / "x\x01y"
        failed = powershell(launcher_task_script(broken, name))
        assert failed.returncode in (3, 4), failed.stderr
        assert actions() == [old_action]

        # Sucesso: a ação, os gatilhos (logon + repetição) e o reinício por falha são trocados.
        done = powershell(launcher_task_script(new_root, name))
        assert done.returncode == 0, done.stderr or done.stdout
        (action,) = actions()
        executable, _, arguments = action.partition("|")
        assert Path(executable).name.lower() == "wscript.exe"
        assert arguments == f'//B //Nologo "{new_root / "launcher.vbs"}"'
        triggers = powershell(f"(Get-ScheduledTask -TaskName '{name}').Triggers.Count")
        assert triggers.stdout.strip() == "2"
        restart = powershell(
            f"$s=(Get-ScheduledTask -TaskName '{name}').Settings;"
            "'' + $s.RestartCount + '|' + $s.RestartInterval + '|' + $s.MultipleInstances"
        )
        assert restart.stdout.strip() == "999|PT1M|IgnoreNew", restart.stderr
        repetition = powershell(
            f"(Get-ScheduledTask -TaskName '{name}').Triggers | "
            "ForEach-Object { $_.Repetition.Interval }"
        )
        assert "PT10M" in repetition.stdout

        # Sem a tarefa (apagada), o mesmo script registra uma completa.
        powershell(f"Unregister-ScheduledTask -TaskName '{name}' -Confirm:$false")
        again = powershell(launcher_task_script(new_root, name))
        assert again.returncode == 0, again.stderr or again.stdout
        assert len(actions()) == 1
    finally:
        powershell(
            f"Unregister-ScheduledTask -TaskName '{name}' -Confirm:$false "
            "-ErrorAction SilentlyContinue"
        )


def test_the_updated_supervisor_starts_the_agent_and_the_tray_with_a_fake_uv(
    tmp_path: Path,
) -> None:
    """O run-agent.ps1 novo, no Windows PowerShell 5.1, com um `uv` falso: sobe tudo, sem janela."""
    base = tmp_path / "Pasta com espaco" / "UniOver"
    (base / "app" / "tools").mkdir(parents=True)
    (base / "runtime").mkdir()
    (base / "app" / ".version").write_text("a" * 40, encoding="ascii")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    record = tmp_path / "uv-calls.txt"
    (bin_dir / "uv.cmd").write_text(
        "@echo off\r\n"
        'echo %*>>"%UNIOVER_TEST_RECORD%"\r\n'
        'if "%~5"=="run" ping -n 120 127.0.0.1 >nul\r\n'
        'if "%~5"=="tray" ping -n 120 127.0.0.1 >nul\r\n'
        "exit /b 0\r\n",
        encoding="ascii",
    )
    environment = os.environ | {
        "LOCALAPPDATA": str(tmp_path / "Pasta com espaco"),
        "PATH": f"{bin_dir};{os.environ['PATH']}",
        "UNIOVER_TEST_RECORD": str(record),
    }
    process = subprocess.Popen(  # noqa: S603 - executáveis do sistema; scripts do repositório
        [
            POWERSHELL,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(TOOLS / "run-agent.ps1"),
        ],
        env=environment,
        creationflags=0x08000000,
    )
    try:
        for _ in range(300):
            text = record.read_text(encoding="utf-8") if record.exists() else ""
            if "uniover-agent run" in text and "uniover-agent tray" in text:
                break
            time.sleep(0.1)
        text = record.read_text(encoding="utf-8") if record.exists() else ""
        app = base / "app"
        assert f'run --project "{app}" uniover-agent run' in text
        assert f'run --project "{app}" uniover-agent tray' in text
        assert "sync" in text
    finally:
        subprocess.run(  # noqa: S603 - taskkill do sistema, só para encerrar o que o teste abriu
            [
                os.path.join(os.environ["SystemRoot"], "System32", "taskkill.exe"),
                "/PID",
                str(process.pid),
                "/T",
                "/F",
            ],
            check=False,
            capture_output=True,
            creationflags=0x08000000,
        )
        process.wait(timeout=10)


def test_the_launcher_only_stops_processes_of_its_own_base(tmp_path: Path) -> None:
    """Rodar o lançador numa pasta de teste não pode derrubar o agente de OUTRA instalação."""
    other = tmp_path / "outra instalacao" / "UniOver"
    mine = tmp_path / "minha"
    (mine / "UniOver").mkdir(parents=True)
    marker = tmp_path / "fallback.txt"
    (mine / "UniOver" / "run-agent.fallback.ps1").write_text(
        "Set-Content -LiteralPath $env:UNIOVER_TEST_MARKER -Value ok\n", encoding="ascii"
    )
    # Um processo cuja linha de comando parece a de um agente da outra instalação (a "real").
    decoy = subprocess.Popen(  # noqa: S603 - executável do sistema; script do próprio teste
        [
            POWERSHELL,
            "-NoProfile",
            "-Command",
            f"# {other / 'app' / 'tools' / 'run-agent.ps1'} {other / 'runtime' / 'venv'} "
            f"{other / 'agent-src'}\nStart-Sleep -Seconds 120",
        ],
        creationflags=0x08000000,
    )
    launcher = subprocess.Popen(  # noqa: S603 - executável do sistema; script do repositório
        [
            POWERSHELL,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(isolated_launcher(tmp_path)),
        ],
        env=os.environ | {"LOCALAPPDATA": str(mine), "UNIOVER_TEST_MARKER": str(marker)},
        creationflags=0x08000000,
    )
    try:
        for _ in range(200):
            if marker.exists():
                break
            time.sleep(0.1)
        assert marker.exists(), "o lançador de teste deveria ter chegado ao supervisor de reserva"
        assert decoy.poll() is None, "o lançador derrubou um processo de outra pasta"
    finally:
        launcher.terminate()
        decoy.kill()
        launcher.wait(timeout=10)
        decoy.wait(timeout=10)
