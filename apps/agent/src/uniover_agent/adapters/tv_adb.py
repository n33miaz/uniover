"""Canal ADB da TV pelo `adb` do próprio PC (um processo por comando, sem shell, um de cada vez).

Regras que moldam este adaptador:

* **um só cliente ADB**: quem segura a conexão com a TV é o servidor do `adb` local; aqui só se roda
  o executável. Todos os comandos passam por uma trava, então nunca há dois ao mesmo tempo;
* **sem shell no Windows**: o `argv` vai em lista. Como o que vem depois de `adb shell` roda no
  shell da TV, todo dado externo é validado e o texto digitado vai entre aspas simples (ver
  `tv_adb_parsing`);
* a queda não é detectada por adivinhação: um comando que falha marca o canal como caído e o próximo
  pedido reconecta. Depois de uma falha de conexão o adaptador espera um pouco antes de tentar de
  novo por conta própria (quem digita letra a letra não paga uma reconexão por tecla);
* mensagens de erro são fixas: nunca o caminho do `adb` nem a saída crua.
"""

import asyncio
import logging
import os
import re
import shutil
import sys
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Final

from uniover_agent.adapters.process import exec_hidden
from uniover_agent.adapters.tv_adb_parsing import (
    AdbOutput,
    DeviceState,
    am_start_succeeded,
    command_succeeded,
    connect_was_refused_for_auth,
    input_text_command,
    is_valid_activity,
    is_valid_package,
    is_valid_remote_apk_path,
    monkey_succeeded,
    parse_component_packages,
    parse_connect,
    parse_device_state,
    parse_dumpsys_music_volume,
    parse_launchable,
    parse_media_session_volume,
    parse_mem_available_mb,
    parse_package_list,
    parse_package_paths,
    parse_package_versions,
    parse_playback_sessions,
    parse_running_packages,
    parse_setting_value,
    quote_for_device_shell,
)
from uniover_agent.ports import (
    AdbCommandFailed,
    AdbError,
    AdbTimeout,
    AdbUnauthorized,
    AdbUnavailable,
    AdbUnreachable,
    LaunchableApp,
)

_log = logging.getLogger(__name__)

DEFAULT_PORT: Final = 5555
DEFAULT_TIMEOUT_SECONDS: Final = 5.0
# Depois de uma falha de conexão, o caminho preguiçoso (comando sem canal aberto) espera isto
# antes de tentar de novo; a abertura explícita da sessão sempre tenta.
DEFAULT_RETRY_AFTER_SECONDS: Final = 30.0
# Copiar um APK leva segundos (o do CineVS, 52 MB, levou ~10 s): bem mais que um comando curto.
DEFAULT_PULL_TIMEOUT_SECONDS: Final = 120.0

_ADB_EXECUTABLE: Final = "adb.exe" if sys.platform == "win32" else "adb"
_LEANBACK: Final = "android.intent.category.LEANBACK_LAUNCHER"
_LAUNCHER: Final = "android.intent.category.LAUNCHER"
_HOME: Final = "android.intent.category.HOME"
_MAX_TEXT_LENGTH: Final = 200
# Estados de `PlaybackState` que a leitura de mídia entende (none, stopped, paused, playing, error);
# qualquer outro número é leitura ambígua. 3 é "tocando".
_PLAYBACK_STATES: Final = frozenset({0, 1, 2, 3, 7})
_PLAYBACK_PLAYING: Final = 3
# Serviço do controle remoto da Android TV (portas 6466 e 6467). Os comandos de religar são os do
# `reparar` do projeto da TV do dono (`ESP32/01-controle-tv/tv.ps1`): proteger o serviço do
# matador de processos por falta de memória e iniciá-lo de novo. Fixos, sem dado externo.
_REMOTE_SERVICE: Final = "com.google.android.tv.remote.service"
_SHIELD_REMOTE_SERVICE: Final = (
    f"dumpsys deviceidle whitelist +{_REMOTE_SERVICE}",
    f"cmd appops set {_REMOTE_SERVICE} RUN_ANY_IN_BACKGROUND allow",
    f"am set-standby-bucket {_REMOTE_SERVICE} active",
)
_START_REMOTE_SERVICE: Final = (
    "am start-foreground-service -a com.android.athome.START_SERVICE "
    f"-n {_REMOTE_SERVICE}/.RemoteService"
)
_GLOBAL_SETTINGS: Final = frozenset(
    {"window_animation_scale", "transition_animation_scale", "animator_duration_scale"}
)
# Decimal sem sinal nem expoente: o que o Android guarda nas escalas de animação.
_DECIMAL: Final = re.compile(r"\d{1,6}(?:\.\d{1,6})?")
_SHORT_ANIMATION_SCALE: Final = "0.5"
_APP_BACKGROUND_MODES: Final = frozenset({"allow", "ignore", "default"})

