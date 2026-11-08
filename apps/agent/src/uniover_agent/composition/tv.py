"""Montagem da TV (Android TV e Samsung), pareamento e varredura da rede."""

import asyncio
import logging
import re
import sys
import time
import uuid
from collections.abc import Awaitable, Callable, Collection, Coroutine, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from uniover_agent.adapters.adb_authorization import AdbAuthorization, AdbKeys, resolve_tv_mac
from uniover_agent.adapters.apk_tools import (
    Aapt2Inspector,
    FileIconCache,
    TempApkScratch,
    default_icons_dir,
    locate_aapt2,
)
from uniover_agent.adapters.arp import arp_mac
from uniover_agent.adapters.cleanup_day_file import CleanupDayFile
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.local_config import ConfigValue, update_config
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
from uniover_agent.adapters.tv_locate import build_liveness
from uniover_agent.adapters.tv_nearby import build_finder
from uniover_agent.adapters.tv_pairing import TvPairingError, is_paired, pair_tv
from uniover_agent.adapters.tv_remote_v2 import ANDROID_OPTIONAL_KEYS, AndroidTvRemoteV2
from uniover_agent.adapters.tv_samsung import (
    SAMSUNG_CLIENT_NAME,
    SAMSUNG_OPTIONAL_KEYS,
    SamsungTvDriver,
)
from uniover_agent.adapters.tv_samsung_pairing import SamsungPairingError, pair_samsung_tv
from uniover_agent.adapters.tv_samsung_volume import SamsungVolume
from uniover_agent.adapters.tv_volume_check import check_volume
from uniover_agent.adapters.wol import send_wake_on_lan
from uniover_agent.composition.system import EXIT_FAILURE, EXIT_OK
from uniover_agent.config import (
    Settings,
    adb_key_backup_dir,
    config_path,
    require_cleanup_keep,
    require_tv_host,
    tv_cert_dir,
)
from uniover_agent.core import (
    DISCOVERY_CAPABILITY,
    PERMISSION_CAPABILITY,
    POWER_OFF_CAPABILITY,
    PRESENCE_CAPABILITY,
    PRESENCE_TYPE,
    SAMSUNG_MAINTENANCE_CAPABILITY,
    SETTINGS_OPEN_CAPABILITY,
    AppIconPublisher,
    AppsAnnouncer,
    Command,
    CommandResult,
    EnvelopeFactory,
    FocusBackgroundCloser,
    Handler,
    IconResolver,
    ResultStatus,
    SamsungMaintenance,
    SamsungMaintenanceScheduler,
    SamsungTvApps,
    TextReconciler,
    TvApps,
    TvCleanup,
    TvCleanupScheduler,
    TvIdentity,
    TvKnown,
    TvLightSettings,
    TvPermission,
    TvSessionManager,
    TvSettings,
    TvWatchdog,
    UserActivity,
    WatchdogEvents,
    tv_app_launch_handler,
    tv_apps_refresh_handler,
    tv_cleanup_handler,
    tv_cleanup_skipped_handler,
    tv_discover_handler,
    tv_key_handler,
    tv_power_off_handler,
    tv_presence_handler,
    tv_settings_open_handler,
    tv_text_handler,
    tv_wake_handler,
    unsupported_handler,
    user_initiated,
)
from uniover_agent.core.tv.livre import CAPABILITY as LIVRE_CAPABILITY
from uniover_agent.core.tv.livre import (
    LivreStateFile,
    PhotoStaging,
    TvLivre,
    tv_livre_handler,
    tv_livre_photo_handler,
)
from uniover_agent.core.tv.pairing import PAIR_CAPABILITY, TvPairing
from uniover_agent.ports import (
    AdbUnauthorized,
    Clock,
    SecretStore,
    Transport,
    TransportError,
    user_initiated_adb,
)

