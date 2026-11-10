"""Montagem do controle do PC (mouse, teclado, mídia)."""

import logging
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from uniover_agent.adapters.local_config import update_config
from uniover_agent.adapters.pc_audio import WindowsPcAudio
from uniover_agent.adapters.pc_direct_aiortc import aiortc_installed, build_peer
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
    DirectSettings,
    EnvelopeFactory,
    EnvelopeGate,
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
from uniover_agent.ports import (
    Clock,
    DirectPeerFactory,
    PcAudio,
    PcInput,
    PcLauncher,
    PcPower,
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
    # O aviso do volume de agora (`pc.volume.state.v1`): quem monta o agente liga `enabled` ao que a
    # API listou em `features`; até lá nada é enviado.
    volume: PcVolumeAnnouncer | None = None
    # O canal direto (WebRTC), quando este PC o oferece; `None` sem a biblioteca ou desligado.
    direct: PcDirectService | None = None


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
) -> PcSetup | None:
    """O controle do PC só existe quando está ligado neste PC (`pc_control`, ligado por padrão) e o
    sistema é o Windows. Desligado, nenhum comando `pc.*` é aceito e a capacidade não é declarada: a
    API nem oferece o módulo. Quem usa ainda precisa da permissão do módulo na API."""
    if not settings.pc_control:
        return None
    if platform != "win32":
        _log.warning("controle do PC ligado, mas só o Windows o suporta; nada foi habilitado")
        return None
    apps = parse_favorites(settings.pc_apps)
    pc_input = pc_input or WindowsPcInput()
    clock = ClockOffset(on_skew=on_clock_skew, on_refused=on_expired, on_unstable=on_clock_unstable)
    use = PcUseTracker()
    pacer = ClickPacer()
    audio = audio or WindowsPcAudio()
    volume = PcVolumeAnnouncer(
        audio, transport, envelopes, clock_source or SystemClock(), enabled=lambda: False
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
        volume_changed=volume.soon,
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
    ]
    direct: PcDirectService | None = None
    if settings.pc_direct and gate is not None and direct_available():
        direct = _build_direct(
            settings, transport, envelopes, gate, agent_id, clock, direct_factory, record
        )
        handlers.update(pc_rtc_handlers(direct, transport, envelopes))
        capabilities.append(PC_RTC_CAPABILITY)
    return PcSetup(
        handlers,
        capabilities,
        [pc_apps_announcer(apps, transport, envelopes), volume_after_hello(volume)],
        apps,
        pc_input.release_all,
        clock,
        use,
        pacer,
        volume,
        direct,
    )


def _build_direct(  # noqa: PLR0913, PLR0917 - dependências da montagem
    settings: Settings,
    transport: Transport,
    envelopes: EnvelopeFactory,
    gate: EnvelopeGate,
    agent_id: str,
    clock: ClockOffset,
    factory: DirectPeerFactory | None,
    record: Callable[[str, str, str], None] | None,
) -> PcDirectService:
    async def notify_closed(session_id: str, reason: str) -> None:
        try:
            await transport.send(envelopes.pc_rtc_closed(session_id, reason))
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
        ),
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
