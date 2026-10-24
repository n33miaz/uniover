"""Layout persistente do agente instalado e migração sem perder o pareamento."""

import os
import shutil
import subprocess
from pathlib import Path


def _powershell() -> str:
    """Caminho do Windows PowerShell que acompanha o Windows (não depende do PATH)."""
    return os.path.join(
        os.environ["SystemRoot"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
    )


def installation_base() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    return (Path(local) if local else Path.home() / ".config") / "UniOver"


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
    _install_launcher(root, start_now=took_over_legacy_wrapper and can_take_over and base is None)
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


def _register_launcher_task(root: Path) -> bool:
    """Reaponta a tarefa do usuário, sem precisar de administrador."""
    command = "".join(
        (
            "$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ",
            "'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden ",
            '-File "$env:LOCALAPPDATA\\UniOver\\launcher.ps1"\';',
            "$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;",
            "$p=New-ScheduledTaskPrincipal -UserId $env:USERNAME ",
            "-LogonType Interactive -RunLevel Limited;",
            "$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) ",
            "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries ",
            "-MultipleInstances IgnoreNew -StartWhenAvailable;",
            "Register-ScheduledTask -TaskName 'UniOver agente' -Action $a -Trigger $t ",
            "-Principal $p -Settings $s -Force|Out-Null",
        )
    )
    try:
        result = subprocess.run(  # noqa: S603 - executável e script fixos, sem dados externos
            [_powershell(), "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
            check=False,
            capture_output=True,
            timeout=30,
        )
    except OSError, subprocess.TimeoutExpired:
        return False
    return result.returncode == 0


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


def _install_launcher(root: Path, *, start_now: bool) -> None:
    """Finaliza a promoção depois que `app` já existe."""
    launcher = root / "app" / "tools" / "launcher.ps1"
    runner = root / "app" / "tools" / "run-agent.ps1"
    if not launcher.is_file() or not runner.is_file():
        return
    try:
        if not _copy_launcher(launcher, root / "launcher.ps1"):
            return
        fallback = root / "run-agent.fallback.ps1"
        if not fallback.exists() and not _copy_launcher(runner, fallback):
            return
        if os.name == "nt" and start_now:
            # A tarefa antiga ainda está executando `agent-src`. Sobe o lançador novo fora
            # dela antes de o processo atual terminar; assim a atualização seguinte já usa
            # `app\tools\run-agent.ps1` e não depende de novo logon.
            subprocess.Popen(  # noqa: S603 - executável e argumentos fixos
                [
                    _powershell(),
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-WindowStyle",
                    "Hidden",
                    "-File",
                    str(root / "launcher.ps1"),
                ],
                creationflags=subprocess.DETACHED_PROCESS,
            )
            os.environ["UNIOVER_LEGACY_TAKEOVER"] = "1"
    except OSError:
        # O agente que já está rodando não pode parar porque a troca do lançador falhou.
        return


def _write_readme(root: Path) -> None:
    text = (
        "UniOver\n\n"
        "Esta pasta guarda o agente que conecta este computador ao UniOver e a TV.\n"
        "Ele inicia sozinho e se atualiza automaticamente.\n\n"
        "Se algo nao funcionar, rode de novo o conectar-uniover.cmd.\n"
        "Para remover, execute o instalador com -Uninstall e depois apague esta pasta se quiser.\n"
    )
    try:
        (root / "LEIA-ME.txt").write_text(text, encoding="utf-8")
    except OSError:
        return
