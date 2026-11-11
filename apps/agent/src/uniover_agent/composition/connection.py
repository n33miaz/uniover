"""Conexão com a API: handler, cuidados remotos, vigia do endereço e laço `run`."""

import asyncio
import json
import logging
import os
import random
import shutil
import sys
import time
import uuid
from collections.abc import Awaitable, Callable, Coroutine, Iterable
from pathlib import Path
from typing import Any

from uniover_agent.adapters.absence_diary import AbsenceDiary
from uniover_agent.adapters.agent_log_file import FileLogSource
from uniover_agent.adapters.connection_marker import ConnectionMarker
from uniover_agent.adapters.crash_trace import install_crash_trace, loop_exception_handler
from uniover_agent.adapters.housekeeping import tidy
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.local_config import ConfigValue, update_config
from uniover_agent.adapters.local_networks import network_signature, same_network
from uniover_agent.adapters.loop_lag import LoopLagMonitor
from uniover_agent.adapters.loop_watchdog import LoopWatchdog
from uniover_agent.adapters.maintenance_signals import RuntimeFlagSignals
from uniover_agent.adapters.network_change import network_change_watcher
from uniover_agent.adapters.pairing_http import fetch_api_features
from uniover_agent.adapters.pc_approval_prompt import WindowsApprovalPrompt
from uniover_agent.adapters.pc_device_store import JsonDeviceStore
from uniover_agent.adapters.run_state import RunState
from uniover_agent.adapters.self_care_checks import ConnectionWatch
from uniover_agent.adapters.single_instance import (
    ALREADY_RUNNING_MESSAGE,
    EXIT_ALREADY_RUNNING,
    acquire,
    acquire_slug,
)
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
    EXIT_DUPLICATE_AGENT,
    EXIT_HANDOVER_UNSUPPORTED,
    EXIT_NOT_PAIRED,
    EXIT_OK,
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
    ADB_REBIND_CAPABILITY,
    LOGS_CAPABILITY,
    LOGS_REQUEST_TYPE,
    MAINTENANCE_CAPABILITY,
    MAINTENANCE_TYPE,
    PC_CLICK_V2_CAPABILITY,
    PC_KEY_V2_CAPABILITY,
    PC_RTC_CAPABILITY,
    PC_TEXT_V2_CAPABILITY,
    PC_VOLUME_CAPABILITY,
    PC_ZOOM_CAPABILITY,
    PRESENCE_CAPABILITY,
    RECONCILE_CAPABILITY,
    RTC_TYPES,
    SETTINGS_OPEN_CAPABILITY,
    TV_RTC_CAPABILITY,
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
    ADB_PERMISSION_FEATURE,
    FEATURES_TIMEOUT_SECONDS,
    HANDOVER_FEATURE,
    NOT_PAIRED_FEATURE,
    WAKING_FEATURE,
    ApiFeatures,
)
from uniover_agent.core.connection import (
    STOP_DUPLICATE,
    STOP_HANDOVER,
    STOP_HANDOVER_UNSUPPORTED,
)
from uniover_agent.core.diagnostics import (
    DIAGNOSTICS_CAPABILITY,
    DiagnosticsRecorder,
    DiagnosticsShipper,
)
from uniover_agent.core.disk_alarm import DiskAlarm
from uniover_agent.core.pc.devices import DeviceApprovals
from uniover_agent.core.pc.handlers import PC_DEVICE_CAPABILITY, PC_OP_CAPABILITY
from uniover_agent.core.self_care import SelfCare
from uniover_agent.core.supervision import TaskHealth, keep_running, run_supervised
from uniover_agent.core.tv.pairing import PAIR_CAPABILITY
from uniover_agent.core.tv.relocator import DEFAULT_FAILURES
from uniover_agent.ports import Clock, SecretStore, Transport, TvNotPaired, TvUnreachable

