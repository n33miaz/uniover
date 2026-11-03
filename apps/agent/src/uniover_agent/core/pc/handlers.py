"""Handlers do controle do PC: traduzem a mensagem já validada em chamadas ao sistema.

Nada aqui sabe que o sistema é o Windows. O que o contrato já limita (listas fechadas, tamanhos)
não é conferido de novo; o que depende do PC (um favorito que sumiu da configuração) é.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.pc.apps import PcApp
from uniover_agent.ports import Transport, TransportError
from uniover_agent.ports.pc import PcInput, PcLauncher, PcPower, PcUnsupported

_log = logging.getLogger(__name__)

# Declarada no `agent.hello.v1`: a API só manda `pc.*` a quem a tem.
PC_CONTROL_CAPABILITY: Final = "pc.control.v1"

# Comandos executados sem resposta: a API manda o movimento do mouse sem esperar por ela.
PC_SILENT_TYPES: Final = frozenset({"pc.pointer.v1"})

UNSUPPORTED: Final = "unsupported"
UNKNOWN_APP: Final = "unknown_app"
# Tempo entre responder à API e suspender: o resultado precisa sair antes de o PC adormecer.
SLEEP_DELAY_SECONDS: Final = 1.0


def _ok(command: Command) -> CommandResult:
    return CommandResult(command.id, ResultStatus.OK)


def _guarded(handle: Callable[[Command], CommandResult], *, noisy: bool = True) -> Handler:
    """Transforma a falha do sistema em resultado: o agente nunca cai por causa de uma tecla.

    `noisy=False` é para o fluxo de alta taxa (o movimento do mouse): uma falha repetida seria uma
    linha de registro por movimento, então vai só para o nível de depuração.
    """

    async def run(command: Command) -> CommandResult:
        try:
            return handle(command)
        except PcUnsupported as exc:
            return CommandResult(command.id, ResultStatus.REJECTED, str(exc), UNSUPPORTED)
        except ValueError as exc:
            # Tecla fora das listas: o contrato já barra, isto só protege contra um erro nosso.
            return CommandResult(command.id, ResultStatus.REJECTED, str(exc), "invalid_message")
        except OSError as exc:
            (_log.warning if noisy else _log.debug)("falha ao executar %s: %s", command.type, exc)
            return CommandResult(command.id, ResultStatus.FAILED, str(exc), "failed")

    return run


def pc_pointer_handler(pc: PcInput) -> Handler:
    """`pc.pointer.v1`: movimento e rolagem somados pelo app, num só toque no sistema."""

    def handle(command: Command) -> CommandResult:
        body = command.body
        dx, dy = int(body.get("dx", 0)), int(body.get("dy", 0))
        scroll_x, scroll_y = int(body.get("scrollX", 0)), int(body.get("scrollY", 0))
        if dx or dy:
            pc.move(dx, dy)
        if scroll_x or scroll_y:
            pc.scroll(scroll_x, scroll_y)
        return _ok(command)

    return _guarded(handle, noisy=False)


def pc_click_handler(pc: PcInput) -> Handler:
    """`pc.click.v1`."""

    def handle(command: Command) -> CommandResult:
        pc.click(str(command.body["button"]), str(command.body.get("action") or "CLICK"))
        return _ok(command)

    return _guarded(handle)


def pc_key_handler(pc: PcInput) -> Handler:
    """`pc.key.v1`."""

    def handle(command: Command) -> CommandResult:
        modifiers: Sequence[str] = command.body.get("modifiers") or ()
        pc.key(str(command.body["key"]), modifiers)
        return _ok(command)

    return _guarded(handle)


def pc_text_handler(pc: PcInput) -> Handler:
    """`pc.text.v1`. O texto nunca vai para o registro: pode ser uma senha."""

    def handle(command: Command) -> CommandResult:
        pc.type_text(str(command.body["text"]))
        return _ok(command)

    return _guarded(handle)


def pc_media_handler(pc: PcInput) -> Handler:
    """`pc.media.v1`."""

    def handle(command: Command) -> CommandResult:
        pc.media(str(command.body["action"]), int(command.body.get("steps") or 1))
        return _ok(command)

    return _guarded(handle)


def pc_power_handler(
    power: PcPower,
    *,
    shutdown_delay_seconds: int,
    sleep_delay_seconds: float = SLEEP_DELAY_SECONDS,
    spawn: Callable[[Awaitable[None]], Any] | None = None,
) -> Handler:
    """`pc.power.v1`. Suspender só acontece depois da resposta: o PC adormece com a conexão."""

    pending: set[asyncio.Task[None]] = set()

    def start(coroutine: Awaitable[None]) -> None:
        if spawn is not None:
            spawn(coroutine)
            return
        task = asyncio.ensure_future(coroutine)
        pending.add(task)
        task.add_done_callback(pending.discard)

    async def suspend_later() -> None:
        await asyncio.sleep(sleep_delay_seconds)
        try:
            # Só volta quando o PC acorda; em outra thread para não parar o agente inteiro.
            await asyncio.to_thread(power.sleep)
        except PcUnsupported, OSError:
            _log.warning("não foi possível suspender o PC", exc_info=True)

    def handle(command: Command) -> CommandResult:
        action = str(command.body["action"])
        if action == "LOCK":
            power.lock()
        elif action == "SHUTDOWN":
            power.shutdown(shutdown_delay_seconds)
            _log.warning("desligamento agendado em %ds a pedido do app", shutdown_delay_seconds)
        elif action == "CANCEL_SHUTDOWN":
            power.cancel_shutdown()
        elif action == "SLEEP":
            _log.warning("suspensão pedida pelo app")
            start(suspend_later())
        return _ok(command)

    return _guarded(handle)


def pc_app_launch_handler(launcher: PcLauncher, apps: Sequence[PcApp]) -> Handler:
    """`pc.app.launch.v1`: só abre o que está na lista do próprio PC, pelo identificador."""

    by_id = {app.id: app for app in apps}

    def handle(command: Command) -> CommandResult:
        app = by_id.get(str(command.body["appId"]))
        if app is None:
            return CommandResult(
                command.id, ResultStatus.REJECTED, "app favorito desconhecido", UNKNOWN_APP
            )
        launcher.launch(app.target)
        _log.info("favorito aberto: %s", app.id)
        return _ok(command)

    return _guarded(handle)


def pc_handlers(
    pc: PcInput,
    power: PcPower,
    launcher: PcLauncher,
    apps: Sequence[PcApp],
    *,
    shutdown_delay_seconds: int,
) -> dict[str, Handler]:
    """Todos os comandos `pc.*` que este agente executa quando o controle está ligado."""
    return {
        "pc.pointer.v1": pc_pointer_handler(pc),
        "pc.click.v1": pc_click_handler(pc),
        "pc.key.v1": pc_key_handler(pc),
        "pc.text.v1": pc_text_handler(pc),
        "pc.media.v1": pc_media_handler(pc),
        "pc.power.v1": pc_power_handler(power, shutdown_delay_seconds=shutdown_delay_seconds),
        "pc.app.launch.v1": pc_app_launch_handler(launcher, apps),
    }


def pc_apps_announcer(
    apps: Sequence[PcApp], transport: Transport, envelopes: EnvelopeFactory
) -> Callable[[], Awaitable[None]]:
    """Avisa a API, a cada conexão, quais favoritos este PC deixa abrir (só id e nome)."""

    async def announce() -> None:
        try:
            await transport.send(envelopes.pc_apps([(app.id, app.label) for app in apps]))
        except TransportError as exc:
            # A conexão caiu no meio: a próxima conexão avisa de novo.
            _log.debug("lista de favoritos não enviada (%s)", exc)

    return announce
