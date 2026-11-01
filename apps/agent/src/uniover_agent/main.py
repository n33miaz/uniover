"""Composição do agente e comandos de linha: `run` (padrão), `pair`, `status`, `tv-pair`,
`tv-find` e `self-update`."""

import argparse
import asyncio
import logging
import os
import platform
import random
import re
import socket
import sys
import uuid
from collections.abc import Awaitable, Callable, Collection, Coroutine, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib import metadata
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any
from urllib.parse import quote

from uniover_agent.adapters.absence_diary import AbsenceDiary
from uniover_agent.adapters.agent_log_file import FileLogSource
from uniover_agent.adapters.apk_tools import (
    Aapt2Inspector,
    FileIconCache,
    TempApkScratch,
    default_icons_dir,
    locate_aapt2,
)
from uniover_agent.adapters.arp import arp_mac
from uniover_agent.adapters.crash_trace import install_crash_trace, loop_exception_handler
from uniover_agent.adapters.housekeeping import tidy
from uniover_agent.adapters.installation import installation_base, migrate_layout
from uniover_agent.adapters.local_config import ConfigValue, save_agent_config, update_config
from uniover_agent.adapters.maintenance_signals import RuntimeFlagSignals
from uniover_agent.adapters.pairing_http import HttpPairingClient, probe_api
from uniover_agent.adapters.pairing_page import (
    can_open_browser,
    open_connection_page,
    write_connected_page,
    write_failed_page,
    write_pairing_page,
    write_progress_page,
)
from uniover_agent.adapters.qr_terminal import render_ascii, render_for
from uniover_agent.adapters.run_state import RunState
from uniover_agent.adapters.secret_store_keyring import KeyringSecretStore, SecretStoreError
from uniover_agent.adapters.self_care_checks import ConnectionWatch
from uniover_agent.adapters.self_update import (
    DEFAULT_CHANNEL,
    UpdateResult,
    read_version,
    self_update,
)
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.transport_ws import WebSocketTransport, build_ws_url
from uniover_agent.adapters.tray_status import TrayStatus
from uniover_agent.adapters.tv_adb import AdbTv, locate_adb
from uniover_agent.adapters.tv_discovery import (
    ANDROID_REMOTE_PORT,
    REFUSAL_WAIT_SECONDS,
    DiscoveredTv,
    PortState,
    TvKindName,
    find_tvs,
    tcp_probe,
)
from uniover_agent.adapters.tv_livre_apk import ReleaseApkSource
from uniover_agent.adapters.tv_livre_signer import ApkSignerVerifier
from uniover_agent.adapters.tv_locate import (
    build_liveness,
    build_locator,
    identify_tv,
)
from uniover_agent.adapters.tv_nearby import build_finder
from uniover_agent.adapters.tv_pairing import (
    TvPairingError,
    ask_code_in_window,
    is_paired,
    pair_tv,
)
from uniover_agent.adapters.tv_remote_v2 import ANDROID_OPTIONAL_KEYS, AndroidTvRemoteV2
from uniover_agent.adapters.tv_samsung import (
    SAMSUNG_CLIENT_NAME,
    SAMSUNG_OPTIONAL_KEYS,
    SamsungTvDriver,
)
from uniover_agent.adapters.tv_samsung_pairing import SamsungPairingError, pair_samsung_tv
from uniover_agent.adapters.tv_samsung_volume import SamsungVolume
from uniover_agent.adapters.tv_volume_check import check_volume
from uniover_agent.adapters.update_status import (
    FileUpdateStatus,
    default_status_path,
    record_failure,
    record_result,
    record_updating,
)
from uniover_agent.adapters.wol import send_wake_on_lan
from uniover_agent.care_setup import (
    DiagnosticsKit,
    announce_start,
    attach_log_handler,
    build_checks,
    build_diagnostics,
    describe_problems,
    roll_back_if_in_trial,
)
from uniover_agent.config import (
    ConfigError,
    Settings,
    agent_source_dir,
    config_path,
    connection_page_path,
    require_api_url,
    require_cleanup_keep,
    require_tv_host,
    tv_cert_dir,
)
from uniover_agent.core import (
    DISCOVERY_CAPABILITY,
    LOGS_CAPABILITY,
    LOGS_REQUEST_TYPE,
    MAINTENANCE_CAPABILITY,
    MAINTENANCE_TYPE,
    PERMISSION_CAPABILITY,
    POWER_OFF_CAPABILITY,
    AppIconPublisher,
    AppsAnnouncer,
    Command,
    CommandResult,
    ConnectionSupervisor,
    EnvelopeFactory,
    EnvelopeGate,
    FocusBackgroundCloser,
    HandleCommand,
    Handler,
    IconResolver,
    PairAgent,
    ProcessMessage,
    ResultStatus,
    SamsungTvApps,
    TextReconciler,
    TvApps,
    TvCleanup,
    TvCleanupScheduler,
    TvIdentity,
    TvKnown,
    TvLightSettings,
    TvPermission,
    TvRelocator,
    TvSessionManager,
    TvStatePublisher,
    TvWatchdog,
    UpdateStatusWatcher,
    WatchdogEvents,
    agent_logs_handler,
    agent_maintenance_handler,
    tv_app_launch_handler,
    tv_apps_refresh_handler,
    tv_cleanup_handler,
    tv_cleanup_skipped_handler,
    tv_discover_handler,
    tv_key_handler,
    tv_power_off_handler,
    tv_text_handler,
    tv_wake_handler,
    unsupported_handler,
    update_body,
)
from uniover_agent.core.diagnostics import DIAGNOSTICS_CAPABILITY, DiagnosticsShipper
from uniover_agent.core.self_care import SelfCare
from uniover_agent.core.supervision import TaskHealth, keep_running, run_supervised
from uniover_agent.core.tv.livre import (
    CAPABILITY as LIVRE_CAPABILITY,
)
from uniover_agent.core.tv.livre import (
    LivreStateFile,
    PhotoStaging,
    TvLivre,
    tv_livre_handler,
    tv_livre_photo_handler,
)
from uniover_agent.ports import (
    AdbUnauthorized,
    Clock,
    PairingDenied,
    PairingError,
    PairingExpired,
    PairingInfo,
    PairingTicket,
    SecretStore,
    Transport,
    TransportError,
    TvNotPaired,
    TvUnreachable,
)

_log = logging.getLogger("uniover_agent")

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_NOT_PAIRED = 2
EXIT_CREDENTIAL_REJECTED = 3
# A TV mudou de endereço: `main` recomeça o `run` já com o endereço novo.
EXIT_TV_MOVED = 4
# De quanto em quanto tempo o vigia olha o ARP atrás do MAC da TV, enquanto não o aprendeu.
ARP_LEARN_SECONDS = 600.0
# Portas do serviço do controle remoto da Android TV: só se dá por de pé com as duas abertas.
REMOTE_SERVICE_PORTS = (ANDROID_REMOTE_PORT, 6467)

_NOT_PAIRED = "não pareado. Rode `uniover-agent pair` para parear este PC."


def agent_version() -> str:
    try:
        return metadata.version("uniover-agent")
    except metadata.PackageNotFoundError:
        return "0.0.0"


_BUILD_DIGITS = 12


def build_version() -> str:
    """Versão SemVer do produto e, quando se sabe, o commit instalado (`0.5.0+3f2a9c1d4e5b`).

    É o que a tela do dono mostra: o número identifica a publicação e o commit diz de fato qual
    código está rodando. O arquivo `.version` é o que a auto-atualização grava e compara.
    """
    version = agent_version()
    try:
        commit = read_version(agent_source_dir())
    except OSError:
        commit = None
    if commit and re.fullmatch(r"[0-9a-f]{7,40}", commit):
        return f"{version}+{commit[:_BUILD_DIGITS]}"
    return version


def describe_os() -> str | None:
    """Sistema do PC para a tela do dono (ex.: `Windows 11 (10.0.26200)`); nunca falha."""
    try:
        system, release, version = platform.system(), platform.release(), platform.version()
    except OSError:
        return None
    text = f"{system} {release} ({version})" if version else f"{system} {release}"
    return text.strip()[:80] or None