_log = logging.getLogger("uniover_agent")
# De quanto em quanto tempo o vigia olha o ARP atrás do MAC da TV, enquanto não o aprendeu.
ARP_LEARN_SECONDS = 600.0
# Prazo da arrumação da pasta na partida: sem ele, um disco travado impediria o agente de subir.
TIDY_TIMEOUT_SECONDS = 60.0
# Quem entende o fechamento 4411 "reconecte já" (`ServerRestartNow`): a API só o usa com quem
# declarou isto.
RESTART_CAPABILITY = "transport.restart.v1"
# Quem entende o fechamento 4410 (a passagem de versão): a API só o usa com a sessão que declarou
# isto (senão a antiga sai como substituída).
HANDOVER_CAPABILITY = HANDOVER_FEATURE
# Passagem sem queda (`run --handover`): quanto esta execução espera a API confirmar que a promoveu
# (`agent.handover.accepted.v1`) e quanto tenta saber se a API sabe fazer a passagem. O supervisor
# desiste dela em 60 s contados do início do processo, e passa a ela, por esta variável, o instante
# absoluto (epoch, em segundos) a que o prazo vale (com margem): os prazos daqui são contados do
# começo desta execução e nunca passam dele. Depois da confirmação a antiga já foi mandada sair e
# não reconecta, então esta execução NÃO desiste mais por prazo próprio: sair com ela deixaria o PC
# sem agente (só o supervisor, que derruba a antiga, decide). Enquanto espera a trava, ela avisa no
# registro a cada `HANDOVER_WAIT_LOG_SECONDS`.
HANDOVER_DEADLINE_ENV = "UNIOVER_HANDOVER_DEADLINE"
HANDOVER_CONFIRM_SECONDS = 40.0
HANDOVER_WAIT_LOG_SECONDS = 30.0
HANDOVER_PROBE_SECONDS = 15.0
HANDOVER_POLL_SECONDS = 0.25
# Comando que chega antes de esta execução ser a dona (a TV e o PC ainda são da antiga): é recusado
# com este código, para quem o mandou saber já.
AGENT_STARTING = "agent_starting"
_STARTING_MESSAGE = "o agente está assumindo o PC; tente de novo em instantes"
_KEEPALIVE_TYPE = "api.keepalive.v1"
# Prazo de cada passo do encerramento: uma TV ou um canal que não fecha não prende a saída (a
# trava da instalação só é solta com o processo morto, e o `uv` e o supervisor esperam por ela).
SHUTDOWN_STEP_SECONDS = 10.0
# O que a execução antiga ainda tem em curso termina em até isto antes de ela fechar tudo.
HANDOVER_DRAIN_SECONDS = 2.0
# Capacidades que uma API anterior recusaria no `hello` (ela não as conhece): só vão depois de a API
# listá-las em `features`.
API_LISTED_CAPABILITIES = frozenset(
    {
        RESTART_CAPABILITY,
        HANDOVER_CAPABILITY,
        PAIR_CAPABILITY,
        PRESENCE_CAPABILITY,
        SETTINGS_OPEN_CAPABILITY,
        ADB_REBIND_CAPABILITY,
        PC_KEY_V2_CAPABILITY,
        PC_TEXT_V2_CAPABILITY,
        PC_CLICK_V2_CAPABILITY,
        PC_ZOOM_CAPABILITY,
        PC_VOLUME_CAPABILITY,
        PC_RTC_CAPABILITY,
        TV_RTC_CAPABILITY,
        RECONCILE_CAPABILITY,
        PC_OP_CAPABILITY,
        PC_DEVICE_CAPABILITY,
    }
)


def declarable_capabilities(
    capabilities: Iterable[str], api_supports: Callable[[str], bool]
) -> tuple[str, ...]:
    """As capacidades da TV e do PC que podem ir ao `hello` agora.

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
    *,
    recorder: DiagnosticsRecorder | None = None,
    failures: int = DEFAULT_FAILURES,
) -> TvRelocator | None:
    """Vigia do endereço da TV: só existe com `tv_host`.

    `is_hot` diz se a sessão com a TV está aberta (prova de que ela responde). Fora isso, confere
    se **a TV certa** atende no endereço (o IP velho pode ter virado de um celular) e, se não,
    procura-a pelo MAC na tabela ARP, depois SSDP, depois numa varredura lenta do /24 dela.
    Sem identidade Android guardada, confirma os candidatos pela sessão com certificado pareado.
    `known` é compartilhado com o resto do agente, que aprende o MAC na primeira conexão.
    `on_refused` é avisado quando a Android TV está na rede e **recusa** a porta do controle (o
    serviço morreu): a conferência é a mesma de sempre, o vigia do serviço só aproveita o resultado.
    A procura cobre a rede de cada placa real do PC, não só a do endereço velho da TV: com o
    roteador de casa fora e o PC e a TV no ponto de acesso do celular, a TV está em outra faixa.
    A troca de rede do PC dispara a procura na hora. Um candidato só vale confirmado pelo MAC, pelo
    `duid` ou pela sessão com o certificado já pareado: nenhum pareamento novo é pedido à TV.
    `recorder` recebe, sem endereços, a TV achada em outra rede e a TV não achada.
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
        if same_network(host, located.host) is False:
            _log.info("a TV foi achada em outra rede")
            if recorder is not None:
                recorder.record(
                    "tv.found_other_network",
                    "info",
                    "TV encontrada em outra rede (o PC e a TV trocaram de rede)",
                    component="tv",
                )
        return located.host

    def not_found(attempts: int, network_changed: bool) -> None:
        _log.warning("a TV não foi achada depois de %d procuras", attempts)
        if recorder is not None:
            recorder.record(
                "tv.not_found",
                "warn" if network_changed else "info",
                "TV não encontrada depois de várias procuras"
                + (
                    " (o PC mudou de rede nesse meio tempo: ela pode estar em uma rede que o PC "
                    "não alcança, ou desligada)"
                    if network_changed
                    else " (desligada, ou em uma rede que o PC não alcança)"
                ),
                component="tv",
            )

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
        network_signature=network_signature,
        on_network_change=lambda new: locator.reset_schedule(full=new),
        searched=lambda: locator.searched,
        on_not_found=not_found,
        failures=failures,
    )


