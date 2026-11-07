"""Montagem do controle do PC (mouse, teclado, mídia)."""

import logging
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from uniover_agent.adapters.local_config import update_config
from uniover_agent.adapters.pc_windows import WindowsPcInput, WindowsPcLauncher, WindowsPcPower
from uniover_agent.composition.system import EXIT_OK
from uniover_agent.config import Settings, config_path
from uniover_agent.core import (
    PC_CONTROL_CAPABILITY,
    ClockOffset,
    EnvelopeFactory,
    Handler,
    PcApp,
    parse_favorites,
    pc_apps_announcer,
    pc_handlers,
)
from uniover_agent.ports import PcInput, PcLauncher, PcPower, Transport

_log = logging.getLogger("uniover_agent")


@dataclass(slots=True)
class PcSetup:
    """O controle do PC, quando ligado: os comandos `pc.*`, a capacidade e o aviso dos favoritos."""

    handlers: dict[str, Handler]
    capabilities: list[str]
    after_hello: list[Callable[[], Awaitable[None]]]
    apps: list[PcApp]
    # Solta os botões do mouse que o PC ficou segurando (conexão caída, agente encerrando).
    release_all: Callable[[], None]
    # Estimativa da diferença de relógio com a API: `ProcessMessage` a alimenta com o `ts` de cada
    # mensagem e os comandos medem a idade por ela.
    clock: ClockOffset


def build_pc(  # noqa: PLR0913 - portas trocáveis para os testes, todas com padrão
    settings: Settings,
    transport: Transport,
    envelopes: EnvelopeFactory,
    *,
    platform: str = sys.platform,
    pc_input: PcInput | None = None,
    power: PcPower | None = None,
    launcher: PcLauncher | None = None,
    on_clock_skew: Callable[[float], None] | None = None,
    on_expired: Callable[[float], None] | None = None,
) -> PcSetup | None:
    """O controle do PC só existe quando a pessoa o ligou neste PC (`pc_control`) e o sistema é o
    Windows. Sem isso nenhum comando `pc.*` é aceito e a capacidade não é declarada: a API nem
    oferece o módulo (mover o mouse e digitar à distância é poder demais para valer por padrão)."""
    if not settings.pc_control:
        return None
    if platform != "win32":
        _log.warning("controle do PC ligado, mas só o Windows o suporta; nada foi habilitado")
        return None
    apps = parse_favorites(settings.pc_apps)
    pc_input = pc_input or WindowsPcInput()
    clock = ClockOffset(on_skew=on_clock_skew, on_refused=on_expired)
    handlers = pc_handlers(
        pc_input,
        power or WindowsPcPower(),
        launcher or WindowsPcLauncher(),
        apps,
        shutdown_delay_seconds=settings.pc_shutdown_delay_seconds,
        clock=clock,
    )
    return PcSetup(
        handlers,
        [PC_CONTROL_CAPABILITY],
        [pc_apps_announcer(apps, transport, envelopes)],
        apps,
        pc_input.release_all,
        clock,
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
