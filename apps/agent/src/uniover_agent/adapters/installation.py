"""Layout persistente do agente instalado e migração sem perder o pareamento."""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from uniover_agent.adapters.process import popen_hidden, run_hidden

# Versão do lançador sem console que a tarefa usa; subir o número reaponta as tarefas já instaladas.
LAUNCHER_TASK_VERSION = "wscript-2-resilient"
# Versão do ajuste de energia sem administrador; subir o número aplica de novo.
POWER_SETTINGS_VERSION = "ac-never-sleep-1"
# Depois de uma tentativa que falhou, espera isto antes de tentar de novo (custa segundos).
RETRY_AFTER_SECONDS = 24 * 3600
TASK_NAME = "UniOver agente"

# Mesmo texto de `tools/launcher.vbs` (um teste confere): o WScript não tem console e `Run(..., 0)`
# cria o PowerShell já oculto, então nada pisca no logon. Escrito daqui para não depender de a
# versão antiga ter o arquivo.
LAUNCHER_VBS = "\r\n".join(
    (
        "' Inicia o lancador do UniOver sem janela: o Windows Script Host nao tem console e o",
        "' Run com estilo 0 cria o PowerShell ja oculto (nada pisca no logon). Somente ASCII.",
        "Option Explicit",
        "Dim shell, base",
        'Set shell = CreateObject("WScript.Shell")',
        r'base = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\UniOver"',
        'shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden '
        '-File """ '
        r'& base & "\launcher.ps1""", 0, False',
        "",
    )
)


def _powershell() -> str:
    """Caminho do Windows PowerShell que acompanha o Windows (não depende do PATH)."""
    return os.path.join(
        os.environ["SystemRoot"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
    )


LOCATION_FILE = "location.txt"
HOME_ENV = "UNIOVER_HOME"


def anchor_dir() -> Path:
    r"""A pasta fixa `%LOCALAPPDATA%\UniOver`: o lançador, a tarefa e o ponteiro da pasta escolhida.

    Fica sempre no mesmo lugar para a tarefa agendada e o lançador nunca dependerem de uma
    escolha que o dono pode ter feito: o Windows só precisa achar `launcher.vbs` aqui.
    """
    local = os.environ.get("LOCALAPPDATA")
    return (Path(local) if local else Path.home() / ".config") / "UniOver"


def chosen_location(anchor: Path | None = None) -> Path | None:
    """A pasta que o dono escolheu na instalação (`location.txt` na pasta fixa), se ainda existe.

    O caminho vem de um arquivo de texto (UTF-8) e não do registro nem do `.vbs`: o Script Host lê
    em página de código ANSI e estragaria um caminho com acento, e os testes isolam a instalação só
    por variável de ambiente.
    """
    pointer = (anchor if anchor is not None else anchor_dir()) / LOCATION_FILE
    try:
        text = pointer.read_text(encoding="utf-8-sig").strip().splitlines()[0].strip()
    except OSError, IndexError:
        return None
    chosen = Path(text)
    return chosen if chosen.is_absolute() and chosen.is_dir() else None


def installation_base() -> Path:
    """Onde ficam `app`, `runtime`, `config`, `logs` e `web`: a pasta escolhida ou a padrão."""
    override = os.environ.get(HOME_ENV)
    if override and Path(override).is_absolute():
        return Path(override)
    return chosen_location() or anchor_dir()


def _is_real_installation(root: Path) -> bool:
    """`root` é a pasta de instalação do usuário no Windows, e não uma pasta de teste ou de ensaio.

    A tarefa agendada e o plano de energia valem para a máquina inteira: só a instalação de verdade
    pode mexer neles. A pasta do usuário vem do registro do Windows e não de `LOCALAPPDATA`, que um
    ensaio ou um teste troca para isolar o agente.
    """
    if sys.platform != "win32":
        return False
    import winreg  # noqa: PLC0415 - só existe no Windows

    key = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
            local = str(winreg.QueryValueEx(handle, "Local AppData")[0])
    except OSError:
        return False
    return os.path.normcase(os.path.normpath(str(root))) == os.path.normcase(
        os.path.normpath(os.path.join(local, "UniOver"))
    )


def _move_once(source: Path, destination: Path) -> None:
    """Move um item legado somente quando o destino ainda não existe."""
    if source.exists() and not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(destination))