class HandoverTimeout(Exception):  # noqa: N818 - nome do domínio
    """A execução anterior não largou a trava da instalação a tempo."""


async def supervise(  # noqa: PLR0913 - o vigia, o relógio e os ganchos da passagem, todos nomeados
    supervisor: ConnectionSupervisor,
    relocator: TvRelocator | None,
    *,
    clock: Clock | None = None,
    kit: DiagnosticsKit | None = None,
    owner: asyncio.Event | None = None,
    takeover: asyncio.Task[None] | None = None,
) -> bool:
    """Mantém a conexão com a API até ela acabar; devolve `True` se a TV mudou de endereço.

    Mudou de endereço: o novo já está gravado no arquivo, e a conexão com a API cai para `main`
    recomeçar com ele. Sem derrubá-la, o canal antigo, aberto, faria a API recusar o novo por
    "substituído" e custaria um minuto de espera.

    Na passagem sem queda, `owner` abre quando esta execução já é a dona da instalação (o vigia do
    endereço da TV só começa aí) e `takeover` é a tarefa que espera a anterior sair: se ela falhar
    (`HandoverTimeout`), a falha sobe daqui.
    """
    connection = asyncio.create_task(supervisor.run())

    async def locate() -> None:
        if owner is not None:
            await owner.wait()
        assert relocator is not None  # noqa: S101 - só é agendada quando há vigia
        await relocator.run()

    # Um erro do vigia do endereço não pode passar por "a TV mudou": ele é registrado e recomeça.
    watch = (
        asyncio.create_task(
            run_supervised(
                "tv.endereco",
                locate,
                clock=clock or SystemClock(),
                recorder=kit.recorder if kit is not None else None,
            )
        )
        if relocator is not None
        else None
    )
    tasks = [task for task in (connection, watch, takeover) if task is not None]
    try:
        waiting: set[asyncio.Task[Any]] = set(tasks)
        while True:
            done, waiting = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
            if takeover is not None and takeover in done:
                takeover.result()  # a espera falhou: sobe `HandoverTimeout`
                if connection not in done and watch not in done:
                    continue  # a passagem terminou bem: a conexão e o vigia seguem
            break
        if connection.done():
            connection.result()
            return False
        return True
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def _acquire_all(agent_id: str) -> bool:
    """As duas travas: a da instalação (uma execução por pasta) e a da identidade (uma por slug)."""
    return acquire() and acquire_slug(agent_id)


def _stop_reason_text(moved: bool, reason: str | None) -> str:
    """O motivo de parar que fica no rastro da execução (`run-state.json`)."""
    if moved:
        return "tv_mudou_de_endereco"
    return {
        STOP_HANDOVER: "handover",
        STOP_DUPLICATE: "agente_duplicado",
        STOP_HANDOVER_UNSUPPORTED: "passagem_sem_rota",
    }.get(reason or "", "credencial_recusada")


def _handover_budget() -> float:
    """Quantos segundos esta execução tem para a API confirmar a passagem, contados de agora (o
    começo dela): o prazo próprio, limitado pelo instante absoluto que o supervisor passou."""
    budget = HANDOVER_CONFIRM_SECONDS
    raw = os.environ.get(HANDOVER_DEADLINE_ENV, "")
    try:
        left = float(raw) - time.time()
    except ValueError:
        return budget
    return min(budget, max(1.0, left))


