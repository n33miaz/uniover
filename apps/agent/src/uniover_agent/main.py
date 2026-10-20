"""Composição do agente e comandos de linha: `run` (padrão), `pair`, `status` e `tv-pair`."""

import argparse
import asyncio
import logging
import platform
import random
import re
import socket
import sys
from collections.abc import Awaitable, Callable, Coroutine, Sequence
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Any

from uniover_agent.adapters.apk_tools import (
    Aapt2Inspector,
    FileIconCache,
    TempApkScratch,
    default_icons_dir,
    locate_aapt2,
)
from uniover_agent.adapters.local_config import save_agent_config
from uniover_agent.adapters.pairing_http import HttpPairingClient, probe_api
from uniover_agent.adapters.secret_store_keyring import KeyringSecretStore, SecretStoreError
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.transport_ws import WebSocketTransport, build_ws_url
from uniover_agent.adapters.tv_adb import AdbTv, locate_adb
from uniover_agent.adapters.tv_pairing import TvPairingError, is_paired, pair_tv
from uniover_agent.adapters.tv_remote_v2 import AndroidTvRemoteV2
from uniover_agent.config import (
    ConfigError,
    Settings,
    config_path,
    require_api_url,
    require_tv_host,
    tv_cert_dir,
)
from uniover_agent.core import (
    POWER_KEYS,
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
    TextReconciler,
    TvApps,
    TvSessionManager,
    TvStatePublisher,
    tv_app_launch_handler,
    tv_apps_refresh_handler,
    tv_key_handler,
    tv_text_handler,
    tv_wake_handler,
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
    for noisy in ("websockets", "httpx", "httpcore", "androidtvremote2"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s", force=True
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


def build_tv(
    settings: Settings, clock: Clock, transport: Transport, envelopes: EnvelopeFactory
) -> TvSetup | None:
    """Sessão da TV pelo Remote v2, ou `None` se não estiver configurada e pareada.

    A capacidade `tv.remote` só é declarada à API quando há endereço da TV **e** o par
    certificado/chave existe: declarar sem poder atender faria o app mostrar uma TV que não
    responde.
    """
    if not settings.tv_host:
        return None
    host = require_tv_host(settings.tv_host)
    cert_dir = tv_cert_dir(settings.tv_name)
    if not is_paired(cert_dir):
        _log.warning("TV configurada, mas ainda não pareada. Rode `uniover-agent tv-pair`.")
        return None
    remote = AndroidTvRemoteV2(host, settings.tv_client_name, cert_dir)
    manager = TvSessionManager(clock, remote, hibernate_seconds=settings.tv_hibernate_seconds)
    # `POWER` fica recusado: sem infravermelho a TV não volta do standby e não tem botão físico.
    keys = tv_key_handler(manager, blocked_keys=POWER_KEYS)
    text = TextReconciler(manager, monotonic=clock.monotonic)
    setup = TvSetup(
        manager,
        transport,
        envelopes,
        handlers={
            "tv.key.v1": keys,
            "tv.key.v2": keys,
            "tv.text.v1": tv_text_handler(manager, reconciler=text),
            "tv.wake.v1": tv_wake_handler(manager),
            "tv.app.launch.v1": tv_app_launch_handler(manager),
        },
        capabilities=["tv.remote"],
        text=text,
    )
    # Cada tarefa seguinte insere aqui só a linha dela; o gerenciador é o único dono da conexão.
    compose_adb(setup, settings, host, clock)  # [composição: adb]
    # [composição: vigia]
    return setup


def compose_adb(setup: TvSetup, settings: Settings, host: str, clock: Clock) -> None:
    """Liga o canal ADB: lista de apps, abertura por pacote e digitação pelo `input text`.

    Sem o `adb` neste PC nada é registrado e a TV segue só com o controle remoto. O canal entra na
    sessão como opcional (abre e hiberna junto, mas a falta dele não derruba as teclas) e os
    handlers dele são os únicos que o usam.
    """
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
    announcer = AppsAnnouncer(apps, lambda: manager.snapshot().connection == "hot")
    # O handler de `tv.text.v1` continua sendo um só: ele recebe o ADB, não é substituído.
    if setup.text is not None:
        setup.text.use_adb(adb)
    setup.handlers["tv.apps.refresh.v1"] = tv_apps_refresh_handler(apps)
    setup.handlers["tv.app.launch.v1"] = tv_app_launch_handler(manager, packages=apps)
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


async def pair(settings: Settings, open_store: StoreFactory, name: str | None) -> int:
    api_url = require_api_url(settings)
    use_case = PairAgent(HttpPairingClient(api_url), open_store(), SystemClock())

    def show(ticket: PairingTicket) -> None:
        print(f"\nCódigo de pareamento: {ticket.user_code}")
        print(
            f"Abra o app ({api_url}) e aprove este código em até {ticket.expires_in // 60} minutos."
        )
        print("Aguardando a aprovação...")

    try:
        paired = await use_case(pairing_info(name), show)
    except PairingExpired:
        print("O código venceu. Rode `uniover-agent pair` de novo.", file=sys.stderr)
        return EXIT_FAILURE
    except PairingDenied:
        print("O pareamento foi recusado no app.", file=sys.stderr)
        return EXIT_FAILURE
    except PairingError as exc:
        print(f"Falha no pareamento: {exc}", file=sys.stderr)
        return EXIT_FAILURE

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

    clock = SystemClock()
    gate = EnvelopeGate(agent_id)
    envelopes = EnvelopeFactory(agent_id, gate, clock)
    transport = WebSocketTransport(
        build_ws_url(api_url, agent_id),
        lambda: secrets.get(agent_id),
        user_agent=f"uniover-agent/{agent_version()}",
    )
    tv = build_tv(settings, clock, transport, envelopes)
    if tv is not None:
        for step in tv.prepare:
            await step()
    process = ProcessMessage(agent_id, gate, build_handler(clock, tv), envelopes, transport)
    publisher: TvStatePublisher | None = None
    after_hello: list[Callable[[], Awaitable[None]]] = []
    if tv is not None:
        publisher = TvStatePublisher(transport, envelopes)
        tv.manager.subscribe(publisher.publish)
        manager, announcer = tv.manager, publisher

        async def announce_tv() -> None:
            # A API recém-conectada não conhece o estado: informa o atual logo depois do `hello`.
            await announcer.announce(manager.snapshot())

        after_hello = [announce_tv, *tv.after_hello]

    async def on_connected() -> None:
        for step in after_hello:
            await step()

    supervisor = ConnectionSupervisor(
        transport,
        process,
        envelopes,
        clock,
        random.SystemRandom().random,
        agent_version=agent_version(),
        capabilities=tuple(tv.capabilities) if tv is not None else (),
        on_connected=on_connected if after_hello else None,
    )
    _log.info("agente %s iniciando (api %s)", agent_id, api_url)
    jobs: list[Callable[[], Coroutine[Any, Any, None]]] = []
    if tv is not None:
        jobs = [tv.manager.watch, *tv.background]
    background = [asyncio.create_task(job()) for job in jobs]
    try:
        await supervisor.run()
    finally:
        # Ao encerrar, fecha a sessão com a TV de forma limpa (não deixa o canal pendurado).
        for task in background:
            task.cancel()
        await asyncio.gather(*background, return_exceptions=True)
        if tv is not None:
            await tv.manager.aclose()
        if publisher is not None:
            await publisher.aclose()
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


async def tv_pair(
    settings: Settings,
    host: str | None,
    name: str | None,
    ask_code: Callable[[], Awaitable[str]] = _ask_tv_code,
) -> int:
    """Pareia o agente com a TV e guarda o certificado fora do repositório."""
    tv_host = require_tv_host(host or settings.tv_host)
    cert_dir = tv_cert_dir(name or settings.tv_name)
    print(f"Pareando com a TV em {tv_host}. Deixe a TV ligada e a tela de pareamento aberta.")
    try:
        await pair_tv(tv_host, settings.tv_client_name, cert_dir, ask_code)
    except TvPairingError as exc:
        print(f"Falha no pareamento da TV: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    print(f"TV pareada. Certificado guardado em {cert_dir} (acesso só do seu usuário).")
    print(f"Agora defina UNIOVER_TV_HOST={tv_host} (ou tv_host no agent.toml) e rode `run`.")
    return EXIT_OK


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="uniover-agent", description="Agente local do UniOver.")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run", help="conecta à API e roda em primeiro plano (padrão)")
    pair_parser = sub.add_parser("pair", help="pareia este PC com um código curto")
    pair_parser.add_argument("--name", help="nome do agente (padrão: nome do computador)")
    sub.add_parser("status", help="mostra se há token e se a API responde")
    tv_parser = sub.add_parser("tv-pair", help="pareia o agente com a TV (código mostrado na tela)")
    tv_parser.add_argument("--host", help="endereço IP da TV (padrão: UNIOVER_TV_HOST)")
    tv_parser.add_argument("--name", help="nome da pasta do certificado (padrão: UNIOVER_TV_NAME)")
    return parser


def main(argv: Sequence[str] | None = None, *, secrets: SecretStore | None = None) -> int:
    args = _parser().parse_args(argv)
    command = args.command or "run"
    try:
        settings = Settings()
        configure_logging(settings.log_level)

        def open_store() -> SecretStore:
            # O cofre só é aberto quando o comando precisa dele.
            return secrets or KeyringSecretStore()

        if command == "pair":
            return asyncio.run(pair(settings, open_store, args.name))
        if command == "status":
            return asyncio.run(status(settings, open_store))
        if command == "tv-pair":
            return asyncio.run(tv_pair(settings, args.host, args.name))
        return asyncio.run(run(settings, open_store))
    except (ConfigError, SecretStoreError) as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    except KeyboardInterrupt:
        print("Encerrado.")
        return EXIT_OK
