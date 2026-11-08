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
from uniover_agent.core.pc.clock_offset import ClockOffset
from uniover_agent.core.pc.freshness import (
    MAX_COMMAND_AGE_SECONDS,
    MAX_POINTER_AGE_SECONDS,
    MAX_POWER_AGE_SECONDS,
    fresh_only,
)
from uniover_agent.core.pc.use import PcUseTracker
from uniover_agent.ports import Transport, TransportError
from uniover_agent.ports.pc import PcInput, PcLauncher, PcPower, PcUnsupported

_log = logging.getLogger(__name__)

# Declarada no `agent.hello.v1`: a API só manda `pc.*` a quem a tem.
PC_CONTROL_CAPABILITY: Final = "pc.control.v1"

# Comandos executados sem resposta: a API manda o movimento do mouse sem esperar por ela.
PC_SILENT_TYPES: Final = frozenset({"pc.pointer.v1"})

POINTER_TYPE: Final = "pc.pointer.v1"
# Limites de um movimento e de uma rolagem (contrato e adaptador): uma soma que os passasse seria
# cortada pelo adaptador e perderia caminho, então não se soma.
MAX_POINTER_DELTA: Final = 2000
MAX_SCROLL_DELTA: Final = 1200
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


def _pointer_axes(command: Command) -> tuple[int, int, int, int]:
    body = command.body
    return (
        int(body.get("dx", 0)),
        int(body.get("dy", 0)),
        int(body.get("scrollX", 0)),
        int(body.get("scrollY", 0)),
    )


def _pointer_kind(command: Command) -> str:
    dx, dy, scroll_x, scroll_y = _pointer_axes(command)
    if not (scroll_x or scroll_y):
        return "move"  # inclusive o movimento vazio que mantém um arrasto vivo
    return "mixed" if (dx or dy) else "scroll"


def merge_pointer_commands(older: Command, newer: Command) -> Command | None:
    """Junta dois comandos seguidos de ponteiro num só, somando deslocamento e rolagem.

    O caminho é o mesmo (movimento é relativo e a soma é a mesma, desde que nada fique entre eles).
    O resultado leva o `id` e o `ts` do mais novo, que dita a idade. Devolve `None`, e não junta,
    quando a ordem entre movimento e rolagem mudaria (um deles mistura os dois, ou um só move e o
    outro só rola) ou quando a soma passaria dos limites do adaptador.
    """
    kind = _pointer_kind(older)
    if kind == "mixed" or kind != _pointer_kind(newer):
        return None
    total = [a + b for a, b in zip(_pointer_axes(older), _pointer_axes(newer), strict=True)]
    limits = (MAX_POINTER_DELTA, MAX_POINTER_DELTA, MAX_SCROLL_DELTA, MAX_SCROLL_DELTA)
    if any(abs(value) > limit for value, limit in zip(total, limits, strict=True)):
        return None
    body: dict[str, Any] = dict(zip(("dx", "dy", "scrollX", "scrollY"), total, strict=True))
    # Só diagnóstico: fica o maior número dos dois.
    seqs = [s for s in (older.body.get("seq"), newer.body.get("seq")) if s is not None]
    if seqs:
        body["seq"] = max(seqs)
    return Command(newer.id, newer.type, body, newer.correlation_id, newer.sent_at)


def pc_pointer_handler(pc: PcInput) -> Handler:
    """`pc.pointer.v1`: movimento e rolagem somados pelo app, num só toque no sistema."""

    def handle(command: Command) -> CommandResult:
        body = command.body
        dx, dy = int(body.get("dx", 0)), int(body.get("dy", 0))
        scroll_x, scroll_y = int(body.get("scrollX", 0)), int(body.get("scrollY", 0))
        if scroll_x or scroll_y:
            if dx or dy:
                pc.move(dx, dy)
            pc.scroll(scroll_x, scroll_y)
        else:
            # Mesmo sem deslocamento: a mensagem vazia (o app a manda a cada 10 s enquanto segura
            # um arrasto) chega ao adaptador, que a conta como tráfego sem enviar evento nenhum.
            pc.move(dx, dy)
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


def pc_handlers(  # noqa: PLR0913 - portas e relógio trocáveis para os testes
    pc: PcInput,
    power: PcPower,
    launcher: PcLauncher,
    apps: Sequence[PcApp],
    *,
    shutdown_delay_seconds: int,
    clock: ClockOffset | None = None,
    use: PcUseTracker | None = None,
) -> dict[str, Handler]:
    """Todos os comandos `pc.*` que este agente executa quando o controle está ligado.

    Cada um só roda dentro da sua validade (ver `freshness`); o UP de um clique e o cancelamento de
    um desligamento passam sempre. `clock` é a referência de idade (relógio da API contra o
    monotônico do agente): quem monta o agente a compartilha com `ProcessMessage`, que a alimenta
    com os batimentos da API. `use` anota cada comando que chega a ser executado (não os recusados
    por idade): a atualização do agente o lê para não reiniciar no meio de uma sessão do touchpad.
    """
    offset = clock or ClockOffset()

    def noted(handle: Handler) -> Handler:
        return use.noting(handle) if use is not None else handle

    def fresh(
        handle: Handler,
        max_age: float,
        *,
        exempt: Callable[[Command], bool] | None = None,
        quiet: bool = False,
    ) -> Handler:
        return fresh_only(handle, max_age_seconds=max_age, clock=offset, exempt=exempt, quiet=quiet)

    return {
        "pc.pointer.v1": fresh(noted(pc_pointer_handler(pc)), MAX_POINTER_AGE_SECONDS, quiet=True),
        "pc.click.v1": fresh(
            noted(pc_click_handler(pc)),
            MAX_COMMAND_AGE_SECONDS,
            exempt=lambda command: command.body.get("action") == "UP",
        ),
        "pc.key.v1": fresh(noted(pc_key_handler(pc)), MAX_COMMAND_AGE_SECONDS),
        "pc.text.v1": fresh(noted(pc_text_handler(pc)), MAX_COMMAND_AGE_SECONDS),
        "pc.media.v1": fresh(noted(pc_media_handler(pc)), MAX_COMMAND_AGE_SECONDS),
        "pc.power.v1": fresh(
            noted(pc_power_handler(power, shutdown_delay_seconds=shutdown_delay_seconds)),
            MAX_POWER_AGE_SECONDS,
            exempt=lambda command: command.body.get("action") == "CANCEL_SHUTDOWN",
        ),
        "pc.app.launch.v1": fresh(
            noted(pc_app_launch_handler(launcher, apps)), MAX_COMMAND_AGE_SECONDS
        ),
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
