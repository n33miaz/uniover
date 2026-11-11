"""Montagem do controle do PC (mouse, teclado, mídia)."""

import asyncio
import contextlib
import logging
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from uniover_agent.adapters import windows_scheduling
from uniover_agent.adapters.local_config import update_config
from uniover_agent.adapters.loop_lag import LoopLagMonitor
from uniover_agent.adapters.pc_audio import WindowsPcAudio
from uniover_agent.adapters.pc_direct_aiortc import aiortc_installed, build_peer
from uniover_agent.adapters.pc_input_thread import (
    ExceptionHandler,
    MainLoopCaller,
    MainLoopSender,
    PcInputThread,
)
from uniover_agent.adapters.pc_windows import WindowsPcInput, WindowsPcLauncher, WindowsPcPower
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.composition.system import EXIT_OK
from uniover_agent.config import Settings, config_path
from uniover_agent.core import (
    PC_CLICK_V2_CAPABILITY,
    PC_CONTROL_CAPABILITY,
    PC_KEY_V2_CAPABILITY,
    PC_RTC_CAPABILITY,
    PC_TEXT_V2_CAPABILITY,
    PC_VOLUME_CAPABILITY,
    PC_ZOOM_CAPABILITY,
    ClickPacer,
    ClockOffset,
    Command,
    DirectSettings,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    Handler,
    PcApp,
    PcDirectService,
    PcUseTracker,
    PcVolumeAnnouncer,
    parse_favorites,
    pc_apps_announcer,
    pc_handlers,
    pc_rtc_handlers,
    volume_after_hello,
)
from uniover_agent.core.pc.devices import DeviceApprovals
from uniover_agent.core.pc.direct import RTC_SILENT_TYPES
from uniover_agent.core.pc.freshness import MAX_POINTER_AGE_SECONDS
from uniover_agent.core.pc.handlers import PC_DEVICE_CAPABILITY, PC_OP_CAPABILITY, PC_SILENT_TYPES
from uniover_agent.core.pc.lane import PcLane, PointerSpread
from uniover_agent.ports import (
    Clock,
    DirectPeerFactory,
    PcAudio,
    PcInput,
    PcLauncher,
    PcPower,
    Sender,
    Transport,
    TransportError,
)

_log = logging.getLogger("uniover_agent")