Runner = Callable[[Sequence[str], float], Awaitable[AdbOutput]]


def locate_adb(configured: str | None) -> Path | None:
    """Acha o `adb`: o caminho configurado, senão o `PATH`, senão o `platform-tools` do Android SDK.

    Caminho configurado que não existe **não** cai nos outros: foi uma escolha explícita errada.
    """
    if configured:
        path = Path(configured)
        return path if path.is_file() else None
    on_path = shutil.which("adb")
    if on_path:
        return Path(on_path)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        sdk = Path(local) / "Android" / "Sdk" / "platform-tools" / _ADB_EXECUTABLE
        if sdk.is_file():
            return sdk
    return None


async def run_process(argv: Sequence[str], seconds: float) -> AdbOutput:
    """Roda o processo sem shell e devolve a saída; tempo estourado mata e levanta `TimeoutError`.

    O `adb` pode ter de subir o servidor dele na primeira chamada; o tempo vale para tudo isso.
    """
    # Sem janela: o `adb` não pode piscar um console a cada comando.
    process = await exec_hidden(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), seconds)
    except BaseException:
        # Tempo estourado ou cancelamento: não deixa o processo (nem o servidor que ele subiu)
        # segurando os canos.
        if process.returncode is None:
            process.kill()
        await asyncio.shield(process.wait())
        raise
    text = (
        stdout.decode("utf-8", errors="replace") + "\n" + stderr.decode("utf-8", errors="replace")
    )
    return AdbOutput(process.returncode if process.returncode is not None else -1, text)


def _is_empty_or_missing(path: Path) -> bool:
    try:
        return path.stat().st_size == 0
    except OSError:
        return True