def migrate_layout(base: Path | None = None) -> Path:
    """Organiza instalações antigas, sem sobrescrever nada que já foi migrado.

    A operação é deliberadamente idempotente: se o Windows estiver usando uma pasta, a próxima
    inicialização tenta de novo. O código e as chaves do Cofre nunca são apagados.
    """
    root = base or installation_base()
    root.mkdir(parents=True, exist_ok=True)
    legacy_source = root / "agent-src"
    app = root / "app"
    took_over_legacy_wrapper = legacy_source.is_dir() and not app.exists()
    # A tarefa antiga só sabe iniciar `agent-src`. Antes de renomear essa pasta, instalamos e
    # registramos o lançador estável, que também entende o caminho legado até a troca terminar.
    # Assim uma queda de energia em qualquer lado da renomeação ainda tem um caminho inicializável.
    can_take_over = not took_over_legacy_wrapper or _prepare_legacy_takeover(
        root, legacy_source, register_task=base is None
    )
    mappings = (
        (root / "agent-src", app),
        (root / "agent-src.previous", root / "app.previous"),
        (root / "venv", root / "runtime" / "venv"),
        (root / "agent.toml", root / "config" / "agent.toml"),
        (root / "agent.log", root / "logs" / "agent.log"),
        (root / "conectar.html", root / "web" / "conectar.html"),
        (root / ".blocked-versions", root / "runtime" / ".blocked-versions"),
        (root / "update-trial.txt", root / "runtime" / "update-trial.txt"),
    )
    for source, destination in mappings:
        if source == legacy_source and took_over_legacy_wrapper and not can_take_over:
            continue
        try:
            _move_once(source, destination)
        except OSError:
            # Uma imagem executável ainda pode estar aberta neste processo. Não arrisca a cópia
            # nem a configuração: basta tentar de novo no próximo ciclo.
            continue
    for name in ("runtime", "config", "logs", "web"):
        (root / name).mkdir(exist_ok=True)
    # Um wrapper legado fixa estas variáveis na raiz. Ajustá-las aqui permite que a primeira
    # execução após a atualização já leia os caminhos novos.
    config = root / "config" / "agent.toml"
    if config.exists():
        os.environ["UNIOVER_CONFIG_FILE"] = str(config)
    os.environ["UNIOVER_LOG_FILE"] = str(root / "logs" / "agent.log")
    os.environ["UV_PROJECT_ENVIRONMENT"] = str(root / "runtime" / "venv")
    _install_launcher(
        root,
        start_now=took_over_legacy_wrapper and can_take_over and base is None,
        real=base is None,
        anchor=anchor_dir() if base is None else root,
    )
    _write_readme(root)
    return root


def _copy_launcher(source: Path, destination: Path) -> bool:
    """Copia um script por troca, sem deixar um arquivo parcial depois de queda de energia."""
    if not source.is_file():
        return False
    temporary = destination.with_suffix(destination.suffix + ".new")
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    except OSError:
        temporary.unlink(missing_ok=True)
        return False
    return True


def _wscript() -> str:
    """Caminho do Windows Script Host (GUI, sem console), que acompanha o Windows."""
    return os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "wscript.exe")


def _write_launcher_vbs(root: Path) -> bool:
    """Grava `launcher.vbs` por troca; o texto é sempre o mesmo, então repetir é inofensivo."""
    destination = root / "launcher.vbs"
    temporary = destination.with_suffix(".vbs.new")
    try:
        temporary.write_bytes(LAUNCHER_VBS.encode("ascii"))
        os.replace(temporary, destination)
    except OSError:
        temporary.unlink(missing_ok=True)
        return False
    return True


# Gatilhos e limites que o instalador e a atualização aplicam igual. Logon: sobe na hora. Repetição:
# a cada 10 min por dez anos, sobe de novo se o agente ou o lançador morreram (instância única do
# mutex do lançador). Sem `-WakeToRun`: acordar o PC a cada 10 min gastaria energia sem ganho, pois
# o agente já pede ao Windows que não suspenda por ociosidade.
TASK_TRIGGERS_AND_SETTINGS = (
    "$t=@((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),"
    "(New-ScheduledTaskTrigger -Once -At (Get-Date).Date"
    " -RepetitionInterval (New-TimeSpan -Minutes 10)"
    " -RepetitionDuration (New-TimeSpan -Days 3650)));"
    "$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)"
    " -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries"
    " -MultipleInstances IgnoreNew -StartWhenAvailable"
    " -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)"
)