@dataclass(slots=True)
class PcSetup:
    """O controle do PC, quando ligado: os comandos `pc.*`, a capacidade e o aviso dos favoritos."""

    handlers: dict[str, Handler]
    capabilities: list[str]
    after_hello: list[Callable[[], Awaitable[None]]]
    apps: list[PcApp]
    # Solta os botões do mouse e as teclas que o PC ficou segurando (conexão caída, agente
    # encerrando).
    release_all: Callable[[], None]
    # Referência de idade dos comandos: `ProcessMessage` a alimenta só com o `ts` dos batimentos da
    # API, e os comandos medem a idade por ela.
    clock: ClockOffset
    # Quando o controle foi usado pela última vez (a atualização do agente espera por ele).
    use: PcUseTracker
    # O último clique, para o intervalo do duplo clique; a faixa o liga (uma soltura nunca espera).
    pacer: ClickPacer
    # A faixa do PC: a fila única dos comandos `pc.*`, ligada ao pacer e ao canal direto. Roda no
    # laço de `host` (ou no do agente, sem ele).
    lane: PcLane
    # O aviso do volume de agora (`pc.volume.state.v1`): quem monta o agente liga `enabled` ao que a
    # API listou em `features`; até lá nada é enviado.
    volume: PcVolumeAnnouncer | None = None
    # O canal direto (WebRTC), quando este PC o oferece; `None` sem a biblioteca ou desligado.
    direct: PcDirectService | None = None
    # O laço próprio da entrada do PC (thread dedicada); `None`: tudo roda no laço do agente.
    host: PcInputThread | None = None
    # Conjunto de trabalho mínimo pedido ao Windows (MB; 0 não pede) e quem pede: trocáveis nos
    # testes, que nunca devem mexer na memória do processo de teste.
    working_set_min_mb: int = 0
    protect_memory: Callable[[int], bool] | None = None
    # A aprovação de aparelho novo (a pergunta ao dono no PC); `None` sem ela.
    approvals: DeviceApprovals | None = None
    # Como o aviso do estado do aparelho sai (montado em `build_pc`): envelope, envio sem espera
    # (entre laços) ou o envio comum (no mesmo laço).
    _device_envelope: Callable[[str, str], dict[str, Any]] = lambda device_id, state: {}
    _device_fire: Callable[[dict[str, Any]], None] | None = None
    _device_send: Callable[[dict[str, Any]], Awaitable[None]] = lambda envelope: asyncio.sleep(0)
    # Leva uma chamada do laço da entrada ao laço do agente (`None` sem a thread: é o mesmo laço).
    _main_call: Callable[..., None] | None = None

    def start(self) -> None:
        """Sobe o laço da entrada (se há) e pede a proteção da memória. Chamado uma vez, já no laço
        principal e antes de a primeira mensagem chegar."""
        if self.host is None:
            return
        self.host.start()
        if self.working_set_min_mb > 0:
            protect = self.protect_memory or windows_scheduling.protect_working_set
            if protect(self.working_set_min_mb):
                _log.info(
                    "conjunto de trabalho mínimo do agente protegido (%d MB)",
                    self.working_set_min_mb,
                )
            else:
                _log.info("seguindo sem a proteção do conjunto de trabalho do agente")
        _log.info(
            "entrada do PC em laço próprio (prioridade %s)",
            "acima do normal" if self.host.prioritized else "normal",
        )

    def bind_device_api(
        self,
        *,
        answered: Callable[[], bool],
        supports: Callable[[], bool],
        refresh: Callable[[], None] | None = None,
    ) -> None:
        """Liga a aprovação de aparelho ao que se sabe da API (que o agente conhece depois):
        `answered` (ela já disse o que aceita) e `supports` (lista `pc.device.v1`). O aviso do
        estado do aparelho sai pelo laço que sabe falar com a API, sem prender o da entrada."""
        approvals = self.approvals
        if approvals is None:
            return
        # O pedido de nova consulta nasce no laço da entrada e a consulta roda no laço do agente.
        hop = self._main_call
        approvals.bind_api(
            answered=answered,
            supports=supports,
            announce=self._announce_device,
            refresh=(lambda: hop(refresh)) if refresh is not None and hop is not None else refresh,
        )

    def _announce_device(self, device_id: str, state: str) -> None:
        envelope = self._device_envelope(device_id, state)
        if self._device_fire is not None:
            self._device_fire(envelope)
        else:
            asyncio.ensure_future(self._device_send(envelope))  # noqa: RUF006 - aviso sem espera

    def on_lane(self, callback: Callable[[], None]) -> None:
        """Roda `callback` no laço da faixa do PC (na ordem das chamadas): agora, sem a thread."""
        if self.host is None:
            callback()
        else:
            self.host.post(callback)

    async def close_direct(self) -> None:
        """Fecha o canal direto e a pergunta ao dono no laço deles (o agente está encerrando)."""
        if self.approvals is not None:
            if self.host is None:
                await self.approvals.aclose()
            else:
                with contextlib.suppress(TimeoutError, RuntimeError):
                    await self.host.call(self.approvals.aclose, wait_seconds=5.0)
        if self.direct is None:
            return
        if self.host is None:
            await self.direct.aclose()
            return
        try:
            await self.host.call(self.direct.aclose, wait_seconds=10.0)
        except TimeoutError, RuntimeError:
            _log.warning("o canal direto não fechou a tempo")

    async def stop_input(self) -> None:
        """Para a thread da entrada (depois de fechar o canal e a faixa)."""
        if self.host is not None:
            await asyncio.to_thread(self.host.stop)


