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
from collections.abc import Awaitable, Callable, Coroutine, Sequence
from dataclasses import dataclass, field
from importlib import metadata
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any
from urllib.parse import quote

from uniover_agent.adapters.apk_tools import (
    Aapt2Inspector,
    FileIconCache,
    TempApkScratch,
    default_icons_dir,
    locate_aapt2,
)
from uniover_agent.adapters.installation import migrate_layout
from uniover_agent.adapters.local_config import ConfigValue, save_agent_config, update_config
from uniover_agent.adapters.pairing_http import HttpPairingClient, probe_api
from uniover_agent.adapters.pairing_page import (
    can_open_browser,
    open_connection_page,
    write_connected_page,
    write_failed_page,
    write_pairing_page,
)
from uniover_agent.adapters.qr_terminal import render_ascii, render_for
from uniover_agent.adapters.secret_store_keyring import KeyringSecretStore, SecretStoreError
from uniover_agent.adapters.self_update import self_update
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.transport_ws import WebSocketTransport, build_ws_url
from uniover_agent.adapters.tray_status import TrayStatus
from uniover_agent.adapters.tv_adb import AdbTv, locate_adb
from uniover_agent.adapters.tv_discovery import (
    ANDROID_REMOTE_PORT,
    DiscoveredTv,
    TvKindName,
    find_tvs,
    tcp_open,
)
from uniover_agent.adapters.tv_locate import (
    build_liveness,
    build_locator,
    identify_tv,
)
from uniover_agent.adapters.tv_pairing import TvPairingError, is_paired, pair_tv
from uniover_agent.adapters.tv_remote_v2 import AndroidTvRemoteV2
from uniover_agent.adapters.tv_samsung import SamsungTvDriver
from uniover_agent.adapters.tv_samsung_pairing import SamsungPairingError, pair_samsung_tv
from uniover_agent.adapters.wol import send_wake_on_lan
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
    AppIconPublisher,
    AppsAnnouncer,
    ConnectionSupervisor,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    Handler,
    IconResolver,
    PairAgent,
    ProcessMessage,
    SamsungTvApps,
    TextReconciler,
    TvApps,
    TvCleanup,
    TvIdentity,
    TvKnown,
    TvRelocator,
    TvSessionManager,
    TvStatePublisher,
    tv_app_launch_handler,
    tv_apps_refresh_handler,
    tv_cleanup_handler,
    tv_key_handler,
    tv_text_handler,
    tv_wake_handler,
    unsupported_handler,
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

_NOT_PAIRED = "não pareado. Rode `uniover-agent pair` para parear este PC."


def agent_version() -> str:
    try:
        return metadata.version("uniover-agent")
    except metadata.PackageNotFoundError:
        return "0.0.0"


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


def build_tv(
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
    remote = AndroidTvRemoteV2(host, settings.tv_client_name, cert_dir)
    manager = TvSessionManager(
        clock,
        remote,
        hibernate_seconds=settings.tv_hibernate_seconds,
        liveness=build_liveness("android", host),
    )
    # `POWER` passa como as outras teclas: o app só o manda depois da folha de confirmação e a API
    # só o aceita pela rota própria de desligar. Sem emissor infravermelho a TV só volta com o
    # controle original, então o gerenciador de sessão não repete um `POWER` e nada aqui o reenvia.
    keys = tv_key_handler(manager)
    text = TextReconciler(
        manager,
        monotonic=clock.monotonic,
        keys=settings.tv_text_by_keys,
        key_pause_seconds=settings.tv_text_key_pause_ms / 1000,
        sleep=clock.sleep,
    )
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
            "tv.text.v1": tv_text_handler(manager, reconciler=text, monotonic=clock.monotonic),
            "tv.wake.v1": tv_wake_handler(manager),
            "tv.app.launch.v1": tv_app_launch_handler(manager),
        },
        capabilities=["tv.remote", "tv.kind.android"],
        text=text,
        known=TvKnown(settings.tv_id_hint, settings.tv_mac),
    )
    # Cada tarefa seguinte insere aqui só a linha dela; o gerenciador é o único dono da conexão.
    compose_adb(setup, settings, host, clock)  # [composição: adb]
    # [composição: vigia]
    return setup