def launcher_task_script(root: Path, name: str = TASK_NAME) -> str:
    """Script (PowerShell 5.1, sem administrador) que deixa a tarefa do agente robusta.

    Tarefa existente: troca a AÇÃO (lançador sem console), os GATILHOS (logon e uma repetição a
    cada 10 min: se o agente caiu, sobe de novo; o mutex do lançador garante uma instância só) e as
    CONFIGURAÇÕES (reinício automático por falha, 999 vezes a cada 1 min). A conta fica como está:
    a tarefa roda interativa, com o token no Cofre de Credenciais do usuário, que uma tarefa sem
    logon (S4U) não consegue abrir; por isso também não há gatilho de inicialização do sistema, que
    exigiria administrador. Confere pela leitura e, se algo falhar, devolve ação, gatilhos e
    configurações antigos: a tarefa antiga nunca fica pela metade. Sem tarefa: registra uma
    completa. A saída diz o que houve (0 feito, 3 revertido, 4 erro).
    """
    vbs = str(root / "launcher.vbs").replace("'", "''")
    wscript = _wscript().replace("'", "''")
    lines = (
        "$ErrorActionPreference='Stop'",
        f"$exe='{wscript}'",
        f"$arg='//B //Nologo \"{vbs}\"'",
        f"$name='{name}'",
        "try {",
        "$a=New-ScheduledTaskAction -Execute $exe -Argument $arg",
        TASK_TRIGGERS_AND_SETTINGS,
        "$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue",
        "if ($task) {",
        "$old=@($task.Actions)",
        "$oldT=@($task.Triggers)",
        "$oldS=$task.Settings",
        "try {",
        "Set-ScheduledTask -TaskName $name -Action $a -Trigger $t -Settings $s|Out-Null",
        "$read=Get-ScheduledTask -TaskName $name",
        "$now=@($read.Actions)",
        "if ($now.Count -ne 1 -or $now[0].Execute -ne $exe -or $now[0].Arguments -ne $arg)"
        " { throw 'conferencia' }",
        "if (@($read.Triggers).Count -ne 2 -or $read.Settings.RestartCount -ne 999)"
        " { throw 'conferencia' }",
        "} catch {",
        "try { Set-ScheduledTask -TaskName $name -Action $old -Trigger $oldT"
        " -Settings $oldS|Out-Null } catch { }",
        "exit 3",
        "}",
        "exit 0",
        "}",
        "$p=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive"
        " -RunLevel Limited",
        "Register-ScheduledTask -TaskName $name -Action $a -Trigger $t -Principal $p"
        " -Settings $s -Force|Out-Null",
        "exit 0",
        "} catch { exit 4 }",
    )
    return "\n".join(lines)


def _note(root: Path, message: str) -> None:
    """Uma linha no registro do agente (a configuração do log só vem depois da migração)."""
    try:
        logs = root / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with (logs / "agent.log").open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} INFO installation: {message}\n")
    except OSError:
        return


def _recently_failed(marker: Path) -> bool:
    try:
        return time.time() - marker.stat().st_mtime < RETRY_AFTER_SECONDS
    except OSError:
        return False


# Script de prova do Script Host: ASCII puro e sem caminho dentro dele. O WScript lê o arquivo na
# página de código do Windows (ANSI) e não em UTF-8, então um caminho com acento gravado aqui
# viraria outro caminho; o arquivo de saída chega como argumento (a linha de comando do Windows é
# Unicode), e funciona com qualquer nome de usuário.
WSH_PROBE_VBS = (
    'CreateObject("Scripting.FileSystemObject")'
    ".CreateTextFile(WScript.Arguments(0), True).Close\r\n"
)


