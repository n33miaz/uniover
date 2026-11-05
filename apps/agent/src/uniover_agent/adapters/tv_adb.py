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

from uniover_agent.adapters.adb_authorization import AdbAuthorization
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
    is_user_initiated,
)
from uniover_agent.ports.tv_livre import ShellResult

_log = logging.getLogger(__name__)

DEFAULT_PORT: Final = 5555
DEFAULT_TIMEOUT_SECONDS: Final = 5.0
# Passos administrativos do TV Livre podem fazer o Android reorganizar a Home e demorar mais
# que uma tecla. O limite curto continua valendo para os comandos do controle.
LIVRE_SHELL_TIMEOUT_SECONDS: Final = 15.0
# Depois de uma falha de conexão, o caminho preguiçoso (comando sem canal aberto) espera isto
# antes de tentar de novo; a abertura explícita da sessão sempre tenta.
DEFAULT_RETRY_AFTER_SECONDS: Final = 30.0
DEFAULT_KILL_SERVER_COOLDOWN_SECONDS: Final = 600.0
# Quantos tempos esgotados seguidos fazem conferir se o servidor do `adb` está travado.
KILL_SERVER_AFTER_TIMEOUTS: Final = 3
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

# O Android 11+ revoga a permissão do ADB que ficou 7 dias sem uso (`adb_allowed_connection_time`,
# em milissegundos); 0 desliga o vencimento (AOSP, `AdbDebuggingManager.AdbKeyStore`). Comandos
# fixos, sem dado externo, que só rodam no fim de um pedido da pessoa (`_finish_pairing_locked`).
_AUTH_TIMEOUT_SETTING: Final = "adb_allowed_connection_time"
_DISABLE_AUTH_TIMEOUT: Final = f"settings put global {_AUTH_TIMEOUT_SETTING} 0"
_READ_AUTH_TIMEOUT: Final = f"settings get global {_AUTH_TIMEOUT_SETTING}"
# Depois de um pedido da pessoa que deixou o aviso na tela da TV: quanto tempo (e de quanto em
# quanto) o agente só lê o estado esperando o aceite, e quantas vezes confirma a permissão gravada.
DEFAULT_PAIRING_WATCH_SECONDS: Final = 90.0
DEFAULT_PAIRING_POLL_SECONDS: Final = 3.0
_READ_SERIAL: Final = "getprop ro.serialno"
_SERIAL: Final = re.compile(r"[A-Za-z0-9._-]{3,64}")
_SERIAL_UNAVAILABLE: Final = "-"
_UNAUTHORIZED_MESSAGE: Final = "a TV ainda não autorizou este PC no ADB"
_GATED_MESSAGE: Final = "a TV ainda não deu ao UniOver a permissão do ADB; peça pelo app"

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
        kill_server: bool = False,
        kill_server_cooldown: float = DEFAULT_KILL_SERVER_COOLDOWN_SECONDS,
        runner: Runner | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        authorization: AdbAuthorization | None = None,
        pairing_watch_seconds: float = DEFAULT_PAIRING_WATCH_SECONDS,
        pairing_poll_seconds: float = DEFAULT_PAIRING_POLL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        mac_resolver: Callable[[], Awaitable[str | None]] | None = None,
    ) -> None:
        self._adb = str(adb_path)
        self._serial = f"{host}:{port}"
        self._timeout = timeout
        self._retry_after = retry_after
        self._pull_timeout = pull_timeout
        # O servidor do `adb` é do PC inteiro (outro projeto, um emulador): só se mexe nele se o
        # dono liga a opção, e mesmo assim só quando o próprio servidor não responde.
        self._kill_server = kill_server
        self._kill_server_cooldown = kill_server_cooldown
        self._run: Runner = runner or run_process
        self._monotonic = monotonic
        # Um comando por vez: o `adb` só atende bem um cliente e a TV tem pouca memória.
        self._lock = asyncio.Lock()
        self._connected = False
        self._blocked_until = 0.0
        self._blocked_error: AdbError | None = None
        # A TV já negou a autorização e o dono ainda não a deu (só uma leitura `device` apaga).
        self._authorization_pending = False
        # Sem isto o adaptador é o de sempre (diagnósticos da linha de comando); com isto, o agente
        # só conecta sozinho a uma TV que já deu a permissão a esta chave (ver `adb_authorization`).
        self._authorization = authorization
        self._pairing_watch_seconds = pairing_watch_seconds
        self._pairing_poll_seconds = pairing_poll_seconds
        self._sleep = sleep
        # MAC da TV pela tabela ARP (sem ADB): sem ele a identidade da TV não se confirma, e o
        # agente nunca conecta sozinho.
        self._mac_resolver = mac_resolver
        self._pairing_task: asyncio.Task[None] | None = None
        self._timeout_streak = 0
        self._last_kill_server_at: float | None = None
        self._disconnect_task: asyncio.Task[None] | None = None
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
        self._connected = False
        if self._lock.locked():
            if self._disconnect_task is None or self._disconnect_task.done():
                self._disconnect_task = asyncio.create_task(self._disconnect_when_available())
            return
        async with self._lock:
            await self._disconnect_locked()

    async def _disconnect_when_available(self) -> None:
        async with self._lock:
            if self._connected:
                # Outra abertura aconteceu enquanto isto esperava a trava: não a derruba.
                return
            await self._disconnect_locked()
            self._connected = False

    async def aclose(self) -> None:
        """Encerramento do agente: cancela o `disconnect` adiado e a espera do aceite."""
        pending = [self._disconnect_task, self._pairing_task]
        self._disconnect_task = self._pairing_task = None
        for task in pending:
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def _disconnect_locked(self) -> None:
        try:
            await self._exec("disconnect", self._serial)
        except AdbError as exc:
            _log.debug("adb disconnect não confirmou: %s", exc.message)

    async def _identity_mac(self) -> str | None:
        """O MAC da TV de agora (ARP, sem ADB); `None` se a TV não atende ou não há resolvedor."""
        if self._mac_resolver is None:
            return None
        return await self._mac_resolver()

    async def _may_connect(self) -> bool:
        """Pode abrir uma conexão nova agora? Nunca, sozinho, sem a permissão provada **desta** TV.

        Um `adb connect` a uma TV que não conhece a chave faz aparecer o aviso "Permitir depuração
        USB". Só o pedido explícito da pessoa (`is_user_initiated`) ou uma permissão provada para
        esta chave, este endereço e este aparelho (o MAC pela ARP) liberam a conexão. Sem registro
        de autorização (diagnósticos da linha de comando) o adaptador não impõe nada. TV que
        não atende na rede levanta `AdbUnreachable`: conectar seria inútil e nada aparece nela.
        """
        authorization = self._authorization
        if authorization is None or is_user_initiated():
            return True
        if not authorization.key_and_endpoint_match():
            return False
        mac = await self._identity_mac()
        if mac is None:
            raise AdbUnreachable("a TV não respondeu na rede")
        return authorization.verified_for(mac)

    async def _refuse_connect_locked(self) -> None:
        """Sem conectar: só lê o estado. `device` (aviso aceito) abre o canal; senão, recusa."""
        try:
            state = parse_device_state((await self._exec("-s", self._serial, "get-state")).text)
        except AdbTimeout:
            state = DeviceState.NOT_FOUND
        if state is DeviceState.DEVICE:
            # Um transporte vivo serve ao canal, mas nada é registrado: pode ser um "Permitir" de
            # uma vez só, e o agente não abre outra conexão por conta própria.
            self._blocked_error = None
            self._authorization_pending = False
            self._timeout_streak = 0
            self._connected = True
            return
        self._authorization_pending = True
        raise AdbUnauthorized(_GATED_MESSAGE)

    def _note_unauthorized(self) -> None:
        self._authorization_pending = True
        if self._authorization is not None:
            # A TV pediu o aviso de novo (reset, revogação, outra chave): nada conecta sozinho até
            # um pedido da pessoa, mesmo depois de um reinício.
            self._authorization.mark_needs_permission()

    async def _finish_pairing_locked(self) -> None:
        """Com a permissão dada e a TV atendendo: desliga o vencimento (uma vez) e anota o serial.

        Só comandos fixos de ajuste e leitura, sobre um transporte já autorizado: nenhuma conexão
        nova, nenhuma tecla.
        """
        authorization = self._authorization
        if authorization is None or not authorization.has_grant():
            return
        if authorization.timeout_step_pending():
            await self._disable_timeout_locked(authorization)
        if not authorization.record.serial:
            await self._record_serial_locked(authorization)

    async def _disable_timeout_locked(self, authorization: AdbAuthorization) -> None:
        try:
            await self._shell(_DISABLE_AUTH_TIMEOUT)
            value = parse_setting_value((await self._shell(_READ_AUTH_TIMEOUT)).text)
        except AdbError as exc:
            authorization.note_timeout_attempt()
            _log.info("não consegui desligar o vencimento da permissão do ADB (%s)", exc.code)
            return
        if value == "0":
            authorization.mark_timeout_disabled()
            _log.info("vencimento da permissão do ADB desligado nesta TV")
        else:
            authorization.note_timeout_attempt()
            _log.info("a TV não aceitou desligar o vencimento da permissão do ADB")

    async def _read_serial_locked(self) -> str | None:
        output = await self._shell(_READ_SERIAL)
        lines = [line.strip() for line in output.text.splitlines() if line.strip()]
        value = lines[-1] if lines else ""
        return value if _SERIAL.fullmatch(value) else None

    async def _record_serial_locked(self, authorization: AdbAuthorization) -> None:
        try:
            serial = await self._read_serial_locked()
        except AdbError as exc:
            _log.debug("serial da TV não lido (%s)", exc.code)
            return
        authorization.note_serial(serial or _SERIAL_UNAVAILABLE)

    async def keep_authorization_fresh(self) -> str:
        """Aperto de mão autorizado (`connect` e `get-state`) que zera a contagem de 7 dias da TV.

        Só com a permissão provada e a identidade da TV conferida: nunca abre o aviso. Se o serial
        anotado não é o do aparelho que respondeu, a permissão é invalidada.

        Devolve `fresh`, `skipped` (sem permissão provada), `unauthorized` ou `unreachable`.
        """
        authorization = self._authorization
        if authorization is None or not authorization.key_and_endpoint_match():
            return "skipped"
        async with self._lock:
            was_connected = self._connected
            try:
                await self._connect_locked()
            except AdbUnauthorized:
                return "unauthorized"
            except AdbError:
                return "unreachable"
            authorization.touch_handshake()
            known = authorization.record.serial
            if known and known != _SERIAL_UNAVAILABLE and not await self._serial_matches(known):
                authorization.mark_needs_permission()
                self._connected = False
                await self._disconnect_locked()
                return "unauthorized"
            if not was_connected:
                # Quem abre a sessão reconecta; fechar aqui deixa a TV como estava.
                self._connected = False
                await self._disconnect_locked()
        return "fresh"

    async def _serial_matches(self, known: str) -> bool:
        try:
            return await self._read_serial_locked() in (known, None)
        except AdbError:
            return True  # sem leitura não há prova de troca de aparelho

    async def _needs_proof(self) -> bool:
        """Falta provar que a TV guardou a permissão (só o pedido da pessoa pode provar)."""
        authorization = self._authorization
        if authorization is None:
            return False
        return not authorization.verified_for(await self._identity_mac())

    async def _handshake_locked(self) -> tuple[AdbOutput, DeviceState]:
        joined = await self._exec("connect", self._serial)
        if connect_was_refused_for_auth(joined.text):
            raise AdbUnauthorized(_UNAUTHORIZED_MESSAGE)
        if not parse_connect(joined.text):
            raise AdbUnreachable("a TV não respondeu pelo ADB")
        state = parse_device_state((await self._exec("-s", self._serial, "get-state")).text)
        return joined, state

    async def _connect_locked(self) -> None:
        self._connected = False
        try:
            allowed = await self._may_connect()
        except AdbUnreachable as exc:
            self._remember_failure(exc)
            raise
        if not allowed:
            await self._refuse_connect_locked()
            return
        authorization = self._authorization
        # A chave de **antes** da conexão: se o `adbkey` mudar no meio (o Android Studio mexe nele),
        # nada é registrado nem guardado em nome da chave errada.
        snapshot = authorization.snapshot_key() if authorization is not None else None
        try:
            joined, state = await self._handshake_locked()
            stale = "already connected" in joined.text
            # `offline` pede refazer a conexão. Com `unauthorized`, uma conexão nova faria a TV
            # mostrar de novo o aviso "Permitir depuração USB" sem ninguém ter pedido. A exceção é o
            # pedido da pessoa sobre uma permissão ainda não provada: um transporte que já estava
            # `device` pode ser um "Permitir" de uma vez só, e só uma conexão nova mostra isso.
            if stale and (
                state is DeviceState.OFFLINE
                or (
                    state is DeviceState.DEVICE
                    and is_user_initiated()
                    and await self._needs_proof()
                )
            ):
                await self._exec("disconnect", self._serial)
                joined, state = await self._handshake_locked()
        except AdbTimeout:
            # Na abertura, tempo esgotado é "a TV não respondeu": nenhum comando foi executado.
            error: AdbError = AdbUnreachable("a TV não respondeu pelo ADB")
            self._remember_failure(error)
            raise error from None
        except AdbError as exc:
            self._remember_failure(exc)
            if isinstance(exc, AdbUnauthorized):
                self._watch_for_acceptance(snapshot)
            raise
        if state is DeviceState.DEVICE:
            self._blocked_error = None
            self._authorization_pending = False
            self._timeout_streak = 0
            self._connected = True
            if authorization is not None and is_user_initiated():
                # Conexão nova, pedida pela pessoa, atendida sem aviso: ficou gravada.
                authorization.mark_verified(snapshot, await self._identity_mac())
            if is_user_initiated():
                await self._finish_pairing_locked()
            return
        failure: AdbError = (
            AdbUnauthorized("a TV ainda não autorizou este PC no ADB")
            if state is DeviceState.UNAUTHORIZED
            else AdbUnreachable("a TV não respondeu pelo ADB")
        )
        self._remember_failure(failure)
        if state in (DeviceState.UNAUTHORIZED, DeviceState.OFFLINE):
            self._watch_for_acceptance(snapshot)
        raise failure

    def _watch_for_acceptance(self, snapshot: str | None) -> None:
        """Pedido da pessoa que deixou o aviso na tela: espera o aceite lendo só o estado (90 s)."""
        if self._authorization is None or not is_user_initiated():
            return
        task = self._pairing_task
        if task is None or task.done():
            self._pairing_task = asyncio.create_task(self._acceptance_watch(snapshot))

    async def _acceptance_watch(self, snapshot: str | None) -> None:
        """Vê o aceite da pessoa e aproveita o transporte vivo; **nunca** conecta nem desconecta.

        Só `get-state`. Quando a TV diz `device`, registra a permissão como `granted` (ainda não
        provada), desliga o vencimento de 7 dias e anota o serial, tudo por comandos fixos sobre o
        transporte já autorizado. A prova (uma conexão nova) só acontece num pedido seguinte da
        pessoa: se o "Sempre permitir" não foi marcado, o aviso volta quando ela tocar de novo, e
        não sozinho. Esta tarefa não leva a marca de pedido da pessoa.
        """
        authorization = self._authorization
        if authorization is None:
            return
        poll = max(self._pairing_poll_seconds, 0.001)
        waited = 0.0
        while waited < self._pairing_watch_seconds:
            await self._sleep(poll)
            waited += poll
            try:
                async with self._lock:
                    output = await self._exec("-s", self._serial, "get-state")
                    if parse_device_state(output.text) is not DeviceState.DEVICE:
                        continue
                    mac = await self._identity_mac()
                    if not authorization.mark_granted(snapshot, mac):
                        return
                    self._blocked_error = None
                    self._authorization_pending = False
                    self._connected = True
                    await self._finish_pairing_locked()
                    return
            except AdbError as exc:
                _log.debug("espera do aceite do ADB: %s", exc.code)

    def _remember_failure(self, error: AdbError) -> None:
        # Só "não abriu" pausa novas tentativas automáticas; tempo estourado não é diagnóstico.
        if isinstance(error, AdbUnauthorized):
            self._note_unauthorized()
        if isinstance(error, AdbUnauthorized | AdbUnreachable | AdbUnavailable):
            self._blocked_error = error
            self._blocked_until = self._monotonic() + self._retry_after
        else:
            self._blocked_error = None

    async def _ensure_connected_locked(self) -> None:
        if self._connected:
            if is_user_initiated():
                if await self._needs_proof():
                    # Transporte vivo sem prova de permissão gravada: a pessoa pediu, então confere.
                    await self._disconnect_locked()
                    await self._connect_locked()
                else:
                    await self._finish_pairing_locked()
            return
        if self._blocked_error is not None and self._monotonic() < self._blocked_until:
            if isinstance(self._blocked_error, AdbUnauthorized):
                # O dono pode ter aceitado o aviso agora: conferir o estado não abre conexão.
                state = parse_device_state((await self._exec("-s", self._serial, "get-state")).text)
                if state is DeviceState.DEVICE:
                    self._blocked_error = None
                    self._authorization_pending = False
                    self._connected = True
                    return
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

        Se a TV já negou a autorização e o dono ainda não a deu, **não conecta**: uma conexão nova
        faz a TV mostrar de novo o aviso "Permitir depuração USB" sem ninguém ter pedido. Só se lê
        o estado (`get-state`); sem `device`, levanta `AdbUnauthorized`.
        """
        async with self._lock:
            if self._authorization_pending:
                state = parse_device_state((await self._exec("-s", self._serial, "get-state")).text)
                if state is not DeviceState.DEVICE:
                    failure = AdbUnauthorized("a TV ainda não autorizou este PC no ADB")
                    self._remember_failure(failure)
                    raise failure
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
                self._note_unauthorized()
                raise AdbUnauthorized(_UNAUTHORIZED_MESSAGE)
            if state in (DeviceState.OFFLINE, DeviceState.NOT_FOUND):
                self._connected = False
                raise AdbUnreachable("a conexão ADB com a TV caiu")
            raise AdbCommandFailed("a TV não entregou o arquivo")
        # O código de saída 0 não garante o arquivo: confere que ele existe e não está vazio.
        if await asyncio.to_thread(_is_empty_or_missing, local_path):
            raise AdbCommandFailed("a TV não entregou o arquivo")

    # --- TV Livre -----------------------------------------------------------------------------
    # O núcleo monta comandos fixos e validados (`core/tv/livre.py`); aqui só se executa, na mesma
    # trava dos demais comandos.

    async def shell(self, command: str) -> ShellResult:
        async with self._lock:
            await self._ensure_connected_locked()
            output = await self._shell(command, timeout=LIVRE_SHELL_TIMEOUT_SECONDS)
        return ShellResult(output.returncode == 0, output.text)

    async def push(self, local: Path, remote: str) -> None:
        async with self._lock:
            await self._ensure_connected_locked()
            output = await self._exec(
                "-s", self._serial, "push", str(local), remote, timeout=self._pull_timeout
            )
        if output.returncode != 0:
            raise AdbCommandFailed("a TV não recebeu o arquivo")

    async def install(self, apk: Path) -> ShellResult:
        async with self._lock:
            await self._ensure_connected_locked()
            output = await self._exec(
                "-s", self._serial, "install", "-r", str(apk), timeout=self._pull_timeout
            )
        return ShellResult(output.returncode == 0, output.text)

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

    async def _shell(
        self,
        command: str,
        *,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> AdbOutput:
        """Um comando fixo no shell da TV. Se o canal caiu, marca e avisa (o próximo reconecta)."""
        try:
            output = await self._exec("-s", self._serial, "shell", command, timeout=timeout)
        except AdbTimeout:
            self._connected = False
            raise
        state = parse_device_state(output.text) if output.returncode != 0 else DeviceState.DEVICE
        if state is DeviceState.UNAUTHORIZED:
            self._connected = False
            self._note_unauthorized()
            raise AdbUnauthorized(_UNAUTHORIZED_MESSAGE)
        if state in (DeviceState.OFFLINE, DeviceState.NOT_FOUND):
            self._connected = False
            raise AdbUnreachable("a conexão ADB com a TV caiu")
        return output

    async def _exec(self, *args: str, timeout: float | None = None) -> AdbOutput:  # noqa: ASYNC109
        if self._authorization is not None:
            # Antes de qualquer `adb`: se o `adbkey` sumiu, ele gera outro e a TV pergunta de novo.
            self._authorization.prepare()
        try:
            output = await self._run([self._adb, *args], timeout or self._timeout)
        except TimeoutError:
            # Pode ter executado ou não: ao reconectar no próximo pedido o canal se refaz. Cópia
            # lenta de APK não prova que o canal caiu: ela só falha, sem derrubar os comandos.
            if timeout is None:
                self._connected = False
            await self._restart_server_after_timeouts()
            raise AdbTimeout("a TV demorou demais para responder ao ADB") from None
        except FileNotFoundError:
            raise AdbUnavailable("o adb não foi encontrado neste PC") from None
        except OSError as exc:
            _log.warning("não foi possível executar o adb (%s)", type(exc).__name__)
            raise AdbUnavailable(
                "não foi possível executar o adb neste PC", transient=True
            ) from None
        # Só timeouts seguidos contam: qualquer resposta do `adb` prova que o servidor atende.
        self._timeout_streak = 0
        _log.debug(
            "adb %s -> código %d, %d caracteres", args[0], output.returncode, len(output.text)
        )
        return output

    async def _restart_server_after_timeouts(self) -> None:
        if not self._kill_server:
            return
        self._timeout_streak += 1
        now = self._monotonic()
        if self._timeout_streak < KILL_SERVER_AFTER_TIMEOUTS or (
            self._last_kill_server_at is not None
            and now - self._last_kill_server_at < self._kill_server_cooldown
        ):
            return
        self._timeout_streak = 0
        # TV desligada ou lenta também esgota o tempo: só o servidor mudo (nem `devices`, que
        # não fala com a TV, responde) justifica derrubá-lo.
        try:
            await self._run([self._adb, "devices"], self._timeout)
        except TimeoutError:
            hung = True
        except Exception:
            hung = False
        else:
            hung = False
        if not hung:
            return
        self._last_kill_server_at = now
        # O servidor novo não conhece a TV: o próximo pedido reconecta.
        self._connected = False
        try:
            await self._run([self._adb, "kill-server"], self._timeout)
        except Exception as exc:
            _log.info("adb kill-server não concluiu (%s)", type(exc).__name__)
