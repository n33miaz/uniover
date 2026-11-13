"""Handlers do controle do PC: traduzem a mensagem já validada em chamadas ao sistema.

Nada aqui sabe que o sistema é o Windows. O que o contrato já limita (listas fechadas, tamanhos)
não é conferido de novo; o que depende do PC (um favorito que sumiu da configuração) é.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace
from typing import Any, Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.pc.apps import PcApp
from uniover_agent.core.pc.click_pacer import ClickPacer
from uniover_agent.core.pc.clock_offset import ClockOffset
from uniover_agent.core.pc.focus import focus_guarded
from uniover_agent.core.pc.freshness import (
    EXPIRED,
    MAX_COMMAND_AGE_SECONDS,
    MAX_POINTER_AGE_SECONDS,
    MAX_POWER_AGE_SECONDS,
    fresh_only,
)
from uniover_agent.core.pc.use import PcUseTracker
from uniover_agent.core.pc.volume import VOLUME_MEDIA_ACTIONS, pc_volume_handler
from uniover_agent.ports import Transport, TransportError
from uniover_agent.ports.pc import (
    PcAudio,
    PcForeground,
    PcInput,
    PcInputRefused,
    PcLauncher,
    PcPower,
    PcUnsupported,
)

_log = logging.getLogger(__name__)

# Declarada no `agent.hello.v1`: a API só manda `pc.*` a quem a tem.
PC_CONTROL_CAPABILITY: Final = "pc.control.v1"
# Também no `hello`, mas só depois de a API listá-la em `features` (uma API anterior recusaria o
# `hello` com capacidade que não conhece): teclas novas, repetição e segurar modificador.
PC_KEY_V2_CAPABILITY: Final = "pc.key.v2"
# Idem: apagar, digitar e apertar uma tecla numa mensagem só.
PC_TEXT_V2_CAPABILITY: Final = "pc.text.v2"
# Idem: clique com modificadores e com o intervalo do toque anterior (duplo clique confiável).
PC_CLICK_V2_CAPABILITY: Final = "pc.click.v2"
# Idem: zoom pela roda do mouse com o Ctrl apertado (a pinça).
PC_ZOOM_CAPABILITY: Final = "pc.pointer.zoom.v1"
# Idem: volume absoluto (nível de 0 a 100 e mudo) e o aviso do nível de agora.
PC_VOLUME_CAPABILITY: Final = "pc.volume.v1"
# Idem: o `operationId` do pedido HTTP no envelope dos comandos (liga os registros).
PC_OP_CAPABILITY: Final = "pc.op.v1"
# Idem: o aparelho do app (`deviceId`, `deviceName`) no envelope, para o dono aprová-lo no PC.
PC_DEVICE_CAPABILITY: Final = "pc.device.v1"

# Comandos executados sem resposta: a API manda o movimento do mouse sem esperar por ela.
PC_SILENT_TYPES: Final = frozenset({"pc.pointer.v1"})

POINTER_TYPE: Final = "pc.pointer.v1"
# Limites de um movimento e de uma rolagem (contrato e adaptador): uma soma que os passasse seria
# cortada pelo adaptador e perderia caminho, então não se soma.
MAX_POINTER_DELTA: Final = 2000
MAX_SCROLL_DELTA: Final = 1200
# Os cliques que contam para o intervalo do duplo clique: apertar e soltar o botão (o arrastar) não.
_PACED_ACTIONS: Final = frozenset({"CLICK", "DOUBLE"})
UNSUPPORTED: Final = "unsupported"
UNKNOWN_APP: Final = "unknown_app"
# Tempo entre responder à API e suspender: o resultado precisa sair antes de o PC adormecer.
SLEEP_DELAY_SECONDS: Final = 1.0


def _ok(command: Command) -> CommandResult:
    return CommandResult(command.id, ResultStatus.OK)


# Recusas seguidas do movimento do mouse (com menos de `BURST_GAP_SECONDS` entre uma e outra) são
# uma rajada: uma linha só no registro, no fim dela ou a cada `BURST_FLUSH_SECONDS` se não acaba.
BURST_GAP_SECONDS: Final = 2.0
BURST_FLUSH_SECONDS: Final = 10.0


class RefusalBurst:
    """Junta as recusas seguidas do fluxo de alta taxa (o movimento do mouse) numa linha só.

    Um PC bloqueado recusa o movimento 60 vezes por segundo: uma linha por recusa afogaria o
    registro, e nenhuma deixaria o dono sem saber por que o mouse não anda. A linha leva quantas
    foram, por quanto tempo e a causa; nunca coordenadas.
    """

    def __init__(
        self,
        label: str,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        gap_seconds: float = BURST_GAP_SECONDS,
        flush_seconds: float = BURST_FLUSH_SECONDS,
    ) -> None:
        self._label = label
        self._monotonic = monotonic
        self._gap = gap_seconds
        self._flush_after = flush_seconds
        self._count = 0
        self._started = 0.0
        self._last = 0.0
        self._cause = ""
        self._detail = ""

    def refused(self, exc: PcInputRefused) -> None:
        now = self._monotonic()
        if self._count and now - self._last > self._gap:
            self._flush()  # a rajada anterior acabou faz tempo: fecha a linha dela
        if not self._count:
            self._started = now
        self._count += 1
        self._last = now
        self._cause, self._detail = exc.cause, exc.detail
        if now - self._started >= self._flush_after:
            self._flush()  # uma rajada que não acaba também aparece

    def accepted(self) -> None:
        if self._count:
            self._flush()

    def _flush(self) -> None:
        _log.warning(
            "%d %s recusados em %.1f s (causa %s; %s)",
            self._count,
            self._label,
            max(0.0, self._last - self._started),
            self._cause,
            self._detail or "sem detalhe",
        )
        self._count = 0


def _guarded(
    handle: Callable[[Command], CommandResult],
    *,
    noisy: bool = True,
    burst: RefusalBurst | None = None,
) -> Handler:
    """Transforma a falha do sistema em resultado: o agente nunca cai por causa de uma tecla.

    `noisy=False` é para o fluxo de alta taxa (o movimento do mouse): uma falha repetida seria uma
    linha de registro por movimento, então vai só para o nível de depuração, e a rajada de recusas
    do sistema vira UMA linha agregada (`burst`). A recusa do sistema (`PcInputRefused`) volta ao
    app com a causa (`session_locked`, `elevated_window` ou `failed`), para ele dizer o que houve.
    """

    async def run(command: Command) -> CommandResult:
        try:
            result = handle(command)
        except PcUnsupported as exc:
            return CommandResult(command.id, ResultStatus.REJECTED, str(exc), UNSUPPORTED)
        except ValueError as exc:
            # Tecla fora das listas: o contrato já barra, isto só protege contra um erro nosso.
            return CommandResult(command.id, ResultStatus.REJECTED, str(exc), "invalid_message")
        except PcInputRefused as exc:
            if noisy:
                _log.warning(
                    "falha ao executar %s: %s (causa %s; %s)",
                    command.type,
                    exc,
                    exc.cause,
                    exc.detail or "sem detalhe",
                )
            else:
                _log.debug("falha ao executar %s: %s", command.type, exc)
                if burst is not None:
                    burst.refused(exc)
            return CommandResult(command.id, ResultStatus.FAILED, str(exc), exc.cause)
        except OSError as exc:
            (_log.warning if noisy else _log.debug)("falha ao executar %s: %s", command.type, exc)
            return CommandResult(command.id, ResultStatus.FAILED, str(exc), "failed")
        if burst is not None:
            burst.accepted()
        return result

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
    return replace(newer, body=body)


def pc_pointer_handler(pc: PcInput, *, burst: RefusalBurst | None = None) -> Handler:
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

    return _guarded(handle, noisy=False, burst=burst or RefusalBurst("movimentos do mouse"))


def pc_click_handler(pc: PcInput, pacer: ClickPacer | None = None) -> Handler:
    """`pc.click.v1`. O clique que sai fica marcado em `pacer`: dele conta o `gapMs` do seguinte."""

    def handle(command: Command) -> CommandResult:
        button = str(command.body["button"])
        action = str(command.body.get("action") or "CLICK")
        if pacer is not None and action in _PACED_ACTIONS:
            pacer.mark(button)
        pc.click(button, action)
        return _ok(command)

    return _guarded(handle)


def pc_click_v2_handler(
    pc: PcInput,
    pacer: ClickPacer | None = None,
    *,
    expired: Callable[[Command], bool] | None = None,
) -> Handler:
    """`pc.click.v2`: o clique da v1 com `modifiers` (apertados, o clique, soltos, num lote só) e
    `gapMs`: antes de clicar espera o que faltar desde o último clique do mesmo botão para
    reproduzir o intervalo que o app mediu (o Windows só vê duplo clique com os apertos próximos).
    Se o pedido chegou mais tarde que `gapMs`, sai na hora; nunca espera mais que `gapMs`.

    Depois da espera o comando é conferido de novo: `expired` diz se ele passou da validade
    enquanto esperava (a idade também conta a espera), e então não sai. Se a faixa o cancelar na
    espera (o canal direto de onde veio fechou), nada sai."""

    def handle(command: Command) -> CommandResult:
        body = command.body
        button = str(body["button"])
        action = str(body.get("action") or "CLICK")
        modifiers: Sequence[str] = body.get("modifiers") or ()
        if pacer is not None:
            pacer.mark(button)
        pc.click(button, action, modifiers)
        return _ok(command)

    guarded = _guarded(handle)

    async def run(command: Command) -> CommandResult:
        gap = command.body.get("gapMs")
        if pacer is not None and isinstance(gap, int) and gap > 0:
            await pacer.wait(str(command.body["button"]), gap / 1000)
            if expired is not None and expired(command):
                _log.info("comando %s expirou durante a espera do intervalo", command.type)
                return CommandResult(command.id, ResultStatus.REJECTED, "comando expirado", EXPIRED)
        return await guarded(command)

    return run


def pc_key_handler(pc: PcInput) -> Handler:
    """`pc.key.v1`."""

    def handle(command: Command) -> CommandResult:
        modifiers: Sequence[str] = command.body.get("modifiers") or ()
        pc.key(str(command.body["key"]), modifiers)
        return _ok(command)

    return _guarded(handle)


def pc_key_v2_handler(pc: PcInput) -> Handler:
    """`pc.key.v2`: a tecla da v1 mais `repeat` (várias vezes num lote só) e `action` (`DOWN` e `UP`
    seguram e soltam um modificador; o adaptador solta o que ficar apertado)."""

    def handle(command: Command) -> CommandResult:
        body = command.body
        modifiers: Sequence[str] = body.get("modifiers") or ()
        pc.key(
            str(body["key"]),
            modifiers,
            repeat=int(body.get("repeat") or 1),
            action=str(body.get("action") or "PRESS"),
        )
        return _ok(command)

    return _guarded(handle)


def pc_text_handler(pc: PcInput) -> Handler:
    """`pc.text.v1`. O texto nunca vai para o registro: pode ser uma senha."""

    def handle(command: Command) -> CommandResult:
        pc.type_text(str(command.body["text"]))
        return _ok(command)

    return _guarded(handle)


def pc_text_v2_handler(pc: PcInput) -> Handler:
    """`pc.text.v2`: apagar `erase` caracteres, digitar `text` e apertar `key` (Enter ou Tab), nesta
    ordem e no mesmo toque no sistema. O texto nunca vai para o registro: pode ser uma senha."""

    def handle(command: Command) -> CommandResult:
        body = command.body
        key = body.get("key")
        erase = int(body.get("erase") or 0)
        text = str(body.get("text") or "")
        # O contrato pede pelo menos um dos três (o modelo gerado não impõe o "ou"): uma edição
        # vazia não faz nada e é recusada, em vez de responder "feito".
        if erase <= 0 and not text and key is None:
            raise ValueError("edição de texto sem nada a fazer")
        pc.edit_text(erase, text, None if key is None else str(key))
        return _ok(command)

    return _guarded(handle)


# O maior zoom de uma mensagem (o contrato limita; o adaptador também).
MAX_ZOOM_STEPS: Final = 12


def pc_zoom_handler(pc: PcInput) -> Handler:
    """`pc.pointer.zoom.v1`: `steps` cliques de roda com o Ctrl apertado (a pinça do app). O Ctrl é
    apertado e solto no mesmo lote do sistema, então nunca fica preso."""

    def handle(command: Command) -> CommandResult:
        steps = command.body.get("steps")
        # O contrato barra o zero e o que passa de 12 (o modelo gerado não impõe o "diferente de
        # zero"): sem passos não há o que fazer, e é recusado em vez de responder "feito".
        if (
            not isinstance(steps, int)
            or isinstance(steps, bool)
            or not (0 < abs(steps) <= MAX_ZOOM_STEPS)
        ):
            raise ValueError("zoom fora do contrato")
        pc.zoom(steps)
        return _ok(command)

    return _guarded(handle)


def pc_media_handler(pc: PcInput, *, volume_changed: Callable[[], None] | None = None) -> Handler:
    """`pc.media.v1`. As teclas de volume e de mudo avisam `volume_changed` depois de apertadas."""

    def handle(command: Command) -> CommandResult:
        action = str(command.body["action"])
        pc.media(action, int(command.body.get("steps") or 1))
        if volume_changed is not None and action in VOLUME_MEDIA_ACTIONS:
            volume_changed()
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
    pacer: ClickPacer | None = None,
    audio: PcAudio | None = None,
    volume_changed: Callable[[], None] | None = None,
    foreground: PcForeground | None = None,
) -> dict[str, Handler]:
    """Todos os comandos `pc.*` que este agente executa quando o controle está ligado.

    Cada um só roda dentro da sua validade (ver `freshness`); o UP de um clique e o cancelamento de
    um desligamento passam sempre. `clock` é a referência de idade (relógio da API contra o
    monotônico do agente): quem monta o agente a compartilha com `ProcessMessage`, que a alimenta
    com os batimentos da API. `use` anota cada comando que chega a ser executado (não os recusados
    por idade): a atualização do agente o lê para não reiniciar no meio de uma sessão do touchpad.
    `pacer` guarda o último clique para o `gapMs` do seguinte (um só para o `v1` e o `v2`, e para
    a nuvem e o canal direto, que entregam ao mesmo conjunto de manipuladores). `audio` é o áudio do
    PC (sem ele não há `pc.volume.v1`); `volume_changed` é avisado depois de um comando mudar o
    volume (o aviso do nível sai atrás dele). `foreground` lê o programa da frente: com ele, a tecla
    e o texto que trazem `target` só saem com aquele programa na frente (ver `focus`).
    """
    offset = clock or ClockOffset()
    clicks = pacer or ClickPacer()

    def aged_out(command: Command) -> bool:
        age = offset.age(command.sent_at)
        if age is None or age <= MAX_COMMAND_AGE_SECONDS:
            return False
        offset.refused(age)  # como a recusa por idade de sempre: alimenta o aviso de relógio
        return True

    def noted(handle: Handler) -> Handler:
        return use.noting(handle) if use is not None else handle

    def focused(handle: Handler) -> Handler:
        # Com `foreground`, o `target` de uma tecla ou texto é conferido (ver `focus`); sem ele o
        # agente não declara `pc.target.v1` e a API nunca manda o campo.
        return focus_guarded(handle, foreground) if foreground is not None else handle

    def fresh(
        handle: Handler,
        max_age: float,
        *,
        exempt: Callable[[Command], bool] | None = None,
        quiet: bool = False,
    ) -> Handler:
        return fresh_only(handle, max_age_seconds=max_age, clock=offset, exempt=exempt, quiet=quiet)

    handlers: dict[str, Handler] = {
        "pc.pointer.v1": fresh(noted(pc_pointer_handler(pc)), MAX_POINTER_AGE_SECONDS, quiet=True),
        "pc.click.v1": fresh(
            noted(pc_click_handler(pc, clicks)),
            MAX_COMMAND_AGE_SECONDS,
            exempt=lambda command: command.body.get("action") == "UP",
        ),
        # O `v2` só tem CLICK e DOUBLE: não há soltura para isentar da idade.
        # A idade é conferida antes da espera do intervalo (não vale esperar o que já expirou) e de
        # novo depois dela (a espera também envelhece o comando).
        "pc.click.v2": fresh(
            noted(pc_click_v2_handler(pc, clicks, expired=aged_out)), MAX_COMMAND_AGE_SECONDS
        ),
        "pc.key.v1": fresh(noted(focused(pc_key_handler(pc))), MAX_COMMAND_AGE_SECONDS),
        # Soltar nunca é recusado por idade (como o UP de um clique): uma soltura atrasada ainda é
        # a que impede o modificador de ficar preso.
        "pc.key.v2": fresh(
            noted(focused(pc_key_v2_handler(pc))),
            MAX_COMMAND_AGE_SECONDS,
            exempt=lambda command: command.body.get("action") == "UP",
        ),
        "pc.text.v1": fresh(noted(focused(pc_text_handler(pc))), MAX_COMMAND_AGE_SECONDS),
        "pc.text.v2": fresh(noted(focused(pc_text_v2_handler(pc))), MAX_COMMAND_AGE_SECONDS),
        # O zoom é um lote só (Ctrl, roda, Ctrl): um zoom velho cairia em outra janela, então
        # vale só dentro da validade dos comandos.
        "pc.pointer.zoom.v1": fresh(noted(pc_zoom_handler(pc)), MAX_COMMAND_AGE_SECONDS),
        "pc.media.v1": fresh(
            noted(pc_media_handler(pc, volume_changed=volume_changed)), MAX_COMMAND_AGE_SECONDS
        ),
        "pc.power.v1": fresh(
            noted(pc_power_handler(power, shutdown_delay_seconds=shutdown_delay_seconds)),
            MAX_POWER_AGE_SECONDS,
            exempt=lambda command: command.body.get("action") == "CANCEL_SHUTDOWN",
        ),
        "pc.app.launch.v1": fresh(
            noted(pc_app_launch_handler(launcher, apps)), MAX_COMMAND_AGE_SECONDS
        ),
    }
    if audio is not None:
        handlers["pc.volume.v1"] = fresh(
            noted(pc_volume_handler(audio, changed=volume_changed)), MAX_COMMAND_AGE_SECONDS
        )
    return handlers


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