async def _handover_features(
    api_url: str, clock: Clock, limit: float = HANDOVER_PROBE_SECONDS
) -> frozenset[str] | None:
    """O que a API aceita, se ela diz saber passar a conexão para uma versão nova; senão `None`.

    Pergunta por até alguns segundos, medidos no relógio (cada consulta pode gastar até
    `FEATURES_TIMEOUT_SECONDS`, então contar só as esperas passaria do prazo). Sem resposta (API
    dormindo, rede) também é "não": a passagem sem queda só vale com a API confirmando, e o
    supervisor tem o caminho de reserva (troca com o agente parado)."""
    started = clock.monotonic()
    while True:
        features = await fetch_api_features(api_url, wait_seconds=FEATURES_TIMEOUT_SECONDS)
        if features is not None:
            return features if HANDOVER_FEATURE in features else None
        if clock.monotonic() - started >= limit:
            return None
        await clock.sleep(2.0)


def _command_to_refuse(raw: str | bytes) -> str | None:
    """O `id` do comando da API que espera resposta; `None` para o que não espera (o batimento)."""
    try:
        message = json.loads(raw)
    except ValueError:
        return None
    if (
        not isinstance(message, dict)
        or message.get("source") != "api"
        or message.get("type") == _KEEPALIVE_TYPE
    ):
        return None
    identifier = message.get("id")
    if not isinstance(identifier, str):
        return None
    try:
        return str(uuid.UUID(identifier))
    except ValueError:
        return None


async def _close_within(what: str, step: Awaitable[Any]) -> None:
    """Um passo do encerramento com prazo: estourar ou falhar é registrado e o resto segue."""
    try:
        async with asyncio.timeout(SHUTDOWN_STEP_SECONDS):
            await step
    except TimeoutError:
        _log.warning(
            "%s passou de %.0f s ao encerrar; sigo sem esperar", what, SHUTDOWN_STEP_SECONDS
        )
    except Exception:
        _log.exception("falha ao encerrar: %s", what)


