"""Handlers dos comandos da TV: traduzem a mensagem validada em chamadas à sessão da TV."""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Final, Protocol
from urllib.parse import urlsplit

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import FreshKeyHandler, Handler
from uniover_agent.core.tv.key_timing import OUTCOME_OK, KeyTimings
from uniover_agent.core.tv.session import PowerOffResult, TvSessionError
from uniover_agent.core.tv.text_edit import TextControl, TextReconciler

_log = logging.getLogger(__name__)

# Esquemas de link que podem ser abertos na TV. `intent://` e afins ficam de fora de propósito: o
# contrato só fixa o formato do link, quem decide o que pode ser aberto é este agente.
DEFAULT_LINK_SCHEMES: Final = frozenset({"https", "http", "market", "vnd.youtube"})

# Declarada no `agent.hello.v1`: a API só manda `tv.power.off.v1` a quem a tem.
POWER_OFF_CAPABILITY: Final = "tv.power.off.v1"

KEY_BLOCKED: Final = "key_blocked"
# Um `POWER` ignorado por repetir o anterior (resultado interno; no fio continua `ok`).
POWER_IGNORED: Final = "power_repeat_ignored"
UNSUPPORTED: Final = "unsupported"
LINK_SCHEME_BLOCKED: Final = "link_scheme_not_allowed"
INVALID_TARGET: Final = "invalid_target"
# A tecla perde o sentido depois da espera pela sessão; a API já pode ter desistido do toque.
KEY_MAX_AGE_SECONDS: Final = 1.5
# A parada do próprio laço do agente não conta para `KEY_MAX_AGE_SECONDS` (ver `LoopProgress`), mas
# nenhuma tecla passa desta idade inteira, com a parada: não se executa um toque de minutos atrás.
# Abaixo dos prazos de quem espera a resposta (6,5 s no canal direto, 8 s na API) e nenhum dos dois
# reenvia a tecla: ela nunca chega à TV depois de o app já ter desistido dela.
KEY_STALLED_MAX_AGE_SECONDS: Final = 4.0
# Toques que chegam juntos com a sessão pronta são todos intencionais. Só se junta uma repetição
# depois desta espera, que indica que a abertura da sessão segurou a fila. A parada do laço do
# agente não conta: as teclas tocadas durante ela foram intencionais e vão todas, na ordem.
KEY_COALESCE_AFTER_SECONDS: Final = 0.3
AGENT_TIMEOUT: Final = "agent_timeout"
# O canal direto que mandou a tecla fechou antes de ela chegar à TV.
CHANNEL_CLOSED: Final = "channel_closed"
# O caminho de quem chegou pelo canal direto (`TimedKeyCommand.path`).
PATH_DIRECT: Final = "canal direto"
# A tecla passou da validade contada desde o envio: o mesmo código dos comandos velhos do PC.
EXPIRED: Final = "expired"


@dataclass(frozen=True, slots=True)
class TimedKeyCommand(Command):
    """Chegada no agente e tecla mais recente, sem mudar o contrato recebido."""

    received_at: float = 0.0
    is_latest: Callable[[], bool] | None = None
    # Idade desde o envio pela API, medida NA CHEGADA (pelo `ClockOffset`): a espera aqui dentro
    # soma por cima. `None` sem referência de relógio (API antiga, recém-conectado, canal direto):
    # a idade conta só desde a chegada, como antes.
    sent_age: float | None = None
    # Só nas teclas do canal direto: a sessão dele ainda vale? Fechada, a tecla não chega à TV.
    is_valid: Callable[[], bool] | None = None
    # Por onde chegou (nuvem ou canal direto) e o instante da chegada em `perf_counter_ns`: só para
    # medir os trechos da tecla (`KeyTimings`); `0` sem medida.
    path: str | None = None
    received_ns: int = 0


@dataclass(frozen=True, slots=True)
class ValidatedCommand(Command):
    """Comando do canal direto com a validade da sessão que o mandou (como `TimedKeyCommand`)."""

    is_valid: Callable[[], bool] | None = None


class PackageLauncher(Protocol):
    """Abre um app pelo nome do pacote (o canal ADB; sem ele o pedido é recusado)."""

    async def launch_package(self, package: str) -> None: ...