def build_pc(  # noqa: PLR0913 - portas trocáveis para os testes, todas com padrão
    settings: Settings,
    transport: Transport,
    envelopes: EnvelopeFactory,
    *,
    platform: str = sys.platform,
    pc_input: PcInput | None = None,
    power: PcPower | None = None,
    launcher: PcLauncher | None = None,
    audio: PcAudio | None = None,
    clock_source: Clock | None = None,
    on_clock_skew: Callable[[float], None] | None = None,
    on_expired: Callable[[float], None] | None = None,
    on_clock_unstable: Callable[[int], None] | None = None,
    gate: EnvelopeGate | None = None,
    agent_id: str = "",
    direct_factory: DirectPeerFactory | None = None,
    direct_available: Callable[[], bool] = aiortc_installed,
    record: Callable[[str, str, str], None] | None = None,
    isolate_input: bool = False,
    prioritize: Callable[[], bool] | None = None,
    protect_memory: Callable[[int], bool] | None = None,
    exception_handler: ExceptionHandler | None = None,
    devices: DeviceApprovals | None = None,
) -> PcSetup | None:
    """O controle do PC só existe quando está ligado neste PC (`pc_control`, ligado por padrão) e o
    sistema é o Windows. Desligado, nenhum comando `pc.*` é aceito e a capacidade não é declarada: a
    API nem oferece o módulo. Quem usa ainda precisa da permissão do módulo na API.

    `isolate_input` (precisa de um laço rodando: o do agente) põe a faixa do PC e o canal direto
    num laço de eventos próprio, numa thread com prioridade acima do normal: quem vem de lá para cá
    (resultados, avisos de diagnóstico, o aviso do volume) volta ao laço do agente sem nunca prender
    a entrada. A thread só sobe em `PcSetup.start()`."""
    if not settings.pc_control:
        return None
    if platform != "win32":
        _log.warning("controle do PC ligado, mas só o Windows o suporta; nada foi habilitado")
        return None
    apps = parse_favorites(settings.pc_apps)
    pc_input = pc_input or WindowsPcInput()
    clock_now = clock_source or SystemClock()

    host: PcInputThread | None = None
    main_call: Callable[..., None] | None = None
    sender: Sender = transport
    fire: Callable[[dict[str, Any]], None] | None = None
    lane_gate = gate
    lane_envelopes = envelopes
    if isolate_input:
        main_loop = asyncio.get_running_loop()
        main_call = MainLoopCaller(main_loop)
        main_sender = MainLoopSender(main_loop, transport)
        sender, fire = main_sender, main_sender.fire
        host = PcInputThread(
            prioritize=prioritize or windows_scheduling.raise_thread_priority,
            exception_handler=exception_handler,
            background=[LoopLagMonitor(name="entrada").run],
        )
        # O laço da entrada tem o seu próprio portão e a sua própria fábrica de envelopes: o que os
        # dois laços compartilham é só o que é imutável.
        lane_gate = EnvelopeGate(agent_id)
        lane_envelopes = EnvelopeFactory(agent_id, lane_gate, clock_now)

    def on_main(callback: Callable[..., None] | None) -> Callable[..., None] | None:
        """O aviso de quem roda no laço da entrada, levado ao laço do agente (sem esperar)."""
        if callback is None or main_call is None:
            return callback
        call = main_call

        def hop(*args: Any) -> None:
            call(callback, *args)

        return hop

    clock = ClockOffset(
        on_skew=on_main(on_clock_skew),
        on_refused=on_main(on_expired),
        on_unstable=on_main(on_clock_unstable),
    )
    use = PcUseTracker()
    pacer = ClickPacer()
    audio = audio or WindowsPcAudio()
    volume = PcVolumeAnnouncer(audio, transport, envelopes, clock_now, enabled=lambda: False)
    volume_changed: Callable[[], None] = (
        (lambda: main_call(volume.soon)) if main_call is not None else volume.soon
    )
    handlers = pc_handlers(
        pc_input,
        power or WindowsPcPower(),
        launcher or WindowsPcLauncher(),
        apps,
        shutdown_delay_seconds=settings.pc_shutdown_delay_seconds,
        clock=clock,
        use=use,
        pacer=pacer,
        audio=audio,
        volume_changed=volume_changed,
    )
    # As capacidades `v2` e `pc.rtc.v1` aqui são só o que este agente sabe; o `hello` só as declara
    # depois de a API listá-las (`declarable_capabilities`).
    capabilities = [
        PC_CONTROL_CAPABILITY,
        PC_KEY_V2_CAPABILITY,
        PC_TEXT_V2_CAPABILITY,
        PC_CLICK_V2_CAPABILITY,
        PC_ZOOM_CAPABILITY,
        PC_VOLUME_CAPABILITY,
        PC_OP_CAPABILITY,
    ]
    approvals = devices
    if approvals is not None:
        capabilities.append(PC_DEVICE_CAPABILITY)
    direct: PcDirectService | None = None
    silent_types = set(PC_SILENT_TYPES)
    if settings.pc_direct and lane_gate is not None and direct_available():
        direct = _build_direct(
            settings,
            sender,
            fire,
            lane_envelopes,
            lane_gate,
            agent_id,
            clock,
            direct_factory,
            on_main(record),
            approvals,
        )
        handlers.update(pc_rtc_handlers(direct, sender, lane_envelopes))
        silent_types |= RTC_SILENT_TYPES
        capabilities.append(PC_RTC_CAPABILITY)
    lane = PcLane(
        HandleCommand(handlers, clock_now),
        lane_envelopes,
        sender,
        silent_types=silent_types,
        release_inputs=pc_input.release_all,
        on_cloud_pc_input=direct.cloud_input if direct is not None else None,
        on_release_queued=pacer.hurry,
        direct_active=(lambda: direct.holds_inputs) if direct is not None else None,
        pointer_stale=lambda command: _older_than(clock, command, MAX_POINTER_AGE_SECONDS),
        devices=approvals,
        spread=(
            PointerSpread(
                min_pixels=settings.pc_pointer_spread_min_px,
                total_seconds=settings.pc_pointer_spread_ms / 1000,
            )
            if settings.pc_pointer_spread_ms > 0
            else None
        ),
    )
    pacer.bind(lane.release_waiting)
    if direct is not None:
        # O canal direto usa a mesma faixa do PC e, ao fechar, solta o que ele segurava.
        direct.bind(lane.submit_direct, lane.direct_lost)
    return PcSetup(
        handlers,
        capabilities,
        [pc_apps_announcer(apps, transport, envelopes), volume_after_hello(volume)],
        apps,
        pc_input.release_all,
        clock,
        use,
        pacer,
        lane,
        volume,
        direct,
        host,
        settings.pc_working_set_min_mb if host is not None else 0,
        protect_memory,
        approvals,
        lane_envelopes.pc_device_state,
        fire,
        sender.send,
        main_call,
    )