_log = logging.getLogger("uniover_agent")
# Portas do serviço do controle remoto da Android TV: só se dá por de pé com as duas abertas.
REMOTE_SERVICE_PORTS = (ANDROID_REMOTE_PORT, 6467)


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
    # Comandos executados sem resposta (a API não a espera: a presença vem a cada toque na tela).
    silent_commands: set[str] = field(default_factory=set)
    # O que se sabe da TV (dica de identificador e MAC): o vigia do endereço e o Wake-on-LAN usam.
    known: TvKnown = field(default_factory=TvKnown)
    # O vigia do serviço do controle (só Android TV com `adb`): quem vê uma porta recusada o avisa.
    watchdog: TvWatchdog | None = None
    cleanup_scheduler: TvCleanupScheduler | SamsungMaintenanceScheduler | None = None
    light_settings: TvLightSettings | None = None
    # Quando alguém usa a TV pelo app (preenchido pelo canal ADB, que é quem precisa saber).
    activity: UserActivity | None = None
    # Chamado quando um sinal de presença é recusado por idade fora da janela (relógio do PC fora de
    # hora, entrega muito atrasada): quem monta a conexão o liga ao diagnóstico.
    on_presence_refused: Callable[[float], None] | None = None
    # Chamados quando `tv.adb` é declarado fora da partida (autorização dada depois).
    adb_declared: list[Callable[[], None]] = field(default_factory=list)
    # Rodam ao encerrar o agente (cancelam o que ficou agendado).
    closers: list[Callable[[], Awaitable[None]]] = field(default_factory=list)


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
        host,
        settings.tv_client_name,
        cert_dir,
        on_connected=learn_android_mac,
        text_cursor=settings.tv_text_cursor,
        text_debug_values=settings.tv_text_debug_values,
        text_trace=settings.tv_text_trace,
        text_counters=settings.tv_text_counters,
    )
    manager = TvSessionManager(
        clock,
        remote,
        hibernate_seconds=settings.tv_hibernate_seconds,
        liveness=build_liveness("android", host),
        power_off_read_timeout_seconds=settings.tv_power_off_read_timeout_seconds,
        power_off_confirmation_timeout_seconds=settings.tv_power_off_confirmation_timeout_seconds,
        warm_timeout_seconds=settings.tv_session_warm_timeout_seconds,
        disconnect_timeout_seconds=settings.tv_session_disconnect_timeout_seconds,
        certificate_refusals_needed=settings.tv_certificate_refusals_needed,
        certificate_refusal_gap_seconds=settings.tv_certificate_refusal_gap_seconds,
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
        remote_settle_seconds=settings.tv_text_remote_settle_ms / 1000,
        adb_group_chars=settings.tv_text_adb_group_chars,
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
    attach_pairing(setup, settings, host, cert_dir, remote)
    # Cada tarefa seguinte insere aqui só a linha dela; o gerenciador é o único dono da conexão.
    adb = compose_adb(setup, settings, host, clock)  # [composição: adb]
    if adb is not None:
        manager.set_volume_reader(volume_reader_when_push_is_silent(manager, adb))
    compose_watchdog(setup, settings, host, clock, adb)  # [composição: vigia]
    return setup


def attach_pairing(
    setup: TvSetup, settings: Settings, host: str, cert_dir: Path, remote: AndroidTvRemoteV2
) -> None:
    """Acrescenta `tv.pair.v1`: o dono pareia a Android TV de novo pelo app (só por toque dele)."""

    async def run(ask_code: Callable[[], Awaitable[str]]) -> None:
        await pair_tv(host, settings.tv_client_name, cert_dir, ask_code)

    async def paired() -> None:
        # O contexto TLS fica no cliente da biblioteca: um par refeito pede um cliente novo.
        remote.forget_client()
        await setup.manager.pairing_done()

    pairing = TvPairing(run, paired)
    setup.handlers["tv.pair.v1"] = pairing.handler()
    # A espera pelo código e pela TV não pode segurar as teclas na fila.
    setup.background_commands.add("tv.pair.v1")
    setup.capabilities.append(PAIR_CAPABILITY)
    setup.closers.append(pairing.aclose)


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
    """Compõe o que a Samsung Tizen oferece: remoto, apps e a manutenção por REST (sem ADB)."""
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
        warm_timeout_seconds=settings.tv_session_warm_timeout_seconds,
        disconnect_timeout_seconds=settings.tv_session_disconnect_timeout_seconds,
    )
    keys = tv_key_handler(manager)
    apps = SamsungTvApps(manager, remote, transport, envelopes)
    announcer = AppsAnnouncer(
        apps, lambda: manager.snapshot().connection == "hot", monotonic=clock.monotonic
    )
    manager.subscribe(announcer.on_state)
    permission = TvPermission(remote, manager, transport, envelopes)
    # Só leituras e fechamento pelo REST da TV, nunca o canal do controle: a manutenção não pode
    # causar o aviso "Permitir". O foco real é desconhecido, então ela protege o último app aberto
    # pelo UniOver e o que o estado da sessão apontar, além do que a própria TV diz estar visível.
    maintenance = SamsungMaintenance(
        remote,
        clock,
        lambda: {
            app_id
            for app_id in (apps.last_opened_app_id, manager.snapshot().app)
            if app_id is not None
        },
    )
    maintenance_scheduler = SamsungMaintenanceScheduler(
        maintenance,
        clock,
        transport,
        envelopes,
        idle_seconds=settings.tv_samsung_maintenance_idle_seconds,
    )

    async def configure_maintenance(command: Command) -> CommandResult:
        # Só o valor desta TV importa: a API manda o corpo da limpeza do Android junto, e a Samsung
        # o ignora. Sem o campo (API antiga) a manutenção continua sem fazer nada.
        value = command.body.get("maintenanceEnabled")
        if isinstance(value, bool):
            maintenance_scheduler.configure(value)
        return CommandResult(command.id, ResultStatus.OK)

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
                "automatic-only",
                "a TV Samsung faz a manutenção sozinha, quando fica parada",
            ),
            "tv.cleanup.config.v1": configure_maintenance,
        },
        capabilities=[
            "tv.remote",
            "tv.kind.samsung",
            POWER_OFF_CAPABILITY,
            PERMISSION_CAPABILITY,
            SAMSUNG_MAINTENANCE_CAPABILITY,
            *key_capabilities(SAMSUNG_OPTIONAL_KEYS),
        ],
        background=[announcer.run, maintenance_scheduler.run],
        after_hello=[permission.announce, announcer.after_hello],
        # O pedido responde em segundos, mas não pode segurar a recepção enquanto a TV é consultada.
        background_commands={"tv.permission.request.v1"},
        known=known,
        cleanup_scheduler=maintenance_scheduler,
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


