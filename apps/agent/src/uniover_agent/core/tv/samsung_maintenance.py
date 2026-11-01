"""Manutenção automática da TV Samsung: fecha só o que a TV prova que está em segundo plano.

A Samsung não informa com certeza qual app está na tela (um app Tizen não consulta isso pelo canal
do controle), e o controle físico troca de app sem avisar o agente. Por isso esta manutenção não
adivinha: o REST da própria TV (`GET /api/v2/applications/<id>`) diz, por app, se ele está rodando
e se está visível, e só um app que aparece **rodando e oculto** pode ser fechado. Na dúvida, nada é
fechado e o relatório diz "pulada".

Garantias, cada uma coberta por teste:

- nunca abre o canal do controle (o `Permitir` da TV só aparece quando alguém abre o WebSocket);
- sem permissão válida (sem token, ou a TV já pediu o aceite de novo) não toca na TV: avisa uma vez;
- exige exatamente um app visível na leitura, como prova de que o campo `visible` funciona nesta TV;
- nunca fecha o app visível, o último que o UniOver abriu nem o que o estado da sessão aponta;
- relê o app logo antes de cada fechamento e para se alguém voltou a usar a TV.
"""

import asyncio
import logging
import uuid
from collections.abc import Callable, Collection
from dataclasses import dataclass
from typing import Final, Protocol

from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.tv.cleanup_schedule import is_user_activity
from uniover_agent.core.tv.samsung_apps import app_alias
from uniover_agent.ports import Clock, Transport, TransportError

_log = logging.getLogger(__name__)

IDLE_SECONDS: Final = 15 * 60.0
# Entre a primeira leitura e a segunda: quem trocou de app logo depois da primeira leitura aparece
# na segunda, e só o que continua oculto nas duas passa para o fechamento.
CONFIRM_DELAY_SECONDS: Final = 3.0
# O contrato do relatório limita a duração (5 min); uma passada nunca chega perto, mas o teto fica.
MAX_DURATION_MS: Final = 300_000

# Marcas do relatório: um tipo de limpeza já conhecido pela API (`deep`) e um gatilho próprio, que a
# tela usa para escrever "Manutenção".
REPORT_KIND: Final = "deep"
REPORT_TRIGGER: Final = "maintenance"

# Declarada no `agent.hello.v1`: a API só manda a preferência desta manutenção a quem a tem.
SAMSUNG_MAINTENANCE_CAPABILITY: Final = "tv.maintenance.v1"

# Motivos de "pulada" (códigos estáveis; a tela os traduz).
REASON_PERMISSION: Final = "permission-required"
REASON_UNCONFIRMED: Final = "foreground-unverifiable"
REASON_UNAVAILABLE: Final = "state-unavailable"
REASON_IN_USE: Final = "recent-command"


@dataclass(frozen=True, slots=True)
class SamsungAppStatus:
    """O que a TV disse de um app. `None` em qualquer campo: a resposta não trouxe o booleano."""

    app_id: str
    running: bool | None
    visible: bool | None


class SamsungMaintenanceDriver(Protocol):
    """O que a manutenção pede ao driver: só leituras e o fechamento por REST, nunca o WebSocket."""

    @property
    def permission_granted(self) -> bool: ...

    async def read_power(self) -> bool | None: ...

    async def app_statuses(self) -> list[SamsungAppStatus]: ...

    async def app_status(self, app_id: str) -> SamsungAppStatus | None: ...

    async def close_app(self, app_id: str) -> bool: ...


@dataclass(frozen=True, slots=True)
class MaintenanceOutcome:
    """Como terminou uma passada. `skipped` traz o motivo; `silent` é "nada a relatar"."""

    closed: tuple[str, ...] = ()
    skipped: str | None = None
    silent: bool = False


