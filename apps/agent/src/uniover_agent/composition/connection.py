"""Conexão com a API: handler, cuidados remotos, vigia do endereço e laço `run`."""

import asyncio
import logging
import random
import shutil
import sys
from collections.abc import Awaitable, Callable, Coroutine, Iterable
from pathlib import Path
from typing import Any

from uniover_agent.adapters.absence_diary import AbsenceDiary
from uniover_agent.adapters.agent_log_file import FileLogSource
from uniover_agent.adapters.crash_trace import install_crash_trace, loop_exception_handler
from uniover_agent.adapters.housekeeping import tidy
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.local_config import ConfigValue, update_config
from uniover_agent.adapters.loop_watchdog import LoopWatchdog
from uniover_agent.adapters.maintenance_signals import RuntimeFlagSignals
from uniover_agent.adapters.pairing_http import fetch_api_features
from uniover_agent.adapters.run_state import RunState
from uniover_agent.adapters.self_care_checks import ConnectionWatch
from uniover_agent.adapters.startup_trace import mark_session_started
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.transport_ws import WebSocketTransport, build_ws_url
from uniover_agent.adapters.tray_status import TrayStatus
from uniover_agent.adapters.tv_discovery import (
    ANDROID_REMOTE_PORT,
    REFUSAL_WAIT_SECONDS,
    PortState,
    tcp_probe,
)
from uniover_agent.adapters.tv_locate import build_locator
from uniover_agent.adapters.tv_remote_v2 import AndroidTvRemoteV2
from uniover_agent.adapters.tv_use_marker import MARKER_FILE as TV_USE_MARKER_FILE
from uniover_agent.adapters.tv_use_marker import PC_MARKER_FILE as PC_USE_MARKER_FILE
from uniover_agent.adapters.tv_use_marker import TvUseMarker
from uniover_agent.adapters.update_status import FileUpdateStatus, default_status_path
from uniover_agent.care_setup import (
    DiagnosticsKit,
    announce_start,
    build_checks,
    build_diagnostics,
    roll_back_if_in_trial,
)
from uniover_agent.composition.diagnostics_delivery import DiagnosticsDelivery
from uniover_agent.composition.pairing import StoreFactory
from uniover_agent.composition.pc import PcSetup, build_pc
from uniover_agent.composition.system import (
    _NOT_PAIRED,
    EXIT_CREDENTIAL_REJECTED,
    EXIT_NOT_PAIRED,
    EXIT_TV_MOVED,
    agent_version,
    build_version,
    describe_os,
)
from uniover_agent.composition.tv import TvSetup, build_tv
from uniover_agent.config import (
    Settings,
    agent_source_dir,
    config_path,
    require_api_url,
    tv_cert_dir,
)
from uniover_agent.core import (
    LOGS_CAPABILITY,
    LOGS_REQUEST_TYPE,
    MAINTENANCE_CAPABILITY,
    MAINTENANCE_TYPE,
    PC_SILENT_TYPES,
    PRESENCE_CAPABILITY,
    SETTINGS_OPEN_CAPABILITY,
    ConnectionSupervisor,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    Handler,
    ProcessMessage,
    TvKnown,
    TvRelocator,
    TvStatePublisher,
    UpdateStatusWatcher,
    agent_logs_handler,
    agent_maintenance_handler,
    update_body,
)
from uniover_agent.core.api_features import (
    FEATURES_TIMEOUT_SECONDS,
    NOT_PAIRED_FEATURE,
    WAKING_FEATURE,
    ApiFeatures,
)
from uniover_agent.core.diagnostics import DIAGNOSTICS_CAPABILITY, DiagnosticsShipper
from uniover_agent.core.disk_alarm import DiskAlarm
from uniover_agent.core.self_care import SelfCare
from uniover_agent.core.supervision import TaskHealth, keep_running, run_supervised
from uniover_agent.core.tv.pairing import PAIR_CAPABILITY
from uniover_agent.ports import Clock, SecretStore, Transport, TvNotPaired, TvUnreachable

_log = logging.getLogger("uniover_agent")
# De quanto em quanto tempo o vigia olha o ARP atrás do MAC da TV, enquanto não o aprendeu.
ARP_LEARN_SECONDS = 600.0
# Prazo da arrumação da pasta na partida: sem ele, um disco travado impediria o agente de subir.
TIDY_TIMEOUT_SECONDS = 60.0
# Capacidades que uma API anterior recusaria no `hello` (ela não as conhece): só vão depois de a API
# listá-las em `features`.
API_LISTED_CAPABILITIES = frozenset(
    {PAIR_CAPABILITY, PRESENCE_CAPABILITY, SETTINGS_OPEN_CAPABILITY}
)


def declarable_capabilities(
    capabilities: Iterable[str], api_supports: Callable[[str], bool]
) -> tuple[str, ...]:
    """As capacidades da TV que podem ir ao `hello` agora.

    Uma API anterior recusa o `hello` com capacidade que não conhece: as de
    `API_LISTED_CAPABILITIES` só vão depois de a API listá-las em `features`; as demais vão sempre.
    """
    return tuple(
        capability
        for capability in capabilities
        if capability not in API_LISTED_CAPABILITIES or api_supports(capability)
    )