def _windows_script_host_works(root: Path) -> bool:
    """O Script Host roda mesmo neste usuário? (Pode estar desligado por política do PC.)

    Roda um script de prova que só cria um arquivo. Se não criar, a tarefa NÃO é trocada: um
    lançador que o Windows se recusa a abrir deixaria o PC sem agente no próximo logon.
    """
    runtime = root / "runtime"
    probe = runtime / "wsh-probe.vbs"
    mark = runtime / "wsh-probe.ok"
    try:
        runtime.mkdir(parents=True, exist_ok=True)
        mark.unlink(missing_ok=True)
        probe.write_bytes(WSH_PROBE_VBS.encode("ascii"))
        run_hidden([_wscript(), "//B", "//Nologo", str(probe), str(mark)], timeout=20)
        return mark.is_file()
    except OSError, subprocess.TimeoutExpired:
        return False
    finally:
        probe.unlink(missing_ok=True)
        mark.unlink(missing_ok=True)


def _register_launcher_task(
    anchor: Path, root: Path | None = None, *, name: str = TASK_NAME
) -> bool:
    """Reaponta a tarefa do usuário para o lançador sem console, sem precisar de administrador.

    À prova de falha: só troca depois de provar que o Script Host funciona, confere a tarefa depois
    da troca e a devolve ao que era se a conferência falhar. `False` deixa tudo como estava.
    """
    root = root if root is not None else anchor
    if not os.path.exists(_wscript()) or not _write_launcher_vbs(anchor):
        return False
    if not _windows_script_host_works(root):
        _note(root, "tarefa mantida: o Windows Script Host não executou o script de prova")
        return False
    try:
        result = run_hidden(
            [
                _powershell(),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                launcher_task_script(anchor, name),
            ],
            check=False,
            capture_output=True,
            timeout=60,
        )
    except OSError, subprocess.TimeoutExpired:
        _note(root, "tarefa mantida: o Agendador não respondeu")
        return False
    if result.returncode != 0:
        _note(root, f"tarefa mantida: a troca não passou na conferência ({result.returncode})")
    return result.returncode == 0


def _ensure_hidden_launcher_task(root: Path, anchor: Path | None = None) -> None:
    """Instalações antigas passam a abrir o lançador sem console na primeira execução nova."""
    marker = root / "runtime" / "launcher-task"
    failed = root / "runtime" / "launcher-task.failed"
    try:
        if marker.read_text(encoding="ascii").strip() == LAUNCHER_TASK_VERSION:
            return
    except OSError:
        pass
    if _recently_failed(failed):
        return
    try:
        # Pasta padrão: lançador e dados no mesmo lugar. Pasta escolhida: o lançador fica na fixa.
        registered = (
            _register_launcher_task(root)
            if anchor is None or anchor == root
            else _register_launcher_task(anchor, root)
        )
        if registered:
            marker.write_text(LAUNCHER_TASK_VERSION, encoding="ascii")
            failed.unlink(missing_ok=True)
            _note(root, "tarefa agendada passou a abrir o lançador sem console")
        else:
            failed.write_text(LAUNCHER_TASK_VERSION, encoding="ascii")
    except OSError:
        return


def _apply_power_settings(root: Path) -> None:
    """Na tomada o PC não suspende nem hiberna, sem administrador (uma vez por versão do ajuste).

    O `powercfg /change` mexe só no plano ativo e é permitido ao usuário comum. O que exige
    administrador (economia de energia do adaptador de rede, regra de firewall) não é tentado: vale
    só para a instalação nova pelo conectar; o que ficou de fora vai para o registro.
    """
    marker = root / "runtime" / "power-settings"
    try:
        if marker.read_text(encoding="ascii").strip() == POWER_SETTINGS_VERSION:
            return
    except OSError:
        pass
    powercfg = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "powercfg.exe")
    failed: list[str] = []
    for setting in ("standby-timeout-ac", "hibernate-timeout-ac"):
        try:
            result = run_hidden(
                [powercfg, "/change", setting, "0"], capture_output=True, timeout=20
            )
        except OSError, subprocess.TimeoutExpired:
            failed.append(setting)
            continue
        if result.returncode != 0:
            failed.append(setting)
    if failed:
        _note(root, "energia: não consegui aplicar " + ", ".join(failed) + " sem administrador")
    else:
        _note(root, "energia: na tomada o PC não suspende nem hiberna (a tela pode apagar)")
    _note(
        root,
        "ficou de fora (exige administrador): economia de energia do adaptador de rede e regra de"
        " firewall da descoberta; só valem numa instalação nova pelo conectar",
    )
    try:
        marker.write_text(POWER_SETTINGS_VERSION, encoding="ascii")
    except OSError:
        return