class SamsungMaintenance:
    """Uma passada de manutenção: lê, decide com prova e só então fecha."""

    def __init__(
        self,
        driver: SamsungMaintenanceDriver,
        clock: Clock,
        protected: Callable[[], Collection[str]],
    ) -> None:
        self._driver = driver
        self._clock = clock
        self._protected = protected

    async def run(self, still_idle: Callable[[], bool]) -> MaintenanceOutcome:
        blocked = await self._precondition()
        if blocked is not None:
            return blocked
        scan = await self._prove_foreground()
        if scan is None:
            return MaintenanceOutcome(skipped=REASON_UNCONFIRMED)

        closed: list[str] = []
        for app_id in sorted(scan.hidden):
            if not still_idle():
                return self._interrupted(closed)
            # Última conferência, deste app: se ficou visível agora, é o que a pessoa está vendo.
            status = await self._driver.app_status(app_id)
            if status is None or status.visible is not False or status.running is not True:
                continue
            if app_id in self._protected():
                continue
            if await self._driver.close_app(app_id):
                closed.append(app_id)
        return MaintenanceOutcome(closed=tuple(closed))

    async def _precondition(self) -> MaintenanceOutcome | None:
        """O que impede a passada antes de qualquer leitura de apps; `None` se pode seguir."""
        if not self._driver.permission_granted:
            # Nenhuma leitura, nem a do REST: sem permissão válida a TV não é tocada.
            return MaintenanceOutcome(skipped=REASON_PERMISSION)
        power = await self._driver.read_power()
        if power is False:
            # Desligada ou em espera: não há app rodando para limpar, e nada a relatar.
            return MaintenanceOutcome(silent=True)
        if power is None:
            return MaintenanceOutcome(skipped=REASON_UNAVAILABLE)
        return None

    async def _prove_foreground(self) -> _Scan | None:
        """Duas leituras seguidas que concordam; só o que está oculto nas duas passa adiante."""
        first = await self._scan()
        if first is None:
            return None
        await self._clock.sleep(CONFIRM_DELAY_SECONDS)
        second = await self._scan()
        if second is None or second.foreground != first.foreground:
            return None
        return _Scan(first.foreground, first.hidden & second.hidden)

    def _interrupted(self, closed: list[str]) -> MaintenanceOutcome:
        if closed:
            return MaintenanceOutcome(closed=tuple(closed))
        return MaintenanceOutcome(skipped=REASON_IN_USE)

    async def _scan(self) -> _Scan | None:
        """Uma leitura com prova: exatamente um app visível e a lista do que está oculto e rodando.

        `None` quando não há prova do app em uso (nenhum visível, mais de um, ou leitura vazia).
        """
        statuses = await self._driver.app_statuses()
        visible = [item.app_id for item in statuses if item.visible is True]
        if len(visible) != 1:
            return None
        protected = {visible[0], *self._protected()}
        hidden = frozenset(
            item.app_id
            for item in statuses
            if item.running is True and item.visible is False and item.app_id not in protected
        )
        return _Scan(visible[0], hidden)


@dataclass(frozen=True, slots=True)
class _Scan:
    foreground: str
    hidden: frozenset[str]


@dataclass(frozen=True, slots=True)
class MaintenanceConfiguration:
    # A API manda o valor desta TV (ligado por padrão para a Samsung). Antes da primeira
    # configuração chegar o agente não faz nada.
    enabled: bool | None = None


