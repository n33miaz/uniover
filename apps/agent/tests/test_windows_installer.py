"""Guardas estáticas do instalador Windows e do wrapper que ele gera."""

import ast
import os
import re
import subprocess
import time
from pathlib import Path

import pytest

from uniover_agent.adapters import installation
from uniover_agent.adapters.process import NO_WINDOW
from uniover_agent.adapters.self_update import CHANNELS, DEFAULT_CHANNEL

from .launcher_isolation import isolated_launcher

INSTALLER = Path(__file__).parents[1] / "tools" / "install-windows.ps1"
LAUNCHER = Path(__file__).parents[1] / "tools" / "launcher.ps1"
RUNNER = Path(__file__).parents[1] / "tools" / "run-agent.ps1"
LAUNCHER_VBS = Path(__file__).parents[1] / "tools" / "launcher.vbs"
CMD_COPIES = (
    Path(__file__).parents[1] / "tools" / "conectar-uniover.cmd",
    Path(__file__).parents[2] / "web" / "public" / "conectar" / "conectar-uniover.cmd",
)
SOURCE = Path(__file__).parents[1] / "src" / "uniover_agent"
POWERSHELL = os.path.join(
    os.environ["SystemRoot"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
)


def test_the_generated_wrapper_is_ascii_and_recovers_the_uv_and_venv() -> None:
    wrapper = RUNNER.read_text(encoding="utf-8")
    assert wrapper.isascii()
    assert "Microsoft\\WinGet\\Links\\uv.exe" in wrapper
    assert "Microsoft\\WindowsApps\\uv.exe" in wrapper
    assert ".local\\bin\\uv.exe" in wrapper
    assert "Remove-Item -LiteralPath $venv -Recurse -Force" in wrapper


def test_the_wrapper_checks_for_updates_while_the_agent_is_alive_and_rolls_back_bad_ones() -> None:
    wrapper = RUNNER.read_text(encoding="utf-8")
    assert "AddHours(6)" in wrapper
    assert "Get-Random -Minimum 0 -Maximum 46" in wrapper
    assert "app.previous" in wrapper
    assert ".blocked-versions" in wrapper
    assert "$falls -lt 3" in wrapper
    assert "taskkill.exe /PID $process.Id /T /F" in wrapper


def test_the_task_has_no_battery_or_time_limit_and_keeps_the_repairable_launcher() -> None:
    installer = INSTALLER.read_text(encoding="utf-8")
    assert "New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME" in installer
    assert "-RepetitionInterval (New-TimeSpan -Minutes 10)" in installer
    assert "-RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)" in installer
    assert "-StartWhenAvailable" in installer
    assert "-ExecutionTimeLimit ([TimeSpan]::Zero)" in installer
    assert "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries" in installer
    assert installer.count("Write-AgentLauncher") == 3
    assert "run-agent.fallback.ps1" in installer


def test_the_launcher_falls_back_when_the_updated_wrapper_is_absent() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")
    assert launcher.isascii()
    assert "Test-Path -LiteralPath $current" in launcher
    assert "Test-Path -LiteralPath $legacy" in launcher
    assert "Test-Path -LiteralPath $fallback" in launcher
    assert "run-agent.fallback.ps1" in launcher


def test_launcher_runs_its_fallback_when_updated_wrapper_is_missing(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    base.mkdir()
    marker = tmp_path / "fallback.txt"
    (base / "run-agent.fallback.ps1").write_text(
        "Set-Content -LiteralPath $env:UNIOVER_TEST_MARKER -Value fallback\n",
        encoding="ascii",
    )
    environment = os.environ | {
        "LOCALAPPDATA": str(tmp_path),
        "UNIOVER_TEST_MARKER": str(marker),
    }
    process = subprocess.Popen(  # noqa: S603 - executável e argumentos fixos do Windows
        [
            POWERSHELL,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(isolated_launcher(tmp_path)),
        ],
        env=environment,
    )
    try:
        for _ in range(100):
            if marker.exists():
                break
            time.sleep(0.1)
        assert marker.read_text(encoding="utf-8").strip() == "fallback"
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_installer_migrates_the_old_layout_and_creates_the_user_facing_files() -> None:
    installer = INSTALLER.read_text(encoding="utf-8")
    for old, new in (
        ("agent-src", "app"),
        ("agent.toml", "config\\agent.toml"),
        ("agent.log", "logs\\agent.log"),
        ("conectar.html", "web\\conectar.html"),
        (".blocked-versions", "runtime\\.blocked-versions"),
        ("update-trial.txt", "runtime\\update-trial.txt"),
    ):
        assert old in installer and new in installer
    assert "LEIA-ME.txt" in installer
    assert "UniOver.lnk" in installer
    # Desinstalar tira o atalho que traz o ícone da bandeja de volta (o supervisor o cria).
    uninstall = installer.split("if ($Uninstall) {", 1)[1].split("exit 0", 1)[0]
    assert "UniOver Agente.lnk" in uninstall


def test_powershell_scripts_are_ascii_and_parse_in_windows_powershell() -> None:
    for script in (INSTALLER, LAUNCHER, RUNNER):
        assert script.read_bytes().isascii()
        escaped = str(script).replace("'", "''")
        command = (
            "$tokens=$null;$errors=$null;"
            "[System.Management.Automation.Language.Parser]::ParseFile("
            f"'{escaped}',[ref]$tokens,[ref]$errors)|Out-Null;"
            "if($errors.Count){$errors|ForEach-Object {$_.ToString()};exit 1}"
        )
        result = subprocess.run(  # noqa: S603 - executável fixo; script é arquivo do repositório
            [POWERSHELL, "-NoProfile", "-Command", command],
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr or result.stdout


def test_launcher_also_respects_the_old_mutex_only_in_the_real_installation_folder() -> None:
    text = LAUNCHER.read_text(encoding="utf-8")
    old_name = "'Local" + chr(92) + "UniOverLauncher'"  # o nome antigo, sem a pasta
    new_name = "'Local" + chr(92) + "UniOverLauncher-' + $key"  # o novo, com o hash da pasta
    assert old_name in text
    assert new_name in text
    # O antigo só é disputado quando a pasta é a instalação real (não em pasta temporária).
    guard = text.index("-ieq $realBase")
    assert guard < text.index(old_name) < text.index("while ($true)")
    assert text.index(new_name) < guard
    assert text.count("exit 0") >= 2


def test_the_tray_never_holds_the_executable_that_the_sync_replaces() -> None:
    # O ícone roda do mesmo ambiente: aberto durante o sync, prende o uniover-agent.exe e o agente
    # nunca mais sobe depois de uma atualização.
    runner = RUNNER.read_text(encoding="utf-8")
    sync_body = runner.split("function Sync-Agent", 1)[1].split("function ", 1)[0]
    assert sync_body.lstrip().split("\n", 1)[1].strip().startswith("Stop-VenvUsers")
    loop = runner.split("while ($true) {", 1)[1]
    assert loop.index("Sync-Agent $uv") < loop.index("Update-Tray $uv")
    startup_update = loop.split("$updated = Invoke-Update $uv", 1)[1].split("exit 42", 1)[0]
    assert "taskkill.exe /PID $tray.Id /T /F" in startup_update


# ---- nenhuma janela de console, nem por um instante ----


def _vbs_run_calls(script: str, tmp_path: Path) -> list[str]:
    """Executa o VBS com um Shell falso que so anota `Run(comando, estilo, espera)`."""
    fake = (
        "Class FakeShell\r\n"
        "  Public Sub Run(a, b, c)\r\n"
        '    WScript.Echo "RUN|" & b & "|" & c & "|" & a\r\n'
        "  End Sub\r\n"
        "  Public Function ExpandEnvironmentStrings(a)\r\n"
        '    ExpandEnvironmentStrings = "C:\\Fake"\r\n'
        "  End Function\r\n"
        "End Class\r\n"
        "Class FakeFso\r\n"
        "  Public Sub DeleteFile(a)\r\n"
        "  End Sub\r\n"
        "End Class\r\n"
        "Function MakeObj(name)\r\n"
        '  If name = "WScript.Shell" Then\r\n'
        "    Set MakeObj = New FakeShell\r\n"
        "  Else\r\n"
        "    Set MakeObj = New FakeFso\r\n"
        "  End If\r\n"
        "End Function\r\n"
    )
    wrapped = tmp_path / "check.vbs"
    body = script.replace("Option Explicit\r\n", "").replace("Option Explicit\n", "")
    wrapped.write_bytes((fake + body.replace("CreateObject(", "MakeObj(")).encode("ascii"))
    cscript = Path(os.environ["SystemRoot"]) / "System32" / "cscript.exe"
    result = subprocess.run(  # noqa: S603 - executável do sistema; script gerado pelo teste
        [str(cscript), "//nologo", str(wrapped)],
        check=False,
        capture_output=True,
        text=True,
        creationflags=0x08000000,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return [line for line in result.stdout.splitlines() if line.startswith("RUN|")]


def test_launcher_vbs_is_ascii_and_opens_the_powershell_launcher_with_a_hidden_window(
    tmp_path: Path,
) -> None:
    text = LAUNCHER_VBS.read_text(encoding="ascii")
    calls = _vbs_run_calls(text, tmp_path)
    assert len(calls) == 1
    style, wait, command = calls[0].split("|")[1:]
    assert style == "0", "estilo 0 = janela oculta desde a criacao"
    assert wait.lower() in ("false", "falso")
    assert command.startswith(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File"
    )
    assert command.endswith('\\launcher.ps1"')


def test_the_vbs_written_by_the_migration_is_the_same_as_the_one_in_tools() -> None:
    shipped = LAUNCHER_VBS.read_text(encoding="ascii").replace("\r\n", "\n")
    assert installation.LAUNCHER_VBS.replace("\r\n", "\n") == shipped


def test_the_task_survives_crashes_and_stays_interactive_for_the_credential_vault() -> None:
    """Sobe no logon, sobe de novo a cada 10 min e reinicia por falha; sem S4U nem inicialização."""
    installer = INSTALLER.read_text(encoding="utf-8")
    action = installer[installer.index("function Register-AgentTask") :]
    action = action[: action.index("function Move-LegacyLayout")]
    assert "-LogonType Interactive" in action
    assert "S4U" not in action
    assert "AtStartup" not in action
    assert "WakeToRun" not in action
    assert "-MultipleInstances IgnoreNew" in action
    # O atualizador aplica exatamente os mesmos gatilhos e limites que o instalador.
    updater = installation.launcher_task_script(Path("C:/x"))
    for fragment in (
        "-AtLogOn",
        "-RepetitionInterval (New-TimeSpan -Minutes 10)",
        "-RestartCount 999",
        "-RestartInterval (New-TimeSpan -Minutes 1)",
        "-MultipleInstances IgnoreNew",
        "-StartWhenAvailable",
    ):
        assert fragment in updater
        assert fragment in action


def test_the_updater_replaces_action_triggers_and_settings_and_reverts_all_three_on_failure() -> (
    None
):
    script = installation.launcher_task_script(Path("C:/x"))
    assert "Set-ScheduledTask -TaskName $name -Action $a -Trigger $t -Settings $s" in script
    assert "-Action $old -Trigger $oldT -Settings $oldS" in script
    assert "$read.Settings.RestartCount -ne 999" in script
    # Um agente já instalado refaz a tarefa quando a versão do ajuste muda.
    assert installation.LAUNCHER_TASK_VERSION != "wscript-1"


def test_the_registered_task_opens_wscript_not_powershell(tmp_path: Path) -> None:
    script = installation.launcher_task_script(tmp_path)
    assert "wscript.exe" in script
    assert "//B //Nologo" in script
    assert str(tmp_path / "launcher.vbs") in script
    assert "powershell" not in script.lower()
    installer = INSTALLER.read_text(encoding="utf-8")
    action = installer[installer.index("function Register-AgentTask") :]
    primary = action[: action.index("else {")]
    assert "New-ScheduledTaskAction -Execute $wscript" in primary
    assert "//B //Nologo" in primary
    assert "powershell.exe" not in primary


def test_an_old_installation_is_pointed_to_the_hidden_launcher_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "runtime").mkdir()
    calls: list[Path] = []

    def register(root: Path) -> bool:
        calls.append(root)
        return True

    monkeypatch.setattr(installation, "_register_launcher_task", register)

    installation._ensure_hidden_launcher_task(tmp_path)
    installation._ensure_hidden_launcher_task(tmp_path)

    assert calls == [tmp_path]
    marker = tmp_path / "runtime" / "launcher-task"
    assert marker.read_text(encoding="ascii") == installation.LAUNCHER_TASK_VERSION


def test_a_failed_registration_is_tried_again_next_time(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "runtime").mkdir()
    results = iter([False, True])
    monkeypatch.setattr(installation, "_register_launcher_task", lambda _root: next(results))

    installation._ensure_hidden_launcher_task(tmp_path)
    assert not (tmp_path / "runtime" / "launcher-task").exists()
    failed = tmp_path / "runtime" / "launcher-task.failed"
    assert failed.exists()
    # Dentro do prazo de espera nem tenta (cada tentativa custa segundos no PC da pessoa).
    installation._ensure_hidden_launcher_task(tmp_path)
    assert not (tmp_path / "runtime" / "launcher-task").exists()
    old = time.time() - installation.RETRY_AFTER_SECONDS - 10
    os.utime(failed, (old, old))
    installation._ensure_hidden_launcher_task(tmp_path)
    assert (tmp_path / "runtime" / "launcher-task").exists()
    assert not failed.exists()


def test_the_real_install_reregisters_the_task_and_the_takeover_starts_wscript_not_powershell(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    tools = tmp_path / "app" / "tools"
    tools.mkdir(parents=True)
    for name in ("launcher.ps1", "run-agent.ps1"):
        (tools / name).write_bytes((Path(__file__).parents[1] / "tools" / name).read_bytes())
    registered: list[Path] = []
    started: list[tuple[list[str], int]] = []

    def register(root: Path) -> bool:
        registered.append(root)
        return True

    def popen(command: list[str], **kwargs: int) -> None:
        started.append((command, kwargs["creationflags"]))

    monkeypatch.setattr(installation, "_is_real_installation", lambda _root: True)
    monkeypatch.setattr(installation, "_register_launcher_task", register)
    monkeypatch.setattr(installation, "_windows_script_host_works", lambda _root: True)
    monkeypatch.setattr(installation, "_apply_power_settings", lambda _root: None)
    monkeypatch.setattr(subprocess, "Popen", popen)
    monkeypatch.delenv("UNIOVER_LEGACY_TAKEOVER", raising=False)

    installation._install_launcher(tmp_path, start_now=True, real=True)

    assert registered == [tmp_path]
    ((command, flags),) = started
    assert Path(command[0]).name.lower() == "wscript.exe"
    assert command[1:3] == ["//B", "//Nologo"]
    assert command[3] == str(tmp_path / "launcher.vbs")
    assert flags == NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    monkeypatch.delenv("UNIOVER_LEGACY_TAKEOVER", raising=False)


def test_no_python_call_opens_a_process_without_hiding_its_console() -> None:
    """Todo subprocess passa por `adapters/process.py` (ou leva `creationflags`)."""
    sync_spawners = {"run", "Popen", "check_output", "check_call", "call"}
    missing: list[str] = []
    # Os demais adaptadores seguem a regra pelo `process.py` (teste em test_process_and_arp).
    for name in ("installation.py", "tv_pairing.py"):
        path = SOURCE / "adapters" / name
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            owner = ast.unparse(node.func.value)
            spawns = (owner == "subprocess" and node.func.attr in sync_spawners) or (
                owner in ("asyncio", "asyncio.subprocess")
                and node.func.attr.startswith("create_subprocess_")
            )
            if spawns and not any(keyword.arg == "creationflags" for keyword in node.keywords):
                missing.append(f"{path.name}:{node.lineno} {owner}.{node.func.attr}")
    assert missing == []


def test_no_powershell_script_starts_a_console_process_through_start_process() -> None:
    """Start-Process cria um console novo e so o esconde depois (pisca); filhos herdam o oculto."""
    allowed = (
        "Start-Process -FilePath $pageFile",  # abre o navegador (programa de janela)
        "Start-Process -FilePath $systemShell -Verb RunAs -WindowStyle Hidden",  # o UAC, oculto
    )
    offenders: list[str] = []
    for script in (INSTALLER, LAUNCHER, RUNNER):
        for number, line in enumerate(script.read_text(encoding="utf-8").splitlines(), start=1):
            code = line.split("#", 1)[0]
            if "Start-Process" in code and not any(item in code for item in allowed):
                offenders.append(f"{script.name}:{number}: {line.strip()}")
    assert offenders == []
    runner = RUNNER.read_text(encoding="utf-8")
    assert "$info.CreateNoWindow = $true" in runner
    assert "$info.UseShellExecute = $false" in runner
    assert "Start-Hidden $uv $arguments" in runner


def test_the_installer_has_no_console_prompts_in_the_automatic_mode() -> None:
    installer = INSTALLER.read_text(encoding="utf-8")
    automatic = installer[
        installer.index("function Invoke-AutomaticInstall") : installer.index("# --- Modo manual")
    ]
    assert "Read-Host" not in automatic
    assert "-Verb RunAs" in installer
    assert installer.count("Read-Host") == 1  # so o modo manual (terminal visivel)
    assert "Write-Page 'Pronto. Pode fechar esta janela.' $false" in automatic
    for step in ("Instalando o UniOver", "Procurando a TV", "Pareando a TV"):
        assert step in automatic
    assert "pair --if-needed --no-browser --installing" in automatic


def test_the_elevated_part_only_applies_system_settings() -> None:
    installer = INSTALLER.read_text(encoding="utf-8")
    start = installer.index("$elevated = @'")
    block = installer[start : installer.index("'@", start + 20)]
    forbidden = (
        "LOCALAPPDATA",
        "USERNAME",
        "Register-ScheduledTask",
        "Credential",
        "icacls",
        "APPDATA",
    )
    for word in forbidden:
        assert word not in block
    assert "& $powercfg /change standby-timeout-ac 0" in block
    assert "& $powercfg /change hibernate-timeout-ac 0" in block
    assert "monitor-timeout" not in block  # a tela pode apagar
    assert "-Protocol UDP -LocalPort 1900" in block
    assert "-Profile Private,Domain" in block
    assert "Public" not in block
    assert "-RemoteAddress LocalSubnet" in block
    assert "Remove-NetFirewallRule" in block  # idempotente: recria a regra em vez de empilhar
    after = installer[installer.index("function Set-SystemSettings") :]
    assert "-EncodedCommand" in after
    assert "-Verb RunAs -WindowStyle Hidden -Wait -PassThru" in after
    assert (
        "catch {" in after[after.index("-Verb RunAs") :]
    )  # UAC recusado: segue sem as configuracoes
    assert block.isascii()


@pytest.mark.parametrize("copy", CMD_COPIES)
def test_the_cmd_leaves_no_console_open_and_both_copies_are_equal(copy: Path) -> None:
    data = copy.read_bytes()
    assert data == CMD_COPIES[0].read_bytes()
    assert data.isascii()
    assert b"\r\n" in data
    text = data.decode("ascii").lower()
    assert "pause" not in text
    assert 'start "" wscript.exe //b //nologo' in text
    assert text.rstrip().endswith("exit")


def test_the_cmd_writes_a_vbs_that_runs_the_installer_hidden(tmp_path: Path) -> None:
    script = CMD_COPIES[0].read_text(encoding="ascii")
    generating = "\r\n".join(
        line for line in script.splitlines() if not line.startswith(("start ", "exit"))
    )
    runner = tmp_path / "generate.cmd"
    runner.write_bytes((generating + "\r\n").encode("ascii"))
    subprocess.run(  # noqa: S603 - cmd.exe do sistema; so grava o arquivo VBS no TEMP do teste
        [str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"), "/c", str(runner)],
        check=True,
        env=os.environ | {"TEMP": str(tmp_path)},
        creationflags=0x08000000,
    )
    (generated,) = tmp_path.glob("conectar-uniover-*.vbs")
    calls = _vbs_run_calls(generated.read_text(encoding="ascii"), tmp_path)
    assert len(calls) == 1
    style, _wait, command = calls[0].split("|")[1:]
    assert style == "0"
    assert command.startswith(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command"
    )
    assert (
        f"irm https://raw.githubusercontent.com/n33miaz/uniover/{DEFAULT_CHANNEL}"
        "/apps/agent/tools/install-windows.ps1" in command
    )
    assert "^" not in command


def test_the_channel_is_switched_in_one_place_the_cmd_the_installer_and_the_agent_agree() -> None:
    """Voltar a publicar pela main é trocar três valores; este teste falha se um ficar para trás."""
    installer = INSTALLER.read_text(encoding="utf-8")
    default_ref = re.search(r"\[string\]\$Ref = '([a-z]+)'", installer)
    assert default_ref is not None
    assert default_ref.group(1) == DEFAULT_CHANNEL
    for copy in CMD_COPIES:
        text = copy.read_text(encoding="ascii")
        assert f"/n33miaz/uniover/{DEFAULT_CHANNEL}/apps/agent/tools/install-windows.ps1" in text
    # O instalador grava o ramo no agent.toml, e o agente só aceita um dos canais conhecidos.
    assert "update_channel" in installer
    assert set(CHANNELS) == {"main", "develop"}