def build_handler(
    clock: Clock,
    tv: TvSetup | None = None,
    care: dict[str, Handler] | None = None,
    pc: PcSetup | None = None,
) -> HandleCommand:
    """Comandos que este agente sabe executar. Sem aparelhos habilitados, só os da manutenção
    remota (registro e atualização, que valem sem TV): todo outro comando é recusado e registrado
    (nada finge que apertou uma tecla)."""
    return HandleCommand(
        {
            **(tv.handlers if tv is not None else {}),
            **(pc.handlers if pc is not None else {}),
            **(care or {}),
        },
        clock,
    )


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


def build_relocator(  # noqa: PLR0913, PLR0917
    settings: Settings,
    clock: Clock,
    is_hot: Callable[[], bool],
    known: TvKnown | None = None,
    on_refused: Callable[[], None] | None = None,
    is_paused: Callable[[], bool] = lambda: False,
    on_recovered: Callable[[], Awaitable[None]] | None = None,
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
        empty_searches_limit=settings.tv_locator_empty_searches,
        slow_search_seconds=settings.tv_locator_slow_search_seconds,
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
        on_recovered=on_recovered,
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
    clock = SystemClock()
    tray = TrayStatus(settings.tv_name, clock)

    kit = kit or build_diagnostics(clock)
    run_state = RunState(installation_base() / "runtime")
    install_crash_trace(installation_base() / "logs", kit.recorder)
    asyncio.get_running_loop().set_exception_handler(loop_exception_handler(kit.recorder))
    announce_start(run_state, kit, settings, build_version())
    # Arruma a pasta (restos de atualização, estrutura): só mexe no que tem nome conhecido.
    # Com prazo: uma pasta travada (disco cheio ou em disputa) não impede o agente de subir.
    try:
        async with asyncio.timeout(TIDY_TIMEOUT_SECONDS):
            await asyncio.to_thread(tidy, installation_base())
    except TimeoutError:
        _log.warning("a arrumação da pasta passou de %.0f s; sigo sem ela", TIDY_TIMEOUT_SECONDS)
    gate = EnvelopeGate(agent_id)
    envelopes = EnvelopeFactory(agent_id, gate, clock)
    transport = WebSocketTransport(
        build_ws_url(api_url, agent_id),
        lambda: secrets.get(agent_id),
        user_agent=f"uniover-agent/{agent_version()}",
    )
    tv = build_tv(settings, clock, transport, envelopes, secrets)
    pc = build_pc(
        settings,
        transport,
        envelopes,
        # Diferença de relógio com a API e comandos recusados por idade vão ao diagnóstico; o
        # registrador junta as repetições, então os textos são fixos.
        on_clock_skew=lambda offset: kit.recorder.record(
            "pc.clock_skew",
            "warn",
            "o relógio do PC difere do da API; os comandos do PC são medidos por essa diferença",
            component="pc",
        ),
        on_expired=lambda age: kit.recorder.record(
            "pc.command_expired",
            "warn",
            "comando do PC recusado por chegar velho demais (rede lenta ou reconexão)",
            component="pc",
        ),
        on_clock_unstable=lambda pairs: kit.recorder.record(
            "pc.clock_unstable",
            "warn",
            "os batimentos da API oscilam demais para medir a idade dos comandos do PC "
            "(enlace instável); eles valem como chegaram",
            component="pc",
        ),
    )
    if tv is not None:
        # Um sinal de presença recusado por idade (relógio do PC fora de hora) vai ao diagnóstico; o
        # registrador junta as repetições, então o texto é fixo (sem a idade exata).
        tv.on_presence_refused = lambda age: kit.recorder.record(
            "tv.presence_clock_skew",
            "warn",
            "sinal de presença da TV recusado: relógio do PC fora de hora ou entrega atrasada; "
            "o ADB não reconecta sozinho até a hora se acertar",
            component="tv",
        )
        for step in tv.prepare:
            await step()
    process = ProcessMessage(
        agent_id,
        gate,
        build_handler(
            clock, tv, build_remote_care(settings, transport, envelopes, secrets, agent_id), pc
        ),
        envelopes,
        transport,
        background_types=tv.background_commands if tv is not None else (),
        silent_types=(
            *(PC_SILENT_TYPES if pc is not None else ()),
            *(tv.silent_commands if tv is not None else ()),
        ),
        # Comandos de fundo (limpeza, TV Livre, busca) são longos por natureza: só teclas têm teto.
        command_timeout_seconds=settings.tv_command_timeout_seconds if tv is not None else None,
        uncapped_types=tv.background_commands if tv is not None else (),
        release_inputs=pc.release_all if pc is not None else None,
        observe_timestamp=pc.clock.observe if pc is not None else None,
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
        publisher = TvStatePublisher(
            transport,
            envelopes,
            reports_not_paired=lambda: features.supports(NOT_PAIRED_FEATURE),
            reports_waking=lambda: features.supports(WAKING_FEATURE),
        )
        tv.manager.subscribe(publisher.publish)
        tv.manager.subscribe(tray.tv_state)
        manager, announcer = tv.manager, publisher

        async def announce_tv() -> None:
            # A API recém-conectada não conhece o estado: informa o atual logo depois do `hello`.
            await announcer.announce(manager.snapshot())

        after_hello = [announce_tv, *tv.after_hello]
    if pc is not None:
        after_hello = [*after_hello, *pc.after_hello]

    diary = AbsenceDiary(installation_base() / "runtime" / "last-alive", clock)
    diary.start()
    watch = ConnectionWatch()
    health = TaskHealth(clock)
    # O diagnóstico só é declarado e enviado depois de a API dizer que o aceita (uma API anterior
    # recusaria o `hello`).
    # A consulta roda em segundo plano, com prazo curto: a primeira conexão nunca espera por ela, e
    # o `hello` repetido a cada 5 minutos passa a declarar a capacidade assim que a API a listar.
    features = ApiFeatures(
        lambda: fetch_api_features(api_url, wait_seconds=FEATURES_TIMEOUT_SECONDS), clock
    )
    if tv is not None and publisher is not None:
        # `not_paired` vai como `disconnected` e `waking` (TV ligando) como o estado de antes até a
        # API aceitá-los: depois, o estado sai de novo.
        features.on_change(lambda: publisher.publish(tv.manager.snapshot()))
    shipper = DiagnosticsShipper(
        kit.store,
        kit.recorder,
        transport,
        envelopes,
        clock,
        enabled=lambda: features.supports(DIAGNOSTICS_CAPABILITY),
    )
    # A falha de partida na fila sai no primeiro `hello`, com ou sem auto-verificação.
    delivery = DiagnosticsDelivery(kit.store, features, shipper, self_care=settings.self_care)
    await delivery.prepare()

    def on_disconnected() -> None:
        process.connection_lost()
        tray.disconnected()
        diary.disconnected()
        watch.disconnected_now()

    async def on_connected() -> None:
        mark_session_started()  # daqui em diante, o que cair não é falha de partida
        tray.connected()
        diary.connected()
        watch.connected_now()
        for step in after_hello:
            await step()
        await delivery.after_hello()

    update_source = FileUpdateStatus(default_status_path(), agent_source_dir())
    supervisor = ConnectionSupervisor(
        transport,
        process,
        envelopes,
        clock,
        random.SystemRandom().random,
        agent_version=build_version(),
        capabilities=lambda: (
            "transport.keepalive.v1",
            LOGS_CAPABILITY,
            MAINTENANCE_CAPABILITY,
            *delivery.capabilities(),
            *(
                declarable_capabilities(tv.capabilities, features.supports)
                if tv is not None
                else ()
            ),
            *(tuple(pc.capabilities) if pc is not None else ()),
        ),
        on_connected=on_connected,
        on_disconnected=on_disconnected,
        os_description=describe_os(),
        tv=(settings.tv_kind, settings.tv_host) if tv is not None and settings.tv_host else None,
        update_status=lambda: update_body(update_source.read()),
        on_startup_failure=delivery.connection_failed,
    )
    # A API passou a listar uma capacidade nova (ex.: depois de um deploy dela): declara já, sem
    # esperar o `hello` de 5 minutos.
    features.on_added = supervisor.hello_now
    # O sinal de vida do agente reflete o laço de conexão: preso, ele deixa de ser dado.
    diary.require_healthy(lambda: not supervisor.is_stalled())
    _log.info("agente %s iniciando (api %s)", agent_id, api_url)
    jobs: list[Callable[[], Coroutine[Any, Any, None]]] = [
        UpdateStatusWatcher(update_source, transport, envelopes, clock).run,
        diary.run,
        tray.run,
        # Se o laço de eventos parar, a pilha de todas as threads vai para `crash.log`.
        LoopWatchdog(installation_base() / "logs").run,
    ]
    # O disco da instalação: um diagnóstico quando o espaço piora de nível e outro quando volta.
    root = installation_base()
    jobs = [
        *jobs,
        DiskAlarm(
            lambda: shutil.disk_usage(root).free,
            kit.recorder,
            clock,
            warn_bytes=settings.disk_warn_mb * 1024 * 1024,
            critical_bytes=settings.disk_critical_mb * 1024 * 1024,
        ).run,
    ]
    if tv is not None:
        # A atualização do agente espera a TV ficar parada: a marca de último uso é o que ela lê.
        marker = TvUseMarker(
            root / "runtime" / TV_USE_MARKER_FILE, tv.manager.seconds_since_use, clock
        )
        jobs = [*jobs, tv.manager.watch, marker.run, *tv.background]
    if pc is not None:
        # Uma sessão do touchpad também adia a atualização: reiniciar o agente a cortaria no meio.
        pc_marker = TvUseMarker(
            root / "runtime" / PC_USE_MARKER_FILE, pc.use.seconds_since_use, clock
        )
        jobs = [*jobs, pc_marker.run]
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
    if settings.self_care or tv is not None:
        # O pareamento pelo app e o estado "não pareada" também dependem do que a API aceita.
        jobs = [*jobs, features.run]
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
            tv.manager.reopen_unattended,
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
            for close in tv.closers:
                await close()
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