class TvControl(Protocol):
    """O que os handlers pedem à sessão da TV (o `TvSessionManager` implementa)."""

    async def send_key(
        self, key: str, direction: str = "SHORT", *, validate: Callable[[], None] | None = None
    ) -> bool | None: ...

    async def launch_link(self, link: str) -> None: ...

    async def send_text(self, text: str) -> None: ...

    async def wake(self) -> None: ...

    async def power_off(self) -> PowerOffResult: ...


def failed_result(command: Command, exc: TvSessionError) -> CommandResult:
    return CommandResult(command.id, ResultStatus.FAILED, exc.message, exc.code)


def unsupported_handler(message: str) -> Handler:
    """Recusa um comando conhecido que este tipo de TV não consegue executar."""

    async def handle(command: Command) -> CommandResult:
        return CommandResult(command.id, ResultStatus.REJECTED, message, UNSUPPORTED)

    return handle


class LoopElapsed(Protocol):
    """Quanto o laço andou desde um instante, sem as paradas dele (`LoopProgress.elapsed_since`)."""

    def __call__(self, moment: float, *, strict: bool = False) -> float: ...


class _KeyAges:
    """A idade das teclas: descarta a velha e conta, no registro, as descartadas e as mantidas.

    Com `loop_elapsed` (o `LoopProgress.elapsed_since`, no mesmo relógio de `monotonic`), a espera
    que conta é só a do laço andando: uma parada do próprio agente não descarta a tecla, até o teto
    `KEY_STALLED_MAX_AGE_SECONDS` da idade inteira.
    """

    def __init__(
        self,
        monotonic: Callable[[], float],
        loop_elapsed: LoopElapsed | None,
        direct_elapsed: LoopElapsed | None = None,
    ) -> None:
        self._monotonic = monotonic
        self._loop_elapsed = loop_elapsed
        # A tecla do canal direto não passa pelo laço que a recebe da nuvem: só o relógio do laço
        # da TV conta (`direct_elapsed`; sem ele, o mesmo das outras).
        self._direct_elapsed = direct_elapsed or loop_elapsed
        self._discarded = 0
        self._kept_after_stall = 0
        # A sessão confere a mesma tecla mais de uma vez: ela só entra uma vez na conta.
        self._last_kept: object | None = None

    def _clock(self, command: object) -> LoopElapsed | None:
        if isinstance(command, TimedKeyCommand) and command.path == PATH_DIRECT:
            return self._direct_elapsed
        return self._loop_elapsed

    def _effective(
        self, elapsed: LoopElapsed | None, start: float, sent_age: float | None
    ) -> tuple[float, float]:
        """A espera aqui dentro e a idade que conta, as duas sem as paradas do laço do agente.

        Pela nuvem, a idade desde o envio foi lida na chegada e já leva a parada que houve antes da
        leitura: ela também sai, pelo trecho do relógio que cobre a idade."""
        if elapsed is None:
            waited = self._monotonic() - start
            return waited, waited if sent_age is None else sent_age + waited
        waited = elapsed(start)
        if sent_age is None or sent_age <= 0:
            return waited, waited + (sent_age or 0.0)
        return waited, elapsed(start - sent_age)

    def check(self, command: object, start: float, sent_age: float | None) -> float:
        """A espera da tecla para a junção; velha demais, `TvSessionError`.

        A junção usa a espera sem parada nenhuma (nem a folga): toques repetidos durante a parada
        foram intencionais, e só a espera com o laço andando (a sessão abrindo) os junta."""
        raw_age = (sent_age or 0.0) + self._monotonic() - start
        elapsed = self._clock(command)
        waited, age = self._effective(elapsed, start, sent_age)
        if age > KEY_MAX_AGE_SECONDS or raw_age > KEY_STALLED_MAX_AGE_SECONDS:
            self._discarded += 1
            # O total evita uma linha por tecla durante a rajada, sem identificar a TV.
            if self._discarded == 1 or self._discarded % 10 == 0:
                _log.info("teclas descartadas por idade: total=%d", self._discarded)
            # Medida desde o envio, é o "comando velho" de sempre (`expired`, que a tela cala);
            # sem a referência, segue o código de antes.
            code = AGENT_TIMEOUT if sent_age is None else EXPIRED
            raise TvSessionError(code, "a tecla expirou antes de chegar à TV")
        if raw_age > KEY_MAX_AGE_SECONDS and self._last_kept is not command:
            # Antes, esta tecla seria descartada: quem a atrasou foi o laço do agente parado.
            self._last_kept = command
            self._kept_after_stall += 1
            if self._kept_after_stall == 1 or self._kept_after_stall % 10 == 0:
                _log.info(
                    "teclas mantidas apesar da parada do agente: total=%d", self._kept_after_stall
                )
        if elapsed is None:
            return waited
        return elapsed(start, strict=True)