def build_adb(
    path: Path,
    host: str,
    settings: Settings,
    user_active: Callable[[], bool],
    *,
    monotonic: Callable[[], float] = time.monotonic,
) -> AdbTv:
    """O único lugar que monta um `AdbTv`: sempre com a trava (registro da permissão por TV).

    O registro lembra se a TV já deu e provou a permissão a esta chave; enquanto não, e fora do
    uso da TV pelo app, o agente nunca conecta sozinho (cada conexão faria o aviso aparecer).
    """
    return AdbTv(
        path,
        host,
        settings.tv_adb_port,
        authorization=AdbAuthorization(
            tv_cert_dir(settings.tv_name),
            AdbKeys(adb_key_backup_dir()),
            f"{host}:{settings.tv_adb_port}",
        ),
        mac_resolver=lambda: resolve_tv_mac(host, settings.tv_adb_port),
        user_active=user_active,
        timeout=settings.adb_timeout_seconds,
        kill_server=settings.adb_kill_server,
        kill_server_cooldown=settings.adb_kill_server_cooldown_seconds,
        pull_timeout=settings.adb_pull_timeout_seconds,
        monotonic=monotonic,
    )


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
    # Quando alguém está diante da tela da TV no app: a única hora em que um caminho automático
    # pode abrir uma conexão ADB nova (ver `AdbTv._may_connect`). O sinal é só `tv.presence.v1`: o
    # tipo de um comando não prova ninguém (o atalho do iPhone e o desligamento agendado mandam
    # teclas sem pessoa na tela).
    if setup.activity is None:
        setup.activity = UserActivity(clock.monotonic)
    setup.handlers[PRESENCE_TYPE] = tv_presence_handler(
        setup.activity,
        on_refused=lambda age: (
            setup.on_presence_refused(age) if setup.on_presence_refused is not None else None
        ),
    )
    setup.silent_commands.add(PRESENCE_TYPE)
    adb = build_adb(path, host, settings, setup.activity.recent, monotonic=clock.monotonic)
    manager = setup.manager
    # O ADB abre nas funções avançadas. Sua espera não pode atrasar o controle remoto.
    manager.add_channel(adb, connect_on_warm=False)
    setup.closers.append(adb.aclose)

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
    # "Atualizar lista" é o pedido da pessoa que pode abrir o aviso do ADB na TV (uma vez, com a
    # marca "Sempre permitir"); a lista diária, a limpeza e o resto nunca o abrem.
    setup.handlers["tv.apps.refresh.v1"] = user_initiated(tv_apps_refresh_handler(apps))
    setup.handlers["tv.app.launch.v1"] = tv_app_launch_handler(manager, packages=apps)
    # Rede e Configurações da TV: lista fechada de duas telas, só quando a pessoa toca no botão.
    setup.handlers["tv.settings.open.v1"] = tv_settings_open_handler(TvSettings(manager, adb))
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
        CleanupDayFile(installation_base() / "runtime"),
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

    def declare_adb_capabilities() -> None:
        if "tv.adb" in setup.capabilities:
            return
        setup.capabilities.append("tv.adb")
        setup.capabilities.append(PRESENCE_CAPABILITY)
        setup.capabilities.append(SETTINGS_OPEN_CAPABILITY)
        # A limpeza automática depende do mesmo ADB (que responde agora ou quando a TV ligar).
        setup.capabilities.append("tv.cleanup.automatic.v1")
        # Os campos novos de `tv.cleanup.config.v1` só vão a quem declara esta capacidade: o schema
        # antigo recusa campo desconhecido e perderia a mensagem inteira.
        setup.capabilities.extend(
            ("tv.light-settings.v1", "tv.focus-closes-background.v1", "tv.focus-catalog.v1")
        )
        for hook in setup.adb_declared:
            hook()

    async def declare_when_usable() -> None:
        # `tv.adb` vai ao `hello` sempre que há `adb` neste PC, mesmo sem a permissão da TV: o app
        # só mostra "Atualizar lista" (o único toque que pede a permissão) a quem tem a
        # capacidade, e sem ela o dono nunca teria como dar o primeiro aceite. Nada fica exposto:
        # toda rota automática por trás dela passa pela trava e só lê o estado. A partida apenas
        # confere: com a permissão provada conecta; sem ela, nunca abre o aviso sozinha.
        try:
            await adb.connect()
        except AdbUnauthorized:
            _log.warning(
                "a TV ainda não deu a permissão do ADB ao UniOver: toque em Atualizar lista no "
                "app e aceite o aviso na TV, marcando Sempre permitir neste computador. Nenhum "
                "aviso é aberto sozinho; a lista de apps fica desligada até lá"
            )
        except Exception as exc:
            _log.info("ADB sem resposta agora (%s); será usado quando a TV responder", exc)
        declare_adb_capabilities()

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
        remote_guard=setup.manager,
    )
    # Ler o estado ao abrir a tela não é pedido de permissão; as ações do TV Livre (instalar,
    # aplicar) são ações da pessoa e podem abrir o aviso do ADB.
    setup.handlers["tv.livre.v1"] = user_initiated(
        tv_livre_handler(livre, setup.transport, setup.envelopes),
        when=lambda command: command.body.get("action") != "status",
    )
    setup.handlers["tv.livre.photo.v1"] = tv_livre_photo_handler(photos)
    setup.background_commands.add("tv.livre.v1")

    def declare() -> None:
        # Sem ADB utilizável não há módulo; o gancho cobre o ADB autorizado só depois da partida.
        if LIVRE_CAPABILITY not in setup.capabilities:
            setup.capabilities.append(LIVRE_CAPABILITY)

    async def declare_when_usable() -> None:
        # Depois da declaração do ADB (passo anterior).
        if "tv.adb" in setup.capabilities:
            declare()

    setup.prepare.append(declare_when_usable)
    setup.adb_declared.append(declare)


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
    watchdog = TvWatchdog(
        clock,
        setup.manager,
        ports_open,
        adb.restart_remote_service,
        events,
        cooldowns=(
            settings.tv_watchdog_cooldown_first_seconds,
            settings.tv_watchdog_cooldown_second_seconds,
            settings.tv_watchdog_cooldown_third_seconds,
            settings.tv_watchdog_cooldown_max_seconds,
        ),
        adb_cooldown_seconds=settings.tv_watchdog_adb_cooldown_seconds,
        probe_seconds=settings.tv_watchdog_probe_seconds,
        restart_seconds=settings.tv_watchdog_restart_seconds,
        budget_seconds=settings.tv_watchdog_budget_seconds,
    )
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
    # Diagnóstico pedido por quem roda o comando: é um pedido da pessoa, então pode abrir o aviso.
    adb = None if path is None else build_adb(path, host, settings, lambda: True)
    with user_initiated_adb() as request:
        try:
            return await check_volume("android", adb=adb)
        finally:
            await request.finish()


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
