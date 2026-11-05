"""Conexão com a API: handler, cuidados remotos, vigia do endereço e laço `run`."""

import asyncio
import logging
import random
import sys
from collections.abc import Awaitable, Callable, Coroutine
from pathlib import Path
from typing import Any

from uniover_agent.adapters.absence_diary import AbsenceDiary
from uniover_agent.adapters.agent_log_file import FileLogSource
from uniover_agent.adapters.crash_trace import install_crash_trace, loop_exception_handler
from uniover_agent.adapters.housekeeping import tidy
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.local_config import ConfigValue, update_config
from uniover_agent.adapters.maintenance_signals import RuntimeFlagSignals
from uniover_agent.adapters.pairing_http import fetch_api_features
from uniover_agent.adapters.run_state import RunState
from uniover_agent.adapters.self_care_checks import ConnectionWatch
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
from uniover_agent.adapters.update_status import FileUpdateStatus, default_status_path
from uniover_agent.care_setup import (
    DiagnosticsKit,
    announce_start,
    build_checks,
    build_diagnostics,
    roll_back_if_in_trial,
)
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
from uniover_agent.core.api_features import FEATURES_TIMEOUT_SECONDS, ApiFeatures
from uniover_agent.core.diagnostics import DIAGNOSTICS_CAPABILITY, DiagnosticsShipper
from uniover_agent.core.self_care import SelfCare
from uniover_agent.core.supervision import TaskHealth, keep_running, run_supervised
from uniover_agent.ports import Clock, SecretStore, Transport, TvNotPaired, TvUnreachable

_log = logging.getLogger("uniover_agent")
# De quanto em quanto tempo o vigia olha o ARP atrás do MAC da TV, enquanto não o aprendeu.
ARP_LEARN_SECONDS = 600.0


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
    pc = build_pc(settings, transport, envelopes)
    if tv is not None:
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
        silent_types=PC_SILENT_TYPES if pc is not None else (),
        # Comandos de fundo (limpeza, TV Livre, busca) são longos por natureza: só teclas têm teto.
        command_timeout_seconds=settings.tv_command_timeout_seconds if tv is not None else None,
        uncapped_types=tv.background_commands if tv is not None else (),
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
    shipper = DiagnosticsShipper(
        kit.store,
        kit.recorder,
        transport,
        envelopes,
        clock,
        enabled=lambda: features.supports(DIAGNOSTICS_CAPABILITY),
    )

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
        capabilities=lambda: (
            "transport.keepalive.v1",
            LOGS_CAPABILITY,
            MAINTENANCE_CAPABILITY,
            *(
                (DIAGNOSTICS_CAPABILITY,)
                if settings.self_care and features.supports(DIAGNOSTICS_CAPABILITY)
                else ()
            ),
            *(tuple(tv.capabilities) if tv is not None else ()),
            *(tuple(pc.capabilities) if pc is not None else ()),
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
        jobs = [*jobs, care.run, shipper.run, features.run]
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