class AdbTv:
    """Implementa `TvAdb` com o `adb` do PC."""

    def __init__(  # noqa: PLR0913 - todas são configuração independente
        self,
        adb_path: Path,
        host: str,
        port: int = DEFAULT_PORT,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        retry_after: float = DEFAULT_RETRY_AFTER_SECONDS,
        pull_timeout: float = DEFAULT_PULL_TIMEOUT_SECONDS,
        runner: Runner | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._adb = str(adb_path)
        self._serial = f"{host}:{port}"
        self._timeout = timeout
        self._retry_after = retry_after
        self._pull_timeout = pull_timeout
        self._run: Runner = runner or run_process
        self._monotonic = monotonic
        # Um comando por vez: o `adb` só atende bem um cliente e a TV tem pouca memória.
        self._lock = asyncio.Lock()
        self._connected = False
        self._blocked_until = 0.0
        self._blocked_error: AdbError | None = None
        # Quanto o último `input_text` esperou a trava (a lista de apps e as consultas de ícones a
        # seguram): entra no resumo da digitação para separar "trava ocupada" de "TV lenta".
        self.last_input_wait_seconds = 0.0

    @property
    def connected(self) -> bool:
        return self._connected

    # --- ciclo de vida ------------------------------------------------------------------------

    async def connect(self) -> None:
        """Abre o canal (idempotente): `adb connect` e confere com `get-state`."""
        async with self._lock:
            await self._connect_locked()

    async def disconnect(self) -> None:
        """Desconecta só esta TV (não mata o servidor do `adb`, que pode servir a outros usos)."""
        async with self._lock:
            self._connected = False
            try:
                await self._exec("disconnect", self._serial)
            except AdbError as exc:
                _log.debug("adb disconnect não confirmou: %s", exc.message)

    async def _connect_locked(self) -> None:
        self._connected = False
        try:
            joined = await self._exec("connect", self._serial)
            if connect_was_refused_for_auth(joined.text):
                raise AdbUnauthorized("a TV ainda não autorizou este PC no ADB")
            if not parse_connect(joined.text):
                raise AdbUnreachable("a TV não respondeu pelo ADB")
            state = parse_device_state((await self._exec("-s", self._serial, "get-state")).text)
        except AdbTimeout:
            # Na abertura, tempo esgotado é "a TV não respondeu": nenhum comando foi executado.
            error: AdbError = AdbUnreachable("a TV não respondeu pelo ADB")
            self._remember_failure(error)
            raise error from None
        except AdbError as exc:
            self._remember_failure(exc)
            raise
        if state is DeviceState.DEVICE:
            self._blocked_error = None
            self._connected = True
            return
        failure: AdbError = (
            AdbUnauthorized("a TV ainda não autorizou este PC no ADB")
            if state is DeviceState.UNAUTHORIZED
            else AdbUnreachable("a TV não respondeu pelo ADB")
        )
        self._remember_failure(failure)
        raise failure

    def _remember_failure(self, error: AdbError) -> None:
        # Só "não abriu" pausa novas tentativas automáticas; tempo estourado não é diagnóstico.
        if isinstance(error, AdbUnauthorized | AdbUnreachable | AdbUnavailable):
            self._blocked_error = error
            self._blocked_until = self._monotonic() + self._retry_after
        else:
            self._blocked_error = None

    async def _ensure_connected_locked(self) -> None:
        if self._connected:
            return
        if self._blocked_error is not None and self._monotonic() < self._blocked_until:
            raise type(self._blocked_error)(self._blocked_error.message)
        await self._connect_locked()

    # --- operações ----------------------------------------------------------------------------

    async def list_apps(self) -> list[LaunchableApp]:
        async with self._lock:
            await self._ensure_connected_locked()
            return await self._launchable_locked()

    async def launch_package(self, package: str, activity: str | None = None) -> None:
        if not is_valid_package(package):
            raise ValueError("nome de pacote inválido")
        if activity is not None and not is_valid_activity(activity):
            raise ValueError("nome de atividade inválido")
        async with self._lock:
            await self._ensure_connected_locked()
            if activity is None:
                for app in await self._launchable_locked():
                    if app.package == package and is_valid_activity(app.activity):
                        activity = app.activity
                        break
            if activity is not None:
                component = quote_for_device_shell(f"{package}/{activity}")
                started = await self._shell(f"am start -n {component}")
                if am_start_succeeded(started.text):
                    return
                _log.info("`am start` não abriu o app; tentando o lançador padrão")
            # Sem atividade conhecida (ou ela falhou): o lançador padrão do pacote.
            monkey = await self._shell(
                f"monkey -p {quote_for_device_shell(package)} -c {_LAUNCHER} 1"
            )
            if not monkey_succeeded(monkey.text):
                raise AdbCommandFailed("a TV não conseguiu abrir o app")

    async def input_text(self, text: str) -> None:
        if len(text) > _MAX_TEXT_LENGTH:
            raise ValueError("texto longo demais para o ADB")
        command = input_text_command(text)
        asked = self._monotonic()
        async with self._lock:
            self.last_input_wait_seconds = self._monotonic() - asked
            await self._ensure_connected_locked()
            await self._shell(command)

    # --- limpeza da TV ------------------------------------------------------------------------
    # Todos são comandos fixos (o único dado variável, o pacote, é validado e vai entre aspas). Um
    # por vez, na mesma trava dos demais: a limpeza não segura o canal entre um passo e outro.

    async def memory_available_mb(self) -> int | None:
        return parse_mem_available_mb(
            (await self._locked_shell("grep MemAvailable /proc/meminfo")).text
        )

    async def home_packages(self) -> frozenset[str]:
        output = await self._locked_shell(
            f"cmd package query-activities --brief -a android.intent.action.MAIN -c {_HOME}"
        )
        packages = frozenset(app.package for app in parse_launchable(output.text))
        if not packages:
            # Sem saber quem é o lançador a limpeza não pode decidir o que poupar.
            raise AdbCommandFailed("a TV não informou qual é a tela inicial")
        return packages

    async def input_method_package(self) -> str | None:
        output = await self._locked_shell("settings get secure default_input_method")
        self._require_success(output, "a TV não informou o teclado em uso")
        packages = parse_component_packages(parse_setting_value(output.text))
        return next(iter(packages), None)

    async def accessibility_packages(self) -> frozenset[str]:
        output = await self._locked_shell("settings get secure enabled_accessibility_services")
        self._require_success(output, "a TV não informou os serviços de acessibilidade")
        return parse_component_packages(parse_setting_value(output.text))

    async def running_packages(self) -> frozenset[str]:
        output = await self._locked_shell("ps -A")
        self._require_success(output, "a TV não informou os processos")
        packages = parse_running_packages(output.text)
        if not packages:
            # Uma TV ligada sempre tem processo de app: lista vazia é leitura que não deu certo.
            raise AdbCommandFailed("a TV não informou os processos")
        return packages

    async def _playback_sessions(self) -> list[tuple[str | None, int]]:
        """As sessões de mídia da TV; uma saída incompleta nunca vale como silêncio."""
        output = await self._locked_shell("dumpsys media_session")
        self._require_success(output, "a TV não informou a sessão de mídia")
        sessions = parse_playback_sessions(output.text)
        if not sessions or any(state not in _PLAYBACK_STATES for _, state in sessions):
            raise AdbCommandFailed("a TV informou uma sessão de mídia ambígua")
        return sessions

    async def media_playing(self) -> bool:
        """Há alguma sessão tocando, de qualquer app?"""
        return any(state == _PLAYBACK_PLAYING for _, state in await self._playback_sessions())

    async def playing_media_packages(self) -> frozenset[str]:
        """Os apps donos de uma sessão tocando; sessão tocando sem dono é leitura ambígua."""
        owners: set[str] = set()
        for package, state in await self._playback_sessions():
            if state != _PLAYBACK_PLAYING:
                continue
            if package is None:
                raise AdbCommandFailed("a TV informou uma sessão de mídia sem dono")
            owners.add(package)
        return frozenset(owners)

    async def read_volume(self) -> int | None:
        """O volume de música (0 a 100) pelo shell da TV; `None` se nenhum comando o informa.

        Reserva para a Android TV cujo canal remoto não empurra o nível (soundbar por HDMI-ARC/CEC,
        firmware que não manda). Só lê. Nunca levanta por saída que não entende: "não sei".
        """
        for command, parse in (
            ("cmd media_session volume --stream 3 --get", parse_media_session_volume),
            ("dumpsys audio", parse_dumpsys_music_volume),
        ):
            output = await self._locked_shell(command)
            if not command_succeeded(output):
                continue
            level = parse(output.text)
            if level is not None:
                return level
        return None

    async def diagnose_volume(self) -> list[tuple[str, bool, str]]:
        """Cada comando de leitura de volume e o que ele devolveu: (nome, deu nível, detalhe)."""
        found: list[tuple[str, bool, str]] = []
        for name, command, parse in (
            (
                "media_session",
                "cmd media_session volume --stream 3 --get",
                parse_media_session_volume,
            ),
            ("dumpsys-audio", "dumpsys audio", parse_dumpsys_music_volume),
        ):
            output = await self._locked_shell(command)
            if not command_succeeded(output):
                found.append((name, False, "o comando falhou ou não existe nesta TV"))
                continue
            level = parse(output.text)
            found.append(
                (
                    name,
                    level is not None,
                    "nível não encontrado na saída" if level is None else f"nível {level}",
                )
            )
        return found

    async def global_setting(self, name: str) -> str | None:
        if name not in _GLOBAL_SETTINGS:
            raise ValueError("configuração global inválida")
        output = await self._locked_shell(f"settings get global {name}")
        self._require_success(output, "a TV não informou a configuração")
        value = parse_setting_value(output.text)
        if value is not None and _DECIMAL.fullmatch(value) is None:
            # Um original que não se sabe devolver não pode ser guardado: nada é alterado.
            raise AdbCommandFailed("a TV informou um valor de animação que não é decimal")
        return value

    async def put_global_setting(self, name: str, value: str) -> None:
        """Aplica o ajuste leve: só a escala curta, nunca texto livre."""
        if name not in _GLOBAL_SETTINGS or value != _SHORT_ANIMATION_SCALE:
            raise ValueError("configuração global inválida")
        output = await self._locked_shell(f"settings put global {name} {value}")
        self._require_success(output, "a TV não conseguiu mudar a configuração")

    async def restore_global_setting(self, name: str, original: str | None) -> None:
        """Devolve o que `global_setting` leu (qualquer decimal) ou apaga o que não existia."""
        if name not in _GLOBAL_SETTINGS or (
            original is not None and _DECIMAL.fullmatch(original) is None
        ):
            raise ValueError("configuração global inválida")
        command = (
            f"settings delete global {name}"
            if original is None
            else f"settings put global {name} {original}"
        )
        output = await self._locked_shell(command)
        self._require_success(output, "a TV não conseguiu restaurar a configuração")

    async def app_background_mode(self, package: str) -> str | None:
        if not is_valid_package(package):
            raise ValueError("nome de pacote inválido")
        output = await self._locked_shell(
            f"cmd appops get {quote_for_device_shell(package)} RUN_ANY_IN_BACKGROUND"
        )
        self._require_success(output, "a TV não informou a permissão do app")
        match = re.search(r"RUN_ANY_IN_BACKGROUND:\s*(allow|ignore|default)\b", output.text)
        if match is not None:
            return match.group(1)
        if "RUN_ANY_IN_BACKGROUND" in output.text:
            raise AdbCommandFailed("a TV informou uma permissão de app ambígua")
        return None

    async def set_app_background_mode(self, package: str, mode: str) -> None:
        if not is_valid_package(package) or mode not in _APP_BACKGROUND_MODES:
            raise ValueError("configuração de app inválida")
        output = await self._locked_shell(
            f"cmd appops set {quote_for_device_shell(package)} RUN_ANY_IN_BACKGROUND {mode}"
        )
        self._require_success(output, "a TV não conseguiu mudar a permissão do app")

    async def go_home(self) -> None:
        output = await self._locked_shell("input keyevent KEYCODE_HOME")
        self._require_success(output, "a TV não foi para a tela inicial")

    async def kill_background(self) -> None:
        output = await self._locked_shell("am kill-all")
        self._require_success(output, "a TV não encerrou os processos de fundo")

    async def force_stop(self, package: str) -> None:
        if not is_valid_package(package):
            raise ValueError("nome de pacote inválido")
        output = await self._locked_shell(f"am force-stop {quote_for_device_shell(package)}")
        self._require_success(output, "a TV não fechou o app")

    async def trim_memory(self, package: str) -> None:
        if not is_valid_package(package):
            raise ValueError("nome de pacote inválido")
        output = await self._locked_shell(
            f"am send-trim-memory {quote_for_device_shell(package)} RUNNING_CRITICAL"
        )
        self._require_success(output, "a TV não reduziu a memória do app")

    async def restart_remote_service(self) -> None:
        """Religa o serviço do controle remoto da TV (o vigia chama quando as portas fecham).

        Conecta de novo antes (o estado guardado pode ser de antes de a TV reiniciar) e roda, numa
        só vez da trava, a proteção e a partida. Só a partida decide o resultado: a proteção é
        melhor esforço, e quem chama confere as portas depois.
        """
        async with self._lock:
            await self._connect_locked()
            for command in _SHIELD_REMOTE_SERVICE:
                await self._shell(command)
            output = await self._shell(_START_REMOTE_SERVICE)
        self._require_success(output, "a TV não religou o serviço do controle")

    # --- APKs (para os ícones) ----------------------------------------------------------------

    async def package_versions(self) -> dict[str, int]:
        """`versionCode` de todos os pacotes numa só consulta curta (com a trava)."""
        async with self._lock:
            await self._ensure_connected_locked()
            output = await self._shell("pm list packages --show-versioncode")
        return parse_package_versions(output.text)

    async def apk_paths(self, package: str) -> list[str]:
        if not is_valid_package(package):
            raise ValueError("nome de pacote inválido")
        async with self._lock:
            await self._ensure_connected_locked()
            output = await self._shell(f"pm path {quote_for_device_shell(package)}")
        return parse_package_paths(output.text)

    async def pull_apk(self, remote_path: str, local_path: Path) -> None:
        """Copia o APK **sem a trava**: o servidor do `adb` atende um `pull` junto com os `shell`.

        Assim uma tecla ou um texto digitado nunca espera a cópia. Aqui não se reconecta (isso é da
        trilha com trava): sem canal aberto a cópia falha e a lista de ícones é retomada depois.
        """
        if not is_valid_remote_apk_path(remote_path):
            raise ValueError("caminho de APK inválido")
        if not self._connected:
            raise AdbUnreachable("a conexão ADB com a TV não está aberta")
        output = await self._exec(
            "-s", self._serial, "pull", remote_path, str(local_path), timeout=self._pull_timeout
        )
        if output.returncode != 0:
            state = parse_device_state(output.text)
            if state is DeviceState.UNAUTHORIZED:
                self._connected = False
                raise AdbUnauthorized("a TV ainda não autorizou este PC no ADB")
            if state in (DeviceState.OFFLINE, DeviceState.NOT_FOUND):
                self._connected = False
                raise AdbUnreachable("a conexão ADB com a TV caiu")
            raise AdbCommandFailed("a TV não entregou o arquivo")
        # O código de saída 0 não garante o arquivo: confere que ele existe e não está vazio.
        if await asyncio.to_thread(_is_empty_or_missing, local_path):
            raise AdbCommandFailed("a TV não entregou o arquivo")

    # --- execução -----------------------------------------------------------------------------

    async def _launchable_locked(self) -> list[LaunchableApp]:
        for category in (_LEANBACK, _LAUNCHER):
            output = await self._shell(
                f"cmd package query-activities --brief -a android.intent.action.MAIN -c {category}"
            )
            apps = parse_launchable(output.text)
            if apps:
                return await self._mark_user_installed(apps)
        return []

    async def _mark_user_installed(self, apps: list[LaunchableApp]) -> list[LaunchableApp]:
        """Marca os apps que o dono instalou. Sem a resposta, a lista segue sem a marca."""
        try:
            output = await self._shell("pm list packages -3")
        except AdbTimeout:
            return apps
        user = parse_package_list(output.text)
        return [replace(app, user_installed=app.package in user) for app in apps]

    async def _locked_shell(self, command: str) -> AdbOutput:
        async with self._lock:
            await self._ensure_connected_locked()
            return await self._shell(command)

    @staticmethod
    def _require_success(output: AdbOutput, message: str) -> None:
        if not command_succeeded(output):
            raise AdbCommandFailed(message)

    async def _shell(self, command: str) -> AdbOutput:
        """Um comando fixo no shell da TV. Se o canal caiu, marca e avisa (o próximo reconecta)."""
        output = await self._exec("-s", self._serial, "shell", command)
        state = parse_device_state(output.text) if output.returncode != 0 else DeviceState.DEVICE
        if state is DeviceState.UNAUTHORIZED:
            self._connected = False
            raise AdbUnauthorized("a TV ainda não autorizou este PC no ADB")
        if state in (DeviceState.OFFLINE, DeviceState.NOT_FOUND):
            self._connected = False
            raise AdbUnreachable("a conexão ADB com a TV caiu")
        return output

    async def _exec(self, *args: str, timeout: float | None = None) -> AdbOutput:  # noqa: ASYNC109
        try:
            output = await self._run([self._adb, *args], timeout or self._timeout)
        except TimeoutError:
            # Pode ter executado ou não: ao reconectar no próximo pedido o canal se refaz. Cópia
            # lenta de APK não prova que o canal caiu: ela só falha, sem derrubar os comandos.
            if timeout is None:
                self._connected = False
            raise AdbTimeout("a TV demorou demais para responder ao ADB") from None
        except FileNotFoundError:
            raise AdbUnavailable("o adb não foi encontrado neste PC") from None
        except OSError as exc:
            _log.warning("não foi possível executar o adb (%s)", type(exc).__name__)
            raise AdbUnavailable("não foi possível executar o adb neste PC") from None
        _log.debug(
            "adb %s -> código %d, %d caracteres", args[0], output.returncode, len(output.text)
        )
        return output