def _older_than(clock: ClockOffset, command: Command, seconds: float) -> bool:
    """O comando passou da validade? Sem referência de relógio (ainda) ele vale como chegou."""
    age = clock.age(command.sent_at)
    return age is not None and age > seconds


def _build_direct(  # noqa: PLR0913, PLR0917 - dependências da montagem
    settings: Settings,
    sender: Sender,
    fire: Callable[[dict[str, Any]], None] | None,
    envelopes: EnvelopeFactory,
    gate: EnvelopeGate,
    agent_id: str,
    clock: ClockOffset,
    factory: DirectPeerFactory | None,
    record: Callable[[str, str, str], None] | None,
    devices: DeviceApprovals | None = None,
) -> PcDirectService:
    async def notify_closed(session_id: str, reason: str) -> None:
        envelope = envelopes.pc_rtc_closed(session_id, reason)
        if fire is not None:
            fire(envelope)  # o aviso não prende o laço da entrada se o principal estiver parado
            return
        try:
            await sender.send(envelope)
        except TransportError as exc:
            _log.debug("aviso de canal direto fechado não enviado (%s)", exc)

    return PcDirectService(
        factory=factory or build_peer,
        agent_id=agent_id,
        gate=gate,
        api_clock=clock,
        notify_closed=notify_closed,
        record=record,
        settings=DirectSettings(
            connect_timeout_seconds=settings.pc_direct_connect_timeout_seconds,
            idle_seconds=settings.pc_direct_idle_seconds,
            max_lifetime_seconds=settings.pc_direct_max_lifetime_seconds,
            api_grace_seconds=settings.pc_direct_api_grace_seconds,
        ),
        devices=devices,
    )


def pc_control(settings: Settings, state: str) -> int:
    """`pc-control on|off|status`: grava no `agent.toml` se este PC aceita o controle pelo app. Vale
    na próxima vez que o agente iniciar."""
    if state == "status":
        print("ligado" if settings.pc_control else "desligado")
        return EXIT_OK
    enabled = state == "on"
    update_config(config_path(), {"pc_control": enabled})
    if enabled:
        print(
            "Controle do PC ligado. Reinicie o agente para valer. Os favoritos ficam em "
            "`pc_apps` no agent.toml (`Nome=destino`)."
        )
    else:
        print("Controle do PC desligado. Reinicie o agente para valer.")
    return EXIT_OK