def silence_noisy_loggers() -> None:
    """Em DEBUG essas bibliotecas registram cabeçalhos (inclusive `Authorization`) e corpos:
    ficam em WARNING sempre, para que nenhum segredo chegue ao registro. A `androidtvremote2`
    também registra o que envia à TV e o código de pareamento."""
    for noisy in ("websockets", "httpx", "httpcore", "androidtvremote2", "samsungtvws"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def configure_logging(level: str, log_file: str | None = None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_file:
        # A tarefa do Windows roda sem janela: o arquivo é o único lugar onde o dono (ou quem o
        # ajuda) vê o que o agente fez. Rodízio de 1 MB com 2 cópias: nunca enche o disco.
        try:
            Path(log_file).parent.mkdir(parents=True, exist_ok=True)
            handlers.append(
                RotatingFileHandler(log_file, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
            )
        except OSError:
            print("Aviso: não consegui abrir o arquivo de registro.", file=sys.stderr)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )
    silence_noisy_loggers()


@dataclass(slots=True)
class TvSetup:
    """Tudo o que a TV precisa e os pontos onde as outras entregas se encaixam.

    Cada entrega seguinte (canal ADB, vigia) insere **uma linha** num marcador de `build_tv` e
    estende este objeto: registra handlers, declara capacidades, agenda tarefas de fundo e avisos
    pós-`hello`. Também tem à mão a sessão, o transporte e as mensagens para enviar eventos.
    """

    manager: TvSessionManager
    transport: Transport
    envelopes: EnvelopeFactory
    handlers: dict[str, Handler]
    capabilities: list[str] = field(default_factory=list)
    # Tarefas de fundo (`async def`) que rodam enquanto o agente roda.
    background: list[Callable[[], Coroutine[Any, Any, None]]] = field(default_factory=list)
    # Rodam depois do `hello`, a cada conexão com a API.
    after_hello: list[Callable[[], Awaitable[None]]] = field(default_factory=list)
    # Rodam uma vez, antes do primeiro `hello`: podem ajustar `capabilities`.
    prepare: list[Callable[[], Awaitable[None]]] = field(default_factory=list)
    # A digitação (uma só, ligada ao handler de `tv.text.v1`): o canal ADB se pluga nela.
    text: TextReconciler | None = None
    # Comandos longos, atendidos em tarefa própria para não segurar as teclas atrás deles.
    background_commands: set[str] = field(default_factory=set)
    # O que se sabe da TV (dica de identificador e MAC): o vigia do endereço e o Wake-on-LAN usam.
    known: TvKnown = field(default_factory=TvKnown)
    # O vigia do serviço do controle (só Android TV com `adb`): quem vê uma porta recusada o avisa.
    watchdog: TvWatchdog | None = None
    cleanup_scheduler: TvCleanupScheduler | None = None
    light_settings: TvLightSettings | None = None


def build_tv(
    settings: Settings,
    clock: Clock,
    transport: Transport,
    envelopes: EnvelopeFactory,
    secrets: SecretStore | None = None,
) -> TvSetup | None:
    """A sessão da TV (veja `build_driver_setup`) e, nela, a procura de TVs na rede do agente."""
    setup = build_driver_setup(settings, clock, transport, envelopes, secrets)
    if setup is not None:
        attach_discovery(setup, settings)
    return setup


def attach_discovery(setup: TvSetup, settings: Settings) -> None:
    """Acrescenta `tv.discover.v1`: ao adicionar uma TV, o app mostra as que estão na rede."""
    finder = build_finder(settings.tv_host, setup.known)
    setup.handlers["tv.discover.v1"] = tv_discover_handler(finder, setup.transport, setup.envelopes)
    setup.background_commands.add("tv.discover.v1")
    setup.capabilities.append(DISCOVERY_CAPABILITY)


def build_driver_setup(
    settings: Settings,
    clock: Clock,
    transport: Transport,
    envelopes: EnvelopeFactory,
    secrets: SecretStore | None = None,
) -> TvSetup | None:
    """Sessão pelo driver configurado, ou `None` se a TV ainda não foi pareada.

    A capacidade `tv.remote` só é declarada à API quando há endereço da TV **e** o par
    certificado/chave existe: declarar sem poder atender faria o app mostrar uma TV que não
    responde.
    """
    if not settings.tv_host:
        return None
    host = require_tv_host(settings.tv_host)
    if settings.tv_kind == "samsung":
        return build_samsung_tv(settings, clock, transport, envelopes, secrets)
    cert_dir = tv_cert_dir(settings.tv_name)
    if not is_paired(cert_dir):
        _log.warning("TV configurada, mas ainda não pareada. Rode `uniover-agent tv-pair`.")
        return None
    known = TvKnown(settings.tv_id_hint, settings.tv_mac)

    async def learn_android_mac() -> None:
        # A sessão autenticada prova que o ARP deste endereço pertence à TV pareada.
        if known.mac is not None:
            return
        mac = await arp_mac(host)
        if mac is not None:
            update_config(config_path(), {"tv_mac": mac})
            known.mac = mac
            _log.info("MAC da TV guardado a partir da tabela ARP")

    remote = AndroidTvRemoteV2(
        host, settings.tv_client_name, cert_dir, on_connected=learn_android_mac
    )
    manager = TvSessionManager(
        clock,
        remote,
        hibernate_seconds=settings.tv_hibernate_seconds,
        liveness=build_liveness("android", host),
        power_off_read_timeout_seconds=settings.tv_power_off_read_timeout_seconds,
        power_off_confirmation_timeout_seconds=settings.tv_power_off_confirmation_timeout_seconds,
    )
    # `POWER` passa como as outras teclas (agente antigo ou app antigo): o app só o manda depois da
    # folha de confirmação e a API só o aceita pela rota própria de desligar. O desligamento com
    # leitura (`tv.power.off.v1`) só aperta a tecla com a TV lida como ligada e nunca a repete.
    keys = tv_key_handler(manager)
    text = TextReconciler(
        manager,
        monotonic=clock.monotonic,
        keys=settings.tv_text_by_keys,
        key_pause_seconds=settings.tv_text_key_pause_ms / 1000,
        sleep=clock.sleep,
    )
    # O estado real do campo (quando a TV o manda) semeia o diff da digitação; outro app em foco ou
    # uma sessão nova o tornam velho, e então vale o comportamento de antes.
    remote.on_text_field(text.observe_field)
    remote.on_app(text.observe_app)
    manager.on_session_opened(lambda _elapsed: text.forget_field())
    manager.subscribe(lambda state: text.forget_field() if state.connection != "hot" else None)
    _log.info(
        "digitação na TV: teclas do controle remoto %s",
        "ligadas" if settings.tv_text_by_keys else "desligadas (padrão)",
    )
    setup = TvSetup(
        manager,
        transport,
        envelopes,
        handlers={
            "tv.key.v1": keys,
            "tv.key.v2": keys,
            "tv.key.v3": keys,
            "tv.power.off.v1": tv_power_off_handler(manager),
            "tv.text.v1": tv_text_handler(manager, reconciler=text, monotonic=clock.monotonic),
            "tv.wake.v1": tv_wake_handler(manager),
            "tv.app.launch.v1": tv_app_launch_handler(manager),
        },
        capabilities=[
            "tv.remote",
            "tv.kind.android",
            POWER_OFF_CAPABILITY,
            *key_capabilities(ANDROID_OPTIONAL_KEYS),
        ],
        text=text,
        known=known,
    )
    # Cada tarefa seguinte insere aqui só a linha dela; o gerenciador é o único dono da conexão.
    adb = compose_adb(setup, settings, host, clock)  # [composição: adb]
    if adb is not None:
        manager.set_volume_reader(volume_reader_when_push_is_silent(manager, adb))
    compose_watchdog(setup, settings, host, clock, adb)  # [composição: vigia]
    return setup


def volume_reader_when_push_is_silent(
    manager: TvSessionManager, adb: AdbTv
) -> Callable[[], Awaitable[int | None]]:
    """Reserva do volume da Android TV: lê pelo shell se não houve push após a última tecla.

    O canal remoto da Android TV avisa o volume sozinho (de graça); ler pelo `adb` a cada tecla
    seria carga a mais numa TV que já engasgou com ela. Por isso o `adb` só entra enquanto o estado
    não atualizou o nível após a tecla, como em algumas soundbars por HDMI-ARC/CEC.
    """

    async def read() -> int | None:
        if manager.remote_volume_seen:
            return None
        level = await adb.read_volume()
        # Um push durante a consulta é mais recente que a resposta do shell.
        return None if manager.remote_volume_seen else level

    return read


def key_capabilities(keys: Sequence[str]) -> list[str]:
    """Capacidades de teclas: a versão da mensagem e uma por tecla opcional que a TV tem.

    O app usa esta lista para oferecer os botões extras; tecla que a TV não tem não é declarada.
    """
    return ["tv.key.v3", *(f"tv.key.{key}" for key in keys)]


def samsung_token_name(tv_name: str) -> str:
    """Nome estável no Cofre de Credenciais, separado do token do agente."""
    return f"samsung:{tv_name}"


def samsung_client_name_key(tv_name: str) -> str:
    """Onde o cofre guarda o nome com que o UniOver se apresentou à TV (junto do token)."""
    return f"samsung-name:{tv_name}"


def samsung_permission_key(tv_name: str) -> str:
    """Marca no cofre: a TV pediu a permissão de novo e o agente parou de tentar (sobrevive a
    reiniciar e a atualizar o agente, para a TV não ser incomodada outra vez)."""
    return f"samsung-permission:{tv_name}"


def resolve_samsung_client_name(secrets: SecretStore, tv_name: str, legacy_name: str) -> str:
    """O nome do cliente na TV, sempre o mesmo depois de escolhido.

    A TV liga a permissão ao nome: trocá-lo faria o aviso "Permitir" voltar. O nome fica no cofre
    (que atualizar ou reinstalar o agente não apaga). Token já guardado sem nome gravado é de
    antes desta regra: foi pareado com `legacy_name` (a configuração), que passa a ser o nome
    gravado. Sem token, vale o nome fixo do UniOver.
    """
    key = samsung_client_name_key(tv_name)
    stored = secrets.get(key)
    if stored:
        return stored
    name = legacy_name if secrets.get(samsung_token_name(tv_name)) else SAMSUNG_CLIENT_NAME
    secrets.set(key, name)
    return name


def build_samsung_tv(
    settings: Settings,
    clock: Clock,
    transport: Transport,
    envelopes: EnvelopeFactory,
    secrets: SecretStore | None,
) -> TvSetup | None:
    """Compõe somente o que a Samsung Tizen oferece: remoto e apps, sem ADB nem limpeza."""
    if secrets is None:
        _log.warning("TV Samsung configurada, mas o cofre não foi aberto para ler o pareamento.")
        return None
    token_name = samsung_token_name(settings.tv_name)
    token = secrets.get(token_name)
    # Sem token ou com a marca de permissão: a TV precisa do aceite de alguém. A sessão é montada
    # do mesmo jeito (para o app poder pedi-lo), mas nenhuma conexão é tentada antes do pedido.
    marked = secrets.get(samsung_permission_key(settings.tv_name)) is not None
    needs_permission = token is None or marked
    if token is None:
        _log.warning(
            "TV Samsung configurada, mas ainda sem permissão. "
            "Peça pelo app ou rode `uniover-agent tv-pair --kind samsung`."
        )
    host = require_tv_host(settings.tv_host)
    known = TvKnown(settings.tv_id_hint, settings.tv_mac)
    client_name = resolve_samsung_client_name(secrets, settings.tv_name, settings.tv_client_name)
    permission_key = samsung_permission_key(settings.tv_name)

    async def request_token(current: str | None) -> str:
        return await pair_samsung_tv(host, client_name, token=current)

    remote = SamsungTvDriver(
        host,
        token,
        client_name,
        save_token=lambda value: secrets.set(token_name, value),
        permission_needed=needs_permission,
        request_token=request_token,
        app_ids=tuple(settings.tv_samsung_apps),
        on_identity=lambda identity: remember_tv_identity(known, identity),
    )

    def remember_permission(needed: bool) -> None:
        if needed:
            secrets.set(permission_key, "needed")
        else:
            secrets.delete(permission_key)

    remote.on_permission(remember_permission)

    async def wake_on_lan() -> bool:
        # O MAC vem do arquivo ou é aprendido na primeira conexão; sem ele não há pacote mágico.
        return known.mac is not None and await send_wake_on_lan(known.mac, host)

    manager = TvSessionManager(
        clock,
        remote,
        hibernate_seconds=settings.tv_hibernate_seconds,
        liveness=build_liveness("samsung", host),
        wake_on_lan=wake_on_lan,
        volume_reader=remote.read_volume,
        power_reader=remote.read_power,
        power_off_read_timeout_seconds=settings.tv_power_off_read_timeout_seconds,
        power_off_confirmation_timeout_seconds=settings.tv_power_off_confirmation_timeout_seconds,
    )
    keys = tv_key_handler(manager)
    apps = SamsungTvApps(manager, remote, transport, envelopes)
    announcer = AppsAnnouncer(
        apps, lambda: manager.snapshot().connection == "hot", monotonic=clock.monotonic
    )
    manager.subscribe(announcer.on_state)
    permission = TvPermission(remote, manager, transport, envelopes)
    return TvSetup(
        manager,
        transport,
        envelopes,
        handlers={
            "tv.key.v1": keys,
            "tv.key.v2": keys,
            "tv.key.v3": keys,
            "tv.power.off.v1": tv_power_off_handler(manager),
            "tv.permission.request.v1": permission.handler(),
            "tv.wake.v1": tv_wake_handler(manager),
            "tv.app.launch.v1": tv_app_launch_handler(
                manager, packages=apps, links_supported=False
            ),
            "tv.apps.refresh.v1": tv_apps_refresh_handler(apps),
            "tv.text.v1": unsupported_handler("a TV Samsung não suporta digitação por este canal"),
            "tv.cleanup.v1": tv_cleanup_skipped_handler(
                transport,
                envelopes,
                "model-unconfirmed",
                "a limpeza automática da TV Samsung fica desligada até confirmar o modelo",
            ),
        },
        capabilities=[
            "tv.remote",
            "tv.kind.samsung",
            POWER_OFF_CAPABILITY,
            PERMISSION_CAPABILITY,
            *key_capabilities(SAMSUNG_OPTIONAL_KEYS),
        ],
        background=[announcer.run],
        after_hello=[permission.announce, announcer.after_hello],
        # O pedido responde em segundos, mas não pode segurar a recepção enquanto a TV é consultada.
        background_commands={"tv.permission.request.v1"},
        known=known,
    )


def remember_tv_identity(known: TvKnown, identity: TvIdentity) -> None:
    """Grava o `duid` e o MAC da TV no `agent.toml` na primeira vez que ela se identifica.

    Assim reencontrar a TV nunca depende do IP antigo, nem de ter rodado o `tv-find`.
    """
    if not known.learn(identity):
        return
    values: dict[str, ConfigValue] = {}
    if known.hint is not None:
        values["tv_id_hint"] = known.hint
    if known.mac is not None:
        values["tv_mac"] = known.mac
    try:
        update_config(config_path(), values)
    except OSError as exc:
        _log.warning("não consegui gravar a identidade da TV (%s)", type(exc).__name__)
    else:
        _log.info("identidade da TV guardada para reencontrá-la se o endereço mudar")


def compose_focus_closer(
    setup: TvSetup,
    adb: AdbTv,
    clock: Clock,
    keep: Collection[str],
    is_busy: Callable[[], bool],
) -> FocusBackgroundCloser:
    """Fechamento de apps de fundo do Modo Foco; o relatório entra nas limpezas como `focus`."""

    async def report(packages: tuple[str, ...], duration_ms: int) -> None:
        request_id = str(uuid.uuid4())
        try:
            await setup.transport.send(
                setup.envelopes.tv_cleanup_result(
                    request_id,
                    request_id,
                    closed_apps=len(packages),
                    closed_packages=packages,
                    memory_before_mb=None,
                    memory_after_mb=None,
                    freed_mb=None,
                    failed_steps=(),
                    kind="light",
                    trigger="focus",
                    result="completed",
                    duration_ms=duration_ms,
                )
            )
        except TransportError:
            _log.info("não consegui enviar o relatório do Modo Foco")

    return FocusBackgroundCloser(
        adb, clock, lambda: setup.manager.snapshot().app, report, keep, is_busy
    )


def compose_light_settings(
    setup: TvSetup,
    adb: AdbTv,
    clock: Clock,
    keep: Collection[str],
    is_busy: Callable[[], bool],
) -> tuple[FocusBackgroundCloser, TvLightSettings]:
    """Ajustes leves da TV, já ligados ao fechamento de apps de fundo do Modo Foco."""
    manager = setup.manager
    closer = compose_focus_closer(setup, adb, clock, keep, is_busy)
    light_settings = TvLightSettings(
        adb,
        clock,
        manager.set_keep_hot,
        lambda: manager.snapshot().app,
        installation_base() / "tv-light-settings.json",
        manager.wake,
        closer.on_focus,
        closer.reset,
    )
    return closer, light_settings


def compose_adb(  # noqa: PLR0915 - uma linha por passo da composição
    setup: TvSetup, settings: Settings, host: str, clock: Clock
) -> AdbTv | None:
    """Liga o canal ADB: lista de apps, abertura por pacote e digitação pelo `input text`.

    Sem o `adb` neste PC nada é registrado e a TV segue só com o controle remoto. O canal entra na
    sessão como opcional (abre e hiberna junto, mas a falta dele não derruba as teclas) e os
    handlers dele são os únicos que o usam. Devolve o adaptador (ou `None`, sem `adb`) para o vigia.
    """
    # Valida a lista do dono antes de qualquer coisa: lista errada para o agente com o motivo.
    keep = require_cleanup_keep(settings)
    path = locate_adb(settings.adb_path)
    if path is None:
        _log.warning(
            "adb não encontrado (UNIOVER_ADB_PATH, PATH ou Android SDK): "
            "lista de apps e abertura por pacote ficam desligadas"
        )
        return None
    adb = AdbTv(
        path,
        host,
        settings.tv_adb_port,
        timeout=settings.adb_timeout_seconds,
        pull_timeout=settings.adb_pull_timeout_seconds,
        monotonic=clock.monotonic,
    )
    manager = setup.manager
    manager.add_channel(adb)

    focus_closer, light_settings = compose_light_settings(
        setup, adb, clock, keep, lambda: cleanup.running
    )
    icons = compose_icons(setup, settings, adb, clock, lambda: light_settings.focus_active)
    if icons is not None:
        light_settings.on_release(icons.resume)
    apps = TvApps(manager, adb, setup.transport, setup.envelopes, icons)
    announcer = AppsAnnouncer(
        apps,
        lambda: manager.snapshot().connection == "hot",
        monotonic=clock.monotonic,
        is_paused=lambda: light_settings.focus_active,
    )
    # O handler de `tv.text.v1` continua sendo um só: ele recebe o ADB, não é substituído.
    if setup.text is not None:
        setup.text.use_adb(adb)
    setup.handlers["tv.apps.refresh.v1"] = tv_apps_refresh_handler(apps)
    setup.handlers["tv.app.launch.v1"] = tv_app_launch_handler(manager, packages=apps)
    # A limpeza só mexe no ADB (nunca na sessão do controle remoto) e leva vários segundos: roda
    # fora do laço de mensagens, e as teclas seguem enquanto ela trabalha.
    cleanup = TvCleanup(adb, clock, keep=keep, allow_app_closing=False)
    scheduler = TvCleanupScheduler(
        cleanup,
        adb,
        clock,
        setup.transport,
        setup.envelopes,
        lambda: setup.manager.snapshot().app,
        lambda: light_settings.focus_active,
    )

    async def configure_cleanup(command: Command) -> CommandResult:
        body = command.body
        scheduler.configure(
            bool(body["lightEnabled"]),
            bool(body["deepEnabled"]),
            int(body["deepThresholdMb"]),
            bool(body.get("closeBackgroundApps", False)),
        )
        # Só o `true` explícito e com o Modo Foco ligado nesta TV libera o fechamento.
        focus_closer.configure(
            bool(body.get("focusEnabled", False)) and body.get("focusClosesBackground") is True
        )
        await light_settings.configure(
            bool(body.get("focusEnabled", False)),
            bool(body.get("shortAnimationsEnabled", False)),
            [item for item in body.get("restrictedPackages", []) if isinstance(item, str)],
            body.get("focusPackages"),
        )
        return CommandResult(command.id, ResultStatus.OK)

    setup.handlers["tv.cleanup.v1"] = tv_cleanup_handler(cleanup, setup.transport, setup.envelopes)
    setup.handlers["tv.cleanup.config.v1"] = configure_cleanup
    setup.background_commands.add("tv.cleanup.v1")
    setup.background.append(scheduler.run)
    setup.background.append(light_settings.run)
    setup.cleanup_scheduler = scheduler
    setup.light_settings = light_settings
    light_settings.on_release(announcer.resume)
    light_settings.on_release(scheduler.resume)
    manager.on_session_opened(scheduler.note_session_opened)
    manager.subscribe(announcer.on_state)
    setup.after_hello.append(announcer.after_hello)
    setup.background.append(announcer.run)

    async def declare_when_usable() -> None:
        # `tv.adb` só vai ao `hello` se o ADB não está sabidamente quebrado. TV desligada agora
        # (sem resposta) não conta: é o normal de manhã e o ADB serve quando ela ligar. Já "a TV
        # não autorizou este PC" não se resolve sozinho: não anuncia e avisa o dono.
        try:
            await adb.connect()
        except AdbUnauthorized:
            _log.warning(
                "a TV não autorizou este PC no ADB: aceite o aviso na tela da TV "
                "e reinicie o agente. Lista de apps desligada até lá"
            )
            return
        except Exception as exc:
            _log.info("ADB sem resposta agora (%s); será usado quando a TV responder", exc)
        setup.capabilities.append("tv.adb")
        # A limpeza automática depende do mesmo ADB (que responde agora ou quando a TV ligar).
        setup.capabilities.append("tv.cleanup.automatic.v1")
        # Os campos novos de `tv.cleanup.config.v1` só vão a quem declara esta capacidade: o schema
        # antigo recusa campo desconhecido e perderia a mensagem inteira.
        setup.capabilities.extend(
            ("tv.light-settings.v1", "tv.focus-closes-background.v1", "tv.focus-catalog.v1")
        )

    setup.prepare.append(declare_when_usable)
    compose_livre(setup, settings, adb, host, clock)
    return adb


def compose_livre(setup: TvSetup, settings: Settings, adb: AdbTv, host: str, clock: Clock) -> None:
    """Liga o TV Livre: só reage a comandos do dono, um passo por vez e sempre reversível.

    A instalação leva vários segundos (baixa o APK e copia para a TV): roda fora do laço de
    mensagens, como a limpeza. O pedaço de foto é rápido e fica no laço.
    """
    if not settings.tv_livre:
        return
    base = installation_base()
    safe_host = re.sub(r"[^A-Za-z0-9.-]", "_", host)
    photos = PhotoStaging(clock)
    livre = TvLivre(
        adb,
        ReleaseApkSource(
            settings.tv_livre_apk_url,
            base / "tv-livre-apk",
            # O hash não autentica o APK: a assinatura v2/v3, conferida localmente, sim.
            verifier=ApkSignerVerifier(),
        ),
        LivreStateFile(base / f"tv-livre-{safe_host}.json"),
        photos,
        clock,
    )
    setup.handlers["tv.livre.v1"] = tv_livre_handler(livre, setup.transport, setup.envelopes)
    setup.handlers["tv.livre.photo.v1"] = tv_livre_photo_handler(photos)
    setup.background_commands.add("tv.livre.v1")

    async def declare_when_usable() -> None:
        # Depois da declaração do ADB (hook anterior): sem ADB utilizável não há módulo.
        if "tv.adb" in setup.capabilities:
            setup.capabilities.append(LIVRE_CAPABILITY)

    setup.prepare.append(declare_when_usable)


def compose_watchdog(
    setup: TvSetup, settings: Settings, host: str, clock: Clock, adb: AdbTv | None
) -> None:
    """Liga o vigia que religa o serviço do controle da TV pelo ADB quando as portas fecham.

    Sem o `adb` neste PC não há como religar, e com `tv_watchdog` desligado o dono não o quer:
    nos dois casos nada é registrado. O vigia não tem sondagem própria (ver `core/tv/watchdog.py`).
    """
    if adb is None or not settings.tv_watchdog:
        return

    async def ports_open() -> bool | None:
        for port in REMOTE_SERVICE_PORTS:
            state = await tcp_probe(host, port, wait=REFUSAL_WAIT_SECONDS)
            if state is PortState.SILENT:
                return None
            if state is PortState.REFUSED:
                return False
        return True

    events = WatchdogEvents(setup.transport, setup.envelopes, clock)
    watchdog = TvWatchdog(clock, setup.manager, ports_open, adb.restart_remote_service, events)
    setup.watchdog = watchdog
    setup.background.append(watchdog.run)
    setup.after_hello.append(events.flush)


def compose_icons(
    setup: TvSetup,
    settings: Settings,
    adb: AdbTv,
    clock: Clock,
    is_paused: Callable[[], bool] = lambda: False,
) -> AppIconPublisher | None:
    """Liga os ícones dos apps (extraídos do APK na TV). Sem `aapt2` neste PC, segue sem ícones.

    O publicador roda em tarefa de fundo: a lista sem ícones sai como sempre e os ícones chegam
    depois, um APK por vez, sem passar pela trava dos comandos curtos do ADB.
    """
    aapt = locate_aapt2(settings.aapt_path)
    if aapt is None:
        _log.info("aapt2 não encontrado (UNIOVER_AAPT_PATH ou Android SDK): sem ícones dos apps")
        return None
    scratch = TempApkScratch()
    scratch.purge()
    cache = FileIconCache(Path(settings.icons_dir) if settings.icons_dir else default_icons_dir())
    resolver = IconResolver(adb, Aapt2Inspector(aapt), cache, scratch)
    manager = setup.manager
    publisher = AppIconPublisher(
        resolver,
        adb,
        setup.transport,
        setup.envelopes,
        lambda: manager.snapshot().connection == "hot",
        clock.sleep,
        monotonic=clock.monotonic,
        is_paused=is_paused,
    )
    manager.subscribe(publisher.on_state)
    setup.background.append(publisher.run)
    return publisher


def build_handler(
    clock: Clock, tv: TvSetup | None = None, care: dict[str, Handler] | None = None
) -> HandleCommand:
    """Comandos que este agente sabe executar. Sem aparelhos habilitados, só os da manutenção
    remota (registro e atualização, que valem sem TV): todo outro comando é recusado e registrado
    (nada finge que apertou uma tecla)."""
    return HandleCommand({**(tv.handlers if tv is not None else {}), **(care or {})}, clock)


def log_file_path(settings: Settings) -> Path:
    """O registro do próprio agente: o que a configuração local diz, nunca algo vindo da rede."""
    if settings.log_file:
        return Path(settings.log_file)
    return installation_base() / "logs" / "agent.log"


def build_remote_care(
    settings: Settings,
    transport: Transport,
    envelopes: EnvelopeFactory,
    secrets: SecretStore,
    agent_id: str,
) -> dict[str, Handler]:
    """Manutenção remota: registro sem segredos e pedidos de atualizar ou reiniciar."""
    source = FileLogSource(
        log_file_path(settings),
        fallback=installation_base() / "agent.log",
        supervisor=installation_base() / "logs" / "supervisor.log",
    )

    def known_secrets() -> list[str]:
        token = secrets.get(agent_id)
        return [token] if token else []

    return {
        LOGS_REQUEST_TYPE: agent_logs_handler(source, transport, envelopes, known_secrets),
        MAINTENANCE_TYPE: agent_maintenance_handler(RuntimeFlagSignals()),
    }


def _sanitize(text: str, pattern: str, limit: int, fallback: str) -> str:
    cleaned = re.sub(pattern, "-", text).strip(" ._-()")[:limit].strip()
    return cleaned or fallback


def pairing_info(name: str | None) -> PairingInfo:
    """Nome, plataforma e versão no alfabeto e tamanho que a API aceita."""
    host = name or socket.gethostname()
    return PairingInfo(
        agent_name=_sanitize(host, r"[^\w ._()-]", 60, "agente"),
        platform=_sanitize(
            f"{platform.system()} {platform.release()}", r"[^A-Za-z0-9._ -]", 30, "pc"
        ),
        agent_version=_sanitize(agent_version(), r"[^A-Za-z0-9.+_-]", 30, "0.0.0"),
    )


StoreFactory = Callable[[], SecretStore]


def approval_link(api_url: str, user_code: str) -> str:
    """Link que abre a aprovação do dispositivo já com o código preenchido."""
    return f"{api_url}/ajustes/dispositivos?codigo={quote(user_code)}"


def print_qr(link: str) -> None:
    """Imprime o QR do link; falha de desenho é só um aviso (o código escrito basta)."""
    try:
        try:
            print(render_for(link))
        except UnicodeEncodeError:
            print(render_ascii(link))
    except Exception:
        _log.warning("não consegui desenhar o QR; use o código escrito")


def _update_page(write: Callable[[Path], None]) -> None:
    """Reescreve a página do QR; falha de disco é só um aviso."""
    try:
        write(connection_page_path())
    except OSError as exc:
        _log.warning("não consegui atualizar a página do QR (%s)", type(exc).__name__)


async def pair(  # noqa: PLR0913 - o instalador soma uma opção a cada passo
    settings: Settings,
    open_store: StoreFactory,
    name: str | None,
    *,
    if_needed: bool = False,
    no_browser: bool = False,
    installing: bool = False,
) -> int:
    api_url = require_api_url(settings)
    store = open_store()
    if if_needed and settings.agent_id and store.get(settings.agent_id) is not None:
        print("Este PC já está pareado com o UniOver.")
        return EXIT_OK
    use_case = PairAgent(HttpPairingClient(api_url), store, SystemClock())

    def show(ticket: PairingTicket) -> None:
        link = approval_link(api_url, ticket.user_code)
        print(f"\nCódigo de pareamento: {ticket.user_code}")
        print("\nEscaneie com o celular de quem administra o UniOver:\n")
        print_qr(link)
        try:
            page = connection_page_path()
            write_pairing_page(page, link, ticket.user_code)
            if not no_browser and can_open_browser():
                open_connection_page(page)
        except OSError as exc:
            _log.warning("não consegui preparar a página do QR (%s)", type(exc).__name__)
        print(
            f"\nOu abra o app ({api_url}) e aprove este código "
            f"em até {ticket.expires_in // 60} minutos."
        )
        print("Aguardando a aprovação...")

    try:
        paired = await use_case(pairing_info(name), show)
    except PairingExpired:
        _update_page(write_failed_page)
        print("O código venceu. Rode `uniover-agent pair` de novo.", file=sys.stderr)
        return EXIT_FAILURE
    except PairingDenied:
        _update_page(write_failed_page)
        print("O pareamento foi recusado no app.", file=sys.stderr)
        return EXIT_FAILURE
    except PairingError as exc:
        if connection_page_path().exists():
            _update_page(write_failed_page)
        print(f"Falha no pareamento: {exc}", file=sys.stderr)
        return EXIT_FAILURE

    if installing:
        # O instalador ainda tem a TV e a tarefa pela frente e é ele quem escreve o "Pronto".
        _update_page(
            lambda page: write_progress_page(page, "PC conectado. Terminando a instalação…")
        )
    else:
        _update_page(write_connected_page)

    # O token já está no cofre; agora o `agentId` vai para a configuração local do usuário.
    try:
        save_agent_config(config_path(), api_url=api_url, agent_id=paired.agent_id)
    except OSError as exc:
        print(
            f"Pareado, mas não consegui gravar a configuração ({type(exc).__name__}). "
            f"Defina UNIOVER_AGENT_ID={paired.agent_id} e UNIOVER_API_URL.",
            file=sys.stderr,
        )
        return EXIT_FAILURE
    print(f"Pareado como '{paired.agent_id}'. Token guardado no cofre de credenciais.")
    print("Agora rode `uniover-agent run`.")
    return EXIT_OK


def build_relocator(  # noqa: PLR0913, PLR0917
    settings: Settings,
    clock: Clock,
    is_hot: Callable[[], bool],
    known: TvKnown | None = None,
    on_refused: Callable[[], None] | None = None,
    is_paused: Callable[[], bool] = lambda: False,
) -> TvRelocator | None:
    """Vigia do endereço da TV: só existe com `tv_host`.

    `is_hot` diz se a sessão com a TV está aberta (prova de que ela responde). Fora isso, confere
    se **a TV certa** atende no endereço (o IP velho pode ter virado de um celular) e, se não,
    procura-a pelo MAC na tabela ARP, depois SSDP, depois numa varredura lenta do /24 dela.
    Sem identidade Android guardada, confirma os candidatos pela sessão com certificado pareado.
    `known` é compartilhado com o resto do agente, que aprende o MAC na primeira conexão.
    `on_refused` é avisado quando a Android TV está na rede e **recusa** a porta do controle (o
    serviço morreu): a conferência é a mesma de sempre, o vigia do serviço só aproveita o resultado.
    """
    host = settings.tv_host
    if not host:
        return None
    identity = known if known is not None else TvKnown(settings.tv_id_hint, settings.tv_mac)

    async def authenticate(candidate: str) -> bool:
        remote = AndroidTvRemoteV2(
            candidate, settings.tv_client_name, tv_cert_dir(settings.tv_name)
        )
        try:
            await remote.connect()
            return True
        except TvNotPaired, TvUnreachable:
            return False
        finally:
            await remote.disconnect()

    locator = build_locator(
        settings.tv_kind,
        host,
        identity,
        clock,
        authenticate=authenticate if settings.tv_kind == "android" else None,
    )

    async def reachable() -> bool:
        if settings.tv_kind == "android":
            state = await tcp_probe(host, ANDROID_REMOTE_PORT, wait=REFUSAL_WAIT_SECONDS)
            if state is PortState.REFUSED and on_refused is not None:
                on_refused()
            return state is PortState.OPEN
        return await locator.is_at(host)

    async def rescan() -> str | None:
        located = await locator.find(host)
        if located is None or located.host == host:
            return None
        if settings.tv_kind == "android" and identity.mac is None:
            await locator.learn_mac(located.host)
        values: dict[str, ConfigValue] = {"tv_host": located.host}
        if identity.mac is not None:
            values["tv_mac"] = identity.mac
        if identity.hint is not None:
            values["tv_id_hint"] = identity.hint
        update_config(config_path(), values)
        return located.host

    learned_at: list[float] = []

    async def learn_arp_mac() -> None:
        """Com a TV confirmada no endereço, guarda o MAC que o ARP mostra (a TV pode estar no
        cabo). Só olha a tabela de tempos em tempos e para de olhar depois de aprender."""
        if settings.tv_kind == "android" and not is_hot():
            return
        now = clock.monotonic()
        if learned_at and (learned_at[0] < 0 or now - learned_at[0] < ARP_LEARN_SECONDS):
            return
        learned_at[:] = [now]
        mac = await locator.learn_mac(host)
        if mac is not None:
            update_config(config_path(), {"tv_mac": mac})
            learned_at[:] = [-1.0]
            _log.info("MAC da TV guardado a partir da tabela ARP")

    return TvRelocator(
        clock,
        is_hot=is_hot,
        reachable=reachable,
        rescan=rescan,
        on_alive=learn_arp_mac,
        is_paused=is_paused,
    )


async def supervise(
    supervisor: ConnectionSupervisor,
    relocator: TvRelocator | None,
    *,
    clock: Clock | None = None,
    kit: DiagnosticsKit | None = None,
) -> bool:
    """Mantém a conexão com a API até ela acabar; devolve `True` se a TV mudou de endereço.

    Mudou de endereço: o novo já está gravado no arquivo, e a conexão com a API cai para `main`
    recomeçar com ele. Sem derrubá-la, o canal antigo, aberto, faria a API recusar o novo por
    "substituído" e custaria um minuto de espera.
    """
    connection = asyncio.create_task(supervisor.run())
    # Um erro do vigia do endereço não pode passar por "a TV mudou": ele é registrado e recomeça.
    watch = (
        asyncio.create_task(
            run_supervised(
                "tv.endereco",
                relocator.run,
                clock=clock or SystemClock(),
                recorder=kit.recorder if kit is not None else None,
            )
        )
        if relocator is not None
        else None
    )
    tasks = [task for task in (connection, watch) if task is not None]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        if connection.done():
            connection.result()
            return False
        return True
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def run(  # noqa: PLR0912, PLR0915 - composição
    settings: Settings, open_store: StoreFactory, kit: DiagnosticsKit | None = None
) -> int:
    agent_id = settings.agent_id
    if not agent_id:
        print(_NOT_PAIRED, file=sys.stderr)
        return EXIT_NOT_PAIRED
    secrets = open_store()
    if secrets.get(agent_id) is None:
        print(_NOT_PAIRED, file=sys.stderr)
        return EXIT_NOT_PAIRED
    api_url = require_api_url(settings)
    tray = TrayStatus(settings.tv_name)

    clock = SystemClock()
    kit = kit or build_diagnostics(clock)
    run_state = RunState(installation_base() / "runtime")
    install_crash_trace(installation_base() / "logs", kit.recorder)
    asyncio.get_running_loop().set_exception_handler(loop_exception_handler(kit.recorder))
    announce_start(run_state, kit, settings, build_version())
    # Arruma a pasta (restos de atualização, estrutura): só mexe no que tem nome conhecido.
    await asyncio.to_thread(tidy, installation_base())
    gate = EnvelopeGate(agent_id)
    envelopes = EnvelopeFactory(agent_id, gate, clock)
    transport = WebSocketTransport(
        build_ws_url(api_url, agent_id),
        lambda: secrets.get(agent_id),
        user_agent=f"uniover-agent/{agent_version()}",
    )
    tv = build_tv(settings, clock, transport, envelopes, secrets)
    if tv is not None:
        for step in tv.prepare:
            await step()
    process = ProcessMessage(
        agent_id,
        gate,
        build_handler(
            clock, tv, build_remote_care(settings, transport, envelopes, secrets, agent_id)
        ),
        envelopes,
        transport,
        background_types=tv.background_commands if tv is not None else (),
        on_command=(
            lambda command: (
                tv.cleanup_scheduler.note_message(command.type)
                if tv is not None and tv.cleanup_scheduler is not None
                else None
            )
        ),
    )
    publisher: TvStatePublisher | None = None
    after_hello: list[Callable[[], Awaitable[None]]] = []
    if tv is not None:
        publisher = TvStatePublisher(transport, envelopes)
        tv.manager.subscribe(publisher.publish)
        tv.manager.subscribe(tray.tv_state)
        manager, announcer = tv.manager, publisher

        async def announce_tv() -> None:
            # A API recém-conectada não conhece o estado: informa o atual logo depois do `hello`.
            await announcer.announce(manager.snapshot())

        after_hello = [announce_tv, *tv.after_hello]

    diary = AbsenceDiary(installation_base() / "runtime" / "last-alive", clock)
    diary.start()
    watch = ConnectionWatch()
    health = TaskHealth(clock)
    shipper = DiagnosticsShipper(kit.store, kit.recorder, transport, envelopes, clock)

    def on_disconnected() -> None:
        tray.disconnected()
        diary.disconnected()
        watch.disconnected_now()

    async def on_connected() -> None:
        tray.connected()
        diary.connected()
        watch.connected_now()
        for step in after_hello:
            await step()
        if settings.self_care:
            await shipper.flush()

    update_source = FileUpdateStatus(default_status_path(), agent_source_dir())
    supervisor = ConnectionSupervisor(
        transport,
        process,
        envelopes,
        clock,
        random.SystemRandom().random,
        agent_version=build_version(),
        capabilities=(
            "transport.keepalive.v1",
            LOGS_CAPABILITY,
            MAINTENANCE_CAPABILITY,
            *((DIAGNOSTICS_CAPABILITY,) if settings.self_care else ()),
            *(tuple(tv.capabilities) if tv is not None else ()),
        ),
        on_connected=on_connected,
        on_disconnected=on_disconnected,
        os_description=describe_os(),
        tv=(settings.tv_kind, settings.tv_host) if tv is not None and settings.tv_host else None,
        update_status=lambda: update_body(update_source.read()),
    )
    _log.info("agente %s iniciando (api %s)", agent_id, api_url)
    jobs: list[Callable[[], Coroutine[Any, Any, None]]] = [
        UpdateStatusWatcher(update_source, transport, envelopes, clock).run,
        diary.run,
    ]
    if tv is not None:
        jobs = [*jobs, tv.manager.watch, *tv.background]
    if settings.self_care:
        care = SelfCare(
            build_checks(
                settings,
                api_url=api_url,
                watch=watch,
                health=health,
                signals=RuntimeFlagSignals(),
            ),
            kit.recorder,
            clock,
            on_critical=lambda outcome: roll_back_if_in_trial(outcome, kit),
        )
        jobs = [*jobs, care.run, shipper.run]
    # Cada tarefa de fundo é supervisionada: erro vira registro e ocorrência, e ela recomeça.
    background = [
        asyncio.create_task(
            keep_running(job.__qualname__, job, clock=clock, recorder=kit.recorder, health=health)
        )
        for job in jobs
    ]
    relocator = (
        build_relocator(
            settings,
            clock,
            lambda: tv.manager.snapshot().connection == "hot",
            tv.known,
            tv.watchdog.request if tv.watchdog is not None else None,
            lambda: tv.light_settings.focus_active if tv.light_settings is not None else False,
        )
        if tv is not None
        else None
    )
    moved = False
    stopped_because = "erro"
    try:
        moved = await supervise(supervisor, relocator, clock=clock, kit=kit)
        stopped_because = "tv_mudou_de_endereco" if moved else "credencial_recusada"
    except asyncio.CancelledError:
        stopped_because = "cancelado"
        raise
    finally:
        # Ao encerrar, fecha a sessão com a TV de forma limpa (não deixa o canal pendurado).
        for task in background:
            task.cancel()
        await asyncio.gather(*background, return_exceptions=True)
        await process.aclose()
        if tv is not None:
            await tv.manager.aclose()
        if publisher is not None:
            await publisher.aclose()
        kit.recorder.flush_pending()
        run_state.end(stopped_because)
    if moved:
        return EXIT_TV_MOVED
    # `run` só devolve quando a credencial foi recusada; o token continua no cofre.
    print(
        "Token revogado ou inválido. Rode `uniover-agent pair` para parear de novo.",
        file=sys.stderr,
    )
    return EXIT_CREDENTIAL_REJECTED


async def status(settings: Settings, open_store: StoreFactory) -> int:
    agent_id = settings.agent_id
    if not agent_id or open_store().get(agent_id) is None:
        print(_NOT_PAIRED)
        return EXIT_OK
    api_url = require_api_url(settings)
    print(f"Pareado como '{agent_id}'; token no cofre de credenciais.")
    # Não abre o canal do agente: uma segunda conexão derrubaria a do agente em execução.
    reachable = await probe_api(api_url)
    print(f"API {'alcançável' if reachable else 'sem resposta (pode estar acordando)'}: {api_url}")
    return EXIT_OK


async def _ask_tv_code() -> str:
    print("\nA TV deve estar mostrando um código de 6 caracteres na tela.")
    return await asyncio.to_thread(input, "Digite o código da TV: ")


async def tv_pair(  # noqa: PLR0911, PLR0913, PLR0917 - espelha a linha de comando e os testes
    settings: Settings,
    host: str | None,
    name: str | None,
    kind: str | None = None,
    secrets: SecretStore | None = None,
    ask_code: Callable[[], Awaitable[str]] = _ask_tv_code,
    *,
    if_needed: bool = False,
    identify: Callable[[TvKindName, str], Awaitable[TvIdentity | None]] | None = None,
) -> int:
    """Pareia a TV escolhida e guarda a credencial no lugar adequado ao driver.

    Com `if_needed`, uma TV que já tem credencial guardada não é pareada de novo (o instalador
    roda de novo para atualizar sem pedir outro aceite na TV).
    """
    tv_host = require_tv_host(host or settings.tv_host)
    tv_kind = kind or settings.tv_kind
    tv_name = name or settings.tv_name
    configured = tv_host == settings.tv_host and tv_kind == settings.tv_kind
    if tv_kind == "samsung":
        if secrets is None:
            print("Não consegui abrir o Cofre de Credenciais para a TV Samsung.", file=sys.stderr)
            return EXIT_FAILURE
        if if_needed and secrets.get(samsung_token_name(tv_name)) is not None:
            print("A TV Samsung já está pareada.")
            return EXIT_OK
        print(f"Pareando com a TV Samsung em {tv_host}. Aceite o aviso na TV em até 60 segundos.")
        try:
            # O mesmo nome de sempre: a TV liga a permissão a ele.
            client_name = resolve_samsung_client_name(secrets, tv_name, settings.tv_client_name)
            token = await pair_samsung_tv(tv_host, client_name)
            secrets.set(samsung_token_name(tv_name), token)
            secrets.delete(samsung_permission_key(tv_name))
        except SamsungPairingError as exc:
            print(f"Falha no pareamento da TV Samsung: {exc}", file=sys.stderr)
            return EXIT_FAILURE
        print("TV Samsung pareada. Token guardado no Cofre de Credenciais.")
        await _remember_paired_identity(settings, tv_kind, tv_host, configured, identify)
        if not configured:
            print(
                f"Agora defina UNIOVER_TV_KIND=samsung e UNIOVER_TV_HOST={tv_host} "
                "(ou no agent.toml)."
            )
        return EXIT_OK
    cert_dir = tv_cert_dir(tv_name)
    if if_needed and is_paired(cert_dir):
        print("A TV já está pareada.")
        return EXIT_OK
    print(f"Pareando com a TV em {tv_host}. Deixe a TV ligada e a tela de pareamento aberta.")
    try:
        await pair_tv(tv_host, settings.tv_client_name, cert_dir, ask_code)
    except TvPairingError as exc:
        print(f"Falha no pareamento da TV: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    print(f"TV pareada. Certificado guardado em {cert_dir} (acesso só do seu usuário).")
    await _remember_paired_identity(settings, tv_kind, tv_host, configured, identify)
    if not configured:
        print(f"Agora defina UNIOVER_TV_HOST={tv_host} (ou tv_host no agent.toml) e rode `run`.")
    return EXIT_OK


async def _remember_paired_identity(
    settings: Settings,
    kind: str,
    host: str,
    configured: bool,
    identify: Callable[[TvKindName, str], Awaitable[TvIdentity | None]] | None,
) -> None:
    """Depois de parear, grava o `duid` e o MAC da TV (a TV está ligada e acabou de responder).

    Só quando é a TV já configurada: parear outra por `--host` não mexe no arquivo."""
    if identify is None or not configured or kind not in {"android", "samsung"}:
        return
    identity = await identify(kind, host)  # type: ignore[arg-type]
    if identity is None:
        return
    known = TvKnown(settings.tv_id_hint, settings.tv_mac)
    remember_tv_identity(known, identity)


async def _ask_line(prompt: str) -> str:
    try:
        return await asyncio.to_thread(input, prompt)
    except EOFError:
        return ""


def _describe(tv: DiscoveredTv) -> str:
    label = "Samsung" if tv.kind == "samsung" else "Android TV"
    return f"{label} {tv.name} em {tv.host}" if tv.name else f"{label} em {tv.host}"


async def tv_volume(settings: Settings) -> int:
    """`tv-volume`: roda os caminhos de leitura do volume da TV configurada e conta o resultado."""
    host = require_tv_host(settings.tv_host)
    if settings.tv_kind == "samsung":
        return await check_volume("samsung", samsung=SamsungVolume(host))
    path = locate_adb(settings.adb_path)
    adb = (
        None
        if path is None
        else AdbTv(path, host, settings.tv_adb_port, timeout=settings.adb_timeout_seconds)
    )
    return await check_volume("android", adb=adb)


async def tv_find(
    kind: TvKindName | None = None,
    *,
    find: Callable[[TvKindName | None], Awaitable[list[DiscoveredTv]]] | None = None,
    ask: Callable[[str], Awaitable[str]] = _ask_line,
    interactive: bool | None = None,
) -> int:
    """Procura a TV na rede local e grava tipo, endereço e identificador no `agent.toml`.

    Uma TV achada é usada direto; havendo várias, pergunta qual (sem terminal interativo não
    há como perguntar: falha com a explicação em vez de adivinhar).
    """
    print("Procurando a TV na rede (leva alguns segundos)...")
    tvs = await (find or find_tvs)(kind)
    if not tvs:
        print(
            "Não encontrei nenhuma TV. Confira se ela está ligada e no mesmo Wi-Fi deste PC.",
            file=sys.stderr,
        )
        return EXIT_FAILURE
    chosen = tvs[0]
    if len(tvs) > 1:
        if interactive is None:
            interactive = sys.stdin.isatty()
        if not interactive:
            print(
                "Há mais de uma TV na rede; rode `uniover-agent tv-find` num terminal para "
                "escolher, ou informe o tipo com --kind.",
                file=sys.stderr,
            )
            return EXIT_FAILURE
        print("Encontrei mais de uma TV:")
        for number, tv in enumerate(tvs, start=1):
            print(f"  {number}) {_describe(tv)}")
        answer = (await ask(f"Qual é a sua? (1-{len(tvs)}): ")).strip()
        if not answer.isdigit() or not 1 <= int(answer) <= len(tvs):
            print("Escolha inválida.", file=sys.stderr)
            return EXIT_FAILURE
        chosen = tvs[int(answer) - 1]
    update_config(
        config_path(),
        {
            "tv_kind": chosen.kind,
            "tv_host": chosen.host,
            "tv_id_hint": chosen.id_hint,
            "tv_mac": chosen.mac,
        },
    )
    print(f"TV encontrada: {_describe(chosen)}.")
    if chosen.id_hint is None:
        print(
            "Aviso: esta TV não informa um identificador; se o endereço dela mudar, "
            "rode `uniover-agent tv-find` de novo."
        )
    return EXIT_OK


async def diagnose(settings: Settings, *, repair: bool) -> int:
    """`diagnose`: roda o auto-diagnóstico uma vez, em palavras simples, e diz o que viu.

    Não abre conexão com a API nem mexe na TV. Sai com 1 se alguma verificação achou um problema de
    verdade (um aviso, como a TV desligada, não conta).
    """
    clock = SystemClock()
    kit = build_diagnostics(clock)
    checks = build_checks(settings, api_url=settings.api_url, watch=None, health=None)
    care = SelfCare(checks, kit.recorder, clock)
    outcomes = await care.run_once(repair=repair)
    lines = [(o.name, o.result.ok or o.repaired, o.result.detail) for o in outcomes]
    for line in describe_problems(lines):
        print(line)
    for outcome in outcomes:
        if outcome.repaired:
            print(f"Reparado: {outcome.name}.")
    print(f"Detalhes no registro: {log_file_path(settings)}")
    failed = [o for o in outcomes if not o.result.ok and o.result.severity == "error"]
    return EXIT_FAILURE if failed else EXIT_OK


def update_agent(
    *, sync: bool, settings: Settings | None = None, kit: DiagnosticsKit | None = None
) -> int:
    """Atualiza o agente instalado pelo ramo do canal; se falhar, o atual continua valendo."""
    migrate_layout()
    status_file = default_status_path()
    channel = settings.update_channel if settings is not None else DEFAULT_CHANNEL
    _safely(record_updating, status_file, datetime.now(UTC))
    try:
        result = self_update(agent_source_dir(), sync=sync, channel=channel)
    except Exception as exc:
        # Não devia acontecer (a atualização devolve o motivo); se ocorrer, o estado diz que falhou.
        _log.exception("a auto-atualização falhou de forma inesperada")
        _safely(
            record_failure,
            status_file,
            f"erro inesperado na atualização ({type(exc).__name__})",
            datetime.now(UTC),
        )
        print("A atualização falhou; o agente atual continua valendo.")
        return EXIT_OK
    _safely(record_result, status_file, result, datetime.now(UTC))
    if kit is not None:
        _note_update_outcome(kit, result)
    print(result.message)
    return EXIT_OK


def _note_update_outcome(kit: DiagnosticsKit, result: UpdateResult) -> None:
    """O que a atualização concluiu vira ocorrência (a recusa de um pacote é a que mais importa)."""
    if result.rejected:
        kit.recorder.record("update.rejected", "error", result.message, component="update")
    elif result.outcome == "failed":
        kit.recorder.record("update.failed", "warn", result.message, component="update")
    elif result.outcome == "updated":
        kit.recorder.record("update.installed", "info", "versão nova instalada", component="update")


def _safely(action: Callable[..., None], *arguments: Any) -> None:
    """O estado da atualização é só informativo: nada nele pode atrapalhar o agente."""
    try:
        action(*arguments)
    except Exception:
        _log.exception("não consegui registrar o estado da atualização")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="uniover-agent", description="Agente local do UniOver.")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run", help="conecta à API e roda em primeiro plano (padrão)")
    pair_parser = sub.add_parser("pair", help="pareia este PC com um código curto")
    pair_parser.add_argument("--name", help="nome do agente (padrão: nome do computador)")
    pair_parser.add_argument(
        "--if-needed", action="store_true", help="não pareia de novo se este PC já está pareado"
    )
    pair_parser.add_argument(
        "--installing",
        action="store_true",
        help="chamado pelo instalador: a página segue em andamento depois do pareamento",
    )
    pair_parser.add_argument(
        "--no-browser", action="store_true", help="não abre a página local do QR no navegador"
    )
    sub.add_parser("status", help="mostra se há token e se a API responde")
    tv_parser = sub.add_parser("tv-pair", help="pareia o agente com a TV (código mostrado na tela)")
    tv_parser.add_argument("--kind", choices=("android", "samsung"), help="tipo da TV")
    tv_parser.add_argument("--host", help="endereço IP da TV (padrão: UNIOVER_TV_HOST)")
    tv_parser.add_argument("--name", help="nome da pasta do certificado (padrão: UNIOVER_TV_NAME)")
    tv_parser.add_argument(
        "--installing",
        action="store_true",
        help="chamado pelo instalador (sem console): o código da TV é pedido numa janela",
    )
    tv_parser.add_argument(
        "--if-needed", action="store_true", help="não pareia de novo uma TV que já está pareada"
    )
    find_parser = sub.add_parser(
        "tv-find", help="procura a TV na rede local e grava o endereço no agent.toml"
    )
    find_parser.add_argument("--kind", choices=("android", "samsung"), help="só este tipo de TV")
    update_parser = sub.add_parser(
        "self-update", help="atualiza o agente instalado se a versão pública mudou"
    )
    update_parser.add_argument(
        "--no-sync", action="store_true", help="não roda `uv sync` depois (o instalador faz)"
    )
    diagnose_parser = sub.add_parser(
        "diagnose", help="confere a saúde deste agente (pasta, início automático, API, TV)"
    )
    diagnose_parser.add_argument(
        "--repair", action="store_true", help="também aplica os reparos seguros que existirem"
    )
    sub.add_parser(
        "tv-volume", help="mostra por quais caminhos o agente consegue ler o volume da TV (só lê)"
    )
    sub.add_parser("tray", help=argparse.SUPPRESS)
    return parser


def main(  # noqa: PLR0911, PLR0912 - um retorno por comando
    argv: Sequence[str] | None = None, *, secrets: SecretStore | None = None
) -> int:
    args = _parser().parse_args(argv)
    command = args.command or "run"
    try:
        # Também roda quando um wrapper antigo inicia o código novo pela primeira vez.
        migrate_layout()
        settings = Settings()
        configure_logging(settings.log_level, settings.log_file)
        kit: DiagnosticsKit | None = None
        if command in {"run", "self-update"} and settings.self_care:
            # Daqui em diante, todo erro registrado vira também uma ocorrência de diagnóstico.
            kit = build_diagnostics(SystemClock())
            attach_log_handler(kit)

        def open_store() -> SecretStore:
            # O cofre só é aberto quando o comando precisa dele.
            return secrets or KeyringSecretStore()

        if command == "pair":
            return asyncio.run(
                pair(
                    settings,
                    open_store,
                    args.name,
                    if_needed=args.if_needed,
                    no_browser=args.no_browser,
                    installing=args.installing,
                )
            )
        if command == "status":
            return asyncio.run(status(settings, open_store))
        if command == "tv-pair":
            return asyncio.run(
                tv_pair(
                    settings,
                    args.host,
                    args.name,
                    args.kind,
                    open_store(),
                    ask_code_in_window if args.installing else _ask_tv_code,
                    if_needed=args.if_needed,
                    identify=identify_tv,
                )
            )
        if command == "tv-find":
            return asyncio.run(tv_find(args.kind))
        if command == "tv-volume":
            return asyncio.run(tv_volume(settings))
        if command == "self-update":
            return update_agent(sync=not args.no_sync, settings=settings, kit=kit)
        if command == "diagnose":
            return asyncio.run(diagnose(settings, repair=args.repair))
        if command == "tray":
            # pystray e Pillow sao opcionais para o processo principal: sem bandeja, a TV segue
            # funcionando e o supervisor tentara o icone de novo depois.
            from uniover_agent.adapters.tray import run_tray  # noqa: PLC0415 - dependência opcional

            return run_tray()
        if os.environ.pop("UNIOVER_LEGACY_TAKEOVER", None):
            # O lançador novo já foi destacado; o wrapper legado fica sem o código antigo e não
            # deve abrir uma segunda conexão com a API.
            return EXIT_OK
        while True:
            code = asyncio.run(run(settings, open_store, kit))
            if code != EXIT_TV_MOVED:
                return code
            # O endereço novo da TV já está no arquivo: recomeça lendo a configuração de novo.
            settings = Settings()
    except (ConfigError, SecretStoreError) as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    except KeyboardInterrupt:
        print("Encerrado.")
        return EXIT_OK
