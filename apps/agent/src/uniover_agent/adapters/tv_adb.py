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
import shutil
import sys
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Final

from uniover_agent.adapters.tv_adb_parsing import (
    AdbOutput,
    DeviceState,
    am_start_succeeded,
    connect_was_refused_for_auth,
    input_text_command,
    is_valid_activity,
    is_valid_package,
    is_valid_remote_apk_path,
    monkey_succeeded,
    parse_connect,
    parse_device_state,
    parse_launchable,
    parse_package_list,
    parse_package_paths,
    parse_package_versions,
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
_MAX_TEXT_LENGTH: Final = 200
# No Windows o `adb` não pode abrir (e piscar) uma janela de console a cada comando.
_NO_WINDOW: Final = 0x08000000 if sys.platform == "win32" else 0

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
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=_NO_WINDOW,
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
        async with self._lock:
            await self._ensure_connected_locked()
            await self._shell(command)

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