def _prepare_legacy_takeover(root: Path, legacy_source: Path, *, register_task: bool) -> bool:
    """Deixa o lançador resiliente antes de tirar a pasta legada do lugar."""
    launcher = legacy_source / "tools" / "launcher.ps1"
    if not _copy_launcher(launcher, root / "launcher.ps1"):
        # Um chamador de teste pode migrar só os dados em uma pasta temporária; na instalação
        # real, sem o lançador novo não é seguro tirar `agent-src` do caminho da tarefa antiga.
        return not register_task
    # Em testes temporários não há tarefa do Windows para alterar. Na instalação real, falhar ao
    # reconfigurá-la é motivo para adiar a troca: o wrapper velho continua funcional.
    return not register_task or _register_launcher_task(root)


def _install_launcher(
    root: Path, *, start_now: bool, real: bool = False, anchor: Path | None = None
) -> None:
    """Finaliza a promoção depois que `app` já existe.

    O lançador e o `launcher.vbs` ficam na pasta fixa (`anchor`, a subpasta UniOver de
    `%LOCALAPPDATA%`): é onde a tarefa agendada os procura, mesmo que o dono tenha escolhido
    outra pasta para o resto.
    """
    anchor = anchor if anchor is not None else root
    launcher = root / "app" / "tools" / "launcher.ps1"
    runner = root / "app" / "tools" / "run-agent.ps1"
    if not launcher.is_file() or not runner.is_file():
        return
    try:
        if not _copy_launcher(launcher, anchor / "launcher.ps1"):
            return
        fallback = root / "run-agent.fallback.ps1"
        if not fallback.exists() and not _copy_launcher(runner, fallback):
            return
        if os.name == "nt" and real and _is_real_installation(anchor):
            _ensure_hidden_launcher_task(root, anchor)
            _apply_power_settings(root)
        if os.name == "nt" and start_now:
            # A tarefa antiga ainda está executando `agent-src`. Sobe o lançador novo fora
            # dela antes de o processo atual terminar; assim a atualização seguinte já usa
            # `app\tools\run-agent.ps1` e não depende de novo logon. O WScript é um programa de
            # janela (sem console): ele cria o PowerShell oculto, então nada pisca na tela. Se o
            # Script Host não funcionar neste PC, o PowerShell oculto sobe o mesmo lançador.
            if _write_launcher_vbs(anchor) and _windows_script_host_works(root):
                command = [_wscript(), "//B", "//Nologo", str(anchor / "launcher.vbs")]
            else:
                command = [
                    _powershell(),
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-WindowStyle",
                    "Hidden",
                    "-File",
                    str(anchor / "launcher.ps1"),
                ]
            popen_hidden(command, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
            os.environ["UNIOVER_LEGACY_TAKEOVER"] = "1"
    except OSError:
        # O agente que já está rodando não pode parar porque a troca do lançador falhou.
        return


def _write_readme(root: Path) -> None:
    text = (
        "UniOver\n\n"
        "Esta pasta guarda o UniOver deste computador: o programa que liga o PC ao app e a TV.\n"
        "Ele inicia sozinho quando voce entra no Windows, fica perto do relogio e se atualiza e\n"
        "se arruma sozinho.\n\n"
        "O que tem aqui (voce nao precisa mexer em nada):\n"
        "  app       o programa em si (troca sozinho a cada atualizacao; a versao anterior fica\n"
        "            guardada ao lado)\n"
        "  config    suas configuracoes\n"
        "  logs      o que o UniOver fez e o que deu errado (agent.log, supervisor.log,\n"
        "            instalacao.log)\n"
        "  runtime   o que ele precisa para funcionar e o estado das atualizacoes\n"
        "  web       a pagina de conexao\n"
        "  tv        a chave de acesso a sua TV\n"
        "  icons     as figuras dos apps da TV\n\n"
        "Se algo nao funcionar, rode de novo o arquivo conectar-uniover.cmd.\n"
        "Para remover, execute o instalador com -Uninstall e, se quiser, apague esta pasta.\n"
    )
    try:
        (root / "LEIA-ME.txt").write_text(text, encoding="utf-8")
    except OSError:
        return