async def run(  # noqa: PLR0911, PLR0912, PLR0915 - composição
    settings: Settings,
    open_store: StoreFactory,
    kit: DiagnosticsKit | None = None,
    *,
    handover: bool = False,
) -> int:
    """Conecta e serve até a credencial ser recusada, a TV mudar de endereço ou outra assumir.

    `handover` (`run --handover`): esta execução é a versão nova de uma passagem sem queda. Ela
    conecta enquanto a antiga ainda serve e deixa para depois de a antiga sair tudo o que é
    compartilhado ou físico (a trava da instalação, o rastro da execução, o diário e a fila de
    diagnóstico, a TV, o canal direto do PC): nada disso tem dois donos ao mesmo tempo."""
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
    # O que a API disse aceitar no momento da partida: a passagem sem queda já o perguntou, e o
    # primeiro `hello` não pode sair mais pobre que o da execução que ela substitui.
    known_features: frozenset[str] = frozenset()
    # O prazo da confirmação conta do começo desta execução (a sondagem e a montagem entram nele).
    confirm_deadline = clock.monotonic() + _handover_budget()
    if handover and not settings.update_handover:
        # A passagem está desligada nesta instalação (`update_handover`): nada é aberto, o
        # supervisor usa o caminho de reserva.
        _log.warning("a passagem sem queda está desligada (update_handover); uso a reserva")
        return EXIT_HANDOVER_UNSUPPORTED
    if handover:
        probed = await _handover_features(
            api_url, clock, min(HANDOVER_PROBE_SECONDS, confirm_deadline - clock.monotonic())
        )
        if probed is None:
            # Antes de tudo: nada foi aberto nem gravado, o supervisor só troca de caminho.
            _log.warning(
                "a API não sabe passar a conexão para uma versão nova; uso o caminho de reserva"
            )
            return EXIT_HANDOVER_UNSUPPORTED
        known_features = probed
    elif not acquire_slug(agent_id):
        # Outra pasta de instalação (ou uma execução manual) já serve esta identidade.
        print(f"Erro: {ALREADY_RUNNING_MESSAGE}", file=sys.stderr)
        _log.error("%s (mesma identidade)", ALREADY_RUNNING_MESSAGE)
        return EXIT_ALREADY_RUNNING
    tray = TrayStatus(settings.tv_name, clock)

    kit = kit or build_diagnostics(clock)
    run_state = RunState(installation_base() / "runtime")
    connection_mark = ConnectionMarker(installation_base() / "runtime")
    # Aberto quando esta execução é a dona da instalação: sempre, salvo na passagem sem queda.
    owner = asyncio.Event()
    if not handover:
        owner.set()
    # Aberto quando a API confirma que promoveu esta execução (só na passagem sem queda).
    accepted = asyncio.Event()

    def handover_accepted() -> None:
        connection_mark.connected()
        accepted.set()

    async def start_shared_state() -> None:
        install_crash_trace(installation_base() / "logs", kit.recorder)
        announce_start(run_state, kit, settings, build_version())
        # Arruma a pasta (restos de atualização, estrutura): só mexe no que tem nome conhecido.
        # Com prazo: uma pasta travada (disco cheio ou em disputa) não impede o agente de subir.
        try:
            async with asyncio.timeout(TIDY_TIMEOUT_SECONDS):
                await asyncio.to_thread(tidy, installation_base())
        except TimeoutError:
            _log.warning(
                "a arrumação da pasta passou de %.0f s; sigo sem ela", TIDY_TIMEOUT_SECONDS
            )

    asyncio.get_running_loop().set_exception_handler(loop_exception_handler(kit.recorder))
    if not handover:
        await start_shared_state()
    gate = EnvelopeGate(agent_id)
    envelopes = EnvelopeFactory(agent_id, gate, clock)
    transport = WebSocketTransport(
        build_ws_url(api_url, agent_id),
        lambda: secrets.get(agent_id),
        user_agent=f"uniover-agent/{agent_version()}",
        # A conexão da passagem se apresenta como candidata: a API só a promove com o hello válido.
        handover_candidate=lambda: supervisor.handover_pending,
    )
    tv = build_tv(settings, clock, transport, envelopes, secrets)
    pc = build_pc(
        settings,
        transport,
        envelopes,
        gate=gate,
        agent_id=agent_id,
        clock_source=clock,
        record=lambda kind, severity, detail: kit.recorder.record(
            kind,
            "warn" if severity == "warn" else "info",
            detail,
            component="pc",
        ),
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
        # A entrada do PC roda num laço próprio (thread dedicada, prioridade acima do normal): o
        # resto do agente não a atrasa. Os avisos dela voltam a este laço sem prendê-la.
        isolate_input=settings.pc_input_thread,
        # A pilha das paradas curtas do laço da entrada vai para `logs\stalls.log`.
        stall_logs=installation_base() / "logs" if settings.stall_dump else None,
        devices=(
            DeviceApprovals(
                JsonDeviceStore(installation_base() / "runtime" / "pc-devices.json"),
                WindowsApprovalPrompt(),
            )
            if settings.pc_device_approval and settings.pc_control
            else None
        ),
        exception_handler=loop_exception_handler(kit.recorder),
    )
    if pc is not None:
        pc.start()
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
        if tv.adb_permission is not None:
            # Por que o ADB não conecta (IP novo, chave trocada, TV recusou, falta a prova) vai ao
            # diagnóstico: o administrador vê em Sistema sem abrir o arquivo de registro.
            tv.adb_permission.record_with(
                lambda kind, severity, detail: kit.recorder.record(
                    kind, severity, detail, component="tv_adb"
                )
            )
        if not handover:
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
        silent_types=tv.silent_commands if tv is not None else (),
        # Comandos de fundo (limpeza, TV Livre, busca) são longos por natureza: só teclas têm teto.
        command_timeout_seconds=settings.tv_command_timeout_seconds if tv is not None else None,
        uncapped_types=tv.background_commands if tv is not None else (),
        observe_timestamp=pc.clock.observe if pc is not None else None,
        # A faixa do PC (e o canal direto) tem o laço dela: o comando de entrada que chega pela
        # nuvem fecha antes o canal direto em uso, e a sinalização do canal corre em tarefa própria
        # (a oferta espera a biblioteca), tudo lá dentro.
        pc_lane=pc.lane if pc is not None else None,
        pc_host=pc.host if pc is not None else None,
        lane_detached_types=RTC_TYPES if pc is not None and pc.direct is not None else (),
        on_command=(
            lambda command: (
                tv.cleanup_scheduler.note_message(command.type)
                if tv is not None and tv.cleanup_scheduler is not None
                else None
            )
        ),
    )
    # As teclas e o texto da TV pelo canal direto: só onde há TV, canal direto do PC e a opção
    # ligada.
    # A ponte leva o comando ao MESMO caminho das teclas da nuvem (`ProcessMessage`), no laço
    # principal, sem prender o laço da entrada do PC.
    tv_direct_capabilities: list[str] = []
    if (
        tv is not None
        and pc is not None
        and settings.tv_direct
        and pc.bind_tv_direct(process.submit_direct_tv)
    ):
        tv_direct_capabilities.append(TV_RTC_CAPABILITY)
    publisher: TvStatePublisher | None = None
    after_hello: list[Callable[[], Awaitable[None]]] = []
    if tv is not None:
        publisher = TvStatePublisher(
            transport,
            envelopes,
            reports_not_paired=lambda: features.supports(NOT_PAIRED_FEATURE),
            reports_waking=lambda: features.supports(WAKING_FEATURE),
            reports_adb_permission=lambda: features.supports(ADB_PERMISSION_FEATURE),
            adb_permission=lambda: tv.adb_permission.state if tv.adb_permission else None,
            adb_permission_reason=lambda: tv.adb_permission.reason if tv.adb_permission else None,
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
    if not handover:
        diary.start()
    watch = ConnectionWatch()
    health = TaskHealth(clock)
    # O diagnóstico só é declarado e enviado depois de a API dizer que o aceita (uma API anterior
    # recusaria o `hello`).
    # A consulta roda em segundo plano, com prazo curto: a primeira conexão nunca espera por ela, e
    # o `hello` repetido a cada 5 minutos passa a declarar a capacidade assim que a API a listar.
    features = ApiFeatures(
        lambda: fetch_api_features(api_url, wait_seconds=FEATURES_TIMEOUT_SECONDS),
        clock,
        known=known_features,
    )
    refreshing: set[asyncio.Future[None]] = set()

    def start_refresh() -> None:
        """Consulta o que a API aceita já (prazo curto), sem esperar a consulta de fundo."""
        refresh = asyncio.ensure_future(features.refresh())
        refreshing.add(refresh)
        refresh.add_done_callback(refreshing.discard)

    if pc is not None and pc.approvals is not None:
        # A API listou a aprovação: o modo sem aprovação nunca mais volta (fica gravado).
        # (na faixa do PC: é lá que o estado da aprovação vive)
        approvals = pc.approvals
        features.on_change(lambda: pc.on_lane(approvals.note_api))
    if pc is not None:
        # A aprovação só dispensa o aparelho se a API RESPONDEU e não a oferece; até lá (partida,
        # consulta que falhou) o comando sem aparelho falha fechado.
        pc.bind_device_api(
            answered=lambda: features.answered,
            supports=lambda: features.supports(PC_DEVICE_CAPABILITY),
            # Aparelho aprovado que o agente não identifica por a API (instância antiga no rollout)
            # deixou de listar a capacidade: nova consulta, no máximo a cada 15 s.
            refresh=start_refresh,
        )
    if tv is not None and publisher is not None:
        # `not_paired` vai como `disconnected` e `waking` (TV ligando) como o estado de antes até a
        # API aceitá-los: depois, o estado sai de novo.
        features.on_change(lambda: publisher.publish(tv.manager.snapshot()))
        if tv.adb_permission is not None:
            # Cada mudança da permissão do ADB (pedida, aceita, perdida) chega ao celular na hora.
            tv.adb_permission.on_change(lambda: publisher.publish(tv.manager.snapshot()))
    if pc is not None and pc.volume is not None:
        volume = pc.volume
        # O nível só sobe depois de a API listar a capacidade (uma anterior recusaria o tipo), e
        # sobe assim que ela passa a listá-la: o primeiro `hello` costuma vir antes da resposta.
        volume.bind_enabled(lambda: features.supports(PC_VOLUME_CAPABILITY))
        features.on_change(volume.soon)
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
        if pc is not None and pc.direct is not None:
            # O canal direto segue uns segundos sem a API (queda curta) e fecha se ela não volta.
            pc.on_lane(pc.direct.api_disconnected)
        tray.disconnected()
        diary.disconnected()
        watch.disconnected_now()
        # O anúncio que esperava a posse é desta sessão: a próxima conexão faz o dela.
        while deferred_announce:
            deferred_announce.pop().cancel()

    async def announce_connected() -> None:
        if pc is not None and pc.direct is not None:
            # Só quem é a dona do PC cuida do canal direto: ele volta a valer com a API.
            # Reconcilia o canal que ficou aberto só se a API a listou (e o `hello` a declara).
            direct = pc.direct
            reconcile = features.supports(RECONCILE_CAPABILITY)
            pc.on_lane(lambda: direct.api_reconnected(reconcile=reconcile))
        tray.connected()
        diary.connected()
        watch.connected_now()
        if not features.answered:
            # A API ainda não disse o que aceita (partida sem rede): consulta já, com prazo curto,
            # em vez de esperar o recuo de até 5 min (sem a capacidade, todo aparelho fica barrado).
            start_refresh()
        for step in after_hello:
            await step()
        await delivery.after_hello()

    deferred_announce: list[asyncio.Task[None]] = []

    async def announce_when_owner() -> None:
        await owner.wait()
        try:
            await announce_connected()
        except Exception:
            _log.exception("falha ao anunciar a conexão depois de virar a dona")

    async def on_connected() -> None:
        mark_session_started()  # daqui em diante, o que cair não é falha de partida
        if not handover:
            connection_mark.connected()
        if owner.is_set():
            await announce_connected()
            return
        # Na passagem sem queda, anunciar a TV e enviar a fila de diagnóstico esperam esta execução
        # ser a dona (a antiga ainda os tem). A conexão não espera junto: a leitura precisa
        # rodar para receber a confirmação da API (ela marca "conectou") e o fechamento.
        deferred_announce.append(asyncio.create_task(announce_when_owner(), name="announce"))

    update_source = FileUpdateStatus(default_status_path(), agent_source_dir())

    async def process_when_owner(raw: str | bytes) -> None:
        if owner.is_set():
            await process(raw)
            return
        # A TV e o PC ainda são da antiga: o comando é recusado na hora, sem prender a leitura do
        # canal (que precisa seguir para ver a confirmação da API, o fechamento e os batimentos).
        reply_to = _command_to_refuse(raw)
        if reply_to is not None:
            await transport.send(
                envelopes.result(reply_to, ok=False, code=AGENT_STARTING, message=_STARTING_MESSAGE)
            )

    supervisor = ConnectionSupervisor(
        transport,
        process_when_owner if handover else process,
        envelopes,
        clock,
        random.SystemRandom().random,
        agent_version=build_version(),
        capabilities=lambda: (
            "transport.keepalive.v1",
            *declarable_capabilities(
                (
                    RESTART_CAPABILITY,
                    # Desligada a passagem, a antiga sai como substituída (4409).
                    *((HANDOVER_CAPABILITY,) if settings.update_handover else ()),
                ),
                features.supports,
            ),
            LOGS_CAPABILITY,
            MAINTENANCE_CAPABILITY,
            *delivery.capabilities(),
            *(
                declarable_capabilities(tv.capabilities, features.supports)
                if tv is not None
                else ()
            ),
            *(
                declarable_capabilities(pc.capabilities, features.supports)
                if pc is not None
                else ()
            ),
            *declarable_capabilities(tv_direct_capabilities, features.supports),
        ),
        on_connected=on_connected,
        on_disconnected=on_disconnected,
        os_description=describe_os(),
        tv=(settings.tv_kind, settings.tv_host) if tv is not None and settings.tv_host else None,
        update_status=lambda: update_body(update_source.read()),
        on_startup_failure=delivery.connection_failed,
        handover=handover,
        # "Conectou" na passagem é a confirmação da API: o que o supervisor lê em `connected.json`.
        on_handover_accepted=handover_accepted,
        # Windows: a reconexão acorda quando a rede muda; nos outros sistemas, nada muda.
        network_watcher=network_change_watcher,
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
        # Atrasos menores que a parada do vigia também explicam lentidão do controle.
        LoopLagMonitor().run,
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
        if pc.volume is not None:
            # A leitura periódica: o volume que mudou por fora (o teclado do PC) chega à API.
            jobs = [*jobs, pc.volume.run]
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
    if settings.self_care or tv is not None or pc is not None:
        # O pareamento pelo app e o estado "não pareada" também dependem do que a API aceita.
        jobs = [*jobs, features.run]
    # Cada tarefa de fundo é supervisionada: erro vira registro e ocorrência, e ela recomeça.
    background: list[asyncio.Task[None]] = []

    def start_background() -> None:
        background.extend(
            asyncio.create_task(
                keep_running(
                    job.__qualname__, job, clock=clock, recorder=kit.recorder, health=health
                )
            )
            for job in jobs
        )

    async def take_over() -> None:
        """Passagem sem queda: espera a execução antiga largar a trava e só então abre o dela.

        Sem a confirmação da API, a antiga não foi mandada sair: passado o prazo (contado do começo
        desta execução, `HANDOVER_CONFIRM_SECONDS`) ela desiste (nada mudou para ninguém). Com a
        confirmação, ela espera quanto for preciso (a antiga sai ao receber o 4410, ou o supervisor
        a derruba)."""
        logged = clock.monotonic()
        while not await asyncio.to_thread(_acquire_all, agent_id):
            now = clock.monotonic()
            if not accepted.is_set():
                if now >= confirm_deadline:
                    _log.error("a API não confirmou a passagem a tempo")
                    raise HandoverTimeout
            elif now - logged >= HANDOVER_WAIT_LOG_SECONDS:
                logged = now
                _log.warning("a API me promoveu, mas a execução anterior ainda não largou a trava")
            await clock.sleep(HANDOVER_POLL_SECONDS)
        await start_shared_state()
        if tv is not None:
            for step in tv.prepare:
                await step()
        diary.start()
        start_background()
        owner.set()
        connection_mark.ready()
        _log.info("passagem concluída: esta execução é a dona do PC e da TV")

    if not handover:
        start_background()
    takeover = asyncio.create_task(take_over(), name="takeover") if handover else None
    relocator = (
        build_relocator(
            settings,
            clock,
            lambda: tv.manager.snapshot().connection == "hot",
            tv.known,
            tv.watchdog.request if tv.watchdog is not None else None,
            lambda: tv.light_settings.focus_active if tv.light_settings is not None else False,
            tv.manager.reopen_unattended,
            recorder=kit.recorder,
        )
        if tv is not None
        else None
    )
    moved = False
    timed_out = False
    stopped_because = "erro"
    try:
        moved = await supervise(
            supervisor, relocator, clock=clock, kit=kit, owner=owner, takeover=takeover
        )
        stopped_because = _stop_reason_text(moved, supervisor.stop_reason)
        if supervisor.stop_reason == STOP_DUPLICATE:
            kit.recorder.record(
                "agent.duplicate",
                "error",
                "outro agente com a mesma identidade tomou a conexão duas vezes em poucos minutos; "
                "este encerrou em vez de disputar",
                component="main",
            )
    except HandoverTimeout:
        stopped_because = "passagem_sem_dona"
        timed_out = True
    except asyncio.CancelledError:
        stopped_because = "cancelado"
        raise
    finally:
        # Ao encerrar, fecha a sessão com a TV de forma limpa (não deixa o canal pendurado).
        if takeover is not None:
            takeover.cancel()
            await asyncio.gather(takeover, return_exceptions=True)
        for task in background:
            task.cancel()
        await _close_within(
            "as tarefas de fundo", asyncio.gather(*background, return_exceptions=True)
        )
        for refresh in list(refreshing):
            refresh.cancel()
        await _close_within(
            "a consulta do que a API aceita", asyncio.gather(*refreshing, return_exceptions=True)
        )
        if pc is not None:
            await _close_within("o canal direto do PC", pc.close_direct())
        if pc is not None and pc.volume is not None:
            await _close_within("o volume do PC", pc.volume.aclose())
        if supervisor.stop_reason == STOP_HANDOVER:
            # Uma versão nova já é a dona: o que está em curso (na TV e na faixa do PC) termina
            # antes de tudo ser fechado.
            await process.drain(HANDOVER_DRAIN_SECONDS)
        # Fecha a faixa no laço dela (solta as teclas e os botões lá) e depois para a thread.
        await _close_within("os comandos em curso", process.aclose())
        if pc is not None:
            await _close_within("a thread da entrada do PC", pc.stop_input())
        if tv is not None:
            await _close_within("a sessão com a TV", tv.manager.aclose())
            for close in tv.closers:
                await _close_within("um recurso da TV", close())
        if publisher is not None:
            await _close_within("o publicador do estado da TV", publisher.aclose())
        kit.recorder.flush_pending()
        await _close_within("a fila de diagnóstico", kit.store.flush_appends())
        if owner.is_set():
            # Quem nunca chegou a ser a dona (a passagem não completou) não escreve no rastro dela.
            run_state.end(stopped_because)
    if timed_out:
        return EXIT_ALREADY_RUNNING
    if supervisor.stop_reason == STOP_HANDOVER_UNSUPPORTED:
        # A API trocou de instância no meio e a nova não tem a rota da candidata: nada foi aberto.
        return EXIT_HANDOVER_UNSUPPORTED
    if moved:
        return EXIT_TV_MOVED
    if supervisor.stop_reason == STOP_HANDOVER:
        _log.info("uma versão nova assumiu a conexão; saí de forma ordenada")
        return EXIT_OK
    if supervisor.stop_reason == STOP_DUPLICATE:
        return EXIT_DUPLICATE_AGENT
    # `run` só devolve quando a credencial foi recusada; o token continua no cofre.
    print(
        "Token revogado ou inválido. Rode `uniover-agent pair` para parear de novo.",
        file=sys.stderr,
    )
    return EXIT_CREDENTIAL_REJECTED