def samsung_token_name(tv_name: str) -> str:
    """Nome estável no Cofre de Credenciais, separado do token do agente."""
    return f"samsung:{tv_name}"


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
    if token is None:
        _log.warning(
            "TV Samsung configurada, mas ainda não pareada. "
            "Rode `uniover-agent tv-pair --kind samsung`."
        )
        return None
    host = require_tv_host(settings.tv_host)
    known = TvKnown(settings.tv_id_hint, settings.tv_mac)
    remote = SamsungTvDriver(
        host,
        token,
        settings.tv_client_name,
        save_token=lambda value: secrets.set(token_name, value),
        app_ids=tuple(settings.tv_samsung_apps),
        on_identity=lambda identity: remember_tv_identity(known, identity),
    )

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
    )
    keys = tv_key_handler(manager)
    apps = SamsungTvApps(manager, remote, transport, envelopes)
    announcer = AppsAnnouncer(
        apps, lambda: manager.snapshot().connection == "hot", monotonic=clock.monotonic
    )
    manager.subscribe(announcer.on_state)
    return TvSetup(
        manager,
        transport,
        envelopes,
        handlers={
            "tv.key.v1": keys,
            "tv.key.v2": keys,
            "tv.wake.v1": tv_wake_handler(manager),
            "tv.app.launch.v1": tv_app_launch_handler(
                manager, packages=apps, links_supported=False
            ),
            "tv.apps.refresh.v1": tv_apps_refresh_handler(apps),
            "tv.text.v1": unsupported_handler("a TV Samsung não suporta digitação por este canal"),
            "tv.cleanup.v1": unsupported_handler("a TV Samsung não suporta limpeza por ADB"),
        },
        capabilities=["tv.remote", "tv.kind.samsung"],
        background=[announcer.run],
        after_hello=[announcer.after_hello],
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


def compose_adb(setup: TvSetup, settings: Settings, host: str, clock: Clock) -> None:
    """Liga o canal ADB: lista de apps, abertura por pacote e digitação pelo `input text`.

    Sem o `adb` neste PC nada é registrado e a TV segue só com o controle remoto. O canal entra na
    sessão como opcional (abre e hiberna junto, mas a falta dele não derruba as teclas) e os
    handlers dele são os únicos que o usam.
    """
    # Valida a lista do dono antes de qualquer coisa: lista errada para o agente com o motivo.
    keep = require_cleanup_keep(settings)
    path = locate_adb(settings.adb_path)
    if path is None:
        _log.warning(
            "adb não encontrado (UNIOVER_ADB_PATH, PATH ou Android SDK): "
            "lista de apps e abertura por pacote ficam desligadas"
        )
        return
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
    icons = compose_icons(setup, settings, adb, clock)
    apps = TvApps(manager, adb, setup.transport, setup.envelopes, icons)
    announcer = AppsAnnouncer(
        apps, lambda: manager.snapshot().connection == "hot", monotonic=clock.monotonic
    )
    # O handler de `tv.text.v1` continua sendo um só: ele recebe o ADB, não é substituído.
    if setup.text is not None:
        setup.text.use_adb(adb)
    setup.handlers["tv.apps.refresh.v1"] = tv_apps_refresh_handler(apps)
    setup.handlers["tv.app.launch.v1"] = tv_app_launch_handler(manager, packages=apps)
    # A limpeza só mexe no ADB (nunca na sessão do controle remoto) e leva vários segundos: roda
    # fora do laço de mensagens, e as teclas seguem enquanto ela trabalha.
    cleanup = TvCleanup(adb, clock, keep=keep)
    setup.handlers["tv.cleanup.v1"] = tv_cleanup_handler(cleanup, setup.transport, setup.envelopes)
    setup.background_commands.add("tv.cleanup.v1")
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

    setup.prepare.append(declare_when_usable)


def compose_icons(
    setup: TvSetup, settings: Settings, adb: AdbTv, clock: Clock
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
    )
    manager.subscribe(publisher.on_state)
    setup.background.append(publisher.run)
    return publisher


def build_handler(clock: Clock, tv: TvSetup | None = None) -> HandleCommand:
    """Comandos que este agente sabe executar. Sem aparelhos habilitados, nenhum: todo comando
    é recusado e registrado (nada finge que apertou uma tecla)."""
    return HandleCommand(tv.handlers if tv is not None else {}, clock)


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


async def pair(
    settings: Settings,
    open_store: StoreFactory,
    name: str | None,
    *,
    if_needed: bool = False,
    no_browser: bool = False,
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


def build_relocator(
    settings: Settings, clock: Clock, is_hot: Callable[[], bool], known: TvKnown | None = None
) -> TvRelocator | None:
    """Vigia do endereço da TV: só existe com `tv_host`.

    `is_hot` diz se a sessão com a TV está aberta (prova de que ela responde). Fora isso, confere
    se **a TV certa** atende no endereço (o IP velho pode ter virado de um celular) e, se não,
    procura-a pelo MAC na tabela ARP, depois SSDP, depois numa varredura lenta do /24 dela.
    `known` é compartilhado com o resto do agente, que aprende o MAC na primeira conexão.
    """
    host = settings.tv_host
    if not host:
        return None
    identity = known if known is not None else TvKnown(settings.tv_id_hint, settings.tv_mac)
    locator = build_locator(settings.tv_kind, host, identity, clock)

    async def reachable() -> bool:
        if settings.tv_kind == "android":
            return await tcp_open(host, ANDROID_REMOTE_PORT, wait=2.0)
        return await locator.is_at(host)

    async def rescan() -> str | None:
        located = await locator.find(host)
        if located is None or located.host == host:
            return None
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
        clock, is_hot=is_hot, reachable=reachable, rescan=rescan, on_alive=learn_arp_mac
    )


async def supervise(supervisor: ConnectionSupervisor, relocator: TvRelocator | None) -> bool:
    """Mantém a conexão com a API até ela acabar; devolve `True` se a TV mudou de endereço.

    Mudou de endereço: o novo já está gravado no arquivo, e a conexão com a API cai para `main`
    recomeçar com ele. Sem derrubá-la, o canal antigo, aberto, faria a API recusar o novo por
    "substituído" e custaria um minuto de espera.
    """
    connection = asyncio.create_task(supervisor.run())
    watch = asyncio.create_task(relocator.run()) if relocator is not None else None
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


async def run(settings: Settings, open_store: StoreFactory) -> int:
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
        build_handler(clock, tv),
        envelopes,
        transport,
        background_types=tv.background_commands if tv is not None else (),
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

    async def on_connected() -> None:
        tray.connected()
        for step in after_hello:
            await step()

    supervisor = ConnectionSupervisor(
        transport,
        process,
        envelopes,
        clock,
        random.SystemRandom().random,
        agent_version=agent_version(),
        capabilities=(
            "transport.keepalive.v1",
            *(tuple(tv.capabilities) if tv is not None else ()),
        ),
        on_connected=on_connected,
        on_disconnected=tray.disconnected,
    )
    _log.info("agente %s iniciando (api %s)", agent_id, api_url)
    jobs: list[Callable[[], Coroutine[Any, Any, None]]] = []
    if tv is not None:
        jobs = [tv.manager.watch, *tv.background]
    background = [asyncio.create_task(job()) for job in jobs]
    relocator = (
        build_relocator(
            settings, clock, lambda: tv.manager.snapshot().connection == "hot", tv.known
        )
        if tv is not None
        else None
    )
    moved = False
    try:
        moved = await supervise(supervisor, relocator)
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
            token = await pair_samsung_tv(tv_host, settings.tv_client_name)
            secrets.set(samsung_token_name(tv_name), token)
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


def update_agent(*, sync: bool) -> int:
    """Atualiza o agente instalado pela `main`. Nunca falha: o agente atual continua valendo."""
    migrate_layout()
    print(self_update(agent_source_dir(), sync=sync).message)
    return EXIT_OK


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
        "--no-browser", action="store_true", help="não abre a página local do QR no navegador"
    )
    sub.add_parser("status", help="mostra se há token e se a API responde")
    tv_parser = sub.add_parser("tv-pair", help="pareia o agente com a TV (código mostrado na tela)")
    tv_parser.add_argument("--kind", choices=("android", "samsung"), help="tipo da TV")
    tv_parser.add_argument("--host", help="endereço IP da TV (padrão: UNIOVER_TV_HOST)")
    tv_parser.add_argument("--name", help="nome da pasta do certificado (padrão: UNIOVER_TV_NAME)")
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
    sub.add_parser("tray", help=argparse.SUPPRESS)
    return parser


def main(  # noqa: PLR0911 - um retorno por comando
    argv: Sequence[str] | None = None, *, secrets: SecretStore | None = None
) -> int:
    args = _parser().parse_args(argv)
    command = args.command or "run"
    try:
        # Também roda quando um wrapper antigo inicia o código novo pela primeira vez.
        migrate_layout()
        settings = Settings()
        configure_logging(settings.log_level, settings.log_file)

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
                    if_needed=args.if_needed,
                    identify=identify_tv,
                )
            )
        if command == "tv-find":
            return asyncio.run(tv_find(args.kind))
        if command == "self-update":
            return update_agent(sync=not args.no_sync)
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
            code = asyncio.run(run(settings, open_store))
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