def tv_key_handler(  # noqa: PLR0913 - tempos e medidas injetáveis para os testes
    tv: TvControl,
    *,
    blocked_keys: frozenset[str] = frozenset(),
    monotonic: Callable[[], float] = time.monotonic,
    timings: KeyTimings | None = None,
    clock_ns: Callable[[], int] = time.perf_counter_ns,
    loop_elapsed: LoopElapsed | None = None,
    direct_elapsed: LoopElapsed | None = None,
) -> Handler:
    """Trata `tv.key.v1`, `v2` e `v3` (a direção existe nas duas últimas).

    Com `loop_elapsed` (ver `_KeyAges`), uma parada do próprio agente não descarta a tecla nem a
    junta com a repetição, até o teto `KEY_STALLED_MAX_AGE_SECONDS` da idade inteira.

    Com `timings`, cada tecla que passou pela fila (`TimedKeyCommand` com `received_ns`) deixa ali
    quanto levou em cada trecho: fila, sessão e envio (medidos por `clock_ns`), além da idade.

    Nenhuma tecla é recusada por padrão, nem `POWER`: quem decide o desligamento é o app (a folha
    de confirmação) e a API (a rota própria, que a rota genérica de teclas recusa). Quem montar o
    agente pode ainda bloquear teclas por `blocked_keys`; elas voltam como `KEY_BLOCKED` sem sequer
    abrir a sessão com a TV.
    """

    latest: dict[str, int] = {}
    ages = _KeyAges(monotonic, loop_elapsed, direct_elapsed)

    async def send(command: Command, ready: list[int] | None) -> CommandResult:
        key = command.body.get("key")
        if not isinstance(key, str) or not key:
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'key' ausente")
        if key in blocked_keys:
            _log.warning("tecla %s recusada: bloqueada neste agente", key)
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                f"a tecla {key} está bloqueada neste agente",
                KEY_BLOCKED,
            )
        direction = command.body.get("direction") or "SHORT"
        # Só toques curtos podem substituir um igual ainda esperando a sessão abrir. Pressões
        # longas têm início e fim próprios; POWER mantém a proteção de repetição da sessão.
        coalesce = key != "POWER" and direction == "SHORT"
        sequence = 0
        if coalesce and not isinstance(command, TimedKeyCommand):
            latest[key] = latest.get(key, 0) + 1
            sequence = latest[key]

        def validate() -> None:
            if key == "POWER":
                return
            if isinstance(command, TimedKeyCommand) and command.is_valid is not None:
                if not command.is_valid():
                    raise TvSessionError(CHANNEL_CLOSED, "o canal direto fechou antes da tecla")
            timed = command if isinstance(command, TimedKeyCommand) else None
            waited = ages.check(
                command,
                timed.received_at if timed is not None else arrived,
                timed.sent_age if timed is not None else None,
            )
            if coalesce:
                if isinstance(command, TimedKeyCommand):
                    superseded = command.is_latest is not None and not command.is_latest()
                else:
                    superseded = sequence != latest[key]
                if waited > KEY_COALESCE_AFTER_SECONDS and superseded:
                    raise TvSessionError(
                        AGENT_TIMEOUT, "a tecla foi substituída por um toque mais recente"
                    )
            if ready is not None:
                # A sessão chama esta conferência logo antes de entregar a tecla ao driver: a
                # última vale (uma reabertura no meio fica no trecho da sessão).
                ready[0] = clock_ns()

        arrived = monotonic()
        if isinstance(command, TimedKeyCommand) and command.is_valid is not None:
            if not command.is_valid():
                return CommandResult(
                    command.id, ResultStatus.REJECTED, "o canal direto fechou", CHANNEL_CLOSED
                )
        try:
            if key == "POWER":
                sent = await tv.send_key(key, str(direction))
                if sent is False:
                    # De propósito: um segundo POWER logo após o anterior religaria a TV (toque
                    # duplo, reenvio). O contrato só tem `ok` para o sucesso; o código fica no
                    # resultado interno e no registro.
                    return CommandResult(
                        command.id,
                        ResultStatus.OK,
                        "POWER ignorado: repete o anterior ou a TV ainda está ligando",
                        POWER_IGNORED,
                    )
            else:
                await tv.send_key(key, str(direction), validate=validate)
        except TvSessionError as exc:
            return failed_result(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    # O receptor só pode seguir lendo mensagens durante a abertura da TV se este handler estiver
    # instalado: é ele que impede o envio tardio ao driver.
    return FreshKeyHandler(_timed_keys(send, timings, clock_ns))


def _timed_keys(
    send: Callable[[Command, list[int] | None], Awaitable[CommandResult]],
    timings: KeyTimings | None,
    clock_ns: Callable[[], int],
) -> Handler:
    """Mede os trechos de cada tecla que passou pela fila; `send` marca em `ready[0]` o instante
    em que a sessão ficou pronta (a última conferência antes de ir ao driver)."""

    async def handle(command: Command) -> CommandResult:
        if (
            timings is None
            or not isinstance(command, TimedKeyCommand)
            or not command.received_ns
            or command.body.get("key") == "POWER"
        ):
            return await send(command, None)
        started = clock_ns()
        ready = [0]
        outcome = "interrompida"
        try:
            result = await send(command, ready)
            outcome = OUTCOME_OK if result.status is ResultStatus.OK else result.code or "recusada"
            return result
        finally:
            done = clock_ns()
            if outcome != OUTCOME_OK:
                # Sem tecla entregue, o tempo depois da vez é todo da sessão (abrir, falhar).
                ready[0] = 0
            timings.record(
                key=str(command.body.get("key")),
                path=command.path,
                outcome=outcome,
                age=command.sent_age,
                queue_ns=max(0, started - command.received_ns),
                session_ns=(ready[0] or done) - started,
                send_ns=done - ready[0] if ready[0] else None,
            )

    return handle


def tv_text_handler(
    tv: TextControl,
    *,
    reconciler: TextReconciler | None = None,
    monotonic: Callable[[], float] = time.monotonic,
) -> Handler:
    """`tv.text.v1`: o campo de texto em foco na TV passa a ter este texto.

    O app manda o texto completo a cada pausa de digitação. O agente não reenvia o campo inteiro (o
    controle remoto insere, então duplicava letras): o `TextReconciler` compara com o que ele
    mesmo digitou, apaga o excedente com `DEL` e digita só o acréscimo. Texto vazio apaga tudo o
    que o agente digitou.

    As mensagens são atendidas uma a uma, na ordem de chegada, e se uma mais nova já chegou enquanto
    a anterior esperava a vez (a TV acordando, por exemplo), a antiga é descartada: o diff é sempre
    contra o último texto pedido, então pular um estado intermediário é seguro. Quanto cada
    mensagem esperou a vez entra no resumo do log (nunca o texto).
    """
    editor = reconciler or TextReconciler(tv)
    turn = asyncio.Lock()
    latest = 0

    async def handle(command: Command) -> CommandResult:
        nonlocal latest
        text = command.body.get("text")
        if not isinstance(text, str):
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'text' ausente")
        arrived = monotonic()
        latest += 1
        mine = latest
        is_valid = command.is_valid if isinstance(command, ValidatedCommand) else None

        def validate() -> None:
            if is_valid is not None and not is_valid():
                raise TvSessionError(CHANNEL_CLOSED, "o canal direto fechou antes do texto")

        async with turn:
            queued = monotonic() - arrived
            # Só depois de obter a vez: quem esperava a trava foi revogado enquanto isso?
            try:
                validate()
            except TvSessionError as exc:
                return failed_result(command, exc)
            if mine != latest:
                # Já existe um texto mais novo na fila; ele é quem vai para a TV.
                _log.info("texto descartado: chegou um mais novo | ms vez=%d", round(queued * 1000))
                return CommandResult(command.id, ResultStatus.OK)
            try:
                await editor.set_text(text, queued=queued, validate=validate)
            except TvSessionError as exc:
                return failed_result(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


def tv_wake_handler(tv: TvControl) -> Handler:
    """`tv.wake.v1`: o app abriu, então aquece a sessão antes do primeiro toque."""

    async def handle(command: Command) -> CommandResult:
        try:
            await tv.wake()
        except TvSessionError as exc:
            return failed_result(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


_POWER_OFF_MESSAGES: Final = {
    PowerOffResult.ALREADY_OFF: "a TV já estava desligada; nenhuma tecla foi enviada",
    PowerOffResult.UNCERTAIN: "não deu para confirmar o estado da TV; a tecla não foi repetida",
    PowerOffResult.OFFLINE: "a TV não respondeu ao controle; nenhuma tecla foi enviada",
    PowerOffResult.FAILED: "o agente não conseguiu desligar a TV",
}


def tv_power_off_handler(tv: TvControl) -> Handler:
    """`tv.power.off.v1`: desliga só com a TV lida como ligada e nunca a liga.

    O resultado é `ok` só quando o desligamento foi confirmado; nos demais casos o código estável
    (`already_off`, `uncertain`, `offline`, `failed`) diz à API o que dizer ao dono.
    """

    async def handle(command: Command) -> CommandResult:
        result = await tv.power_off()
        if result is PowerOffResult.OFF:
            return CommandResult(command.id, ResultStatus.OK)
        return CommandResult(
            command.id, ResultStatus.FAILED, _POWER_OFF_MESSAGES[result], result.value
        )

    return handle


async def _launch_package(
    command: Command, packages: PackageLauncher, value: object
) -> CommandResult:
    if not isinstance(value, str) or not value:
        return CommandResult(command.id, ResultStatus.REJECTED, "alvo inválido")
    try:
        await packages.launch_package(value)
    except ValueError:
        return CommandResult(
            command.id, ResultStatus.REJECTED, "nome de pacote inválido", INVALID_TARGET
        )
    except TvSessionError as exc:
        return failed_result(command, exc)
    return CommandResult(command.id, ResultStatus.OK)


async def _launch_link(
    command: Command, tv: TvControl, allowed_schemes: frozenset[str], kind: object, value: object
) -> CommandResult:
    if kind != "link" or not isinstance(value, str) or not value:
        return CommandResult(command.id, ResultStatus.REJECTED, "alvo inválido")
    scheme = urlsplit(value).scheme.lower()
    if scheme not in allowed_schemes:
        return CommandResult(
            command.id,
            ResultStatus.REJECTED,
            f"esquema de link não permitido: {scheme or '(nenhum)'}",
            LINK_SCHEME_BLOCKED,
        )
    try:
        await tv.launch_link(value)
    except TvSessionError as exc:
        return failed_result(command, exc)
    return CommandResult(command.id, ResultStatus.OK)


def tv_app_launch_handler(
    tv: TvControl,
    *,
    allowed_schemes: frozenset[str] = DEFAULT_LINK_SCHEMES,
    packages: PackageLauncher | None = None,
    links_supported: bool = True,
) -> Handler:
    """`tv.app.launch.v1`: link pelo controle remoto; pacote pelo canal ADB (`packages`).

    Sem o canal ADB, abrir por pacote é recusado com `unsupported`. Drivers sem abertura de link
    passam `links_supported=False`, para que o app esconda a ação em vez de tentar um protocolo que
    a TV não oferece.
    """

    async def handle(command: Command) -> CommandResult:
        target = command.body.get("target")
        if not isinstance(target, dict):
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'target' ausente")
        kind, value = target.get("kind"), target.get("value")
        if kind == "package" and packages is not None:
            return await _launch_package(command, packages, value)
        if kind == "package":
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                "abrir app por pacote precisa do canal ADB, que não está habilitado",
                UNSUPPORTED,
            )
        if kind == "link" and not links_supported:
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                "a TV não suporta abrir links por este canal",
                UNSUPPORTED,
            )
        return await _launch_link(command, tv, allowed_schemes, kind, value)

    return handle
