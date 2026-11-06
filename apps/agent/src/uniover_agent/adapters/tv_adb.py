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
from typing import Final, cast

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
    AdbIdentityUnconfirmed,
    AdbIdle,
    AdbTimeout,
    AdbUnauthorized,
    AdbUnavailable,
    AdbUnreachable,
    LaunchableApp,
    UserRequest,
    current_user_request,
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
# Ao encerrar o agente: quanto esperar a trava de uma operação em andamento antes de desconectar
# mesmo assim (o servidor do `adb` sobrevive ao agente e religaria uma conexão não provada).
DEFAULT_CLOSE_WAIT_SECONDS: Final = 2.0
# Quanto a hibernação espera para confirmar a identidade da TV antes de decidir se o canal fica
# (ela dá 5 s ao `disconnect` inteiro; sem confirmação, o canal se desfaz).
_STAY_CHECK_SECONDS: Final = 2.5
# Num pedido da pessoa sobre uma permissão já dada, o `get-state` logo depois do `connect` pode
# dizer `offline`/`authorizing` (conexão ainda subindo): relê por até este tempo, a cada
# `_SETTLE_POLL_SECONDS`, antes de concluir. `unauthorized` nunca é relido.
DEFAULT_SETTLE_SECONDS: Final = 3.0
_SETTLE_POLL_SECONDS: Final = 0.5
_TRANSIENT_STATES: Final = frozenset({DeviceState.OFFLINE, DeviceState.CONNECTING})
# MAC ainda não lido nesta operação (`None` já significa "a TV não atende").
_UNREAD: Final = object()
_READ_SERIAL: Final = "getprop ro.serialno"
_SERIAL: Final = re.compile(r"[A-Za-z0-9._-]{3,64}")
_SERIAL_UNAVAILABLE: Final = "-"
_UNAUTHORIZED_MESSAGE: Final = "a TV ainda não autorizou este PC no ADB"
_GATED_MESSAGE: Final = "a TV ainda não deu ao UniOver a permissão do ADB; peça pelo app"
_IDLE_MESSAGE: Final = "o ADB só abre conexão nova enquanto alguém usa a TV pelo app"
_IDENTITY_MESSAGE: Final = "não deu para confirmar qual aparelho responde aqui; peça pelo app"

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
        authorization: AdbAuthorization,
        mac_resolver: Callable[[], Awaitable[str | None]],
        user_active: Callable[[], bool],
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        retry_after: float = DEFAULT_RETRY_AFTER_SECONDS,
        pull_timeout: float = DEFAULT_PULL_TIMEOUT_SECONDS,
        kill_server: bool = False,
        kill_server_cooldown: float = DEFAULT_KILL_SERVER_COOLDOWN_SECONDS,
        runner: Runner | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        pairing_watch_seconds: float = DEFAULT_PAIRING_WATCH_SECONDS,
        pairing_poll_seconds: float = DEFAULT_PAIRING_POLL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        close_wait_seconds: float = DEFAULT_CLOSE_WAIT_SECONDS,
        settle_seconds: float = DEFAULT_SETTLE_SECONDS,
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
        # Todo `AdbTv` nasce com a trava: o agente só conecta sozinho a uma TV que já provou a
        # permissão a esta chave e só enquanto alguém usa a TV pelo app (ver `_may_connect`).
        self._authorization = authorization
        self._user_active = user_active
        self._pairing_watch_seconds = pairing_watch_seconds
        self._pairing_poll_seconds = pairing_poll_seconds
        self._sleep = sleep
        # MAC da TV pela tabela ARP (sem ADB): sem ele a identidade da TV não se confirma.
        self._mac_resolver = mac_resolver
        self._close_wait_seconds = close_wait_seconds
        self._settle_seconds = settle_seconds
        # O MAC lido uma vez por operação de conexão (a sondagem de rede custa até 1,5 s com a TV
        # desligada): `_UNREAD` fora de uma operação.
        self._mac_memo: object = _UNREAD
        self._in_operation = False
        self._pairing_task: asyncio.Task[None] | None = None
        # O pedido da pessoa que já passou pelo portão nesta conexão (`_ensure_connected_locked`).
        self._gated_request: UserRequest | None = None
        # A última recusa de `_may_connect` foi só falta de uso (e não falta de permissão)?
        self._refused_as_idle = False
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

    async def _stays_attached(self) -> bool:
        """Com a permissão provada para esta chave, endereço e aparelho, o canal fica aberto.

        A chave gravada na TV não mostra aviso ao religar, e é isso que mantém a lista diária, a
        limpeza, os ícones e abrir app pela Siri funcionando depois da hibernação por ociosidade.
        Sem a prova o canal se desfaz como sempre (o servidor do `adb` religa sozinho uma conexão
        TCP feita com `adb connect`, e cada religação seria um aviso novo).
        """
        if not self._connected:
            return False
        try:
            mac = await asyncio.wait_for(self._identity_mac(), _STAY_CHECK_SECONDS)
        except TimeoutError:
            return False  # sem confirmar a identidade, o canal não fica
        return self._authorization.keeps_channel(mac)

    async def disconnect(self) -> None:
        """Desconecta só esta TV (não mata o servidor do `adb`, que pode servir a outros usos).

        Com a permissão provada o canal **fica** (ver `_stays_attached`); sem ela desconecta.
        """
        if await self._stays_attached():
            return
        self._connected = False
        if self._disconnect_task is None or self._disconnect_task.done():
            self._disconnect_task = asyncio.create_task(self._disconnect_when_available())
        if self._lock.locked():
            return  # a trava está com outra operação: o adiado desconecta quando ela soltar
        # Protegido do cancelamento de quem chama (a hibernação dá 5 s): o `disconnect` termina.
        await asyncio.shield(self._disconnect_task)

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
        # Ao encerrar, nada fica registrado no servidor do `adb` sem estar provado (ele segue
        # rodando depois do agente e religaria a conexão). A trava de uma operação em andamento é
        # esperada por pouco tempo: passado esse tempo, o `adb disconnect` sai mesmo assim (é outro
        # processo e não atrapalha o comando em curso), e encerrar nunca fica preso nela.
        try:
            await asyncio.wait_for(self._disconnect_on_close(), self._close_wait_seconds * 2)
        except TimeoutError, Exception:
            _log.debug("adb disconnect no encerramento não confirmou")

    async def _disconnect_on_close(self) -> None:
        held = False
        try:
            await asyncio.wait_for(self._lock.acquire(), self._close_wait_seconds)
            held = True
        except TimeoutError:
            pass
        try:
            if self._authorization.keeps_channel(await self._identity_mac()):
                return
            self._connected = False
            await self._disconnect_locked()
        finally:
            if held:
                self._lock.release()

    async def _disconnect_unless_verified_locked(self) -> None:
        """Fim de um pedido, da espera do aceite ou do agente: sem prova, desfaz a conexão.

        O servidor do `adb` tenta religar sozinho as conexões TCP feitas com `adb connect`; numa TV
        que ainda não guardou a permissão (aviso ignorado, recusa, só `granted`) cada tentativa
        mostraria o aviso de novo, sem ninguém ter pedido. Provada, a conexão fica.
        """
        if self._authorization.keeps_channel(await self._identity_mac()):
            return
        self._connected = False
        await self._disconnect_locked()

    async def _end_user_request(self) -> None:
        """Ao fim do pedido da pessoa que usou o ADB: o que não terminou provado é desconectado."""
        task = self._pairing_task
        if task is not None and not task.done():
            return  # a espera do aceite segue com a conexão e a desfaz ao terminar
        async with self._lock:
            await self._disconnect_unless_verified_locked()

    def _remember_user_request(self) -> None:
        request = current_user_request()
        if request is not None:
            request.on_finish(self._end_user_request)

    async def _disconnect_locked(self) -> None:
        try:
            await self._exec("disconnect", self._serial)
        except AdbError as exc:
            _log.debug("adb disconnect não confirmou: %s", exc.message)

    async def _identity_mac(self) -> str | None:
        """O MAC da TV de agora (ARP, sem ADB); `None` se a TV não atende.

        Dentro de uma operação de conexão a leitura é única (ver `_connect_locked`).
        """
        if self._mac_memo is not _UNREAD:
            return cast("str | None", self._mac_memo)
        mac = await self._mac_resolver()
        if self._in_operation:
            self._mac_memo = mac
        return mac

    async def _may_connect(self) -> bool:
        """Pode abrir uma conexão nova agora? Nunca, sozinho, sem a permissão provada **desta** TV.

        Um `adb connect` a uma TV que não conhece a chave faz aparecer o aviso "Permitir depuração
        USB". Só o pedido explícito da pessoa (`is_user_initiated`) libera sem condição. Os caminhos
        automáticos exigem **as duas coisas**: a permissão provada para esta chave, este endereço e
        este aparelho (o MAC pela ARP) e alguém usando a TV pelo app agora (`user_active`): depois
        de um reset de fábrica, o aviso só pode aparecer com a pessoa diante da TV. Partida, vigia e
        tarefas de fundo, fora disso, só usam um transporte já aberto. TV que não atende na rede
        levanta `AdbUnreachable`: conectar seria inútil e nada aparece nela.
        """
        authorization = self._authorization
        if is_user_initiated():
            return True
        self._refused_as_idle = False
        if not authorization.key_and_endpoint_match():
            return False
        if not self._user_active():
            self._refused_as_idle = True
            return False
        mac = await self._identity_mac()
        if mac is None:
            raise AdbUnreachable("a TV não respondeu na rede")
        if not mac:
            # A porta abriu mas a tabela ARP não mostra o aparelho (outra sub-rede, VPN): não é TV
            # fora do ar nem recusa dela, só identidade que não se confirma. Sem bloqueio de 30 s.
            raise AdbIdentityUnconfirmed(_IDENTITY_MESSAGE)
        return authorization.verified_for(mac)

    async def _refuse_connect_locked(self) -> None:
        """Sem conectar: só lê o estado. `device` (aviso aceito) abre o canal; senão, recusa.

        Sem a permissão provada, a recusa vale como "TV sem permissão"; com ela e sem ninguém usando
        a TV, é só "espere o uso": nada se grava e o registro segue `verified`.
        """
        try:
            state = parse_device_state((await self._exec("-s", self._serial, "get-state")).text)
        except AdbTimeout:
            state = DeviceState.NOT_FOUND
        if state is DeviceState.DEVICE and (
            is_user_initiated() or self._authorization.keeps_channel(await self._identity_mac())
        ):
            # Um transporte vivo de uma permissão provada serve ao canal; nada é registrado e o
            # agente não abre outra conexão por conta própria.
            self._blocked_error = None
            self._authorization_pending = False
            self._timeout_streak = 0
            self._connected = True
            return
        if state in (DeviceState.DEVICE, DeviceState.UNAUTHORIZED, DeviceState.OFFLINE):
            # Sobra de outra execução (agente morto na espera do aceite, atualização) ou
            # transporte que a TV recusou: um `device` sem prova pode ser um "Permitir" de uma vez
            # só. Nada disso fica no servidor do `adb`, que o religaria e mostraria o aviso.
            self._connected = False
            await self._undo_transport_locked()
        # Recusa da trava, não da TV: nada de `_authorization_pending` nem de `needs_user` aqui (só
        # uma recusa explícita da TV rebaixa o registro).
        if self._refused_as_idle:
            raise AdbIdle(_IDLE_MESSAGE)
        raise AdbUnauthorized(_GATED_MESSAGE)

    def _note_unauthorized(self) -> None:
        # Qualquer `unauthorized` rebaixa o registro a `needs_user` (nada conecta sozinho até um
        # toque da pessoa), e a espera do aceite o regrava como `granted` sem herdar o ajuste do
        # vencimento. Num caminho automático, um `unauthorized` passageiro logo depois de um
        # `connect` (autenticação ainda correndo; precisa de TV real para medir) só tira
        # disponibilidade: nada abre aviso. Num pedido da pessoa vale sempre: o aviso é real e a
        # chave pode não ter ficado gravada.
        self._authorization_pending = True
        # A TV pediu o aviso de novo (reset, revogação, outra chave): nada conecta sozinho até um
        # pedido da pessoa, mesmo depois de um reinício.
        self._authorization.mark_needs_permission()

    async def _finish_pairing_locked(self) -> None:
        """Com a permissão dada e a TV atendendo: desliga o vencimento (uma vez) e anota o serial.

        Só comandos fixos de ajuste e leitura, sobre um transporte já autorizado: nenhuma conexão
        nova, nenhuma tecla.
        """
        authorization = self._authorization
        if not authorization.has_grant():
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
            # Tempo esgotado ou transporte caído não é resposta da TV: não gasta uma das tentativas
            # (senão três toques com Wi-Fi instável a esgotariam para sempre).
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

    async def _serial_changed_locked(self, authorization: AdbAuthorization) -> bool:
        """Num pedido da pessoa, confere o serial anotado: outro aparelho no mesmo endereço?"""
        record = authorization.record
        known = record.serial
        if known in ("", _SERIAL_UNAVAILABLE) or record.endpoint != self._serial:
            return False
        try:
            serial = await self._read_serial_locked()
        except AdbError:
            return False  # sem leitura não há prova de troca de aparelho
        return serial is not None and serial != known

    async def _needs_proof(self) -> bool:
        """Falta provar que a TV guardou a permissão (só o pedido da pessoa pode provar).

        Sem MAC na ARP a prova se completa com chave, endereço e MAC vazio (`proven_for`): nunca
        fica pedindo prova a cada toque.
        """
        return not self._authorization.proven_for(await self._identity_mac())

    async def _handshake_locked(self) -> tuple[AdbOutput, DeviceState]:
        joined = await self._exec("connect", self._serial)
        if connect_was_refused_for_auth(joined.text):
            raise AdbUnauthorized(_UNAUTHORIZED_MESSAGE)
        if not parse_connect(joined.text):
            raise AdbUnreachable("a TV não respondeu pelo ADB")
        state = parse_device_state((await self._exec("-s", self._serial, "get-state")).text)
        if state in _TRANSIENT_STATES:
            state = await self._settle_transient_locked(joined, state)
        return joined, state

    async def _settle_transient_locked(self, joined: AdbOutput, state: DeviceState) -> DeviceState:
        """Só num pedido da pessoa e com a permissão já dada: relê um estado passageiro.

        `offline`, `authorizing` e `connecting` logo depois do `connect` podem ser a conexão ainda
        subindo, e a prova nunca se completaria. **Só esses são relidos**: `unauthorized` vale na
        hora. Reler `unauthorized`
        confundiria a pessoa apertando OK num aviso real (que não deixa a chave gravada) com a
        autenticação ainda correndo, e daria por provada uma permissão que a TV não guardou. Um
        `unauthorized` visto, mesmo que depois a TV diga `device`, é um aceite novo: o registro cai
        para `needs_user`, a espera do aceite o regrava como `granted` (sem herdar o ajuste do
        vencimento nem o serial) e a prova fica para o toque seguinte. `offline` de uma conexão que
        já existia (`already connected`) pede refazer a conexão, não esperar.
        """
        if (
            not is_user_initiated()
            or not self._authorization.has_grant()
            or (state is DeviceState.OFFLINE and "already connected" in joined.text)
        ):
            return state
        polls = int(self._settle_seconds / _SETTLE_POLL_SECONDS)
        for _ in range(polls):
            await self._sleep(_SETTLE_POLL_SECONDS)
            state = parse_device_state((await self._exec("-s", self._serial, "get-state")).text)
            if state not in _TRANSIENT_STATES:
                break
        return state

    async def _connect_locked(self, *, proof_ready: bool = False) -> None:
        """Abre o canal. `proof_ready`: quem chamou acabou de desconectar um canal que chegou a
        `device`, então esta conexão já é a segunda da prova (não se repete o `disconnect`).

        O MAC da TV é lido **uma vez** por operação (porta e ARP custam até 1,5 s com a TV
        desligada, e a operação os pedia em vários pontos).
        """
        outer = not self._in_operation
        if outer:
            self._in_operation = True
            self._mac_memo = _UNREAD
        try:
            await self._connect_steps_locked(proof_ready=proof_ready)
        finally:
            if outer:
                self._in_operation = False
                self._mac_memo = _UNREAD

    async def _connect_steps_locked(self, *, proof_ready: bool = False) -> None:
        self._connected = False
        try:
            allowed = await self._may_connect()
        except AdbUnreachable as exc:
            self._remember_failure(exc)
            raise
        if not allowed:
            await self._refuse_connect_locked()
            return
        self._remember_user_request()
        authorization = self._authorization
        # A chave de **antes** da conexão: se o `adbkey` mudar no meio (o Android Studio mexe nele),
        # nada é registrado nem guardado em nome da chave errada.
        snapshot = authorization.snapshot_key()
        try:
            joined, state = await self._handshake_locked()
            stale = "already connected" in joined.text
            credited = proof_ready  # há uma conexão anterior que chegou a `device`
            if (
                state is DeviceState.DEVICE
                and not stale
                and not proof_ready
                and is_user_initiated()
                and authorization.granted_for(await self._identity_mac())
            ):
                # A TV já tinha aceitado (`granted`) e esta conexão **nova** chegou a `device` sem
                # aviso: a chave ficou gravada. É a prova que o `disconnect` + `connect` faria.
                credited = True
            # `offline` pede refazer a conexão. Com `unauthorized`, uma conexão nova faria a TV
            # mostrar de novo o aviso "Permitir depuração USB" sem ninguém ter pedido. A exceção é o
            # pedido da pessoa sobre uma permissão ainda não provada: `device` logo depois de uma
            # conexão (nova ou não) pode ser um "Permitir" de uma vez só aceito durante ela, e só
            # uma segunda conexão, ainda dentro do mesmo pedido, mostra se ficou gravado. A pessoa
            # está diante da TV: se o aviso voltar, é a hora de ela marcar "Sempre permitir".
            if stale and state is DeviceState.OFFLINE:
                await self._exec("disconnect", self._serial)
                joined, state = await self._handshake_locked()
            elif (
                state is DeviceState.DEVICE
                and not proof_ready
                and is_user_initiated()
                and not credited
                and await self._needs_proof()
            ):
                await self._exec("disconnect", self._serial)
                joined, state = await self._handshake_locked()
                credited = True
        except AdbTimeout:
            # Na abertura, tempo esgotado é "a TV não respondeu": nenhum comando foi executado.
            error: AdbError = AdbUnreachable("a TV não respondeu pelo ADB")
            self._remember_failure(error)
            raise error from None
        except AdbError as exc:
            self._remember_failure(exc)
            if isinstance(exc, AdbUnauthorized):
                self._watch_for_acceptance(snapshot)
                await self._drop_after_refusal()
            raise
        if state is DeviceState.DEVICE:
            self._blocked_error = None
            self._authorization_pending = False
            self._timeout_streak = 0
            self._connected = True
            if is_user_initiated():
                if await self._register_user_connection_locked(
                    authorization, snapshot, "already connected" not in joined.text, credited
                ):
                    return  # o aparelho era outro: a prova foi refeita dentro desta chamada
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
            await self._drop_after_refusal()
        raise failure

    async def _register_user_connection_locked(
        self,
        authorization: AdbAuthorization,
        snapshot: str | None,
        fresh: bool,
        credited: bool,
    ) -> bool:
        """Registra o que a conexão do pedido da pessoa provou. `True` se refez a prova por dentro.

        * **Provada** = uma segunda conexão, realmente **nova** (`connected to`, nunca `already
          connected`), chegou a `device` depois de uma anterior que também chegou: só então
          `verified`. Se a segunda veio "já conectada" (o `disconnect` não derrubou o transporte), a
          conexão serve mas nada é dado como provado (`granted`).
        * O serial só se lê aqui, dentro de um pedido da pessoa. Se for outro aparelho, esquece o
          serial e o ajuste: a prova refeita a seguir anota a identidade nova (nada de trava eterna,
          e nada de `needs_user`, que só vem de uma recusa da TV).
        """
        changed = await self._serial_changed_locked(authorization)
        if changed:
            _log.warning("o aparelho que respondeu não é o anotado; a prova vai ser refeita")
            authorization.forget_device()
            if not (credited and fresh):
                await self._disconnect_locked()
                await self._connect_locked(proof_ready=True)
                return True
        mac = await self._identity_mac()
        if not await self._needs_proof() and not changed:
            return False  # já provada antes: nada a registrar
        if credited and fresh:
            authorization.mark_verified(snapshot, mac)
        else:
            authorization.mark_granted(snapshot, mac)
        return False

    async def _drop_after_refusal(self) -> None:
        """Recusa num caminho automático: desfaz a conexão (no pedido da pessoa, quem a desfaz é a
        espera do aceite, que precisa dela para ver o `device`)."""
        if is_user_initiated():
            return
        self._connected = False
        await self._disconnect_locked()

    def _watching_for_acceptance(self) -> bool:
        task = self._pairing_task
        return task is not None and not task.done()

    async def _undo_transport_locked(self) -> None:
        """Desfaz o transporte no servidor do `adb`, salvo durante a espera do aceite (ela precisa
        dele para ver o `device` e o desfaz sozinha ao terminar)."""
        if self._watching_for_acceptance():
            return
        await self._disconnect_locked()

    async def _drop_lost_transport_locked(self, state: DeviceState) -> None:
        """Fora de um pedido da pessoa, um transporte que a TV recusou (ou que caiu sem estar
        provado) é desfeito com `adb disconnect`.

        O servidor do `adb` religa sozinho as conexões TCP feitas com `adb connect`: se a TV
        revogou a permissão (ou foi resetada) com o canal mantido aberto, cada religação mostraria
        o aviso de novo, sem ninguém ter tocado. `unauthorized` sempre termina aqui; `offline` só
        quando a permissão não está provada (provada, a TV desligada é só a TV desligada e o
        servidor religa sem aviso). No pedido da pessoa, quem desfaz é o fim do pedido.
        """
        if is_user_initiated():
            return
        if state is DeviceState.UNAUTHORIZED or not self._authorization.keeps_channel(
            await self._identity_mac()
        ):
            await self._undo_transport_locked()

    def _watch_for_acceptance(self, snapshot: str | None) -> None:
        """Pedido da pessoa que deixou o aviso na tela: espera o aceite lendo só o estado (90 s)."""
        if not is_user_initiated():
            return
        task = self._pairing_task
        if task is None or task.done():
            self._pairing_task = asyncio.create_task(self._acceptance_watch(snapshot))

    async def _acceptance_watch(self, snapshot: str | None) -> None:
        """Continuação do toque da pessoa: espera o aceite por até `pairing_watch_seconds` (90 s).

        **Nunca conecta** e não leva a marca de pedido da pessoa. Enquanto espera só lê `get-state`
        (a conexão do toque precisa ficar para ela ver o `device`). Quando a TV diz `device`,
        registra a permissão como `granted` (ainda não provada) e, como continuação do mesmo toque,
        roda sobre o transporte já autorizado dois comandos fixos de shell: desliga o vencimento de
        7 dias (`settings put`/`get`) e anota o serial (`getprop`). A prova (uma conexão nova) só
        acontece num pedido seguinte da pessoa.

        **Ao terminar** (aceite, fim da janela, recusa) desfaz a conexão com `adb disconnect`, a
        menos que a permissão esteja provada: o servidor do `adb` religa sozinho conexões TCP não
        provadas.

        É limitada no tempo (contagem e relógio, conferido de novo depois de esperar a trava) e só
        existe na memória: nada a retoma depois dos 90 s nem depois de reiniciar o agente.
        """
        try:
            await self._watch_loop(snapshot)
        finally:
            try:
                async with self._lock:
                    await self._disconnect_unless_verified_locked()
            except Exception:
                _log.debug("adb disconnect ao fim da espera não confirmou")

    async def _watch_loop(self, snapshot: str | None) -> None:
        authorization = self._authorization
        poll = max(self._pairing_poll_seconds, 0.001)
        deadline = self._monotonic() + self._pairing_watch_seconds
        waited = 0.0
        while waited < self._pairing_watch_seconds and self._monotonic() <= deadline:
            await self._sleep(poll)
            waited += poll
            try:
                async with self._lock:
                    if self._monotonic() > deadline:
                        return  # esperou a trava além da janela: a continuação do toque acabou
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
            request = current_user_request()
            if request is not None:
                if request is self._gated_request:
                    # Mesmo pedido, mesma conexão: um texto em vários grupos confere uma vez só.
                    return
                self._remember_user_request()
                if await self._needs_proof():
                    # Transporte vivo sem prova de permissão gravada: a pessoa pediu, então confere.
                    await self._disconnect_locked()
                    await self._connect_locked(proof_ready=True)
                else:
                    await self._finish_pairing_locked()
                self._gated_request = request
            return
        self._gated_request = None
        if self._blocked_error is not None and self._monotonic() < self._blocked_until:
            if isinstance(self._blocked_error, AdbUnauthorized):
                # O dono pode ter aceitado o aviso agora: conferir o estado não abre conexão.
                state = parse_device_state((await self._exec("-s", self._serial, "get-state")).text)
                if (
                    state is DeviceState.DEVICE
                    and not is_user_initiated()
                    and not self._authorization.keeps_channel(await self._identity_mac())
                ):
                    # Um `device` sem prova fora de um pedido da pessoa pode ser um "Permitir" de
                    # uma vez só: o agente não o adota (a espera do aceite é quem trata dele).
                    await self._undo_transport_locked()
                elif state is DeviceState.DEVICE:
                    self._blocked_error = None
                    self._authorization_pending = False
                    self._connected = True
                    if is_user_initiated() and await self._needs_proof():
                        # A pessoa tocou de novo logo depois de aceitar: a prova é neste toque.
                        await self._disconnect_locked()
                        await self._connect_locked(proof_ready=True)
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
            try:
                await self._ensure_connected_locked()
            except AdbError as exc:
                # Conectar ou conferir o aparelho vem antes do shell: nada foi digitado.
                exc.may_have_executed = False
                raise
            output = await self._shell(command)
        if not command_succeeded(output):
            # Pode ter digitado parte do grupo: quem chama não repete às cegas.
            raise AdbCommandFailed("a TV não confirmou a digitação")

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
                    # Só informa o vigia: a TV não recusou nada agora (pode estar desligada), então
                    # nada é gravado nem rebaixado.
                    raise AdbUnauthorized("a TV ainda não autorizou este PC no ADB")
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
                await self._drop_lost_transport_locked(state)
                raise AdbUnauthorized(_UNAUTHORIZED_MESSAGE)
            if state in (DeviceState.OFFLINE, DeviceState.NOT_FOUND):
                self._connected = False
                await self._drop_lost_transport_locked(state)
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
            await self._drop_lost_transport_locked(state)
            raise AdbUnauthorized(_UNAUTHORIZED_MESSAGE)
        if state in (DeviceState.OFFLINE, DeviceState.NOT_FOUND):
            self._connected = False
            await self._drop_lost_transport_locked(state)
            raise AdbUnreachable("a conexão ADB com a TV caiu")
        return output

    async def _exec(self, *args: str, timeout: float | None = None) -> AdbOutput:  # noqa: ASYNC109
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