class SamsungMaintenanceScheduler:
    """Roda uma passada quando a TV ficou ociosa por 15 minutos depois do uso pelo UniOver.

    O temporizador só arma com uso pelo UniOver (uma TV usada só com o controle físico nunca
    dispara): é o único sinal de atividade que o agente tem sem falar com a TV.
    """

    def __init__(
        self,
        maintenance: SamsungMaintenance,
        clock: Clock,
        transport: Transport,
        envelopes: EnvelopeFactory,
        *,
        idle_seconds: float = IDLE_SECONDS,
    ) -> None:
        self._maintenance = maintenance
        self._clock = clock
        self._transport = transport
        self._envelopes = envelopes
        self._idle_seconds = idle_seconds
        self._configuration = MaintenanceConfiguration()
        self._last_activity = clock.monotonic()
        self._pending = False
        self._last_skip: str | None = None
        self._wake = asyncio.Event()
        self._wake_task: asyncio.Task[None] | None = None
        self._closed = False

    @property
    def enabled(self) -> bool:
        return self._configuration.enabled is True

    def configure(self, enabled: bool) -> None:
        self._configuration = MaintenanceConfiguration(enabled)
        if not enabled:
            self._pending = False
        self._wake.set()

    def note_message(self, command_type: str) -> None:
        if not is_user_activity(command_type):
            return
        self._last_activity = self._clock.monotonic()
        if not self.enabled:
            return
        self._pending = True
        self._wake_after(self._idle_seconds)

    async def run(self) -> None:
        try:
            while not self._closed:
                await self._wake.wait()
                self._wake.clear()
                try:
                    await self.run_pending()
                except Exception:
                    # Manutenção automática nunca derruba o agente: o próximo uso arma de novo.
                    _log.exception("falha na manutenção automática da TV Samsung")
                    self._pending = False
        finally:
            if self._wake_task is not None:
                self._wake_task.cancel()

    async def aclose(self) -> None:
        self._closed = True
        self._wake.set()

    async def run_pending(self) -> None:
        if not self._pending or not self.enabled:
            return
        quiet_for = self._clock.monotonic() - self._last_activity
        if quiet_for < self._idle_seconds:
            self._wake_after(self._idle_seconds - quiet_for)
            return
        self._pending = False
        started = self._clock.monotonic()
        marker = self._last_activity
        outcome = await self._maintenance.run(lambda: self._last_activity == marker)
        if outcome.silent:
            self._last_skip = None
            return
        duration = min(round((self._clock.monotonic() - started) * 1000), MAX_DURATION_MS)
        if outcome.skipped is not None:
            await self._send_skipped(outcome.skipped)
            return
        self._last_skip = None
        await self._send_completed(outcome.closed, duration)

    def _wake_after(self, delay: float) -> None:
        if self._wake_task is not None and not self._wake_task.done():
            return

        async def alarm() -> None:
            await self._clock.sleep(delay)
            self._wake.set()

        self._wake_task = asyncio.ensure_future(alarm())

    async def _send_completed(self, closed: tuple[str, ...], duration_ms: int) -> None:
        await self._send(
            closed_apps=len(closed),
            closed_packages=tuple(app_alias(app_id) for app_id in closed),
            result="completed",
            reason=None,
            duration_ms=duration_ms,
        )

    async def _send_skipped(self, reason: str) -> None:
        # O mesmo motivo seguido não vira outra linha: a pessoa é avisada uma vez, e só a mudança
        # (ou uma passada que fechou algo) volta a aparecer.
        if reason == self._last_skip:
            return
        self._last_skip = reason
        await self._send(
            closed_apps=0, closed_packages=(), result="skipped", reason=reason, duration_ms=0
        )

    async def _send(
        self,
        *,
        closed_apps: int,
        closed_packages: tuple[str, ...],
        result: str,
        reason: str | None,
        duration_ms: int,
    ) -> None:
        request_id = str(uuid.uuid4())
        message = self._envelopes.tv_cleanup_result(
            request_id,
            request_id,
            closed_apps=closed_apps,
            closed_packages=closed_packages,
            memory_before_mb=None,
            memory_after_mb=None,
            freed_mb=None,
            failed_steps=(),
            kind=REPORT_KIND,
            trigger=REPORT_TRIGGER,
            result=result,
            reason=reason,
            duration_ms=duration_ms,
        )
        try:
            await self._transport.send(message)
        except TransportError:
            _log.info("não consegui enviar o relatório da manutenção da TV Samsung")


__all__ = [
    "IDLE_SECONDS",
    "SAMSUNG_MAINTENANCE_CAPABILITY",
    "MaintenanceOutcome",
    "SamsungAppStatus",
    "SamsungMaintenance",
    "SamsungMaintenanceDriver",
    "SamsungMaintenanceScheduler",
]
